// Server mirror constants. Each cites the server line it mirrors (pongo/ is the server checkout).
// Geometry is re-derived at runtime from the first grid (World.canvas, gridSize, cellSize); these are the
// expected values and the client's fixed capacities.

export const TICK_MS = 25;              // utils/config.go:58 (40 Hz physics)
export const CANVAS = 900;              // config.go:65
export const GRID = 18;                 // config.go:66
export const CELL = 50;                 // CANVAS / GRID
export const CELLS = GRID * GRID;       // 324; game_actor_state.go:18-28 row-major
export const BALL_R0 = 8;               // config.go:73 (cellSize / 6)
export const MASS_R_STEP = 4;           // config.go:93-94 (2 mass x 2 radius); ball.go:196-202
export const RADIUS_K = 31;             // candidates r0 + 4k, k = 0..30 (IncreaseMass has no cap; 31 bits keep the set a non-negative int32)
export const PADDLE_LEN = 150;          // config.go:79
export const PADDLE_THICK = 25;         // config.go:80
export const PADDLE_STEP = 12;          // config.go:81; paddle.go:93-114
export const BALL_V_MIN = 5, BALL_V_MAX = 10; // config.go:70-71
export const PHASE_MS = 3000;           // config.go:74
export const TEMP_BALL_TTL_MS: readonly [number, number] = [10000, 14000]; // game_actor_entities.go:57-67
export const GRACE_MS = 30000;          // game_actor_disconnect.go:13
export const EMPTY_ROOM_GRACE_MS = 30000; // game_actor_disconnect.go:16; timer starts only at a grace expiry with nobody connected (:107-117)
export const HEARTBEAT_MS = 15000;      // game_actor_state.go:46
export const WALL_CLEAR_CELLS = 3;      // config.go:86
export const BRICK_FIELD: readonly [number, number] = [150, 750]; // canvas px band that bricks can occupy
export const BRICK_MAX_LIFE = 7;        // config.go:88
export const MAX_PLAYERS = 4;
export const MAX_BALLS = 64;            // client slot capacity
export const WALL_T = 10, WALL_H = 16;  // board units (visual)
export const LIFE_H = 6;                // board units of height per life
export const BRICK_SIZE = 44;           // board units (cell 50 minus a 6 gap)
export const SPAWN_JITTER_PX = 12;      // game_actor_physics.go:410-414
export const ROOM_CODE_RE = /^[0-9A-F]{6}$/; // room_manager.go:42-48 (3 random bytes, upper hex)
export const CellType = { Brick: 0, Block: 1, Empty: 2 } as const;
