// The snapshot ring (D06, 4.7): one row per closed tick, 64 ticks deep (1.6 s). Row layout, canvas px:
// 4 paddles x 6 [cx, cy, vx, vy, flags, 0], then MAX_BALLS balls x 6 [x, y, vx, vy, flags, owner].
// Flags: 1 present, 2 phasing, 4 permanent, 8 collided. Each row carries the tick it holds, so a row that was
// overwritten or skipped simply reads as absent.

import type { Seat } from './events';
import type { World } from './types';
import { MAX_BALLS } from '../config/constants';

export const RING_FLAG = { PRESENT: 1, PHASING: 2, PERMANENT: 4, COLLIDED: 8 } as const;

const P_STRIDE = 6;
const B_STRIDE = 6;
const BALLS_AT = 4 * P_STRIDE;
const ROW = BALLS_AT + MAX_BALLS * B_STRIDE;

export class SnapshotRing {
  static readonly CAP = 64;
  private readonly data = new Float32Array(SnapshotRing.CAP * ROW);
  private readonly tags = new Int32Array(SnapshotRing.CAP).fill(-1);
  private newestTick = -1;
  private oldestTick = -1;

  /** Tick numbers; -1 when empty. */
  get newest(): number {
    return this.newestTick;
  }
  get oldest(): number {
    return this.oldestTick;
  }

  clear(): void {
    this.tags.fill(-1);
    this.newestTick = -1;
    this.oldestTick = -1;
  }

  /** Writes the World as the row for `tick`. tick === newest overwrites that row (frameless batches); an older
   *  tick only overwrites a row still held, and anything else older is ignored. */
  push(tick: number, w: World): void {
    if (tick < 0) return;
    if (this.newestTick >= 0 && tick < this.newestTick && !this.has(tick)) return;
    const row = tick & (SnapshotRing.CAP - 1);
    const base = row * ROW;
    const d = this.data;
    for (let s = 0; s < 4; s++) {
      const p = w.paddles[s];
      const o = base + s * P_STRIDE;
      if (p.present) {
        d[o] = p.x;
        d[o + 1] = p.y;
        d[o + 2] = p.vx;
        d[o + 3] = p.vy;
        d[o + 4] = RING_FLAG.PRESENT | (p.collided ? RING_FLAG.COLLIDED : 0);
      } else {
        d[o] = 0;
        d[o + 1] = 0;
        d[o + 2] = 0;
        d[o + 3] = 0;
        d[o + 4] = 0;
      }
      d[o + 5] = 0;
    }
    const balls = w.balls;
    for (let slot = 0; slot < MAX_BALLS; slot++) {
      const b = balls[slot];
      const o = base + BALLS_AT + slot * B_STRIDE;
      if (b !== undefined && b.live) {
        d[o] = b.x;
        d[o + 1] = b.y;
        d[o + 2] = b.vx;
        d[o + 3] = b.vy;
        d[o + 4] = RING_FLAG.PRESENT
          | (b.phasing ? RING_FLAG.PHASING : 0)
          | (b.permanent ? RING_FLAG.PERMANENT : 0)
          | (b.collided ? RING_FLAG.COLLIDED : 0);
        d[o + 5] = b.owner;
      } else {
        d[o] = 0;
        d[o + 1] = 0;
        d[o + 2] = 0;
        d[o + 3] = 0;
        d[o + 4] = 0;
        d[o + 5] = -1;
      }
    }
    this.tags[row] = tick;
    if (tick > this.newestTick) {
      this.newestTick = tick;
      const floor = tick - SnapshotRing.CAP + 1;
      this.oldestTick = this.oldestTick < 0 ? tick : Math.max(this.oldestTick, floor);
    }
  }

  has(tick: number): boolean {
    return tick >= 0 && this.tags[tick & (SnapshotRing.CAP - 1)] === tick;
  }

  /** Copies [cx, cy, vx, vy, flags] to out[o..o+4]. False when the row or the paddle is absent. */
  readPaddle(tick: number, seat: Seat, out: Float32Array, o: number): boolean {
    if (!this.has(tick)) return false;
    const i = (tick & (SnapshotRing.CAP - 1)) * ROW + seat * P_STRIDE;
    const d = this.data;
    if ((d[i + 4] & RING_FLAG.PRESENT) === 0) return false;
    out[o] = d[i];
    out[o + 1] = d[i + 1];
    out[o + 2] = d[i + 2];
    out[o + 3] = d[i + 3];
    out[o + 4] = d[i + 4];
    return true;
  }

  /** Copies [x, y, vx, vy, flags, owner] to out[o..o+5]. False when the row or the ball is absent. */
  readBall(tick: number, slot: number, out: Float32Array, o: number): boolean {
    if (slot < 0 || slot >= MAX_BALLS || !this.has(tick)) return false;
    const i = (tick & (SnapshotRing.CAP - 1)) * ROW + BALLS_AT + slot * B_STRIDE;
    const d = this.data;
    if ((d[i + 4] & RING_FLAG.PRESENT) === 0) return false;
    out[o] = d[i];
    out[o + 1] = d[i + 1];
    out[o + 2] = d[i + 2];
    out[o + 3] = d[i + 3];
    out[o + 4] = d[i + 4];
    out[o + 5] = d[i + 5];
    return true;
  }
}
