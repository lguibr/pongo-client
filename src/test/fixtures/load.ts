// Recorded sessions (14.3), read through import.meta.glob so tests use no Node globals and never `fs`.

export interface FixtureFrame { t: number; c: 'A' | 'B' | 'C'; dir: 'in' | 'out'; d: string }   // 14.3 line format

/** One JSON object per non-empty line. Throws with the line number on a malformed line. */
export function loadFixture(raw: string): FixtureFrame[] {
  const frames: FixtureFrame[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let f: unknown;
    try {
      f = JSON.parse(line);
    } catch {
      throw new Error(`fixture line ${i + 1}: malformed JSON`);
    }
    if (!isFrame(f)) throw new Error(`fixture line ${i + 1}: not a {t, c, dir, d} frame`);
    frames.push(f);
  }
  return frames;
}

function isFrame(v: unknown): v is FixtureFrame {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as Record<string, unknown>;
  return typeof f.t === 'number' && Number.isFinite(f.t)
    && (f.c === 'A' || f.c === 'B' || f.c === 'C')
    && (f.dir === 'in' || f.dir === 'out')
    && typeof f.d === 'string';
}

const modules = import.meta.glob<string>('./*.jsonl', { query: '?raw', import: 'default', eager: true });

/** name -> raw JSONL, built with import.meta.glob('./*.jsonl', { query: '?raw', import: 'default', eager: true }).
 *  Some recordings were trimmed after recording: see FIXTURE_GAPS. */
export const FIXTURES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(modules).map(([path, raw]) => [path.replace(/^\.\//, '').replace(/\.jsonl$/, ''), raw])),
);

/** A stretch cut out of a recording: frames exist at t === from and t === to, and none in between (ms, as t). */
export interface FixtureGap { from: number; to: number }

/** Cuts per fixture name; a fixture not listed was kept whole. `game-over` waited about 12 minutes for its
 *  gameOver, so it keeps the admission frames and the first batches (t <= 39.1), then only the last 60 s
 *  before gameOver (t >= 706188.2). Replays must tolerate the jump: arrival time, server tick, scores,
 *  bricks and balls all move on across it with no frame in between, so a playout clock should re-anchor
 *  rather than count it as a stall, and derived events must not be expected across it. */
export const FIXTURE_GAPS: Readonly<Record<string, readonly FixtureGap[]>> = Object.freeze({
  'game-over': Object.freeze([Object.freeze({ from: 39.1, to: 706188.2 })]),
});
