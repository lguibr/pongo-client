// Global tokens, reset and layout base (9.7, 9.9; C103, C108). No JavaScript sets the root height: the app
// grid is 100dvh with a 100vh fallback (AppShell). The body is no longer centred (the Vite template's
// index.css is gone). The font is self-hosted through @fontsource, so no Google Fonts request is made.

import '@fontsource/vt323/latin-400.css';
import { createGlobalStyle } from 'styled-components';

const REDUCED = `
  --dur-fast: 0ms;
  --dur: 0ms;
  --dur-slow: 0ms;
  --motion: 0;
`;

export const GlobalStyle = createGlobalStyle`
  /* The grace ring (E51) animates this number from 1 to 0; @property makes it interpolate. */
  @property --grace-p {
    syntax: '<number>';
    inherits: false;
    initial-value: 1;
  }

  :root {
    --bg: #09090b;
    --fg: #fafafa;
    --muted: #a1a1aa;
    --border: #27272a;
    --card: #09090b;
    --secondary: #27272a;
    --primary: #2563eb;
    --primary-fg: #ffffff;
    --danger: #ef4444;
    --success: #22c55e;
    --warn: #eab308;
    --dot: #71717a;
    --focus: #60a5fa;
    --header-h: 60px;
    --radius: 4px;
    --safe-t: env(safe-area-inset-top, 0px);
    --safe-r: env(safe-area-inset-right, 0px);
    --safe-b: env(safe-area-inset-bottom, 0px);
    --safe-l: env(safe-area-inset-left, 0px);
    --dur-fast: 120ms;
    --dur: 200ms;
    --dur-slow: 400ms;
    --motion: 1;
    --z-stage: 0;
    --z-hud: 20;
    --z-overlay: 30;
    --z-dialog: 40;
    --z-toast: 50;
    --z-header: 60;
    --font: 'VT323', ui-monospace, Menlo, monospace;
    color-scheme: dark;
  }

  /* The system preference applies unless the in-app setting forces full motion; the setting can also force
     reduced motion (app/runtime.ts writes data-motion from the motion slice). */
  @media (prefers-reduced-motion: reduce) {
    :root:not([data-motion='full']) { ${REDUCED} }
    :root:not([data-motion='full']) [data-anim] { animation: none !important; }
  }
  :root[data-motion='reduced'] { ${REDUCED} }
  /* Continuous animations (spinners) opt in with a data-anim attribute and stop under reduced motion. */
  :root[data-motion='reduced'] [data-anim] { animation: none !important; }

  *, *::before, *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  html, body, #root {
    width: 100%;
    height: 100%;
  }

  html, body {
    overflow: hidden;
    overscroll-behavior: none;
    -webkit-tap-highlight-color: transparent;
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
  }

  body {
    background-color: var(--bg);
    color: var(--fg);
    font-family: var(--font);
    font-size: 1.25rem;
    line-height: 1.35;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  button, input, select, textarea {
    font: inherit;
    color: inherit;
  }

  button {
    cursor: pointer;
    background: none;
    border: none;
  }

  button:disabled {
    cursor: not-allowed;
  }

  img {
    display: block;
    max-width: 100%;
  }

  :focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }

  dialog::backdrop {
    background: rgba(9, 9, 11, 0.8);
  }

  @keyframes pongo-spin {
    to { transform: rotate(360deg); }
  }

  @keyframes pongo-grace {
    from { --grace-p: 1; }
    to { --grace-p: 0; }
  }
`;
