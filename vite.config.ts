// File: frontend/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      devOptions: {
        enabled: true,
        type: 'module',
      },
      manifest: {
        name: 'PonGo Game',
        short_name: 'PonGo',
        description: 'A multiplayer Pong-like game with bricks and mayhem, built with React and Three.js.',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'any', // Changed
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: '/icons/icon-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable'
          },
          {
            src: '/icons/icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          },
          {
            src: '/bitmap.png',
            sizes: '400x225',
            type: 'image/png',
            purpose: 'any'
          }
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json,woff,woff2,wasm,wav}'],
      }
    })
  ],
  server: {
    // Proxy configuration remains removed
  },
});