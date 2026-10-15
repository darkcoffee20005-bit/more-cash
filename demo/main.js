// نقطة دخول النسخة التجريبية: تجهيز الخادم الداخلي ثم تشغيل نفس الواجهة.
import { createDemoBackend } from './backend.js';
import { boot } from '../public/js/app.js';

const root = document.getElementById('app');
root.innerHTML = '<div style="height:100%;display:grid;place-items:center;font-family:sans-serif;color:#6a776f">جارٍ تجهيز المقهى التجريبي…</div>';
createDemoBackend().then(({ backend }) => {
  globalThis.MORECASH_BACKEND = backend;
  globalThis.MORECASH_DEMO_PAGE = true; // التسجيل في التجربة يوجّه للموقع الحقيقي (الحساب هنا لا يُحفظ)
  return boot();
}).catch((e) => { root.textContent = `تعذر التشغيل: ${e.message}`; console.error(e); });
