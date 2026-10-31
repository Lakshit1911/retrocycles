/* Installable web app: registers the service worker (sw.js) so Phantom Run starts and races solo offline,
   for example from the iPhone home screen (Safari > Share > Add to Home Screen).

   Registered only on a real deployment: never inside the desktop (Electron) or iOS (Capacitor) apps,
   and not on localhost unless the URL has ?sw=1 (so local tests and development see no cache).
   ?sw=0 skips it anywhere. After registering it sends the worker every URL this page loaded, so the
   whole module graph is cached on the first visit; <html data-offline="ready"> marks when that is done. */
const W = window;
const params = new URLSearchParams(location.search);
const LOCAL = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(location.hostname);
const NATIVE = !!W.phantomDesktop || !!(W.Capacitor && typeof W.Capacitor.isNativePlatform === 'function' && W.Capacitor.isNativePlatform());

export const swWanted = 'serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !NATIVE &&
  params.get('sw') !== '0' && (!LOCAL || params.get('sw') === '1');

// iOS home-screen apps: lets CSS tell the installed app from a Safari tab
if (navigator.standalone || (W.matchMedia && W.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches)) {
  document.documentElement.classList.add('installed');
}

function loadedUrls(){
  const urls = new Set([location.href.split('#')[0]]);
  try { for (const e of performance.getEntriesByType('resource')) urls.add(e.name); } catch (e) {}
  document.querySelectorAll('script[src], link[rel="stylesheet"][href], link[rel="manifest"][href], link[rel~="icon"][href], link[rel="apple-touch-icon"][href]')
    .forEach(el => urls.add(new URL(el.getAttribute('src') || el.getAttribute('href'), location.href).href));
  return [...urls].filter(u => /^https?:/.test(u));
}

async function register(){
  try {
    const reg = await navigator.serviceWorker.register('sw.js', {scope:'./'});
    await navigator.serviceWorker.ready;
    const worker = reg.active || navigator.serviceWorker.controller;
    if (!worker) return;
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data && e.data.type === 'cached') document.documentElement.dataset.offline = 'ready';
    });
    // Modules imported later (Firebase stays online-only) are cached by the worker as they load
    setTimeout(() => worker.postMessage({type:'cache-urls', urls:loadedUrls()}), 1500);
  } catch (e) { console.warn('Offline mode unavailable', e && e.message || e); }
}

if (swWanted) {
  if (document.readyState === 'complete') register();
  else addEventListener('load', register, {once:true});
}
