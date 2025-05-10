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
      // Explicitly define manifest properties here to ensure they are included
      // This will override or supplement what's in public/manifest.json if there are discrepancies
      // or if the plugin isn't picking it up correctly.
      manifest: {
        name: 'PonGo Game',
        short_name: 'PonGo',
        description: 'A multiplayer Pong-like game with bricks and mayhem, built with React and Three.js.',
        theme_color: '#000000', // Crucial for installability
        background_color: '#000000', // Good to have
        display: 'fullscreen',
        orientation: 'landscape',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: '/icons/icon-192x192.png', // Ensure this path is correct relative to your public folder
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable'
          },
          {
            src: '/icons/icon-512x512.png', // Ensure this path is correct
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          },
          {
            src: '/bitmap.png', // Example of using an existing image
            sizes: '400x225',   // Adjust size if needed
            type: 'image/png',
            purpose: 'any'
          }
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json,woff,woff2,wasm}'],
        // runtimeCaching: [ ... ] // Optional
      }
    })
  ],
  server: {
    // Proxy configuration remains removed
  },
});