// Game events (4.5). Positions x, y are canvas px (the server's own coordinates); consumers convert with
// orientation.canvasToBoard. `tick` is the physics tick the event belongs to. IMMEDIATE (-1) marks flow
// events that release on the next frame. `conf` is in 0..1. `ball` is a ball id, or -1 when unknown.

export type Seat = 0 | 1 | 2 | 3;
export type Owner = Seat | -1;
export type Wall = Seat;
export const SeatConn = { Empty: 0, Connected: 1, Grace: 2 } as const;
export type SeatConn = (typeof SeatConn)[keyof typeof SeatConn];
export const IMMEDIATE = -1;

export interface EventBase { tick: number; seq: number; x: number; y: number; conf: number; stale: boolean }
export type GameEvent =
  | (EventBase & { k: 'paddleHit'; ball: number; seat: Seat; speed: number; prevOwner: Owner; u: number })
  | (EventBase & { k: 'ownerChanged'; ball: number; from: Owner; to: Owner; cause: 'paddle' | 'ownGoal' | 'released' })
  | (EventBase & { k: 'wallBounce'; ball: number; wall: Wall; phasing: boolean; u: number })
  | (EventBase & { k: 'goal'; ball: number; wall: Wall; scorer: Owner; repeat: number; u: number })
  | (EventBase & { k: 'absorbed'; ball: number; wall: Wall; u: number })
  | (EventBase & { k: 'brickBounce'; ball: number })
  | (EventBase & { k: 'brickDamaged'; cell: number; from: number; to: number; level: number; ball: number })
  | (EventBase & { k: 'brickDestroyed'; cell: number; from: number; level: number; ball: number; scorer: Owner;
                   points: number | null; chain: number; last: boolean })
  | (EventBase & { k: 'ballSpawned'; ball: number; owner: Owner; permanent: boolean; cause: 'join' | 'powerUp' | 'snapshot' })
  | (EventBase & { k: 'ballRemoved'; ball: number; owner: Owner; cause: 'expired' | 'absorbed' | 'released' })
  | (EventBase & { k: 'phaseStart'; ball: number })
  | (EventBase & { k: 'phaseEnd'; ball: number })
  | (EventBase & { k: 'powerUp'; ball: number; kind: 'split' | 'phase' | 'boost' | 'mass' })
  | (EventBase & { k: 'ballResized'; ball: number; from: number; to: number })
  | (EventBase & { k: 'score'; seat: Seat; from: number | null; to: number; delta: number;
                   cause: 'conceded' | 'scored' | 'brick' | 'join' | 'unknown' })
  | (EventBase & { k: 'seat'; seat: Seat; from: SeatConn; to: SeatConn; graceEndsAt: number })
  | (EventBase & { k: 'boardReady'; bricks: number })
  | (EventBase & { k: 'countdown'; seconds: number })
  | (EventBase & { k: 'countdownCancelled' })
  | (EventBase & { k: 'go' })
  | (EventBase & { k: 'gameOver'; winner: Owner; derived: boolean });
export type GameEventKind = GameEvent['k'];
export type EventOf<K extends GameEventKind> = Extract<GameEvent, { k: K }>;

export interface EventSink { push(e: GameEvent): void }
export interface EventQueue extends EventSink {
  readonly size: number;
  /** Sum of unreleased `score` deltas per seat. Incremented on push, decremented on release or drop. */
  readonly pendingScoreDelta: Int32Array;
  /** Releases in (tick, seq) order every event with tick <= displayTick, every IMMEDIATE event, and every
   *  event when `idle` is true. Events with displayTick - tick > staleTicks are released with stale = true. */
  drain(displayTick: number, idle: boolean, staleTicks: number, fire: (e: GameEvent) => void): void;
  /** Headless release: marks every queued event stale and fires it. */
  releaseAllStale(fire: (e: GameEvent) => void): void;
  clear(): void;                       // epoch change; zeroes pendingScoreDelta
  nextSeq(): number;
}
export interface IngestEventCtx { nowMs: number; displayMs: number; myIndex: Seat | null; headless: boolean }
export type IngestListener = (events: readonly GameEvent[], ctx: IngestEventCtx) => void;
