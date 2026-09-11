// Property tests for the session machine (5.5.1, 14.1). Seeded random input sequences run through the pure
// transition with a fake timer model: every state must keep an exit, clears must precede sets, generations
// must increase, and a room-bound recovery must end within its online budget.

import { describe, expect, it } from 'vitest';
import { initialModel, roomOf, transition } from './machine';
import { POLICY } from './policy';
import { seeded } from '../lib/random';
import type { Rand } from '../lib/random';
import type { ControlEvent, Intent, MachineEnv, Model, RoomCode, SessionEffect, SessionInput, TimerName, WorldSummary } from './types';
import type { RoomPhase } from '../protocol/messages';

const P = POLICY;
const CODES = ['ABC123', 'DEF456'] as RoomCode[];
const PHASES: RoomPhase[] = ['lobby', 'countingDown', 'playing'];
const REASONS = [
  'Room not found', 'Room is closing', 'Room closed during admission', 'Room is full', 'Server is full',
  'Session admission is pending', 'Session already connected', 'Server is stopping', 'Room is unavailable',
  'Invalid connection', 'Connection closed', 'Admission failed', 'Something unexpected',
];

interface Sim {
  m: Model;
  now: number;
  timers: Map<TimerName, number>; // name -> due time
  lastFrameAt: number;
  world: WorldSummary;
  lastOpened: number;
  rng: Rand;
}

function newSim(seed: number): Sim {
  return {
    m: initialModel(true, true), now: 1000, timers: new Map(), lastFrameAt: 0,
    world: { ready: true, bricksAlive: 40, bricksAtStart: 100, tick: 0, graceSeats: 0 }, lastOpened: 0, rng: seeded(seed),
  };
}

const pick = <V>(rng: Rand, arr: readonly V[]): V => arr[Math.floor(rng() * arr.length)];

function earliest(sim: Sim): [TimerName, number] | null {
  let best: [TimerName, number] | null = null;
  for (const [name, due] of sim.timers) if (best === null || due < best[1]) best = [name, due];
  return best;
}

/** Applies one input and checks the per-step properties. Returns a problem description, or null. */
function step(sim: Sim, input: SessionInput): string | null {
  const env: MachineEnv = { now: sim.now, rand: sim.rng, sessionId: 'sid', lastFrameAt: sim.lastFrameAt, world: { ...sim.world }, policy: P };
  const { model, effects } = transition(sim.m, input, env);
  const problem = applyEffects(sim, effects);
  sim.m = model;
  return problem ?? exitProblem(sim);
}

function applyEffects(sim: Sim, effects: readonly SessionEffect[]): string | null {
  let setSeen = false;
  for (const e of effects) {
    switch (e.e) {
      case 'timer.set':
        setSeen = true;
        if (!(e.ms >= 0) || !Number.isFinite(e.ms)) return `timer.set(${e.name}) with ${e.ms} ms`;
        sim.timers.set(e.name, sim.now + e.ms);
        break;
      case 'timer.clear':
        if (e.name === '*') {
          if (setSeen) return 'timer.set before timer.clear(*) in one step';
          sim.timers.clear();
        } else {
          sim.timers.delete(e.name);
        }
        break;
      case 'socket.open':
        if (e.gen <= sim.lastOpened) return `socket.open gen ${e.gen} after ${sim.lastOpened}`;
        sim.lastOpened = e.gen;
        break;
      case 'socket.send':
        if (e.gen !== sim.lastOpened || e.gen === 0) return `socket.send gen ${e.gen} without its socket.open (last ${sim.lastOpened})`;
        break;
      case 'socket.close':
        if (e.gen > sim.lastOpened) return `socket.close gen ${e.gen} was never opened`;
        break;
      default:
        break;
    }
  }
  return null;
}

/** Every state has a guaranteed exit (5.5.1 property). */
function exitProblem(sim: Sim): string | null {
  const s = sim.m.state;
  const has = (n: TimerName) => sim.timers.has(n);
  switch (s.s) {
    case 'connecting':
      return has('connect') ? null : 'connecting without a connect timer';
    case 'requesting':
      return has('admission') || has('retry') ? null : 'requesting without an admission or retry timer';
    case 'reconnecting':
      if (s.offline !== !sim.m.online) return 'reconnecting.offline disagrees with model.online';
      if (s.suspended) return null; // exits on pageshow or visible (T41 matches whenever suspended)
      if (s.offline) return null; // exits on online (T44)
      return has('retry') ? null : 'online reconnecting without a retry timer';
    case 'lobby':
    case 'countdown':
    case 'playing':
      return has('liveness') ? null : `${s.s} without a liveness timer`;
    default:
      return null; // idle, failed and finished exit through user actions
  }
}

type Maker = () => SessionInput;

