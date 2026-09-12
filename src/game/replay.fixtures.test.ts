// Fixture replays (14.2): every recorded fixture replayed with its recorded arrival times through decode,
// createGameRuntime and frame() at a simulated 60 Hz, plus 10 minutes of synthetic play scored against the oracle.
// Fixtures come from FIXTURES (never fs); declared gaps (FIXTURE_GAPS) re-anchor the frame clock.

import { describe, expect, it } from 'vitest';
import { FIXTURES, FIXTURE_GAPS, loadFixture } from '../test/fixtures/load';
import type { FixtureFrame, FixtureGap } from '../test/fixtures/load';
import { decode } from '../net/decode';
import { createGameRuntime } from './runtime';
import type { GameRuntime } from './types';
import { PADDLE_STRIDE, PO } from './types';
import { createBatchPlan, segmentBatch } from './segment';
import type { BatchPlan } from './segment';
import { rMax } from './radius';
import type { EventOf, GameEvent, Seat } from './events';
import { SeatConn } from './events';
import { createStore } from '../lib/store';
import { initialAppState } from '../state/appStore';
import type { ResultsView } from '../state/appStore';
import { FakeClock } from '../test/fakes/FakeClock';
import type { BatchItem, GameOver, GameUpdates, InitialState, ServerMessage } from '../protocol/messages';
import { synthSession, batch } from './testing/synth';
import type { OracleTruth } from './testing/oracle';
import { ServerSim } from './testing/oracle';
import { CANVAS, MASS_R_STEP, RADIUS_K } from '../config/constants';
import { TUNING } from '../config/tuning';

const FRAME = 1000 / 60;
const REQUIRED = ['quick-solo', 'lobby-2p', 'grace', 'late-join', 'rejections', 'game-over'];
/** After a cut in a recording, derived events are not expected for this long (FIXTURE_GAPS). */
const TRUST_AFTER_GAP_MS = 3000;
type Client = FixtureFrame['c'];

const distanceToWall = (w: number, x: number, y: number): number => (w === 0 ? CANVAS - x : w === 1 ? y : w === 2 ? x : CANVAS - y);

/** Earliest arrival time of every ball id in a stream (initial state, spawn or position update). */
function firstSeenTimes(stream: { t: number; msg: ServerMessage }[]): Map<number, number> {
  const seen = new Map<number, number>();
  const note = (id: number, t: number): void => {
    if (!seen.has(id)) seen.set(id, t);
  };
  for (const { t, msg } of stream) {
    if (msg.messageType === 'initialPlayersAndBallsState') for (const b of msg.balls) note(b.id, t);
    if (msg.messageType !== 'gameUpdates') continue;
    for (const u of msg.updates) {
      if (u.messageType === 'ballSpawned') note(u.ball.id, t);
      if (u.messageType === 'ballPositionUpdate') note(u.id, t);
    }
  }
  return seen;
}

/** A goal with ball -1 that a trimmed recording cannot verify. Take the ball nearest the conceder's wall at the
 *  goal tick, among those some lattice radius (r0 + 4 * (RADIUS_K - 1), plus the goal slack) could reach. That
 *  ball was already live before a declared cut (FIXTURE_GAPS), and it sits farther from the wall than the
 *  client's rMax plus the slack. The server grows a ball 4 px per mass pickup (ball.go:196-202). When those
 *  pickups fall inside the cut, the client never sees the destroys that add the candidates. 5.4.6 then ignores
 *  every later wall sample as inconsistent, so the set cannot recover from the recording. rMax is read just
 *  after the batch that derived the goal. Positions come from the recorded frame at the goal tick. */
