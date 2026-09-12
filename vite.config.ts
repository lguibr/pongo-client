import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,                 // src/ui/pwa/registerSW.ts registers /sw.js through workbox-window (5.14, amended)
      devOptions: { enabled: false },        // C111
      includeAssets: ['bitmap.png', 'bitmap.ico', 'icons/favicon-16x16.png', 'icons/favicon-32x32.png', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'PonGo', short_name: 'PonGo',
        description: 'A four-player Pong and Breakout arena.',
        theme_color: '#09090b', background_color: '#09090b',
        display: 'standalone', orientation: 'any', scope: '/', start_url: '/',
        icons: [
          { src: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,ico}'],
        globIgnores: ['**/sounds/**', 'replay.html', 'fx.html'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/sounds\//],
        cleanupOutdatedCaches: true,
        importScripts: ['sw-migrate.js'],    // D35: one-time hand-off from the legacy autoUpdate worker
        dontCacheBustURLsMatching: /-[A-Za-z0-9_-]{8}\.(?:js|css|woff2|png|svg)$/,   // C110: only hashed files
        runtimeCaching: [{
          urlPattern: ({ url }) => url.pathname.startsWith('/sounds/'),
          handler: 'CacheFirst',
          options: { cacheName: 'pongo-sounds', expiration: { maxEntries: 16 } },
        }],
      },
    }),
  ],
  esbuild: command === 'build'
    ? { drop: ['debugger'], pure: ['console.log', 'console.debug', 'console.info'] }  // C53; warn and error stay
    : undefined,
  build: {
    target: 'es2020',
    rollupOptions: {
      input: { main: 'index.html' },         // replay.html and fx.html are dev-only
      output: {
        manualChunks(id: string) {
          if (id.includes('/node_modules/three/')) return 'three';
          if (id.includes('/node_modules/@react-three/fiber/')) return 'r3f';
          if (id.includes('/node_modules/postprocessing/')) return 'post';
          if (id.includes('/node_modules/tone/') || id.includes('/node_modules/standardized-audio-context/')) return 'tone';
          return undefined;
        },
      },
    },
  },
  server: { port: 5173 },
}));
