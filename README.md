
<img
  src="https://raw.githubusercontent.com/lguibr/pongo-client/main/bitmap.png"
  alt="screenshot"
  width="400"
/>

This directory contains the React frontend for the PonGo game, built with Vite and **React Three Fiber (R3F)**. It displays the game state received from the backend via WebSockets, handles user input for paddle control, and renders the game elements using WebGL.

## WebSocket Communication & State Management

The frontend communicates with the backend using WebSockets.

1.  **Initial Connection:** Upon connecting, the client receives initial messages directly:
    *   `PlayerAssignmentMessage`: Assigns the client a player index (0-3).
    *   `InitialPlayersAndBallsState`: Provides the state of entities already present in the room (using original backend coordinates and pre-calculated R3F coordinates).
    *   The client waits for the first `GameUpdatesBatch` containing a `FullGridUpdate` to receive the initial grid state and dimensions.
2.  **Real-time Updates:** After initialization, the backend sends a continuous stream of `GameUpdatesBatch` messages. Each batch contains an array of **atomic updates** reflecting changes that occurred on the backend since the last batch.
    *   `PaddlePositionUpdate`, `BallPositionUpdate`, `BallSpawned`, `PlayerJoined` now include pre-calculated `r3fX`, `r3fY` coordinates suitable for direct rendering in the R3F scene (centered origin, Y-up).
    *   `FullGridUpdate` contains a flat list of `BrickStateUpdate` objects representing the state (life, type) and final R3F coordinates (`x`, `y`) of **every** cell in the grid.
3.  **Game Over:** A `GameOverMessage` is sent when the game concludes.

The `App.tsx` component manages the game state via the `useGameState` hook:
*   It stores the **original, unrotated** game state (player info, paddle data, ball data) including the R3F coordinates received from the backend updates.
*   It stores the flat list of `brickStates` received from `FullGridUpdate`.
*   It calculates the required scene `rotationAngle` (in radians) based on `myPlayerIndex` using the `usePlayerRotation` hook.
*   The `originalPaddles`, `originalBalls`, `brickStates`, `cellSize`, and the `rotationAngle` are passed as props to the `R3FCanvas` component for rendering.

## Rendering & Visuals (React Three Fiber)

The game area is rendered using WebGL managed by React Three Fiber.

*   **Canvas:** An R3F `<Canvas>` component.
*   **Camera:** A static `<PerspectiveCamera>` provides a slightly angled top-down view, looking at the scene origin (0,0,0).
*   **Scene Rotation:** A parent `<group>` element wraps all game entities (paddles, balls, bricks). This group's Z-rotation is set based on the `rotationAngle` calculated from the player's index. This rotates the entire game view so the player's paddle effectively appears at the bottom.
*   **Entities:** Paddles, Balls, and Bricks are rendered as 3D meshes (`<Paddle3D>`, `<Ball3D>`, `<Brick3D>`) inside the rotated parent group.
    *   They are positioned directly using their **pre-calculated R3F coordinates** (`r3fX`/`r3fY` for paddles/balls, `x`/`y` for bricks) received from the backend. The parent group's rotation handles the visual orientation for the player.
*   **Lighting:** Basic ambient and directional lights illuminate the scene.
*   **Effects:** Collision highlights are implemented using emissive material properties and point lights.

## Input Handling

User input (keyboard arrows, touch controls) controls the paddle.

*   **Keyboard:** The `useInputHandler` hook tracks `ArrowLeft`/`ArrowRight` presses using an `InputQueue`. It determines the current *visual* direction (the direction the user intends based on the screen, e.g., "move left on screen").
*   **Touch:** Simple touch buttons mimic `ArrowLeft`/`ArrowRight` visual directions.
*   **Mapping:** `App.tsx` maps the *visual* direction (from keyboard or touch) to the *logical* direction required by the backend. This mapping depends on the player's index and the current scene rotation. For example, if the scene is rotated 90 degrees for Player 0, pressing the visual 'ArrowLeft' key actually needs to send the logical 'ArrowRight' command to the backend to move the paddle correctly relative to its original orientation.
*   **Sending:** The mapped logical direction (`ArrowLeft`, `ArrowRight`, or `Stop`) is sent to the backend via WebSocket.

This ensures controls feel intuitive ("left means left on screen") regardless of the player's position and the applied visual rotation.

## Tech Stack

*   React 19
*   TypeScript
*   Vite
*   **React Three Fiber (`@react-three/fiber`)**
*   **Three.js**
*   **Drei (`@react-three/drei`)** (Helpers for R3F)
*   Styled Components (for UI outside the R3F canvas)
*   `react-use-websocket`
*   Custom Hooks (`useWindowSize`, `useInputHandler`, `useGameState`, `usePlayerRotation`)
*   Utility Functions (`src/utils/`)
*   ESLint + Prettier
*   Vitest (setup pending)

## Project Structure

```
pongo-client/
├── src/
│   ├── components/  # React components (R3FCanvas, Ball3D, Brick3D, Paddle3D, StatusOverlay)
│   ├── hooks/       # Custom React hooks (useInputHandler, useWindowSize, useGameState, InputQueue)
│   ├── styles/      # Styling-related files (Theme, GlobalStyle)
│   ├── types/       # TypeScript type definitions
│   ├── utils/       # Utility functions (constants, colors, rotation, coords)
│   ├── App.tsx      # Main application component (renders UI/Canvas)
│   ├── index.css    # Base CSS
│   ├── main.tsx     # Application entry point
│   └── vite-env.d.ts
├── public/
│   └── bitmap.png
├── .gitignore
├── eslint.config.js
├── package-lock.json
├── package.json
├── prettier.config.js
├── README.md       # This file
├── tsconfig.app.json
├── tsconfig.json
├── tsconfig.node.json
└── vite.config.ts
```

## Getting Started

1.  `cd pongo-client`
2.  `npm install`
3.  `npm run dev` (Starts frontend, usually on `http://localhost:5173`)
4.  Ensure the Go backend is running (See [Backend README](https://github.com/lguibr/pongo/blob/main/README.md)).

## Available Scripts

*   `npm run dev`: Start dev server.
*   `npm run build`: Build for production.
*   `npm run lint`: Lint code.
*   `npm run preview`: Preview production build.
*   `npm run test`: Run tests.

## Building for Production

```bash
npm run build
```

Creates a `dist` folder.

## Related Modules

*   [PonGo Backend](https://github.com/lguibr/pongo/blob/main/README.md)
*   [PonGo Game Logic](https://github.com/lguibr/pongo/blob/main/game/README.md)
*   [Bollywood Actor Library](https://github.com/lguibr/bollywood) (External Dependency)
*   [Main Project](https://github.com/lguibr/pongo)