function grownInsideGap(
  rt: GameRuntime, msg: GameUpdates, t: number, tickBefore: number, e: EventOf<'goal'>,
  gaps: readonly FixtureGap[], firstSeen: Map<number, number>, plan: BatchPlan,
): boolean {
  const before = gaps.filter((g) => g.to <= t);
  if (before.length === 0) return false;
  const cutFrom = Math.max(...before.map((g) => g.from));
  segmentBatch(msg.updates, plan);
  const j = e.tick - tickBefore - 1;   // frame j of a batch closes tick w.tick + 1 + j
  if (j < 0 || j >= plan.frameCount) return false;
  const slack = TUNING.derive.goalOverlapSlackPx;
  let nearest = -1;
  let nearestD = Infinity;
  for (const b of plan.frames[j].balls) {
    const slot = rt.slotOf(b.id);
    if (slot < 0) continue;
    const d = distanceToWall(e.wall, b.x, b.y);
    if (d > rt.world.balls[slot].r0 + MASS_R_STEP * (RADIUS_K - 1) + slack) continue;
    if (d < nearestD) {
      nearestD = d;
      nearest = b.id;
    }
  }
  if (nearest < 0) return false;
  const seenAt = firstSeen.get(nearest);
  if (seenAt === undefined || seenAt > cutFrom) return false;
  return nearestD > rMax(rt.world.balls[rt.slotOf(nearest)]) + slack;
}

interface GoalTally { goals: number; unmatched: number; exempt: number; negatives: number }

/** Replays every client of a fixture and counts trusted goals, goals with ball -1, and the ones of those that
 *  grownInsideGap exempts. It also checks the results table against gameOver. */
function goalTally(name: string): GoalTally {
  const tally: GoalTally = { goals: 0, unmatched: 0, exempt: 0, negatives: 0 };
  const gaps = FIXTURE_GAPS[name] ?? [];
  const plan = createBatchPlan();
  for (const client of clientsOf(name)) {
    const stream = inbound(name, client);
    const firstSeen = firstSeenTimes(stream);
    const exempted = new Set<GameEvent>();
    const r = replay(stream, gaps, {
      afterIngest: (rt, msg, t, tickBefore, fresh) => {
        for (const e of fresh) {
          if (e.k === 'goal' && e.ball === -1 && grownInsideGap(rt, msg, t, tickBefore, e, gaps, firstSeen, plan)) exempted.add(e);
        }
      },
    });
    const trusted = (e: GameEvent): boolean => e.tick >= r.trustedFromTick;
    const g = kinds(r.events, 'goal').filter(trusted);
    tally.goals += g.length;
    tally.unmatched += g.filter((e) => e.ball === -1).length;
    tally.exempt += g.filter((e) => exempted.has(e)).length;
    tally.negatives += kinds(r.events, 'score').filter(trusted).filter((e) => e.from !== null && e.delta < 0).length;
    expect(r.rt.world.tick).toBeGreaterThanOrEqual(0);
    if (r.gameOver !== null && r.results !== null) {
      expect(r.results.winner).toBe(r.gameOver.winnerIndex);
      for (const row of r.results.rows) {
        expect(row.score).toBe(r.gameOver.finalScores[row.index]);
        expect([SeatConn.Connected, SeatConn.Grace]).toContain(r.rt.world.seats[row.index].conn);
      }
    }
  }
  return tally;
}

function inbound(name: string, client: Client): { t: number; msg: ServerMessage }[] {
  const out: { t: number; msg: ServerMessage }[] = [];
  for (const f of loadFixture(FIXTURES[name])) {
    if (f.c !== client || f.dir !== 'in') continue;
    const d = decode(f.d);
    if (!d.ok) throw new Error(`${name} ${client} t=${f.t}: ${d.detail}`);
    out.push({ t: f.t, msg: d.msg });
  }
  return out;
}

function clientsOf(name: string): Client[] {
  const set = new Set<Client>();
  for (const f of loadFixture(FIXTURES[name])) if (f.dir === 'in') set.add(f.c);
  return [...set].sort();
}

interface ReplayHooks {
  /** Index at which to cut a batch in two before ingesting it (-1: do not cut). */
  split?: (msg: GameUpdates) => number;
  afterFirstPart?: (rt: GameRuntime, msg: GameUpdates) => void;
  onFrame?: (rt: GameRuntime) => void;
  /** After a whole gameUpdates batch: the world tick before it, and the events its ingest emitted. */
  afterIngest?: (rt: GameRuntime, msg: GameUpdates, t: number, tickBefore: number, fresh: readonly GameEvent[]) => void;
}
interface Replay {
  rt: GameRuntime; events: GameEvent[]; gameOver: GameOver | null; results: ResultsView | null;
  /** First tick whose events can be trusted: after a declared gap the world is re-anchored and needs a moment. */
  trustedFromTick: number; frames: number;
}

