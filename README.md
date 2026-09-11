<img src="bitmap.png" alt="The PonGo logo" width="400" />

# PonGo client

The browser client for PonGo, a four-player Pong and Breakout arena. The interface is React 18 with
styled-components. The arena is React Three Fiber on three.js, with postprocessing for bloom and grading, and Tone
plays the music. The client talks to the PonGo game server over one WebSocket, and the wire protocol is frozen:
`src/protocol/messages.ts` mirrors the server's messages exactly.

## Requirements

- Node 22 and Yarn 1.22.
- A PonGo game server. Local work expects it at `ws://localhost:8080/subscribe`.

## Getting started

```bash
yarn install
cp .env.example .env.local   # VITE_WS_URL=ws://localhost:8080/subscribe
yarn dev                     # http://localhost:5173
```

## Scripts

| Command | What it does |
|---|---|
| `yarn dev` | The Vite dev server on port 5173. There is no service worker in development; stale ones are removed at boot. |
| `yarn build` | Type check (`tsc -b`), then the production build into `dist/`, with the service worker. |
| `yarn preview` | Serves `dist/` on port 4173. |
| `yarn lint` | ESLint over the repository. |
| `yarn test` | Vitest in watch mode. |
| `yarn test:run` | The whole suite, once. |
| `yarn record --scenario <name>` | Records a fixture from a local server (see [Recording fixtures](#recording-fixtures)). |

## Configuration

| Variable | Meaning |
|---|---|
| `VITE_WS_URL` | The WebSocket endpoint. When it is unset, development uses `ws://<page host>:8080/subscribe`, and a build uses the production endpoint (`PROD_WS_URL` in `src/config/env.ts`). Development never falls through to production. |

## Debug flags

| Flag | Effect |
|---|---|
| `?debug=1` | Turns on the logger and the protocol trail (always on in development) and opens the debug overlay. The overlay shows frames and bytes per second, playout delay and jitter, snaps, ticks per batch, queued and stale events, fps, scene and post draw calls (the scene budget is 12), triangles, programs, the quality tier and context health, effect pool use, audio voices, input sends and the last protocol messages. Its "Own-paddle lead" box switches the own-paddle lead at runtime; the lead ships switched off. The flag is read when the page loads, so it stays on across navigation. |
| `?tune=path:value,...` | Development only. Overrides any value in `src/config/tuning.ts`, for example `?tune=hitStop.enabled:0,playout.minDelayMs:40`. Production ignores it. |

## Development pages

These pages exist on the dev server only and are not part of the build.

| Page | What it shows |
|---|---|
| `/replay.html?fixture=<name>&client=<A\|B\|C>&speed=<n>` | A recorded fixture played at its recorded timing through the real game runtime and render core, with a derivation overlay. |
| `/fx.html` | The effects playground: fires each effect on demand and switches the quality tier and reduced motion. `?fixture=<name>` replays a fixture through the full effects director. |
| `/ui.html` | The UI gallery: every room view rendered from fake app states. `?view=<id>` shows one view, and `?motion=reduced` applies reduced motion. |

## Tests

- Vitest runs in the `node` environment by default. DOM tests opt in with `/** @vitest-environment jsdom */`.
- Workers run with `--expose-gc`, which backs the zero-allocation checks.
- Run one area with an explicit path, for example `yarn vitest run src/session`.
- The fixture replays read `src/test/fixtures/*.jsonl` through `import.meta.glob`.
- The ingest benchmark runs with `yarn vitest bench src/game/ingest.bench.ts`.

## Recording fixtures

```bash
node scripts/record-frames.mjs --scenario <name> [--url ws://localhost:8080/subscribe] [--out src/test/fixtures/<name>.jsonl]
```

The scenarios are `quick-solo`, `lobby-2p`, `grace`, `late-join`, `rejections` and `game-over`. Each line is
`{"t": <ms since start>, "c": "A" | "B" | "C", "dir": "in" | "out", "d": "<raw text>"}`. The script sends only the
five existing client messages and accepts loopback servers only; never record against the production endpoint.
The Quick Play scenarios need a server with no open public rooms. The committed `game-over` fixture is trimmed: it
keeps the admission frames and the last 60 seconds before `gameOver`, and `FIXTURE_GAPS` in
`src/test/fixtures/load.ts` declares the jump.

## How it works

One server batch and one display frame each take a fixed path, and React is kept out of both.

1. **Transport** (`src/net/transport.ts`) owns one WebSocket per generation. Frames from an older generation are
   dropped.
2. **Session** (`src/session/`) is a pure state machine, `transition(model, input, env)`, run by an interpreter
   that owns named, tokened timers. The session runtime decodes each frame once (`src/net/decode.ts`, one
   `JSON.parse`) and routes it. It handles admission, rejections, reconnection with backoff, liveness, page
   lifecycle and a per-tab identity held through Web Locks.
3. **Game runtime** (`src/game/`) applies each decoded batch to a World kept in typed arrays. It keeps a ring of
   64 tick snapshots and a playout clock in the tick domain. Gameplay events are derived from state
   diffs, each with a confidence value, and released in tick order when display time reaches them.
4. **Frame loop** (`src/render/loop.ts`): a single `useFrame` advances the clock, samples the ring, and runs the
   entity systems, the effects director (`src/fx/`), the camera and one composer render. That comes to at most
   12 scene draws.
5. **Audio** (`src/audio/`): one `AudioContext`, created on the first gesture. Cues are scheduled on the display
   timeline, and Tone is loaded lazily for the music.
6. **UI** (`src/ui/`) reads `appStore` slices through `useSyncExternalStore`. A plain batch causes no React commit.

`src/app/runtime.ts` is the composition root: it builds every singleton once, wires the ports and undoes it all
on dispose, including on a hot update. `src/main.tsx` boots it and mounts the router.

### Routes

| Path | Screen |
|---|---|
| `/` | Landing: create, join by code, Quick Play, the rules. It never opens a socket. |
| `/room/:code?` | The room, lazy-loaded with the 3D stack. This is the only route that opens a socket, and the canvas stays mounted for the whole room, rejoins included. |
| `/lobby/:code`, `/game/:code` | Legacy links, redirected to `/room/:code`. |
| `/lobby/create`, `/lobby/quickplay` | Redirected to `/`, so a bookmark never creates a room. |
| anything else | Not found. |

### Layout

```
src/
  app/        composition root and App context
  audio/      audio engine, unlock, cues, samples, synth voices, music
  config/     server mirror constants, tuning, palette, environment
  dev/        the ?debug=1 overlay
  fx/         effects director, GPU particle pools, trails, shells, score pops, playground
  game/       World, segmentation, derivation, radius inference, seats, playout, interpolation, queue
  input/      keyboard, touch joystick, input controller
  lib/        store, timers, storage, settings, logger, math
  net/        decode, encode, transport, room codes
  protocol/   wire types
  render/     canvas host, frame loop, camera, quality, context loss, materials, systems, post
  session/    machine, runtime, policy, identity, lifecycle
  state/      app store slices, hooks, debug counters
  test/       fakes, fixtures, setup
  ui/         shell, landing, room views, dialogs, PWA prompt
```

## Service worker

The service worker runs in prompt mode. An update applies by itself only when the session is idle on `/`. In a
room, an "Update ready" chip shows, and the update applies after the match. `public/sw-migrate.js` hands over once
from the legacy auto-update worker, so tabs of the old build pick up the new one without being closed.
