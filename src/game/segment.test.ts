import { describe, expect, it } from 'vitest';
import { createBatchPlan, segmentBatch } from './segment';
import type { BatchPlan } from './segment';
import type { BatchItem } from '../protocol/messages';
import {
  ballItem, countdownItem, gridItem, joinedItem, lobbyItem, ownerItem, paddleItem, removedItem, scoreItem, startedItem, cancelledItem,
} from './testing/synth';

/** One server tick: pre items, paddles 0..3 (the given seats), balls. */
function tick(pre: BatchItem[], seats: (0 | 1 | 2 | 3)[], ballIds: number[]): BatchItem[] {
  return [...pre, ...seats.map((s) => paddleItem(s)), ...ballIds.map((id) => ballItem(id, 100 + id, 100, 5, 5))];
}

function seg(items: BatchItem[]): BatchPlan {
  const plan = createBatchPlan();
  segmentBatch(items, plan);
  return plan;
}

describe('segmentBatch', () => {
  it('finds no frames in a lobby batch and keeps its items as headless', () => {
    const items = [joinedItem(1), lobbyItem([0, 1])];
    const plan = seg(items);
    expect(plan.frameCount).toBe(0);
    expect(plan.headless).toEqual(items);
    expect(plan.tail).toEqual(items);
    expect(plan.lobby).toBe(items[1]);
  });

  it('splits 1, 2 and 3 coalesced ticks', () => {
    for (const n of [1, 2, 3]) {
      const items: BatchItem[] = [];
      for (let t = 0; t < n; t++) items.push(...tick([], [0, 3], [1, 2]));
      const plan = seg(items);
      expect(plan.frameCount).toBe(n);
      for (let j = 0; j < n; j++) {
        expect(plan.frames[j].paddles.map((p) => p.index)).toEqual([0, 3]);
        expect(plan.frames[j].balls.map((b) => b.id)).toEqual([1, 2]);
      }
      expect(plan.headless).toEqual([]);
    }
  });

  it('assigns items before a position block to that frame, and items after the last block to the tail', () => {
    const s1 = scoreItem(0, -1);
    const o1 = ownerItem(2, 3);
    const rm = removedItem(9);
    const items = [...tick([s1], [0, 3], [1]), ...tick([o1], [0, 3], [2]), rm];
    const plan = seg(items);
    expect(plan.frameCount).toBe(2);
    expect(plan.frames[0].pre).toEqual([s1]);
    expect(plan.frames[1].pre).toEqual([o1]);
    expect(plan.tail).toEqual([rm]);
  });

  it('starts a frame on a paddle after a ball even with no item between (R2)', () => {
    const items = [...tick([], [0], [1, 2]), ...tick([], [0], [1, 2])];
    expect(seg(items).frameCount).toBe(2);
  });

  it('starts a frame on a repeated ball id when no paddles exist (R2)', () => {
    const items = [...tick([], [], [4, 5]), ...tick([], [], [5, 4])];
    const plan = seg(items);
    expect(plan.frameCount).toBe(2);
    expect(plan.frames[1].balls.map((b) => b.id)).toEqual([5, 4]);
  });

  it('starts a frame on a repeated paddle index (R2)', () => {
    const items = [paddleItem(1), paddleItem(1)];
    expect(seg(items).frameCount).toBe(2);
  });

  it('takes the grid out of the stream wherever it is, and keeps the last one', () => {
    const g1 = gridItem(() => 1);
    const g2 = gridItem(() => 2);
    const items = [...tick([], [0], [1]), g1, ...tick([], [0], [1]), g2];
    const plan = seg(items);
    expect(plan.grid).toBe(g2);
    expect(plan.frameCount).toBe(2);
    expect(plan.frames[1].pre).toEqual([]);
    expect(plan.tail).toEqual([]);
  });

  it('captures controls in order and keeps them in the stream', () => {
    const c1 = countdownItem(3);
    const c2 = cancelledItem();
    const c3 = startedItem();
    const plan = seg([c1, c2, ...tick([c3], [0], [1])]);
    expect(plan.controls).toEqual([c1, c2, c3]);
    expect(plan.frames[0].pre).toEqual([c1, c2, c3]);
  });

  it('reuses its arrays: a second batch replaces the first', () => {
    const plan = createBatchPlan();
    segmentBatch([...tick([scoreItem(1, 5)], [1], [1]), ...tick([], [1], [1])], plan);
    segmentBatch([joinedItem(2)], plan);
    expect(plan.frameCount).toBe(0);
    expect(plan.headless).toHaveLength(1);
    expect(plan.grid).toBeNull();
    expect(plan.controls).toEqual([]);
  });
});