/** Replays one client's inbound stream at 60 Hz simulated frames, as the session runtime would route it. */
function replay(stream: { t: number; msg: ServerMessage }[], gaps: readonly { from: number; to: number }[], hooks: ReplayHooks = {}): Replay {
  const clock = new FakeClock(0);
  const store = createStore(initialAppState());
  const rt = createGameRuntime({ store, now: clock.now, timers: clock });
  const events: GameEvent[] = [];
  rt.onIngestEvents((es) => {
    events.push(...es);
  });
  let epoch = 0;
  let frameAt = -Infinity;
  let gameOver: GameOver | null = null;
  let results: ResultsView | null = null;
  let trustedFromTick = 0;
  let frames = 0;
  let trustAt = -Infinity;
  const fire = (): void => {};
  for (const { t, msg } of stream) {
    if (frameAt === -Infinity) frameAt = t;
    if (gaps.some((g) => frameAt <= g.from && t >= g.to)) {
      frameAt = t;   // re-anchor: no frames through a cut in the recording
      trustAt = t + TRUST_AFTER_GAP_MS;
    }
    while (frameAt + FRAME <= t) {
      frameAt += FRAME;
      clock.setTime(frameAt);
      rt.frame(FRAME, frameAt, fire);
      frames++;
      hooks.onFrame?.(rt);
    }
    clock.setTime(Math.max(clock.now(), t));
    switch (msg.messageType) {
      case 'playerAssignment':
        rt.reset(++epoch, msg.playerIndex as Seat);
        break;
      case 'initialPlayersAndBallsState':
        if (epoch > 0) rt.ingest(msg, t);
        break;
      case 'gameUpdates': {
        if (epoch === 0) break;
        if (trustAt > -Infinity && t >= trustAt) {
          trustedFromTick = rt.world.tick + 1;   // events before this settle the re-anchored world
          trustAt = -Infinity;
        } else if (trustAt > -Infinity) {
          trustedFromTick = Number.MAX_SAFE_INTEGER;
        }
        const tickBefore = rt.world.tick;
        const seen = events.length;
        const cut = hooks.split?.(msg) ?? -1;
        if (cut >= 0) {
          if (cut > 0) rt.ingest({ messageType: 'gameUpdates', updates: msg.updates.slice(0, cut) }, t);
          hooks.afterFirstPart?.(rt, msg);
          rt.ingest({ messageType: 'gameUpdates', updates: msg.updates.slice(cut) }, t);
        } else {
          rt.ingest(msg, t);
        }
        hooks.afterIngest?.(rt, msg, t, tickBefore, events.slice(seen));
        break;
      }
      case 'gameOver':
        gameOver = msg;
        results = rt.results(msg, msg.reason);
        rt.ended(results.winner, false);
        break;
      default:
        break;
    }
  }
  return { rt, events, gameOver, results, trustedFromTick, frames };
}

const kinds = <K extends GameEvent['k']>(events: GameEvent[], k: K): EventOf<K>[] => events.filter((e): e is EventOf<K> => e.k === k);

