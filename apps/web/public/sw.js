/*
 * Service worker — app shell only.
 *
 * ── What this must never do ─────────────────────────────────────────────────
 *
 * This app's data is evidence. A cached tenancy aggregate redisplayed after the
 * record has moved on is a stale photograph count and a stale change list shown
 * as if they were current, which is the one failure mode the whole product
 * exists to prevent. A cached presigned URL is worse: it expires in five
 * minutes (§7) and a cache would keep serving a dead link, or — if it held the
 * response — would keep a copy of someone's evidence in a browser cache that
 * nothing clears on sign-out.
 *
 * So the rule is a whitelist, not a blacklist. Only same-origin static build
 * output is ever cached. Everything else — the API, S3, anything
 * cross-origin — is passed straight through to the network, untouched, with no
 * fallback. An offline API call fails, and the UI already has a state for that.
 *
 * ── Why this is hand-written ────────────────────────────────────────────────
 *
 * `vite-plugin-pwa` would precache the manifest of hashed assets, which is
 * genuinely better at knowing the build's file list. It also generates a
 * Workbox runtime with default route handlers that cache what they are pointed
 * at, and the default that matters here is the one that would treat the API as
 * just another origin. Forty lines with an explicit whitelist is the smaller
 * risk, and the brief asks for the simplest production-appropriate path.
 */

// Bumped when the caching rules change; old caches are dropped on activate.
const CACHE = 'handover-shell-v1';

/**
 * The entry points. Hashed asset files are not listed because their names are
 * build output — they are picked up at runtime by the whitelist below, which is
 * safe precisely because a hashed name is immutable.
 */
const SHELL = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // `addAll` rejects the whole install if any entry 404s, which on a static
      // host is a real possibility during a deploy. A failed precache must not
      // wedge the worker — the runtime handler fills the cache anyway.
      .then((cache) => cache.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/**
 * The whitelist. True only for this origin's immutable build output and the
 * icons — never for a path that could carry tenancy data.
 */
function isCacheableAsset(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.search !== '') return false;
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.json'
  );
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only GET is ever considered. A POST is a presign, an upload or a claim, and
  // none of those has a cacheable answer.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  /*
   * Navigations are network-first so a deploy is picked up on the next load,
   * with the cached shell as the offline fallback. The shell carries no tenancy
   * data — it is an empty React root — so serving it offline shows the app's
   * own "could not reach the server" state rather than stale evidence.
   */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html').then((hit) => hit ?? Response.error())),
    );
    return;
  }

  if (!isCacheableAsset(url)) return; // API, S3, everything else: straight to the network.

  // Cache-first, safe because these paths are content-hashed or static icons.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
