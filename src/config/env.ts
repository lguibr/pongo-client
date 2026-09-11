// Runtime environment: the socket endpoint and the debug switch (C37).

export const PROD_WS_URL = 'wss://pongo-967328387581.us-central1.run.app/subscribe';

/** VITE_WS_URL when set and non-empty; DEV: ws://<location.hostname>:8080/subscribe; else PROD_WS_URL. */
export function wsUrl(): string {
  const configured = import.meta.env.VITE_WS_URL;
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  if (import.meta.env.DEV) {
    // DEV never falls through to production; without a page location, use the local server.
    const host = typeof location !== 'undefined' && location.hostname ? location.hostname : 'localhost';
    return `ws://${host}:8080/subscribe`;
  }
  return PROD_WS_URL;
}

/** True in DEV, or when the page URL has ?debug=1. */
export function isDebug(): boolean {
  if (import.meta.env.DEV) return true;
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get('debug') === '1';
}