function randomInput(sim: Sim): SessionInput | 'fire' {
  const s = sim.m.state.s;
  const admitted = s === 'lobby' || s === 'countdown' || s === 'playing';
  const rng = sim.rng;
  const gen = rng() < 0.93 ? sim.m.lastGen : Math.max(0, sim.m.lastGen - 1 - Math.floor(rng() * 2));
  const at = sim.now;
  const intents: Intent[] = [
    { kind: 'create', isPublic: rng() < 0.5 }, { kind: 'quick' }, { kind: 'join', code: pick(rng, CODES) },
    { kind: 'join', code: 'nope!!' as RoomCode },
  ];
  const controls: ControlEvent[] = [{ k: 'countdown', seconds: 1 + Math.floor(rng() * 3) }, { k: 'cancelled', reason: 'x' }, { k: 'started' }];
  const w = (cond: boolean, hi: number, lo: number) => (cond ? hi : lo);
  const menu: Array<[number, Maker]> = [
    [w(s === 'connecting', 6, 0.3), () => ({ t: 'open', gen })],
    [1.2, () => ({ t: 'closed', gen, code: 1006, wasClean: false })],
    [w(s === 'requesting', 3, 0.3), () => ({ t: 'message', gen, at, msg: { messageType: 'roomCreated', code: pick(rng, CODES), roomPID: 'p' } })],
    [w(s === 'requesting', 3, 0.3), () => ({ t: 'message', gen, at, msg: { messageType: 'roomJoined', success: true, roomPID: 'p', code: pick(rng, CODES), phase: pick(rng, PHASES), reason: '' } })],
    [w(s === 'requesting', 5, 0.3), () => ({ t: 'message', gen, at, msg: { messageType: 'roomJoined', success: false, roomPID: '', code: '', phase: '', reason: pick(rng, REASONS) } })],
    [w(s === 'requesting', 4, 0.3), () => ({ t: 'message', gen, at, msg: { messageType: 'playerAssignment', playerIndex: Math.floor(rng() * 4), phase: pick(rng, PHASES) } })],
    [w(admitted, 0.4, 0.1), () => ({ t: 'message', gen, at, msg: { messageType: 'gameOver', winnerIndex: -1, finalScores: [0, 0, 0, 0], reason: 'r', roomPID: 'p' } })],
    [w(admitted, 3, 0.2), () => ({ t: 'control', gen, at, ev: pick(rng, controls) })],
    [w(admitted, 1.5, 0.2), () => ({ t: 'frame', gen, at })],
    [w(admitted, 1, 0.2), () => ({ t: 'badFrame', gen, at })],
    [0.8, () => ({ t: 'start', intent: pick(rng, intents) })],
    [0.3, () => ({ t: 'leave', explicit: rng() < 0.5 })],
    [0.6, () => ({ t: 'retry' })],
    [0.4, () => ({ t: 'joinAsNew' })],
    [0.5, () => pick<SessionInput>(rng, [{ t: 'online' }, { t: 'offline' }])],
    [0.6, () => pick<SessionInput>(rng, [{ t: 'visible' }, { t: 'hidden' }, { t: 'freeze' }, { t: 'resume' }])],
    [0.4, () => ({ t: 'pagehide', persisted: rng() < 0.7 })],
    [0.4, () => ({ t: 'pageshow', persisted: rng() < 0.7 })],
  ];
  const fireWeight = sim.timers.size > 0 ? 5 : 0;
  let total = fireWeight;
  for (const [weight] of menu) total += weight;
  let r = rng() * total;
  if (r < fireWeight) return 'fire';
  r -= fireWeight;
  for (const [weight, make] of menu) {
    if (r < weight) return make();
    r -= weight;
  }
  return menu[menu.length - 1][1]();
}

/** Moves time forward by up to maxMs, never past the next due timer (which then fires first). */
function passTime(sim: Sim, maxMs: number): void {
  const next = earliest(sim);
  const target = sim.now + sim.rng() * maxMs;
  sim.now = next === null ? target : Math.min(target, next[1]);
}

function fire(sim: Sim): SessionInput {
  const next = earliest(sim);
  if (next === null) throw new Error('no timer to fire');
  sim.timers.delete(next[0]);
  sim.now = Math.max(sim.now, next[1]);
  return { t: 'timer', name: next[0] };
}

