// Decode plus ingest cost per batch (run manually: `yarn vitest bench src/game/ingest.bench.ts`). Two runtimes
// replay the quick-solo stream: one sees only batches without a grid, the other only batches that carry one.

import { bench, describe } from 'vitest';
import { decode } from '../net/decode';
import { FIXTURES, loadFixture } from '../test/fixtures/load';
import { createGameRuntime } from './runtime';
import type { GameRuntime } from './types';
import { createStore } from '../lib/store';
import { initialAppState } from '../state/appStore';
import type { TimerHost } from '../lib/timers';

const inert: TimerHost = { setTimeout: () => 0, clearTimeout: () => {} };
const texts = loadFixture(FIXTURES['quick-solo'] ?? '').filter((f) => f.c === 'A' && f.dir === 'in').map((f) => f.d);
const admission: string[] = [];
const withGrid: string[] = [];
const withoutGrid: string[] = [];
for (const text of texts) {
  const d = decode(text);
  if (!d.ok) continue;
  if (d.msg.messageType === 'initialPlayersAndBallsState') admission.push(text);
  else if (d.msg.messageType === 'gameUpdates') (text.includes('"fullGridUpdate"') ? withGrid : withoutGrid).push(text);
}
const firstGrid = withGrid.shift();

function admitted(): GameRuntime {
  const rt = createGameRuntime({ store: createStore(initialAppState()), timers: inert, now: () => 0 });
  rt.reset(1, 0);
  for (const text of [...admission, ...(firstGrid === undefined ? [] : [firstGrid])]) {
    const d = decode(text);
    if (d.ok && (d.msg.messageType === 'initialPlayersAndBallsState' || d.msg.messageType === 'gameUpdates')) rt.ingest(d.msg, 0);
  }
  return rt;
}

function cycle(list: readonly string[]): () => void {
  const rt = admitted();
  let i = 0;
  let t = 0;
  return () => {
    const d = decode(list[i]);
    i = (i + 1) % list.length;
    t += 25;
    if (d.ok && d.msg.messageType === 'gameUpdates') rt.ingest(d.msg, t);
  };
}

describe('decode + ingest per batch (quick-solo)', () => {
  if (withoutGrid.length > 0) bench('a batch without a grid', cycle(withoutGrid));
  if (withGrid.length > 0) bench('a batch with a grid', cycle(withGrid));
});
