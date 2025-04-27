
# PonGo Frontend

<p align="center">
  <img src="bitmap.png" alt="Logo" width="300"/>
</p>

This directory contains the React frontend for the PonGo game, built with Vite.

## Tech Stack

*   React 19
*   TypeScript
*   Vite
*   Styled Components
*   `react-use-websocket` for WebSocket communication
*   ESLint + Prettier for code quality
*   Vitest for testing (setup pending)

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
    The backend server (usually on `http://localhost:3001`) must be running for the frontend to connect via WebSockets. See the [Backend README](../backend/README.md) for setup instructions.

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
