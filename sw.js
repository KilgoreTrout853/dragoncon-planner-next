/* Dragon Con 2026 planner - offline support.

   The building has terrible signal and everyone is on the same towers, so
   the planner has to open and render from cache. Three different jobs, three
   different strategies:

     index.html    network-first with a short timeout. A UI fix should land
                   when there is signal, but a slow tower must not block the
                   app from opening.
     the schedule  cache-first, revalidated behind you. The schedule is 3MB;
                   waiting for it on con wifi is the thing that makes the app
                   feel broken. Serve what we have, check quietly, and only
                   speak up if the copy actually changed.
     fonts         cache-first forever. They never change and a missing font
                   is a visibly broken page.

   Bump the version in CACHE when index.html or sw.js changes; older caches
   under the same prefix are removed on activate. */

/* The next site shares this origin, and so its CacheStorage. build.py stamps
   CHANNEL there, so each site's worker names, and clears, only its own. */
const CHANNEL = "next";                        /* stamped by build.py: "next" on the next site */
const CACHE_PREFIX = `dc26${CHANNEL ? "-" + CHANNEL : ""}-`;
const CACHE = `${CACHE_PREFIX}v4`;
const HTML_TIMEOUT_MS = 3000;
const DATA = "data/2026/events.json";
const SHELL = ["./", "./index.html", "./data/2026/events.json", "./manifest.json", "./icon.svg",
               "./icon-180.png", "./icon-192.png", "./icon-512.png"];

const isFont = url =>
  url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
const isData = url => url.pathname.endsWith(`/${DATA}`) || url.pathname.endsWith(DATA);
const isHTML = (req, url) =>
  req.mode === "navigate" ||
  url.pathname.endsWith("/") ||
  url.pathname.endsWith("/index.html");

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    /* addAll fails the whole install if any one request fails, and the
       schedule is the one that matters - take them individually. */
    await Promise.all(SHELL.map(async path => {
      try {
        const res = await fetch(path, {cache: "reload"});
        if (res.ok) await cache.put(path, res.clone());
      } catch (e) { /* offline at install: the fetch handlers will fill in */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(n => n.startsWith(CACHE_PREFIX) && n !== CACHE)
      .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function tellClients(message) {
  const clients = await self.clients.matchAll({type: "window", includeUncontrolled: true});
  clients.forEach(c => c.postMessage(message));
}

/* Serve the cached schedule at once, then look for a newer one. Only if
   generated_at actually moved do we replace it and tell the page - a
   reload prompt that fires on every load would be trained away in a day. */
async function revalidateData(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, {ignoreSearch: true});
  try {
    const fresh = await fetch(request, {cache: "no-store"});
    if (!fresh || !fresh.ok) return null;
    if (!cached) { await cache.put(request, fresh.clone()); return fresh; }
    const [a, b] = await Promise.all([cached.clone().json(), fresh.clone().json()]);
    await cache.put(request, fresh.clone());
    if (a.generated_at !== b.generated_at) {
      await tellClients({type: "schedule-updated", generated_at: b.generated_at});
    } else {
      await tellClients({type: "schedule-online"});
    }
    return fresh;
  } catch (e) {
    /* The page can't work this out for itself: we already handed it the
       cached copy and its fetch resolved normally. Only we know the
       revalidation never reached the network. */
    await tellClients({type: "schedule-offline"});
    return null;
  }
}

async function cachedDataOr(request, update) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, {ignoreSearch: true});
  if (cached) return cached;
  const fresh = await update;
  return fresh || new Response('{"events":[]}', {headers: {"Content-Type": "application/json"}});
}

/* The page, fetched and stored whenever it arrives - including after the
   race below has already given up on it. Otherwise a tower that is slow but
   working would serve the stale copy on every launch, for ever. */
function fetchAndCache(request) {
  return fetch(request).then(async res => {
    if (res && res.ok) { const cache = await caches.open(CACHE); await cache.put(request, res.clone()); }
    return res;
  });
}

/* Race the network against a timer, not against nothing: a request that
   hangs on a saturated tower is worse than one that fails. */
async function networkFirst(request, net) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      net,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), HTML_TIMEOUT_MS)),
    ]);
    if (res && res.ok) return res;
    throw new Error("bad response");
  } catch (e) {
    const cached = (await cache.match(request, {ignoreSearch: true})) ||
                   (await cache.match("./index.html")) ||
                   (await cache.match("./"));
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  /* Font files come back opaque (no CORS); they still cache and replay. */
  if (res && (res.ok || res.type === "opaque")) await cache.put(request, res.clone());
  return res;
}

self.addEventListener("fetch", event => {
  const {request} = event;
  if (request.method !== "GET") return;
  let url;
  try { url = new URL(request.url); } catch (e) { return; }

  if (isFont(url)) { event.respondWith(cacheFirst(request)); return; }
  if (url.origin !== self.location.origin) return;
  if (isData(url)) {
    /* waitUntil must be called synchronously, here, not inside the async work:
       respondWith only keeps the worker alive until the cached copy is handed
       over, which is immediate - so without this the background check is
       killed before it finishes and the cache never refreshes. */
    const update = revalidateData(request);
    event.waitUntil(update.catch(() => {}));
    event.respondWith(cachedDataOr(request, update));
    return;
  }
  if (isHTML(request, url)) {
    /* Keep the late arrival alive past the response, as with the schedule. */
    const net = fetchAndCache(request);
    event.waitUntil(net.catch(() => {}));
    event.respondWith(networkFirst(request, net));
    return;
  }

  event.respondWith(cacheFirst(request).catch(() => fetch(request)));
});
