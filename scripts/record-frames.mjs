#!/usr/bin/env node
/**
 * Fixture recorder for the replay tests (spec 14.3).
 *
 *   node scripts/record-frames.mjs --scenario <name> [--url ws://localhost:8080/subscribe]
 *                                  [--out src/test/fixtures/<name>.jsonl]
 *
 * Every line is {"t": <ms since start>, "c": "A" | "B" | "C", "dir": "in" | "out", "d": "<raw text>"}.
 * The clients send only the five existing client messages (createRoom, joinRoom, quickPlay,
 * playerReady, direction). A letter names a client role; in `rejections` a later socket reuses
 * a letter only after the earlier socket with that letter has closed.
 *
 * Only loopback servers are accepted: never record against the production endpoint.
 * The Quick Play scenarios need a server without open public rooms (GET /rooms/ is empty);
 * otherwise Quick Play can land in an existing room and the script stops.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DEFAULT_URL = 'ws://localhost:8080/subscribe';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const SIZE_BUDGET = 5_000_000; // bytes per fixture file
const ADMIT_MS = 10_000;
const GAME_OVER_TIMEOUT_MS = 20 * 60_000;
const GAME_OVER_TAIL_MS = 60_000;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const A_STEPS = [['ArrowLeft', 900], ['Stop', 400], ['ArrowRight', 1300], ['Stop', 250], ['ArrowRight', 600], ['ArrowLeft', 700]];
const B_STEPS = [['ArrowRight', 700], ['ArrowLeft', 1100], ['Stop', 500], ['ArrowLeft', 400], ['ArrowRight', 900], ['Stop', 300]];

const sleep = (ms) => new Promise((done) => setTimeout(done, Math.max(0, ms)));
const newSessionId = () => randomUUID().replaceAll('-', '');
const textOf = (data) => (typeof data === 'string' ? data : new TextDecoder().decode(data));

function loadWebSocket() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  return createRequire(import.meta.url)('ws');
}

class Recording {
  t0 = performance.now();
  lines = [];
  add(c, dir, d) {
    this.lines.push({ t: Math.round((performance.now() - this.t0) * 10) / 10, c, dir, d });
  }
}

/** One client socket. It keeps only the last message of each type and a count per type. */
class Peer {
  constructor(name, recording, url, WS) {
    this.name = name;
    this.recording = recording;
    this.url = url;
    this.WS = WS;
    this.last = {};
    this.counts = {};
    this.waiters = new Set();
    this.isOpen = false;
    this.closed = false;
  }

  connect() {
    return new Promise((done, fail) => {
      // The server's websocket.Handler rejects a handshake without Origin (403), as a browser would never send one.
      const { protocol, host } = new URL(this.url);
      const ws = new this.WS(this.url, { headers: { Origin: `${protocol === 'wss:' ? 'https:' : 'http:'}//${host}` } });
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.addEventListener('open', () => {
        this.isOpen = true;
        done(this);
      });
      ws.addEventListener('error', () => {
        if (!this.isOpen) fail(new Error(`${this.name}: cannot connect to ${this.url}`));
      });
      ws.addEventListener('message', (event) => this.receive(textOf(event.data)));
      ws.addEventListener('close', () => {
        this.isOpen = false;
        this.closed = true;
        this.poll();
      });
    });
  }

  send(message) {
    const d = JSON.stringify(message);
    this.recording.add(this.name, 'out', d);
    this.ws.send(d);
  }

  receive(text) {
    this.recording.add(this.name, 'in', text);
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const type = message?.messageType;
    if (typeof type !== 'string') return;
    this.counts[type] = (this.counts[type] ?? 0) + 1;
    if (type === 'gameUpdates') {
      for (const item of message.updates ?? []) {
        if (typeof item?.messageType === 'string') this.counts[item.messageType] = (this.counts[item.messageType] ?? 0) + 1;
      }
    } else {
      this.last[type] = message;
    }
    this.poll();
  }

  /** Resolves with the first truthy value of probe(peer), checked now and after every message. */
  until(probe, ms, what) {
    return new Promise((done, fail) => {
      const waiter = { probe, done, fail, what };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        fail(new Error(`${this.name}: timed out after ${ms} ms waiting for ${what}`));
      }, ms);
      this.waiters.add(waiter);
      this.poll();
    });
  }

  poll() {
    for (const waiter of this.waiters) {
      const value = waiter.probe(this);
      if (!value && !this.closed) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      if (value) waiter.done(value);
      else waiter.fail(new Error(`${this.name}: socket closed while waiting for ${waiter.what}`));
    }
  }

  async close(code = 1000) {
    if (this.closed || !this.ws) return;
    const closed = new Promise((done) => this.ws.addEventListener('close', done, { once: true }));
    this.ws.close(code);
    await Promise.race([closed, sleep(2000)]);
  }
}

