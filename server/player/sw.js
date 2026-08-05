const CACHE_NAME = 'rd-player-v19';
// Content lives in its own cache so the shell can be re-versioned (the activate handler deletes
// every cache that is not CACHE_NAME) WITHOUT throwing away megabytes of media that are still
// perfectly valid. Rolling the shell used to mean a player re-downloaded its entire playlist.
const CONTENT_CACHE = 'rd-content-v1';

// Single source, shared with server/lib/player-cache-policy.js and its Node tests. A service worker
// cannot require(), so this is importScripts against the route that serves that same file.
importScripts('/player/cache-policy.js');
const POLICY = self.PlayerCachePolicy;

// Install: skip waiting to activate immediately
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate: clean old caches (including old content cache), claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      // CONTENT_CACHE is spared deliberately: it holds media, not code, and dropping it on every
      // shell version bump would make each deploy re-download the whole playlist — over a link
      // that may be exactly what is broken.
      keys.filter(k => k !== CACHE_NAME && k !== CONTENT_CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// Fetch handler — ONLY cache player page and static assets.
// Content files (/uploads/content/) are NOT intercepted — the server sets
// Cache-Control: public, max-age=2592000, immutable which lets the browser
// cache them natively without SW complications (range requests, opaque
// responses, video seeking, etc.)
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Widget renders pinned to a revision: cache-FIRST, because those exact bytes cannot change
  // without the rev changing. This is what lets a widget keep rendering when the network is gone —
  // previously the server sent no-store for every render, so widgets were the one thing the
  // player's offline cache could never hold, and a display that lost its uplink lost them.
  // ignoreSearch is deliberately NOT used here: the query string carries the rev, and ignoring it
  // would match a different revision's entry, which is the staleness we are trying to remove.
  if (url.pathname.startsWith('/api/widgets/') && url.pathname.endsWith('/render') && url.searchParams.has('rev')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok && response.type !== 'opaque') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => new Response(
          '<!DOCTYPE html><body style="margin:0;background:#000"></body>',
          { status: 200, headers: { 'Content-Type': 'text/html' } }
        ));
      })
    );
    return;
  }

  // Player page and static assets: network-first, fall back to cache
  if (url.pathname.startsWith('/player') || url.pathname === '/socket.io/socket.io.js') {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() =>
        caches.match(event.request, { ignoreSearch: true }).then(cached =>
          cached || new Response('Offline', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain' }
          })
        )
      )
    );
    return;
  }

  // Content files: cache the bytes so a player that loses its server keeps playing.
  //
  // This used to be left to the browser's HTTP cache (the server sends
  // `Cache-Control: public, max-age=2592000, immutable`). That is fine on a desktop and is NOT a
  // documented-persistent store on BrightSign, which guarantees survival across reboots for
  // IndexedDB, localStorage and SQLite only. A panel could come back from a power cut with its
  // playlist intact (localStorage) and no media to play.
  //
  // Range requests are the reason this was avoided, and POLICY is what makes it safe: we only ever
  // STORE complete 200s, and slice them ourselves when a seeking video asks for a range.
  if (POLICY && POLICY.isCacheableContent(url, event.request.method)) {
    event.respondWith(handleContent(event.request));
    return;
  }

  // Everything else (API calls, sockets, etc.): don't intercept.
  // Returning without event.respondWith lets the browser handle it natively.
});

async function handleContent(request) {
  const range = request.headers.get('range');
  const cache = await caches.open(CONTENT_CACHE);

  // Keyed WITHOUT the range header (Cache API ignores request headers by default), so one stored
  // full body serves every range of that file rather than one entry per seek position.
  const cached = await cache.match(request, { ignoreVary: true });

  if (cached) {
    if (!range) return cached;
    const sliced = await sliceCached(cached, range);
    if (sliced) return sliced;
    // Unsatisfiable against the cached copy: fall through to the network rather than inventing a
    // 416 that might be wrong if the cached copy is somehow stale.
  }

  try {
    // A ranged request goes to the network as-is; storing its 206 would corrupt the entry, so this
    // response is returned and deliberately NOT cached. The full copy arrives on a non-ranged
    // request (the player's preloader issues one) and that is what populates the cache.
    const response = await fetch(request);

    if (!range && POLICY.isStorable(response)) {
      const clone = response.clone();
      // Not awaited: a slow write must not delay first frame. Failures are swallowed because a
      // cache miss is a performance problem, and a thrown error here is a black screen.
      storeContent(cache, request, clone).catch(() => {});
    }
    return response;
  } catch (err) {
    // Offline with nothing cached. A 504 is more honest than a 200 with an empty body — the player
    // treats a failed media load as an item to skip, and an empty 200 would hang on a dead element.
    if (cached) return cached;
    return new Response('', { status: 504, statusText: 'Offline and not cached' });
  }
}

/* Build a correct 206 from a stored full body. */
async function sliceCached(cached, rangeHeader) {
  const buf = await cached.arrayBuffer();
  const parsed = POLICY.parseRange(rangeHeader, buf.byteLength);

  if (parsed === null) return new Response(buf, { status: 200, headers: cached.headers });
  if (parsed === 'unsatisfiable') return null;

  const body = buf.slice(parsed.start, parsed.end + 1);
  return new Response(body, {
    status: 206,
    statusText: 'Partial Content',
    headers: POLICY.partialHeaders(
      parsed.start, parsed.end, buf.byteLength, cached.headers.get('content-type')
    )
  });
}

/* Store a full response, evicting oldest-first when the quota is close rather than waiting for a
   QuotaExceededError to land on whichever item happened to be next. */
async function storeContent(cache, request, response) {
  const len = Number(response.headers.get('content-length')) || 0;

  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      if (POLICY.needsEviction(usage || 0, len, quota || 0)) await evictOldest(cache, len);
    }
  } catch (e) { /* estimate is unavailable on some builds; proceed and rely on the catch below */ }

  try {
    await cache.put(request, response);
  } catch (e) {
    // Quota exceeded despite the check (or no estimate available). Make room once and retry — but
    // only once, so a pathologically large item cannot spin evicting the whole cache.
    await evictOldest(cache, len);
    try { await cache.put(request, response); } catch (e2) { /* give up: playback still works live */ }
  }
}

/* Cache API preserves insertion order, so the front of keys() is the least recently ADDED. That is
   a rough proxy for least useful and is the only ordering the API exposes without tracking metadata
   ourselves. */
async function evictOldest(cache, needBytes) {
  const keys = await cache.keys();
  let freed = 0;
  for (const key of keys) {
    const hit = await cache.match(key);
    const size = hit ? Number(hit.headers.get('content-length')) || 0 : 0;
    await cache.delete(key);
    freed += size;
    if (freed >= needBytes) break;
  }
}
