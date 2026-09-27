// Service worker for the installed-app experience (icon on your Dock/Home Screen, standalone window —
// see docs/SPEC.md's install notes). Deliberately minimal: this is a single-operator tool for *live*
// security camera video, where caching anything time-sensitive would be actively wrong, not just
// unhelpful. Its only job is (a) satisfying the browser's installability requirement for a registered
// worker with a fetch handler, and (b) letting the static app shell (this JS/CSS, not any data) launch
// once already installed even if the Mac running the server is briefly asleep or off the network.
//
// Explicitly NOT cached, ever: anything under /api/ (settings, calibration, export, thumbnails — all must
// always be live), the playback/live WebSocket and WebRTC/MSE streams (the browser never routes these
// through a service worker's fetch event in the first place — no special-casing needed), and anything
// cross-origin.
const CACHE_NAME = 'sentinel-eye-shell-v1';
const STATIC_RE = /\.(?:js|css|png|svg|json|ico|webmanifest)$/;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  const isShell = url.pathname === '/' || url.pathname === '/index.html' || STATIC_RE.test(url.pathname);
  if (!isShell) return;
  event.respondWith(networkFirst(req));
});

// Network first, not cache first: always prefers the freshest code when the server's actually reachable
// (this app changes as you develop it — a stale cached shell silently winning over a real update would be
// its own kind of bug), and only falls back to whatever was last cached if the network request fails
// outright (server asleep/unreachable), so the app shell can still open rather than showing a bare error.
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}
