
# PonGo Frontend

<p align="center">
  <img src="bitmap.png" alt="Logo" width="300"/>
</p>

This directory contains the React frontend for the PonGo game, built with Vite. It displays the game state received from the backend via WebSockets and handles user input for paddle control, applying necessary transformations based on player perspective.

## Visual Style & Theme

The application utilizes `styled-components` with a defined theme (`src/styles/theme.ts`) for consistent styling.

*   **Theme:** Colors, fonts, and common styles are defined in `src/styles/theme.ts`.
*   **Paddles:** Colored based on player index using the Google color palette defined in the theme (Blue, Green, Yellow, Red).
*   **Balls:** Colored based on the owning player's paddle color. Unowned balls are white. Balls feature a simple trailing effect.
*   **Bricks:**
    *   Styled with rounded corners and a subtle shadow for a softer look.
    *   Colored based on remaining life using a divergent scale defined in the theme (Blue -> Green -> Yellow -> Red). Opacity increases with higher life.
    *   Feature a "hit" animation (slight scale pulse) when their life decreases.
*   **Rotation:** The game canvas is rotated so each player views their paddle at the "bottom" of their screen.

## Input Handling

User input (keyboard arrows, touch) controls the paddle. Crucially, the input direction is automatically adjusted based on the player's assigned rotation:

*   **Players 0 & 1:** Horizontal controls are inverted (screen left moves paddle right, screen right moves paddle left) to match the rotated perspective.
*   **Players 2 & 3:** Controls are standard (screen left moves paddle left, screen right moves paddle right).

This logic is encapsulated in the `useInputHandler` hook (`src/hooks/useInputHandler.ts`).

## Tech Stack

*   React 19
*   TypeScript
*   Vite
*   Styled Components (with Theming)
*   `react-use-websocket` for WebSocket communication
*   Custom Hooks (`useWindowSize`, `usePlayerRotation`, `useInputHandler`)
*   ESLint + Prettier for code quality
*   Vitest for testing (setup pending)

## Project Structure

```
pongo-client/
├── src/
│   ├── components/  # React components (Ball, Brick, GameCanvas, Paddle)
│   ├── hooks/       # Custom React hooks (useInputHandler, usePlayerRotation, useWindowSize)
│   ├── styles/      # Styling-related files (GlobalStyle, theme)
│   ├── types/       # TypeScript type definitions (game)
│   ├── utils/       # Utility functions (colors, constants)
│   ├── App.tsx      # Main application component
│   ├── index.css    # Base CSS (minimal)
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

1.  **Navigate to the pongo-client directory:**
    ```bash
    cd pongo-client
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    ```
3.  **Run the development server:**
    ```bash
    npm run dev
    ```
    This will typically start the frontend on `http://localhost:5173`.

4.  **Ensure the Go backend is running:**
    The backend server (e.g., `ws://localhost:8080/subscribe` or the cloud URL) must be running for the frontend to connect via WebSockets. See the [Backend README](../backend/README.md) for setup instructions.

## Available Scripts

*   `npm run dev`: Starts the development server.
*   `npm run build`: Builds the application for production.
*   `npm run lint`: Lints the codebase using ESLint.
*   `npm run preview`: Serves the production build locally for preview.
*   `npm run test`: Runs tests using Vitest (configuration may be needed).

## Building for Production

```bash
npm run build
```

This will create a `dist` folder with the optimized production build.

## Related Modules

*   [PonGo Backend](../backend/README.md)
*   [PonGo Game Logic](../game/README.md)
*   [Bollywood Actor Library](../bollywood/README.md)
*   [Main Project](../README.md)