describe('fixture replays (14.2)', () => {
  it('has every required fixture', () => {
    for (const name of REQUIRED) expect(Object.keys(FIXTURES)).toContain(name);
  });

  describe.each(REQUIRED)('%s', (name) => {
    it('keeps the 5.1 segmentation invariants and paddle-hit consistency', () => {
      const plan = createBatchPlan();
      const dist = [0, 0, 0, 0];
      let hits = 0;
      let hitsWithVelocityChange = 0;
      for (const client of clientsOf(name)) {
        let paddleSet: string | null = null;
        let membershipMoved = true;
        const lastV = new Map<number, [number, number]>();
        const gaps = FIXTURE_GAPS[name] ?? [];
        let lastT = -Infinity;
        for (const { t, msg } of inbound(name, client)) {
          if (gaps.some((g) => lastT <= g.from && t >= g.to)) {
            lastV.clear();
            membershipMoved = true;
          }
          lastT = t;
          if (msg.messageType === 'playerAssignment') {
            paddleSet = null;
            membershipMoved = true;
            lastV.clear();
          } else if (msg.messageType === 'initialPlayersAndBallsState') {
            paddleSet = msg.paddles.map((p) => p.index).sort().join(',');
            membershipMoved = false;
            for (const b of msg.balls) lastV.set(b.id, [b.vx, b.vy]);
          } else if (msg.messageType === 'gameUpdates') {
            const ups = msg.updates;
            const gridAt = ups.findIndex((u) => u.messageType === 'fullGridUpdate');
            if (gridAt >= 0) expect(gridAt, `${name} ${client}: the grid is the last item`).toBe(ups.length - 1);
            segmentBatch(ups, plan);
            expect(plan.frameCount).toBeLessThanOrEqual(3);
            dist[plan.frameCount]++;
            for (let j = 0; j < plan.frameCount; j++) {
              const f = plan.frames[j];
              const owners: number[] = [];
              for (const u of f.pre) {
                if (u.messageType === 'playerJoined' || u.messageType === 'playerLeft') membershipMoved = true;
                if (u.messageType === 'ballOwnerChanged' && u.newOwnerIndex >= 0) owners.push(u.id);
                if (u.messageType === 'ballSpawned') lastV.set(u.ball.id, [u.ball.vx, u.ball.vy]);
              }
              const idx = f.paddles.map((p) => p.index);
              for (let i = 1; i < idx.length; i++) expect(idx[i], `${name} ${client}: paddles ascending`).toBeGreaterThan(idx[i - 1]);
              const ids = f.balls.map((b) => b.id);
              expect(new Set(ids).size, `${name} ${client}: each ball once per frame`).toBe(ids.length);
              const set = idx.join(',');
              if (!membershipMoved && paddleSet !== null) expect(set, `${name} ${client}: every present paddle in every frame`).toBe(paddleSet);
              paddleSet = set;
              membershipMoved = false;
              for (const id of owners) {
                const b = f.balls.find((x) => x.id === id);
                const prev = lastV.get(id);
                if (b === undefined || prev === undefined) continue;
                hits++;
                if (b.vx !== prev[0] || b.vy !== prev[1]) hitsWithVelocityChange++;
              }
              for (const b of f.balls) lastV.set(b.id, [b.vx, b.vy]);
            }
            for (const u of plan.tail) {
              expect(u.messageType, `${name} ${client}: scores only in a frame's pre`).not.toBe('scoreUpdate');
              if (u.messageType === 'ballOwnerChanged') expect(u.newOwnerIndex, `${name} ${client}: paddle owners only in pre`).toBe(-1);
              if (u.messageType === 'playerJoined' || u.messageType === 'playerLeft') membershipMoved = true;
            }
          }
        }
      }
      const batches = dist.reduce((a, b) => a + b, 0);
      console.info(`[replay] ${name}: frames per batch 0:${dist[0]} 1:${dist[1]} 2:${dist[2]} 3:${dist[3]} (2-frame share ${(dist[2] / Math.max(1, batches) * 100).toFixed(1)} %); paddle hits with a velocity change ${hitsWithVelocityChange}/${hits}`);
      expect(batches).toBeGreaterThan(0);
      expect(hitsWithVelocityChange).toBe(hits);
    });

    // Goal consistency. In game-over the recording cuts the whole middle of the match (FIXTURE_GAPS). Its goals
    // come from a ball whose mass pickups fall inside the cut, so the check cannot be verified from that recording:
    // grownInsideGap exempts them. The untrimmed fixtures carry the gate (the aggregate case below).
    it('replays through the runtime with at most 2 % of goals lacking an overlapping ball (growth cut from a trimmed recording apart)', () => {
      const { goals, unmatched, exempt, negatives } = goalTally(name);
      expect(goals).toBe(negatives);   // one goal per conceded point
      console.info(`[replay] ${name}: goals ${goals}, without an overlapping ball ${unmatched}, of which growth inside a recording cut explains ${exempt}`);
      if ((FIXTURE_GAPS[name] ?? []).length === 0) expect(exempt).toBe(0);
      expect(unmatched - exempt).toBeLessThanOrEqual(Math.floor(goals * 0.02));
    }, 60_000);
  });

  it('keeps the goal gate meaningful: the untrimmed fixtures carry real goals, and at most 2 % lack an overlapping ball', () => {
    let goals = 0;
    let unmatched = 0;
    for (const name of REQUIRED.filter((n) => (FIXTURE_GAPS[n] ?? []).length === 0)) {
      const t = goalTally(name);
      goals += t.goals;
      unmatched += t.unmatched;
    }
    expect(goals).toBeGreaterThanOrEqual(40);
    expect(unmatched).toBeLessThanOrEqual(Math.floor(goals * 0.02));
  }, 60_000);

  it('late-join: each ball radius in B initial state lies in A radius set at the same tick', () => {
    const b = inbound('late-join', 'B');
    const assignB = b.find((x) => x.msg.messageType === 'playerAssignment')?.msg as { playerIndex: number };
    const initB = b.find((x) => x.msg.messageType === 'initialPlayersAndBallsState')?.msg as InitialState;
    expect(initB.balls.length).toBeGreaterThan(0);
    const joinAt = (msg: GameUpdates): number => msg.updates.findIndex((u) => u.messageType === 'playerJoined' && u.player.index === assignB.playerIndex);
    let checked = 0;
    replay(inbound('late-join', 'A'), [], {
      split: joinAt,
      afterFirstPart: (rt) => {
        // B's snapshot and A's view of it are the same tick: the positions agree exactly.
        for (const ball of initB.balls) {
          const slot = rt.slotOf(ball.id);
          expect(slot).toBeGreaterThanOrEqual(0);
          const s = rt.world.balls[slot];
          expect([s.x, s.y]).toEqual([ball.x, ball.y]);
          const candidates: number[] = [];
          for (let k = 0; k < RADIUS_K; k++) if ((s.radiusSet & (1 << k)) !== 0) candidates.push(s.r0 + MASS_R_STEP * k);
          expect(candidates).toContain(ball.radius);
          if (candidates.length === 1) expect(s.radius).toBe(ball.radius);
          checked++;
        }
      },
    });
    expect(checked).toBe(initB.balls.length);
  });

  it('grace: two playerLeft messages move the seat Connected -> Grace -> Empty, and the paddle renders while Grace', () => {
    const b = inbound('grace', 'B');
    const seat = (b.find((x) => x.msg.messageType === 'playerAssignment')?.msg as { playerIndex: number }).playerIndex as Seat;
    let graceFrames = 0;
    let graceFramesWithPaddle = 0;
    const r = replay(inbound('grace', 'A'), [], {
      onFrame: (rt) => {
        if (rt.world.seats[seat].conn !== SeatConn.Grace) return;
        graceFrames++;
        if (rt.render.paddle[seat * PADDLE_STRIDE + PO.PRESENT] === 1) graceFramesWithPaddle++;
      },
    });
    const transitions = kinds(r.events, 'seat').filter((e) => e.seat === seat).map((e) => `${e.from}->${e.to}`);
    const seq = transitions.join(' ');
    expect(seq).toContain(`${SeatConn.Connected}->${SeatConn.Grace} ${SeatConn.Grace}->${SeatConn.Empty}`);
    expect(r.rt.world.seats[seat].conn).toBe(SeatConn.Empty);
    expect(graceFrames).toBeGreaterThan(60 * 25);   // about 30 s of grace
    expect(graceFramesWithPaddle).toBe(graceFrames);
  }, 60_000);
});

