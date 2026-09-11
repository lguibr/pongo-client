// Dev-only fixture replay (replay.html, 3.8). A recorded fixture is played at its recorded timing through decode
// and a real createGameRuntime inside createFakeApp, and drawn by GameStage with noopFxFactory. The harness stands
// in for the session and lifecycle writers of this page's fake app. The overlay shows the derivation (event counts
// and the latest derived events), playout, render budget and graphics health, and offers speed, pause, tier,
// reduced motion, viewport presets and WEBGL_lose_context loss and restore.
//
// URL: replay.html?fixture=<name>&client=<A|B|C>&speed=<n>
//
// This is an entry module: it renders on load and exports nothing, so fast refresh does not apply to it.
/* eslint-disable react-refresh/only-export-components */

import { StrictMode, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { GameStage } from '../GameStage';
import { StageBoundary } from '../StageBoundary';
import { noopFxFactory } from '../contracts';
import type { StageMode } from '../contracts';
import { FIXTURES, FIXTURE_GAPS, loadFixture } from '../../test/fixtures/load';
import type { FixtureGap } from '../../test/fixtures/load';
import { createFakeApp } from '../../test/fakes/fakeApp';
import { createStore } from '../../lib/store';
import { useStore } from '../../lib/useStore';
import { initialAppState } from '../../state/appStore';
import type { AppState, SessionView } from '../../state/appStore';
import { createGameRuntime } from '../../game/runtime';
import { decode } from '../../net/decode';
import { stats } from '../../state/stats';
import type { GameEvent, Seat } from '../../game/events';
import type { ServerMessage } from '../../protocol/messages';
import type { RoomCode } from '../../session/types';
import type { App } from '../../app/types';
import type { QualityPref } from '../../lib/settings';

interface Inbound { t: number; msg: ServerMessage }
interface Derived { k: GameEvent['k']; tick: number; conf: number; detail: string }

const params = new URLSearchParams(location.search);
const fixtureNames = Object.keys(FIXTURES).sort();
const fixtureName = FIXTURES[params.get('fixture') ?? ''] !== undefined ? (params.get('fixture') as string) : 'quick-solo';
const allFrames = loadFixture(FIXTURES[fixtureName] ?? '');
const clients = [...new Set(allFrames.filter((f) => f.dir === 'in').map((f) => f.c))].sort();
const client = clients.includes(params.get('client') as 'A') ? (params.get('client') as 'A' | 'B' | 'C') : (clients[0] ?? 'A');
const startSpeed = Number(params.get('speed')) > 0 ? Number(params.get('speed')) : 1;

function inbound(): Inbound[] {
  const out: Inbound[] = [];
  for (const f of allFrames) {
    if (f.c !== client || f.dir !== 'in') continue;
    const d = decode(f.d);
    if (d.ok) out.push({ t: f.t, msg: d.msg });
  }
  return out;
}

function patchSession(app: App, p: Partial<SessionView>): void {
  app.store.patch({ session: { ...app.store.get().session, ...p } });
}

function describe(e: GameEvent): string {
  switch (e.k) {
    case 'paddleHit': return `ball ${e.ball} seat ${e.seat} u ${e.u.toFixed(2)}`;
    case 'wallBounce': return `ball ${e.ball} wall ${e.wall}${e.phasing ? ' phasing' : ''}`;
    case 'goal': return `ball ${e.ball} wall ${e.wall} scorer ${e.scorer}${e.repeat > 0 ? ` x${e.repeat + 1}` : ''}`;
    case 'absorbed': return `ball ${e.ball} wall ${e.wall}`;
    case 'brickDamaged': return `cell ${e.cell} ${e.from}->${e.to}`;
    case 'brickDestroyed': return `cell ${e.cell} scorer ${e.scorer} +${e.points ?? '?'}${e.chain >= 3 ? ` chain ${e.chain}` : ''}${e.last ? ' last' : ''}`;
    case 'ballSpawned': return `ball ${e.ball} ${e.cause}`;
    case 'ballRemoved': return `ball ${e.ball} ${e.cause}`;
    case 'powerUp': return `ball ${e.ball} ${e.kind}`;
    case 'ownerChanged': return `ball ${e.ball} ${e.from}->${e.to} ${e.cause}`;
    case 'score': return `seat ${e.seat} ${e.from ?? '?'}->${e.to} ${e.cause}`;
    case 'seat': return `seat ${e.seat} ${e.from}->${e.to}`;
    default: return '';
  }
}

/** Plays inbound frames at their recorded times, scaled by speed. A declared cut (FIXTURE_GAPS) is jumped over. */
class FixturePlayer {
  readonly frames: Inbound[];
  readonly counts = new Map<string, number>();
  readonly recent: Derived[] = [];
  private readonly app: App;
  private readonly gaps: readonly FixtureGap[];
  private i = 0;
  private base = 0;
  private offset = 0;
  private speedV = startSpeed;
  private timer = -1;
  private paused = false;
  private epoch = 0;
  private retained = false;

  constructor(app: App, frames: Inbound[], gaps: readonly FixtureGap[]) {
    this.app = app;
    this.frames = frames;
    this.gaps = gaps;
    app.game.onIngestEvents((events) => {
      for (const e of events) {
        this.counts.set(e.k, (this.counts.get(e.k) ?? 0) + 1);
        if (e.k === 'paddleHit' || e.k === 'wallBounce' || e.k === 'goal' || e.k === 'absorbed' || e.k.startsWith('brick')
          || e.k.startsWith('ball') || e.k === 'powerUp' || e.k === 'ownerChanged' || e.k === 'score' || e.k === 'seat') {
          this.recent.unshift({ k: e.k, tick: e.tick, conf: e.conf, detail: describe(e) });
          if (this.recent.length > 12) this.recent.pop();
        }
      }
    });
  }

  get position(): number {
    return this.timeline(performance.now());
  }

  get total(): number {
    return this.frames.length > 0 ? this.frames[this.frames.length - 1].t : 0;
  }

  get speed(): number {
    return this.speedV;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isRetained(): boolean {
    return this.retained;
  }

  start(): void {
    this.base = performance.now();
    this.offset = this.frames.length > 0 ? this.frames[0].t : 0;
    this.schedule();
  }

  setSpeed(s: number): void {
    const t = this.timeline(performance.now());
    this.speedV = s;
    this.base = performance.now();
    this.offset = t;
    this.reschedule();
  }

  togglePause(): void {
    if (this.paused) {
      this.paused = false;
      this.base = performance.now();
      this.schedule();
    } else {
      this.offset = this.timeline(performance.now());
      this.paused = true;
      clearTimeout(this.timer);
    }
  }

  private timeline(nowMs: number): number {
    return this.paused ? this.offset : (nowMs - this.base) * this.speedV + this.offset;
  }

  private reschedule(): void {
    clearTimeout(this.timer);
    this.schedule();
  }

  private schedule(): void {
    if (this.paused || this.i >= this.frames.length) return;
    const wait = (this.frames[this.i].t - this.timeline(performance.now())) / this.speedV;
    this.timer = window.setTimeout(this.pump, Math.max(0, wait));
  }

  private readonly pump = (): void => {
    const nowMs = performance.now();
    while (this.i < this.frames.length && this.frames[this.i].t <= this.timeline(nowMs)) {
      const prev = this.frames[this.i];
      this.deliver(prev.msg, nowMs);
      this.i++;
      if (this.i < this.frames.length) {
        const next = this.frames[this.i].t;
        const cut = this.gaps.find((g) => prev.t <= g.from + 1 && next >= g.to - 1);
        if (cut !== undefined) this.offset += next - 25 - this.timeline(nowMs);
      }
    }
    this.schedule();
  };

  private deliver(msg: ServerMessage, at: number): void {
    const app = this.app;
    const game = app.game;
    switch (msg.messageType) {
      case 'roomCreated':
        patchSession(app, { code: msg.code as RoomCode, roomKnown: true });
        return;
      case 'roomJoined':
        if (msg.success) patchSession(app, { code: msg.code as RoomCode, roomKnown: true, phase: msg.phase === '' ? null : msg.phase });
        return;
      case 'playerAssignment': {
        this.epoch++;
        const me = msg.playerIndex as Seat;
        game.reset(this.epoch, me);
        patchSession(app, {
          s: msg.phase === 'lobby' ? 'lobby' : msg.phase === 'countingDown' ? 'countdown' : 'playing',
          myIndex: me, phase: msg.phase, epoch: this.epoch, worldReady: false, stageRetained: this.retained,
        });
        return;
      }
      case 'initialPlayersAndBallsState':
      case 'gameUpdates': {
        const res = game.ingest(msg, at);
        if (res.boardReady) {
          this.retained = true;
          patchSession(app, { worldReady: true, stageRetained: true });
        }
        for (const c of res.controls) {
          if (c.k === 'countdown') {
            patchSession(app, { s: 'countdown' });
            app.store.patch({ countdown: { seconds: c.seconds, endsAt: at + c.seconds * 1000 } });
          } else if (c.k === 'started') {
            patchSession(app, { s: 'playing' });
            app.store.patch({ countdown: null });
          } else {
            patchSession(app, { s: 'lobby' });
            app.store.patch({ countdown: null });
          }
        }
        return;
      }
      case 'gameOver': {
        const results = game.results(msg, msg.reason);
        app.store.patch({ results });
        game.ended(results.winner, false);
        patchSession(app, { s: 'finished' });
        return;
      }
    }
  }
}

function stageModeOf(s: SessionView): StageMode | 'none' {
  if (s.s === 'lobby' || s.s === 'countdown' || s.s === 'playing') {
    if (!s.worldReady) return s.stageRetained ? 'frozen' : 'none';
    return s.s === 'lobby' ? 'lobby' : 'live';
  }
  if (s.s === 'finished') return s.worldReady ? 'ended' : 'none';
  return 'none';
}

// One extension per canvas: a remount (new stage key) brings a new canvas and context, and a lost context returns
// null from getExtension, so Restore must use the extension taken from that canvas before the loss.
const loseExts = new WeakMap<HTMLCanvasElement, WEBGL_lose_context>();
function contextControl(lose: boolean): void {
  const canvas = document.querySelector('canvas');
  if (canvas === null) return;
  let ext = loseExts.get(canvas);
  if (ext === undefined) {
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const found = gl?.getExtension('WEBGL_lose_context') ?? null;
    if (found === null) return;
    ext = found;
    loseExts.set(canvas, ext);
  }
  if (lose) ext.loseContext();
  else ext.restoreContext();
}

const VIEWPORTS: readonly { label: string; w: number; h: number }[] = [
  { label: 'fill', w: 0, h: 0 }, { label: '320x568', w: 320, h: 568 }, { label: '390x844', w: 390, h: 844 },
  { label: '844x390', w: 844, h: 390 }, { label: '1440x900', w: 1440, h: 900 },
];

const selectSession = (s: AppState): SessionView => s.session;
const selectGfx = (s: AppState): AppState['gfx'] => s.gfx;

function Stage({ app, viewport }: { app: App; viewport: { w: number; h: number } }): JSX.Element {
  const session = useStore(app.store, selectSession);
  const gfx = useStore(app.store, selectGfx);
  const mode = stageModeOf(session);
  const box: CSSProperties = viewport.w > 0
    ? { width: viewport.w, height: viewport.h, margin: '0 auto', outline: '1px solid #3f3f46' }
    : { width: '100%', height: '100%' };
  return (
    <div style={box}>
      {mode !== 'none' && (
        <StageBoundary resetKey={gfx.stageKey} fallback={<div style={{ padding: 24 }}>Graphics stopped responding</div>}>
          <GameStage app={app} fxFactory={noopFxFactory} mode={mode} />
        </StageBoundary>
      )}
    </div>
  );
}

const PANEL: CSSProperties = {
  position: 'fixed', top: 8, left: 8, maxWidth: 360, maxHeight: 'calc(100% - 16px)', overflow: 'auto', padding: 10,
  background: 'rgba(9, 9, 11, 0.82)', border: '1px solid #3f3f46', borderRadius: 6,
  font: '12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace', color: '#e4e4e7',
};
const ROW: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4, margin: '6px 0' };

function Overlay({ app, player, viewport, setViewport }: { app: App; player: FixturePlayer; viewport: { w: number; h: number }; setViewport: (v: { w: number; h: number }) => void }): JSX.Element {
  const [, setTick] = useState(0);
  useEffect(() => {
    const handle = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(handle);
  }, []);
  const s = app.store.get();
  const r = stats.render;
  const ps = app.game.playoutStats;
  const kinds = [...player.counts.entries()].sort((a, b) => b[1] - a[1]);
  return (
    <div style={PANEL}>
      <div>
        <select value={fixtureName} onChange={(e) => { location.search = `?fixture=${encodeURIComponent(e.target.value)}`; }}>
          {fixtureNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>{' '}
        {clients.length > 1 && (
          <select value={client} onChange={(e) => { location.search = `?fixture=${encodeURIComponent(fixtureName)}&client=${e.target.value}`; }}>
            {clients.map((c) => <option key={c} value={c}>client {c}</option>)}
          </select>
        )}
      </div>
      <div>t {(player.position / 1000).toFixed(1)} / {(player.total / 1000).toFixed(1)} s, x{player.speed}{player.isPaused ? ' (paused)' : ''}</div>
      <div style={ROW}>
        <button type="button" onClick={() => player.togglePause()}>{player.isPaused ? 'Play' : 'Pause'}</button>
        {[0.5, 1, 2, 4].map((v) => <button key={v} type="button" onClick={() => player.setSpeed(v)}>x{v}</button>)}
        <button type="button" onClick={() => location.reload()}>Restart</button>
      </div>
      <div>session {s.session.s}, mode {stageModeOf(s.session)}, epoch {s.session.epoch}, seat {s.session.myIndex ?? '-'}</div>
      <div>playout delay {ps.delayMs.toFixed(1)} ms, jitter {ps.jitterMs.toFixed(1)}, snaps {ps.snaps}{ps.extrapolating ? ', extrapolating' : ''}</div>
      <div>events pushed {stats.events.pushed}, released {stats.events.released}, stale {stats.events.stale}</div>
      <div>scene draws {r.calls}, post draws {r.postCalls}, triangles {r.triangles}, programs {r.programs}</div>
      <div>fps {r.fps.toFixed(0)}, systems p95 {r.frameMsP95.toFixed(2)} ms, tier {r.tier || s.gfx.tier}</div>
      <div>gfx {s.gfx.health}, stage key {s.gfx.stageKey}</div>
      <div style={ROW}>
        {(['auto', 'high', 'medium', 'low'] as const).map((q: QualityPref) => (
          <button key={q} type="button" aria-pressed={app.settings.get().quality === q} onClick={() => app.settings.update({ quality: q })}>{q}</button>
        ))}
        <label>
          <input type="checkbox" checked={s.motion.reduced} onChange={(e) => app.store.patch({ motion: { reduced: e.target.checked } })} /> reduced motion
        </label>
      </div>
      <div style={ROW}>
        {VIEWPORTS.map((v) => (
          <button key={v.label} type="button" aria-pressed={viewport.w === v.w && viewport.h === v.h} onClick={() => setViewport({ w: v.w, h: v.h })}>{v.label}</button>
        ))}
      </div>
      <div style={ROW}>
        <button type="button" onClick={() => contextControl(true)}>Lose context</button>
        <button type="button" onClick={() => contextControl(false)}>Restore context</button>
      </div>
      <div style={{ marginTop: 6 }}>{kinds.map(([k, n]) => `${k} ${n}`).join(' · ')}</div>
      <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        {player.recent.map((d, i) => (
          <li key={i}>t{d.tick} {d.k} {d.detail} (conf {d.conf.toFixed(2)})</li>
        ))}
      </ol>
    </div>
  );
}

function Page({ app, player }: { app: App; player: FixturePlayer }): JSX.Element {
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  return (
    <>
      <Stage app={app} viewport={viewport} />
      <StrictMode>
        <Overlay app={app} player={player} viewport={viewport} setViewport={setViewport} />
      </StrictMode>
    </>
  );
}

function main(): void {
  const store = createStore(initialAppState());
  const game = createGameRuntime({ store });
  const app = createFakeApp({ store, game });
  const player = new FixturePlayer(app, inbound(), FIXTURE_GAPS[fixtureName] ?? []);
  document.addEventListener('visibilitychange', () => {
    const visible = document.visibilityState === 'visible';
    store.patch({ page: { ...store.get().page, visible } });
    game.setHeadless(!visible);
  });
  const root = document.getElementById('root');
  if (root === null) throw new Error('replay.html has no #root');
  createRoot(root).render(<Page app={app} player={player} />);
  player.start();
}

main();
