// Session runtime (5.5.5): the interpreter around the pure machine. It owns the named, tokened timers, the
// socket generation gate, the one decode per frame, routing to the game runtime, and the session's appStore
// slices (session, countdown, results, notices, net, lastLeft).
//
// Dispatch is synchronous. Inputs raised while effects run (a sink event, a timer, a UI call from a store
// subscriber) wait in a FIFO and run after the current step, so the runtime never re-enters itself.

import type { AppState, CountdownView, Notice, SessionView } from '../state/appStore';
import type { ClientMessage, ServerMessage } from '../protocol/messages';
import type {
  MachineEnv, Model, NoticeKind, RoomCode, SessionApi, SessionDeps, SessionEffect, SessionInput, SessionState,
  TimerName, TransportSink, WorldSummary,
} from './types';
import { Timers, browserTimers } from '../lib/timers';
import { now as clockNow } from '../lib/clock';
import { rand as mathRand } from '../lib/random';
import { log, recordProtocol } from '../lib/log';
import { stats } from '../state/stats';
import { T } from '../config/tuning';
import { decode } from '../net/decode';
import { encode } from '../net/encode';
import { POLICY } from './policy';
import { boundCode, initialModel, intentOf, isBoundTo, roomOf, transition } from './machine';

/** Notice copy (9.6). Every other room string lives in src/ui/room/copy.ts. */
export const NOTICE_TEXT: Readonly<Record<NoticeKind, string>> = {
  'countdown-cancelled': 'Countdown cancelled — a player left or changed their ready state.',
  'joined-as-new': 'Rejoined as a new player — your previous connection was still open.',
  'placed-in-left-room': "You're back in the match you just left, as a new player.",
  'rejoin-failed': 'That seat has already been released.',
  'seat-released': "Your seat was released — you're back as a new player.",
  'seat-maybe-released': 'You were away for over 30 seconds, so you may be back as a new player with the room-average score.',
};

const NOTICE_TONE: Readonly<Record<NoticeKind, Notice['tone']>> = {
  'countdown-cancelled': 'info',
  'joined-as-new': 'warn',
  'placed-in-left-room': 'info',
  'rejoin-failed': 'warn',
  'seat-released': 'warn',
  'seat-maybe-released': 'warn',
};

const NULL_SINK: TransportSink = { open: () => {}, frame: () => {}, closed: () => {} };

type Admitted = Extract<SessionState, { s: 'lobby' | 'countdown' | 'playing' }>;
const isAdmitted = (s: SessionState): s is Admitted => s.s === 'lobby' || s.s === 'countdown' || s.s === 'playing';

