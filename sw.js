/* Phantom Run service worker: lets the installed web app (and the site) start and race solo offline.

   - index.html (navigations): network first, cached copy when offline, so a deploy shows up at once
   - the game's own files (js/, css/, icons, manifest): network first, refreshed in the cache on every
     successful fetch; the page also sends the list of files it loaded (js/pwa.js) so the whole module
     graph is cached on the very first visit
   - three.js on cdnjs and the Google Fonts files (versioned, immutable URLs): cache first
   - never cached, never intercepted: Firebase (SDK on www.gstatic.com, *.firebaseio.com, *.googleapis.com
     APIs, *.firebaseapp.com) and the /__/auth sign-in pages; online play needs the live network anyway
   Bump VERSION when the caching rules change; old caches are deleted on activation.
   Registered by js/pwa.js (production only; on localhost only with ?sw=1). */
const VERSION = '1';
const PREFIX = 'phantom-run-';
const CACHE = `${PREFIX}v${VERSION}`;
const SHELL = ['./', 'index.html', 'css/style.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/apple-touch-icon.png', 'js/ui.js', 'js/game.js'];
const CDN_SHELL = ['https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'];
const CDN = /^(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

/** Requests the worker must leave alone (Firebase, Google APIs, sign-in, non-GET, non-http). */
function bypass(req, url){
  if (req.method !== 'GET' || !/^https?:$/.test(url.protocol)) return true;
  if (req.headers.has('range')) return true;
  const h = url.hostname;
  if (url.origin === self.location.origin) return url.pathname.startsWith('/__/') || url.pathname.endsWith('/sw.js');
  if (h === 'fonts.googleapis.com' || h === 'fonts.gstatic.com') return false;
  if (/(^|\.)gstatic\.com$/.test(h) || /firebase/i.test(h) || /(^|\.)googleapis\.com$/.test(h) || /(^|\.)google\.com$/.test(h)) return true;
  return !CDN.test(h);
}
const cacheable = res => !!res && (res.ok || res.type === 'opaque');

async function put(req, res){
  if (!cacheable(res)) return;
  try { const c = await caches.open(CACHE); await c.put(req, res); } catch (e) {}
}
async function fetchAndCache(url){
  const u = new URL(url, self.location.href);
  const req = new Request(u.href, u.origin === self.location.origin ? {cache:'no-cache'} : {mode:'no-cors'});
  if (bypass(req, u)) return false;
  try { const res = await fetch(req); if (!cacheable(res)) return false; await put(req, res); return true; }
  catch (e) { return false; }
}

self.addEventListener('install', e => {
  // Tolerant precache: a missing file must not stop the worker from installing
  e.waitUntil(Promise.all([...SHELL, ...CDN_SHELL].map(fetchAndCache)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function networkFirst(req, navigate){
  try {
    const res = await fetch(req);
    if (res.ok && (res.type === 'basic' || res.type === 'default' || res.type === 'cors')) put(navigate ? new Request(new URL('./', self.registration.scope).href) : req, res.clone());
    return res;
  } catch (err) {
    const c = await caches.open(CACHE);
    const hit = navigate
      ? (await c.match(new URL('./', self.registration.scope).href)) || (await c.match(new URL('index.html', self.registration.scope).href, {ignoreSearch:true}))
      : (await c.match(req)) || (await c.match(req.url, {ignoreSearch:true}));
    if (hit) return hit;
    throw err;
  }
}
async function cacheFirst(req){
  const c = await caches.open(CACHE);
  const hit = await c.match(req) || await c.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  put(req, res.clone());
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (bypass(req, url)) return;
  if (url.origin === self.location.origin) e.respondWith(networkFirst(req, req.mode === 'navigate'));
  else e.respondWith(cacheFirst(req));
});

// js/pwa.js sends every URL the page loaded, so the first visit already caches the full module graph
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type !== 'cache-urls' || !Array.isArray(d.urls)) return;
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    let n = 0;
    for (const url of d.urls.slice(0, 400)) {
      if (typeof url !== 'string') continue;
      if (await c.match(url)) { n++; continue; }
      if (await fetchAndCache(url)) n++;
    }
    if (e.source) e.source.postMessage({type:'cached', count:n, cache:CACHE});
  })());
});