/** Sends one admission request; resolves with the outcome once the initial state arrives or the request is rejected. */
async function admit(peer, request) {
  peer.send(request);
  const reply = await peer.until((p) => p.last.roomCreated ?? p.last.roomJoined, ADMIT_MS, 'an admission reply');
  if (reply.messageType === 'roomJoined' && !reply.success) return { ok: false, reason: reply.reason };
  const init = await peer.until(
    (p) => p.last.playerAssignment && p.last.initialPlayersAndBallsState,
    ADMIT_MS,
    'playerAssignment and initialPlayersAndBallsState',
  );
  return { ok: true, code: reply.code, index: peer.last.playerAssignment.playerIndex, init };
}

async function mustAdmit(peer, request) {
  const result = await admit(peer, request);
  if (!result.ok) throw new Error(`${peer.name}: ${request.messageType} rejected: ${result.reason}`);
  return result;
}

function expectRejected(peer, result, reason) {
  if (result.ok || result.reason !== reason) {
    throw new Error(`${peer.name}: expected rejection "${reason}", got ${result.ok ? 'success' : `"${result.reason}"`}`);
  }
}

/** Quick Play into a fresh room; stops when it lands in an existing one. */
async function quickPlayAlone(peer) {
  const room = await mustAdmit(peer, { messageType: 'quickPlay', sessionId: newSessionId() });
  if (room.index !== 0 || room.init.players.length !== 1) {
    throw new Error(
      `${peer.name}: Quick Play joined an existing room (seat ${room.index}, ${room.init.players.length} players); ` +
        'wait until GET /rooms/ is empty and retry',
    );
  }
  return room;
}

/** A creates a room, B joins by code, both ready; resolves once both have seen gameStarted. */
async function startPair(connect, isPublic) {
  const a = await connect('A');
  const room = await mustAdmit(a, { messageType: 'createRoom', isPublic, sessionId: newSessionId() });
  const b = await connect('B');
  await mustAdmit(b, { messageType: 'joinRoom', code: room.code, sessionId: newSessionId() });
  await sleep(500);
  a.send({ messageType: 'playerReady', isReady: true });
  await sleep(300);
  b.send({ messageType: 'playerReady', isReady: true });
  await Promise.all([a, b].map((p) => p.until((q) => q.counts.gameStarted, ADMIT_MS, 'gameStarted')));
  return { a, b };
}

/** Cycles through scripted directions until the deadline, then stops the paddle. */
async function drive(peer, steps, deadline) {
  for (let i = 0; peer.isOpen && performance.now() < deadline; i++) {
    const [direction, holdMs] = steps[i % steps.length];
    peer.send({ messageType: 'direction', direction });
    await sleep(Math.min(holdMs, deadline - performance.now()));
  }
  if (peer.isOpen) peer.send({ messageType: 'direction', direction: 'Stop' });
}

const SCENARIOS = {
  async 'quick-solo'({ connect }) {
    const a = await connect('A');
    await quickPlayAlone(a);
    await sleep(60_000);
  },

  async 'lobby-2p'({ connect }) {
    const { a, b } = await startPair(connect, true);
    const deadline = performance.now() + 30_000;
    await Promise.all([drive(a, A_STEPS, deadline), drive(b, B_STEPS, deadline)]);
  },

  async grace({ connect }) {
    const { b } = await startPair(connect, false);
    await sleep(20_000);
    await b.close(1000);
    await sleep(35_000);
  },

  async 'late-join'({ connect }) {
    const a = await connect('A');
    const room = await quickPlayAlone(a);
    await sleep(40_000);
    const b = await connect('B');
    await mustAdmit(b, { messageType: 'joinRoom', code: room.code, sessionId: newSessionId() });
    await sleep(5_000);
  },

  async rejections({ connect, warn }) {
    const c = await connect('C');
    expectRejected(c, await admit(c, { messageType: 'joinRoom', code: 'FFFFFF', sessionId: newSessionId() }), 'Room not found');
    await c.close(4002);

    const a = await connect('A');
    const sessionId = newSessionId();
    const room = await mustAdmit(a, { messageType: 'createRoom', isPublic: false, sessionId });
    const b = await connect('B');
    expectRejected(b, await admit(b, { messageType: 'joinRoom', code: room.code, sessionId }), 'Session already connected');
    await b.close(4002);

    // Two sockets, one session, the same room, sent in the same turn. Each attempt seats one socket (3 seats left).
    for (let attempt = 1; attempt <= 3; attempt++) {
      const peers = await Promise.all([connect('B'), connect('C')]);
      const request = { messageType: 'joinRoom', code: room.code, sessionId: newSessionId() };
      const results = await Promise.all(peers.map((p) => admit(p, request)));
      await Promise.all(peers.map((p, i) => (results[i].ok ? null : p.close(4002))));
      await sleep(500);
      await Promise.all(peers.map((p) => p.close(1000)));
      if (results.some((r) => !r.ok && r.reason === 'Session admission is pending')) break;
      warn(`attempt ${attempt} did not produce "Session admission is pending": ${JSON.stringify(results.map((r) => r.reason ?? 'ok'))}`);
    }
    await sleep(1000); // A records the room's reaction to the closed sockets
  },

  async 'game-over'({ connect }) {
    const a = await connect('A');
    await quickPlayAlone(a);
    await a.until((p) => p.last.gameOver, GAME_OVER_TIMEOUT_MS, 'gameOver');
  },
};