/** Replays synthetic frames and scores wall and paddle classification against the oracle's truth. */
function accuracy(seed: number, seats: Seat[], seconds: number): { truth: number; derived: number; matched: number; byKind: Record<string, [number, number]> } {
  const { frames, truth } = synthSession({ seed, seats, bricks: true, seconds, tickJitterMs: 4 });
  const stream = frames.filter((f) => f.dir === 'in').map((f) => {
    const d = decode(f.d);
    if (!d.ok) throw new Error(d.detail);
    return { t: f.t, msg: d.msg };
  });
  const r = replay(stream, []);
  const keyOfTruth = (x: OracleTruth): string => `${x.tick}:${x.ball}:${x.kind}:${x.kind === 'paddle' ? x.seat : x.wall}`;
  const truthKeys = new Map<string, string>();
  for (const x of truth) if (x.kind !== 'brick') truthKeys.set(keyOfTruth(x), x.kind);
  const derivedKeys = new Map<string, string>();
  for (const e of r.events) {
    if (e.k === 'paddleHit') derivedKeys.set(`${e.tick}:${e.ball}:paddle:${e.seat}`, 'paddle');
    else if (e.k === 'wallBounce') derivedKeys.set(`${e.tick}:${e.ball}:wallBounce:${e.wall}`, 'wallBounce');
    else if (e.k === 'goal') derivedKeys.set(`${e.tick}:${e.ball}:goal:${e.wall}`, 'goal');
    else if (e.k === 'absorbed') derivedKeys.set(`${e.tick}:${e.ball}:absorbed:${e.wall}`, 'absorbed');
  }
  let matched = 0;
  const byKind: Record<string, [number, number]> = {};
  for (const [k, kind] of truthKeys) {
    byKind[kind] ??= [0, 0];
    byKind[kind][1]++;
    if (derivedKeys.has(k)) {
      matched++;
      byKind[kind][0]++;
    }
  }
  return { truth: truthKeys.size, derived: derivedKeys.size, matched, byKind };
}

