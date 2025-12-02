// File: frontend/src/utils/constants.ts

// Central place for constants like API endpoints.

const getWebsocketUrl = () => {
  // User requested to use the public Cloud Run instance
  return "wss://pongo-967328387581.us-central1.run.app/subscribe";
  
  // Local development fallback (commented out for now)
  // const hostname = window.location.hostname;
  // return `ws://${hostname}:8080/subscribe`;
};

export const WEBSOCKET_URL = getWebsocketUrl();