const lineBytes = (lines) => lines.reduce((n, line) => n + Buffer.byteLength(JSON.stringify(line)) + 1, 0);

function parsedIn(line) {
  if (line.dir !== 'in') return null;
  try {
    return JSON.parse(line.d);
  } catch {
    return null;
  }
}

/**
 * Keeps the admission frames (through the first batch with a position item) and the final
 * 60 s before gameOver, when the whole recording would exceed the size budget.
 */
function fitGameOver(lines, log) {
  if (lineBytes(lines) < SIZE_BUDGET) return lines;
  const headEnd = lines.findIndex((line) => {
    const m = parsedIn(line);
    return m?.messageType === 'gameUpdates' && (m.updates ?? []).some((u) => u?.messageType === 'ballPositionUpdate' || u?.messageType === 'paddlePositionUpdate');
  });
  const overAt = lines.findLastIndex((line) => parsedIn(line)?.messageType === 'gameOver');
  if (headEnd < 0 || overAt < 0) return lines;
  const from = lines[overAt].t - GAME_OVER_TAIL_MS;
  const tailStart = lines.findIndex((line, i) => i > headEnd && line.t >= from);
  if (tailStart < 0) return lines;
  const kept = [...lines.slice(0, headEnd + 1), ...lines.slice(tailStart)];
  log(`trimmed to the admission frames (t <= ${lines[headEnd].t}) and the final 60 s (t >= ${lines[tailStart].t}); ${lines.length - kept.length} lines dropped`);
  return kept;
}

function usage() {
  return `usage: node scripts/record-frames.mjs --scenario <${Object.keys(SCENARIOS).join('|')}> [--url ${DEFAULT_URL}] [--out src/test/fixtures/<name>.jsonl]`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string' },
      url: { type: 'string', default: DEFAULT_URL },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(usage());
    return 0;
  }
  const name = values.scenario;
  if (!name || !Object.hasOwn(SCENARIOS, name)) {
    console.error(usage());
    return 2;
  }
  const url = new URL(values.url);
  if (!LOOPBACK.has(url.hostname)) {
    console.error(`refusing to record against ${url.host}: only a local server is allowed`);
    return 2;
  }
  const out = values.out ? resolve(values.out) : resolve(ROOT, 'src/test/fixtures', `${name}.jsonl`);

  const WS = loadWebSocket();
  const recording = new Recording();
  const peers = [];
  const log = (text) => console.log(`[${name}] ${text}`);
  const ctx = {
    connect: async (letter) => peers[peers.push(new Peer(letter, recording, url.href, WS)) - 1].connect(),
    warn: (text) => console.warn(`[${name}] warning: ${text}`),
  };

  let failure = null;
  try {
    await SCENARIOS[name](ctx);
  } catch (error) {
    failure = error;
  }
  await Promise.all(peers.map((p) => p.close(1000)));
  if (failure) {
    console.error(`[${name}] failed: ${failure.message}; nothing written`);
    return 1;
  }

  const lines = name === 'game-over' ? fitGameOver(recording.lines, log) : recording.lines;
  const bytes = lineBytes(lines);
  if (bytes >= SIZE_BUDGET) ctx.warn(`${bytes} bytes exceeds the ${SIZE_BUDGET}-byte budget`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  log(`${lines.length} lines, ${bytes} bytes, ${((recording.lines.at(-1)?.t ?? 0) / 1000).toFixed(1)} s -> ${out}`);
  return 0;
}

process.exitCode = await main();
process.exit();