export function createSessionRuntime(deps: SessionDeps): SessionApi {
  const { transport, game, input, audio, identity, store } = deps;
  const host = deps.timers ?? browserTimers;
  const now = deps.now ?? clockNow;
  const rand = deps.rand ?? mathRand;
  const policy = deps.policy ?? POLICY;
  const timers = new Timers<TimerName>(host);
  const listeners = new Set<() => void>();
  const queue: SessionInput[] = [];
  const noticeTimers = new Map<number, number>();
  const deferredLeaves = new Map<string, number>();
  const identityBounds = new Set<number>(); // pending identityReadyMaxMs bounds, cleared on dispose

  let model: Model = initialModel(pageOnline(), pageVisible());
  let running = false;
  let disposed = false;
  let identitySettled = false;
  let lastSummary: WorldSummary = { ready: false, bricksAlive: null, bricksAtStart: null, tick: 0, graceSeats: 0 };
  let lastSessionId = '';
  let lastFrameAt = 0;
  let worldReady = false; // an ingest reported boardReady since the last game.reset
  let boardCode: RoomCode | null = null; // boundCode when the board was last ready (D33)
  let notices: readonly Notice[] = store.get().notices;
  let nextNoticeId = 1;

  const settled = (): void => {
    identitySettled = true;
  };
  identity.ready.then(settled, settled);

  // ---- dispatch ----

  function dispatch(inp: SessionInput): void {
    if (disposed) return;
    queue.push(inp);
    if (running) return;
    running = true;
    try {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        try {
          step(next);
        } catch (err) {
          log.error('session step failed', next.t, err); // the rest of the FIFO still runs
        }
      }
    } finally {
      running = false;
    }
  }

  /** The world summary, or the last good one if the port throws: a lost timer input would never re-arm. */
  function safeSummary(): WorldSummary {
    try {
      lastSummary = game.summary();
    } catch (err) {
      log.error('game summary failed', err);
    }
    return lastSummary;
  }

  function safeSessionId(): string {
    try {
      lastSessionId = identity.current();
    } catch (err) {
      log.error('identity read failed', err);
    }
    return lastSessionId;
  }

  function step(inp: SessionInput): void {
    const env: MachineEnv = { now: now(), rand, sessionId: safeSessionId(), lastFrameAt, world: safeSummary(), policy };
    const prev = model;
    const { model: next, effects } = transition(prev, inp, env);
    model = next;
    for (const e of effects) {
      try {
        run(e);
      } catch (err) {
        log.error('session effect failed', e.e, err); // one broken port must not wedge the session
      }
    }
    publish();
    if (next === prev) return;
    for (const fn of Array.from(listeners)) {
      try {
        fn();
      } catch (err) {
        log.error('session subscriber failed', err);
      }
    }
  }

  function run(e: SessionEffect): void {
    switch (e.e) {
      case 'socket.open':
        return openSocket(e.gen);
      case 'socket.send':
        send(e.gen, wire(e.msg), e.msg.messageType);
        return;
      case 'socket.close':
        return transport.close(e.gen, e.code, e.reason);
      case 'timer.set':
        return armTimer(e.name, e.ms);
      case 'timer.clear':
        if (e.name === '*') timers.clearAll();
        else timers.clear(e.name);
        return;
      case 'game.reset':
        worldReady = false;
        return game.reset(e.epoch, e.myIndex);
      case 'game.freeze':
        return game.freeze(e.frozen);
      case 'game.ended': {
        const res = game.results(e.msg, e.reason);
        store.patch({ results: res });
        return game.ended(res.winner, e.msg === null);
      }
      case 'identity.rotate':
        return identity.rotate();
      case 'input.resync':
        return input.resync();
      case 'input.halt':
        return input.halt();
      case 'audio.scene':
        return audio.setScene(e.scene);
      case 'notice':
        return addNotice(e.kind);
    }
  }

  /** Waits for the identity (bounded by identityReadyMaxMs), then opens only if that gen is still wanted: a
   *  leave or another start during the wait must neither open an orphan socket nor supersede a newer one. */
  function openSocket(gen: number): void {
    const go = (): void => {
      if (disposed) return;
      const s = model.state;
      if (s.s !== 'connecting' || s.gen !== gen) return;
      transport.open(gen, deps.wsUrl());
    };
    if (identitySettled) return go();
    let done = false;
    const bound = host.setTimeout(() => {
      identityBounds.delete(bound);
      if (done) return;
      done = true;
      // 5.5.5: past the bound the current id is used, so later opens (every reconnect) do not wait again.
      identitySettled = true;
      go();
    }, T.session.identityReadyMaxMs);
    identityBounds.add(bound);
    const onReady = (): void => {
      if (done) return;
      done = true;
      identityBounds.delete(bound);
      host.clearTimeout(bound);
      go();
    };
    identity.ready.then(onReady, onReady);
  }

  function armTimer(name: TimerName, ms: number): void {
    const token = timers.set(name, ms, () => {
      if (timers.isCurrent(name, token)) dispatch({ t: 'timer', name });
    });
  }

  function send(gen: number, text: string, kind: string): boolean {
    const ok = transport.send(gen, text);
    if (ok && log.enabled) recordProtocol({ at: now(), dir: 'out', kind, bytes: text.length }); // no hot-path allocation
    return ok;
  }

  // ---- frames ----

  function onFrame(gen: number, text: string, at: number): void {
    if (disposed || gen !== model.lastGen) return;
    lastFrameAt = at; // first, so even a bad frame proves the socket is alive
    stats.net.framesIn += 1;
    stats.net.bytesIn += text.length;
    const d = decode(text);
    if (!d.ok) {
      stats.net.badFrames += 1;
      log.debug('bad frame:', d.detail);
      dispatch({ t: 'badFrame', gen, at });
    } else {
      stats.net.droppedItems += d.dropped;
      if (log.enabled) recordProtocol({ at, dir: 'in', kind: d.msg.messageType, bytes: text.length }); // ~40 Hz in play
      route(gen, d.msg, at);
    }
    if (model.unstable) dispatch({ t: 'frame', gen, at });
  }

  function route(gen: number, msg: ServerMessage, at: number): void {
    switch (msg.messageType) {
      case 'roomCreated':
      case 'roomJoined':
      case 'playerAssignment':
      case 'gameOver':
        dispatch({ t: 'message', gen, msg, at });
        return;
      case 'initialPlayersAndBallsState':
      case 'gameUpdates': {
        const s = model.state;
        if (!isAdmitted(s) || s.gen !== gen) return; // dropped outside admission
        let result;
        try {
          result = game.ingest(msg, at);
        } catch (err) {
          log.error('ingest failed', err);
          dispatch({ t: 'badFrame', gen, at });
          return;
        }
        if (result.boardReady) {
          const code = boundCode(model);
          if (!worldReady || boardCode !== code) {
            worldReady = true;
            boardCode = code;
            publish();
          }
        }
        for (const ev of result.controls) dispatch({ t: 'control', gen, ev, at });
        return;
      }
    }
  }

  transport.setSink({
    open: (gen) => dispatch({ t: 'open', gen }),
    frame: onFrame,
    closed: (gen, ev) => dispatch({ t: 'closed', gen, code: ev.code, wasClean: ev.wasClean }),
  });

  // ---- publishing ----

  function sessionView(): SessionView {
    const s = model.state;
    const room = roomOf(model);
    const code = boundCode(model);
    return {
      s: s.s, intent: intentOf(model), code, myIndex: room?.myIndex ?? null, phase: room?.lastPhase ?? null,
      attempt: s.s === 'connecting' || s.s === 'requesting' || s.s === 'reconnecting' ? s.attempt : 0,
      nextAt: s.s === 'reconnecting' ? s.nextAt : null,
      offline: !model.online,
      suspended: s.s === 'reconnecting' && s.suspended,
      failure: s.s === 'failed' ? s.failure : null,
      cause: s.s === 'reconnecting' ? s.cause : null,
      roomKnown: room !== null,
      worldReady,
      stageRetained: boardCode !== null && boardCode === code,
      canReady: (s.s === 'lobby' || s.s === 'countdown') && transport.isOpen,
      gen: model.lastGen, epoch: model.epoch,
    };
  }

  function countdownView(prev: CountdownView | null): CountdownView | null {
    const s = model.state;
    if (s.s !== 'countdown' || s.seconds === null || s.endsAt === null) return null;
    if (prev !== null && prev.seconds === s.seconds && prev.endsAt === s.endsAt) return prev;
    return { seconds: s.seconds, endsAt: s.endsAt };
  }

  function lastLeftView(prev: AppState['lastLeft']): AppState['lastLeft'] {
    const left = model.lastLeft;
    if (left === null) return null;
    const canRejoin = identity.hasPrevious();
    if (prev !== null && prev.code === left.code && prev.at === left.at && prev.canRejoin === canRejoin) return prev;
    return { code: left.code, at: left.at, canRejoin };
  }

  /** publishNow, contained: a throwing store subscriber must not undo the step that is publishing. */
  function publish(): void {
    try {
      publishNow();
    } catch (err) {
      log.error('session publish failed', err);
    }
  }

  /** Builds every session-owned slice and patches only those that changed. */
  function publishNow(): void {
    if (disposed) return;
    if (model.state.s === 'idle') boardCode = null;
    const cur = store.get();
    const patch: Partial<AppState> = {};
    let dirty = false;
    const view = sessionView();
    if (!sameFields(cur.session, view)) {
      patch.session = view;
      dirty = true;
    }
    const countdown = countdownView(cur.countdown);
    if (countdown !== cur.countdown) {
      patch.countdown = countdown;
      dirty = true;
    }
    if (cur.notices !== notices) {
      patch.notices = notices;
      dirty = true;
    }
    if (cur.net.unstable !== model.unstable) {
      patch.net = { unstable: model.unstable };
      dirty = true;
    }
    const lastLeft = lastLeftView(cur.lastLeft);
    if (lastLeft !== cur.lastLeft) {
      patch.lastLeft = lastLeft;
      dirty = true;
    }
    if (model.state.s !== 'finished' && cur.results !== null) {
      patch.results = null;
      dirty = true;
    }
    if (dirty) store.patch(patch);
  }

  // ---- notices ----

  function addNotice(kind: NoticeKind): void {
    const ttl = T.session.noticeTtlMs;
    const id = nextNoticeId++;
    notices = [...notices, { id, kind, text: NOTICE_TEXT[kind], tone: NOTICE_TONE[kind], expiresAt: now() + ttl }];
    noticeTimers.set(id, host.setTimeout(() => {
      noticeTimers.delete(id);
      removeNotice(id);
    }, ttl));
  }

  function removeNotice(id: number): void {
    const next = notices.filter((n) => n.id !== id);
    if (next.length === notices.length) return;
    notices = next;
    publish();
  }

  // ---- API ----

  const api: SessionApi = {
    start: (intent) => dispatch({ t: 'start', intent }),
    leave: ({ explicit }) => dispatch({ t: 'leave', explicit }),
    retry: () => dispatch({ t: 'retry' }),
    joinAsNew: () => dispatch({ t: 'joinAsNew' }),

    rejoinPrevious(code: RoomCode): void {
      if (disposed) return;
      if (identity.restorePrevious()) {
        dispatch({ t: 'start', intent: { kind: 'join', code } });
        return;
      }
      addNotice('rejoin-failed');
      publish();
    },

    setReady(ready: boolean): boolean {
      const s = model.state;
      if ((s.s !== 'lobby' && s.s !== 'countdown') || !transport.isOpen) return false;
      return send(s.gen, encode.playerReady(ready), 'playerReady');
    },

    sendDirection(d): boolean {
      const s = model.state;
      if (s.s !== 'playing' || !transport.isOpen) return false;
      return send(s.gen, encode.direction(d), 'direction');
    },

    /** StrictMode-safe route binding. While bound to `code` (finished and failed included) nothing is
     *  dispatched, so a boundary reset never rejoins an ended room and a create or quick play that has just
     *  learned its code is not restarted by the URL sync. */
    bindRoute(code: RoomCode | null, key: string): () => void {
      const pending = deferredLeaves.get(key);
      if (pending !== undefined) {
        host.clearTimeout(pending);
        deferredLeaves.delete(key);
      }
      if (code !== null && !isBoundTo(model, code)) dispatch({ t: 'start', intent: { kind: 'join', code } });
      let unbound = false;
      return () => {
        if (unbound || disposed) return;
        unbound = true;
        const earlier = deferredLeaves.get(key);
        if (earlier !== undefined) host.clearTimeout(earlier);
        deferredLeaves.set(key, host.setTimeout(() => {
          deferredLeaves.delete(key);
          dispatch({ t: 'leave', explicit: false });
        }, 0));
      };
    },

    notifyEnv: (e) => dispatch(e),

    dismissNotice(id: number): void {
      const h = noticeTimers.get(id);
      if (h !== undefined) host.clearTimeout(h);
      noticeTimers.delete(id);
      removeNotice(id);
    },

    getModel: () => model,

    subscribe(cb: () => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    dispose(): void {
      if (disposed) return;
      timers.clearAll();
      for (const h of noticeTimers.values()) host.clearTimeout(h);
      noticeTimers.clear();
      for (const h of deferredLeaves.values()) host.clearTimeout(h);
      deferredLeaves.clear();
      for (const h of identityBounds) host.clearTimeout(h);
      identityBounds.clear();
      transport.setSink(NULL_SINK);
      transport.close(model.lastGen, 1000, 'dispose');
      disposed = true;
      queue.length = 0;
      listeners.clear();
    },
  };

  publish();
  return api;
}

function wire(msg: ClientMessage): string {
  switch (msg.messageType) {
    case 'createRoom':
      return encode.createRoom(msg.isPublic, msg.sessionId);
    case 'joinRoom':
      return encode.joinRoom(msg.code as RoomCode, msg.sessionId);
    case 'quickPlay':
      return encode.quickPlay(msg.sessionId);
    case 'playerReady':
      return encode.playerReady(msg.isReady);
    case 'direction':
      return encode.direction(msg.direction);
  }
}

function sameFields<V extends object>(a: V, b: V): boolean {
  for (const k of Object.keys(b) as Array<keyof V>) if (!Object.is(a[k], b[k])) return false;
  return true;
}

function pageOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}
