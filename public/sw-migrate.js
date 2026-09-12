// Legacy worker hand-off (D35), loaded by the generated worker through workbox importScripts.
// Only the legacy autoUpdate build precached /registerSW.js. While that entry is still in a precache,
// this install skips waiting once so the prompt-mode worker takes over; activation cleans the entry.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (!name.startsWith('workbox-precache')) continue;
      const requests = await (await caches.open(name)).keys();
      if (requests.some((req) => new URL(req.url).pathname === '/registerSW.js')) {
        await self.skipWaiting();
        return;
      }
    }
  })());
});