describe('session machine properties', () => {
  it('every state keeps an exit over 10 000 seeded runs of 200 random inputs', () => {
    const problems: string[] = [];
    const reached = new Set<string>();
    for (let seed = 1; seed <= 10_000 && problems.length < 5; seed++) {
      const sim = newSim(seed);
      for (let i = 0; i < 200; i++) {
        const choice = randomInput(sim);
        let input: SessionInput;
        if (choice === 'fire') {
          input = fire(sim);
        } else {
          passTime(sim, 1500);
          input = choice;
          if ((input.t === 'message' || input.t === 'control' || input.t === 'frame' || input.t === 'badFrame') && input.gen === sim.m.lastGen) {
            sim.lastFrameAt = sim.now; // the runtime records every current-gen frame
          }
        }
        if (sim.rng() < 0.05) {
          sim.world.bricksAlive = pick(sim.rng, [null, 0, 2, 3, 40]);
          sim.world.graceSeats = pick(sim.rng, [0, 0, 1]);
        }
        const problem = step(sim, input);
        reached.add(sim.m.state.s);
        if (problem !== null) {
          problems.push(`seed ${seed}, step ${i}, input ${JSON.stringify(input)}: ${problem}; state ${JSON.stringify(sim.m.state)}`);
          break;
        }
      }
    }
    expect(problems).toEqual([]);
    // The generator must actually exercise the machine, or the property holds vacuously.
    expect([...reached].sort()).toEqual(['connecting', 'countdown', 'failed', 'finished', 'idle', 'lobby', 'playing', 'reconnecting', 'requesting']);
  }, 120_000);

  it('a room-bound recovery reaches failed within onlineBudgetMs + inRoom.capMs + connectTimeoutMs', () => {
    const bound = P.inRoom.onlineBudgetMs + P.inRoom.capMs + P.connectTimeoutMs;
    const overruns: string[] = [];
    let longest = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const sim = newSim(seed);
      // Admit into play through the machine itself.
      const admitSteps: SessionInput[] = [
        { t: 'start', intent: { kind: 'join', code: CODES[0] } },
      ];
      for (const input of admitSteps) step(sim, input);
      step(sim, { t: 'open', gen: sim.m.lastGen });
      step(sim, { t: 'message', gen: sim.m.lastGen, at: sim.now, msg: { messageType: 'roomJoined', success: true, roomPID: 'p', code: CODES[0], phase: 'playing', reason: '' } });
      step(sim, { t: 'message', gen: sim.m.lastGen, at: sim.now, msg: { messageType: 'playerAssignment', playerIndex: 1, phase: 'playing' } });
      expect(sim.m.state.s).toBe('playing');
      sim.lastFrameAt = sim.now;

      // The drop.
      const problem = step(sim, { t: 'closed', gen: sim.m.lastGen, code: 1006, wasClean: false });
      expect(problem).toBeNull();
      expect(sim.m.state.s).toBe('reconnecting');
      expect(roomOf(sim.m)).not.toBeNull();
      const droppedAt = sim.now;

      // Online, and only closes and timers from here on.
      for (let i = 0; i < 20_000 && sim.m.state.s !== 'failed'; i++) {
        let input: SessionInput;
        if (sim.timers.size > 0 && sim.rng() < 0.6) {
          input = fire(sim);
        } else {
          passTime(sim, 3000);
          input = { t: 'closed', gen: sim.m.lastGen, code: 1006, wasClean: false };
        }
        const p = step(sim, input);
        if (p !== null) {
          overruns.push(`seed ${seed}: ${p}`);
          break;
        }
      }
      const took = sim.now - droppedAt;
      longest = Math.max(longest, took);
      if (sim.m.state.s !== 'failed') overruns.push(`seed ${seed}: still ${sim.m.state.s} after ${took} ms`);
      else if (took > bound) overruns.push(`seed ${seed}: failed only after ${took} ms (bound ${bound})`);
      else expect(sim.m.state).toMatchObject({ s: 'failed', failure: { code: 'room-lost', retryable: true } });
      if (overruns.length > 5) break;
    }
    expect(overruns).toEqual([]);
    expect(longest).toBeGreaterThanOrEqual(P.inRoom.onlineBudgetMs); // the budget, not something shorter, ended it
  }, 60_000);

  it('a recovery before any room is known ends in failed{unreachable} after the attempt limit', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const sim = newSim(seed);
      step(sim, { t: 'start', intent: { kind: 'quick' } });
      let opens = 1;
      for (let i = 0; i < 1000 && sim.m.state.s !== 'failed'; i++) {
        const before = sim.m.lastGen;
        const input: SessionInput = sim.rng() < 0.5 && sim.timers.size > 0 ? fire(sim) : { t: 'closed', gen: sim.m.lastGen, code: 1006, wasClean: false };
        expect(step(sim, input)).toBeNull();
        if (sim.m.lastGen !== before) opens += 1;
      }
      expect(sim.m.state).toMatchObject({ s: 'failed', failure: { code: 'unreachable', autoRetryOnOnline: true } });
      expect(opens).toBe(P.preAdmit.maxAttempts);
    }
  });
});
