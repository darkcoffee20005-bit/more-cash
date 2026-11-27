// نسخة البرنامج على الجهاز: يفتح بلا إنترنت. الشبكة أولاً (لتصل التحديثات فوراً)، والنسخة المحفوظة عند الانقطاع.
// طلبات /api/ لا تُخزَّن أبداً: البيع بلا اتصال يمر عبر طابور التطبيق (public/js/offline.js).
// بعض المتصفحات لا تتيح التخزين (Safari في «وضع القفل» Lockdown Mode، أو خصوصية مشددة): عندها يتنحى هذا الملف
// ويُحمَّل كل شيء من الشبكة كأنه غير موجود. أي خطأ هنا يجب ألا يمنع فتح الصفحة أبداً.
const CACHE = 'morecash-v2';
const SHELL = ['/', '/css/app.css', '/js/main.js', '/icon.svg', '/manifest.webmanifest'];
const HAS_CACHE = typeof caches !== 'undefined';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    if (HAS_CACHE) {
      try { await (await caches.open(CACHE)).addAll(SHELL); } catch { /* التخزين ممنوع أو ممتلئ: نكمل بلا نسخة محفوظة */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    if (HAS_CACHE) {
      try { const keys = await caches.keys(); await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))); } catch { /* لا شيء */ }
    }
    await self.clients.claim();
  })());
});

function fromNetwork(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    fetch(request).then((res) => { clearTimeout(timer); resolve(res); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

self.addEventListener('fetch', (event) => {
  if (!HAS_CACHE) return; // بلا تخزين: المتصفح يجلب الصفحة بنفسه
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.endsWith('/demo.html')) return;
  const navigation = req.mode === 'navigate';
  event.respondWith((async () => {
    let cache = null;
    try { cache = await caches.open(CACHE); } catch { /* التخزين غير متاح الآن */ }
    try {
      const res = await fromNetwork(req, navigation ? 5000 : 4000);
      if (res.ok && cache) cache.put(navigation ? '/' : req, res.clone()).catch(() => {});
      return res;
    } catch {
      const hit = cache ? await cache.match(navigation ? '/' : req).catch(() => null) : null;
      if (hit) return hit;
      // آخر محاولة مباشرة (بلا مهلة) قبل رسالة الانقطاع
      try { return await fetch(req); } catch {
        return new Response('غير متصل', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    }
  })());
});
