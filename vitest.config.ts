import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vitest does not load VitePWA, so `virtual:pwa-register` is stubbed here and any import of the plugin's
// virtual module still resolves. src/ui/pwa/registerSW.ts no longer imports it (it uses workbox-window).
// DOM tests opt in with `/** @vitest-environment jsdom */`.
// `--expose-gc` backs the zero-allocation checks, which call forceGc() (src/test/gc.ts).
//
// vitest 3.2.4 resolves its own vite (node_modules/vitest/node_modules/vite, 7.x) while the app builds with
// vite 5.4.21, so the plugin types of the two copies do not unify. The plugin object is the same at runtime.
const reactPlugin = react() as unknown as Plugin[];

export default defineConfig({
  plugins: [
    reactPlugin,
    {
      name: 'pwa-register-stub',
      enforce: 'pre',
      resolveId: (id: string) => (id === 'virtual:pwa-register' ? '\0pwa-register-stub' : null),
      load: (id: string) => (id === '\0pwa-register-stub' ? 'export function registerSW(){ return async () => {} }' : null),
    },
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { execArgv: ['--expose-gc'] } },
    benchmark: { include: ['src/**/*.bench.ts'] },
  },
});
