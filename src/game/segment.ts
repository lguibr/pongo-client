// Tick segmentation (5.1). One pass over a batch splits it into tick frames with the R1/R2 stamps:
//   R1: the first position item after any other item starts a frame;
//   R2: a paddle after a ball, a repeated paddle index, or a repeated ball id starts a frame.
// Items before a frame's position block are its `pre`. Arrays are reused across batches.

import type {
  BallPositionUpdate, BatchItem, ControlItem, FullGridUpdate, LobbyState, PaddlePositionUpdate,
} from '../protocol/messages';

export interface TickFrame { pre: BatchItem[]; paddles: PaddlePositionUpdate[]; balls: BallPositionUpdate[] }
export interface BatchPlan {
  frames: TickFrame[]; frameCount: number;   // frames[0..frameCount) valid; arrays reused across batches
  tail: BatchItem[];                          // non-position items after the last position block
  grid: FullGridUpdate | null;                // the last fullGridUpdate in the batch
  lobby: LobbyState | null;                   // the last lobbyState in the batch
  controls: ControlItem[];                    // in order
  headless: BatchItem[];                      // non-position items in a batch with no frames
}

interface PlanState extends BatchPlan { stamps: Map<number, number> }

export function createBatchPlan(): BatchPlan {
  const plan: PlanState = {
    frames: [], frameCount: 0, tail: [], grid: null, lobby: null, controls: [], headless: [],
    stamps: new Map(),
  };
  return plan;
}

function isControl(u: BatchItem): u is ControlItem {
  return u.messageType === 'gameStartCountdown' || u.messageType === 'gameStarted' || u.messageType === 'gameStartCancelled';
}

function nextFrame(plan: BatchPlan): TickFrame {
  let f = plan.frames[plan.frameCount];
  if (f === undefined) {
    f = { pre: [], paddles: [], balls: [] };
    plan.frames.push(f);
  } else {
    f.pre.length = 0;
    f.paddles.length = 0;
    f.balls.length = 0;
  }
  plan.frameCount++;
  return f;
}

export function segmentBatch(updates: readonly BatchItem[], plan: BatchPlan): void {
  const stamps = (plan as PlanState).stamps ?? new Map<number, number>();
  plan.frameCount = 0;
  plan.tail.length = 0;
  plan.headless.length = 0;
  plan.controls.length = 0;
  plan.grid = null;
  plan.lobby = null;
  stamps.clear();

  const pending = plan.tail;   // pending items accumulate in tail and move into each new frame's pre
  let frame: TickFrame | null = null;
  let inBlock = false;
  let lastWasBall = false;
  let paddleSeen = 0;
  let frameNo = 0;

  for (let n = 0; n < updates.length; n++) {
    const u = updates[n];
    if (u.messageType === 'paddlePositionUpdate' || u.messageType === 'ballPositionUpdate') {
      const isPaddle = u.messageType === 'paddlePositionUpdate';
      const newFrame = !inBlock
        || frame === null
        || (isPaddle && (lastWasBall || (paddleSeen & (1 << (u as PaddlePositionUpdate).index)) !== 0))
        || (!isPaddle && stamps.get((u as BallPositionUpdate).id) === frameNo);
      if (newFrame) {
        frame = nextFrame(plan);
        for (let i = 0; i < pending.length; i++) frame.pre.push(pending[i]);
        pending.length = 0;
        paddleSeen = 0;
        frameNo++;
      }
      const f = frame as TickFrame;
      if (isPaddle) {
        const p = u as PaddlePositionUpdate;
        f.paddles.push(p);
        paddleSeen |= 1 << p.index;
      } else {
        const b = u as BallPositionUpdate;
        f.balls.push(b);
        stamps.set(b.id, frameNo);
      }
      inBlock = true;
      lastWasBall = !isPaddle;
      continue;
    }
    inBlock = false;
    if (u.messageType === 'fullGridUpdate') {
      plan.grid = u;
      continue;
    }
    if (u.messageType === 'lobbyState') plan.lobby = u;   // also stays in order below
    if (isControl(u)) plan.controls.push(u);             // also stays in order below
    pending.push(u);
  }
  if (plan.frameCount === 0) for (let i = 0; i < pending.length; i++) plan.headless.push(pending[i]);
}
