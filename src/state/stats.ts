// Mutable debug counters (4.15). Not reactive: DebugOverlay polls at 4 Hz. Writers are listed per field.

export interface Stats {
  net: { framesIn: number; bytesIn: number; badFrames: number; droppedItems: number };   // session/runtime.ts
  playout: { delayMs: number; jitterMs: number; snaps: number; extrapolating: boolean; ticksPerBatch: Uint16Array /* [0..3] */ }; // game/runtime.ts
  events: { pushed: number; released: number; stale: number };                          // game/runtime.ts
  render: { calls: number; postCalls: number; triangles: number; programs: number; fps: number; frameMsP95: number; tier: string }; // render/loop.ts; calls = scene draws only (2.5 step 7)
  fx: { sparks: number; shards: number; rings: number; decals: number; droppedP2: number }; // fx/director.ts
  audio: { voices: number; dropped: number };                                           // audio/cues.ts
  input: { sent: number; coalesced: number };                                           // input/controller.ts
}

export const stats: Stats = {
  net: { framesIn: 0, bytesIn: 0, badFrames: 0, droppedItems: 0 },
  playout: { delayMs: 0, jitterMs: 0, snaps: 0, extrapolating: false, ticksPerBatch: new Uint16Array(4) },
  events: { pushed: 0, released: 0, stale: 0 },
  render: { calls: 0, postCalls: 0, triangles: 0, programs: 0, fps: 0, frameMsP95: 0, tier: '' },
  fx: { sparks: 0, shards: 0, rings: 0, decals: 0, droppedP2: 0 },
  audio: { voices: 0, dropped: 0 },
  input: { sent: 0, coalesced: 0 },
};
