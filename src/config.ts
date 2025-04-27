// File: frontend/src/config.ts
// Ensure this points directly to your backend's WebSocket endpoint
export const WEBSOCKET_URL = "ws://localhost:3001/subscribe";

// These MUST match the default values in backend's utils/config.go
export const CANVAS_SIZE = 576;
export const GRID_SIZE = 12;
export const CELL_SIZE = CANVAS_SIZE / GRID_SIZE; // 48