describe('derivation accuracy against the oracle (14.2)', () => {
  it('classifies wall and paddle events at >= 98 % over 10 minutes of synthetic play', () => {
    const runs = [accuracy(2024, [0, 3], 300), accuracy(77, [1, 2, 3], 300)];
    let truth = 0;
    let derived = 0;
    let matched = 0;
    for (const a of runs) {
      truth += a.truth;
      derived += a.derived;
      matched += a.matched;
      console.info(`[accuracy] ${JSON.stringify(a.byKind)} derived ${a.derived}`);
    }
    const recall = matched / truth;
    const precision = matched / derived;
    console.info(`[accuracy] truth ${truth}, derived ${derived}, recall ${(recall * 100).toFixed(2)} %, precision ${(precision * 100).toFixed(2)} %`);
    expect(truth).toBeGreaterThan(500);
    for (const a of runs) for (const kind of ['paddle', 'wallBounce', 'goal', 'absorbed']) expect(a.byKind[kind]?.[1] ?? 0, kind).toBeGreaterThan(0);
    expect(recall).toBeGreaterThanOrEqual(0.98);
    expect(precision).toBeGreaterThanOrEqual(0.98);
  }, 180_000);

  it('keeps the true radius in every candidate set through mass power-ups (synthetic late joins)', () => {
    const sim = new ServerSim({ seed: 5150, seats: [0, 2, 3], bricks: true }, { ai: true });
    const store = createStore(initialAppState());
    const clock = new FakeClock(0);
    const rt = createGameRuntime({ store, now: clock.now, timers: clock });
    rt.reset(1, 0);
    rt.ingest(sim.initialState(), clock.now());
    sim.gridDirty = false;
    rt.ingest(batch(sim.grid()), clock.now());
    let checks = 0;
    let grown = 0;
    let resolvedGrown = 0;
    for (let k = 1; k <= 40 * 240; k++) {
      const items: BatchItem[] = [...sim.step().items];
      if (sim.gridDirty) {
        items.push(sim.grid());
        sim.gridDirty = false;
      }
      clock.advance(25);
      rt.ingest(batch(...items), clock.now());
      if (k % 40 !== 0) continue;
      // A late joiner's snapshot now would carry these radii.
      for (const b of sim.initialState().balls) {
        const slot = rt.slotOf(b.id);
        expect(slot).toBeGreaterThanOrEqual(0);
        const s = rt.world.balls[slot];
        const candidates: number[] = [];
        for (let i = 0; i < RADIUS_K; i++) if ((s.radiusSet & (1 << i)) !== 0) candidates.push(s.r0 + MASS_R_STEP * i);
        checks++;
        if (b.radius > s.r0) grown++;
        expect(candidates, `ball ${b.id} at tick ${k}`).toContain(b.radius);
        if (candidates.length === 1 && b.radius > s.r0) resolvedGrown++;
        if (candidates.length === 1) expect(s.radius).toBe(b.radius);
      }
    }
    console.info(`[radius] checks ${checks}, grown ${grown}, grown and resolved ${resolvedGrown}`);
    expect(grown).toBeGreaterThan(0);
    expect(resolvedGrown).toBeGreaterThan(0);
  }, 120_000);
});
