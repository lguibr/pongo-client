// Boot (12.3; C39, C103, C111). In order: in DEV, stale service workers are removed; createApp builds the runtime
// inside try/catch, and a failure shows a static "PonGo could not start" page with a Reload link, which covers
// C39 above React; then the React tree mounts. No JavaScript sets the root height (C103): the layout is CSS (9.7).
// The service worker is registered by createApp through pwa.start() (5.14).

import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AppProvider } from './app/AppContext';
import { createApp } from './app/runtime';
import type { App as AppApi } from './app/types';
import { GlobalStyle } from './ui/GlobalStyle';
import { unregisterDevWorkers } from './ui/pwa/devUnregister';
import { log } from './lib/log';

if (import.meta.env.DEV) void unregisterDevWorkers();

const container = document.getElementById('root') ?? document.body.appendChild(document.createElement('div'));

let app: AppApi | null = null;
try {
  app = createApp();
} catch (err) {
  log.error('PonGo could not start', err);
}

if (app === null) {
  showStartFailure(container);
} else {
  createRoot(container).render(
    <AppProvider app={app}>
      <BrowserRouter>
        <GlobalStyle />
        <App />
      </BrowserRouter>
    </AppProvider>,
  );
}

/** Plain DOM, because nothing else is known to work at this point. The colours are the 9.9 tokens. */
function showStartFailure(el: HTMLElement): void {
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText = 'box-sizing:border-box;min-height:100vh;display:flex;flex-direction:column;align-items:center;'
    + 'justify-content:center;gap:16px;padding:24px;background:#09090b;color:#fafafa;text-align:center;'
    + "font-family:'VT323',ui-monospace,Menlo,monospace;font-size:20px";
  const title = document.createElement('h1');
  title.textContent = 'PonGo could not start';
  title.style.margin = '0';
  const body = document.createElement('p');
  body.textContent = 'Something stopped the game from loading. Reloading usually fixes it.';
  body.style.cssText = 'margin:0;color:#a1a1aa';
  const reload = document.createElement('a');
  reload.href = location.href;
  reload.textContent = 'Reload';
  reload.style.cssText = 'color:#ffffff;background:#2563eb;padding:12px 24px;border-radius:4px;text-decoration:none';
  reload.addEventListener('click', (e) => {
    e.preventDefault();
    location.reload();
  });
  box.append(title, body, reload);
  el.replaceChildren(box);
}
