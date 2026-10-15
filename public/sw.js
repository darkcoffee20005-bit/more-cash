// نسخة البرنامج على الجهاز: يفتح بلا إنترنت. الشبكة أولاً (لتصل التحديثات فوراً)، والنسخة المحفوظة عند الانقطاع.
// طلبات /api/ لا تُخزَّن أبداً: البيع بلا اتصال يمر عبر طابور التطبيق (public/js/offline.js).
const CACHE = 'morecash-v1';
const SHELL = ['/', '/css/app.css', '/js/main.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function fromNetwork(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    fetch(request).then((res) => { clearTimeout(timer); resolve(res); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.endsWith('/demo.html')) return;
  const navigation = req.mode === 'navigate';
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fromNetwork(req, navigation ? 5000 : 4000);
      if (res.ok) cache.put(navigation ? '/' : req, res.clone());
      return res;
    } catch {
      const hit = await cache.match(navigation ? '/' : req);
      if (hit) return hit;
      return new Response('غير متصل', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
