// العمل بلا إنترنت: نسخة محفوظة من القائمة والجلسة، وطابور مبيعات يُرسل تلقائياً عند عودة الاتصال.
// كل بيع يحمل clientId فريداً، فإعادة إرساله (حتى لو وصل سابقاً وانقطع الرد) لا تكرره على الخادم.
import { post } from './api.js';
import { render, state, toast } from './ui.js';

const QUEUE = 'morecash.queue';
const FAILED = 'morecash.queueFailed';
const BOOT = 'morecash.bootstrap';
const SESSION = 'morecash.session';

function read(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function write(key, value) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* التخزين ممتلئ أو غير متاح */ }
}

export const pendingSales = () => read(QUEUE, []);
export const failedSales = () => read(FAILED, []);

// ---------------------------------------------------------------- نسخ محفوظة
export function rememberBootstrap(shopId, data) { if (shopId) write(BOOT, { shopId, data, at: Date.now() }); }
export function savedBootstrap(shopId) {
  const b = read(BOOT, null);
  return b && b.shopId === shopId ? b.data : null;
}
/** آخر مقهى وموظف على هذا الجهاز: لفتح البرنامج بلا إنترنت */
export function rememberSession(shop, employee) { write(SESSION, shop ? { shop, employee: employee ?? null } : null); }
export const savedSession = () => read(SESSION, null);

// ---------------------------------------------------------------- الطابور
export function queueSale(body, summary) {
  const q = pendingSales();
  if (!q.some((x) => x.body.clientId === body.clientId)) q.push({ body: { ...body, offlineAt: new Date().toISOString() }, summary, queuedAt: Date.now() });
  write(QUEUE, q);
  render();
}

let flushing = false;
/** يرسل المبيعات المحفوظة بالترتيب. يتوقف عند انقطاع الشبكة أو انتهاء جلسة الموظف ويعيد المحاولة لاحقاً */
export async function flushSales() {
  if (flushing || !pendingSales().length) return;
  flushing = true;
  let sent = 0;
  try {
    for (;;) {
      const [item] = pendingSales();
      if (!item) break;
      try {
        await post('/api/sales', item.body);
        sent += 1;
      } catch (e) {
        if (e.code === 'NETWORK' || e.status === 0 || e.status === 401 || e.status >= 500) break;
        // رفضه الخادم (سعر تغيّر، وردية أُغلقت…): يُنقل للمراجعة ولا يوقف بقية الطابور
        write(FAILED, [...failedSales(), { ...item, error: e.code, detail: e.detail ?? null, failedAt: Date.now() }]);
      }
      write(QUEUE, pendingSales().filter((x) => x.body.clientId !== item.body.clientId));
    }
  } finally {
    flushing = false;
    if (sent) toast(`أُرسلت ${sent} ${sent === 1 ? 'عملية بيع محفوظة' : 'عمليات بيع محفوظة'}`, 'ok');
    render();
  }
}

export function discardFailed(clientId) {
  write(FAILED, failedSales().filter((x) => x.body.clientId !== clientId));
  render();
}

export function retryFailed(clientId) {
  const item = failedSales().find((x) => x.body.clientId === clientId);
  if (!item) return;
  write(FAILED, failedSales().filter((x) => x.body.clientId !== clientId));
  write(QUEUE, [...pendingSales(), { body: item.body, summary: item.summary, queuedAt: item.queuedAt }]);
  flushSales();
}

// ---------------------------------------------------------------- حالة الاتصال
export function initOffline() {
  if (typeof window === 'undefined') return;
  state.online = navigator.onLine !== false;
  window.addEventListener('online', () => { state.online = true; render(); flushSales(); });
  window.addEventListener('offline', () => { state.online = false; render(); });
  setInterval(() => { if (pendingSales().length) flushSales(); }, 20_000);
  // نسخة التطبيق على الجهاز (Service Worker) — ليس في النسخة التجريبية
  if ('serviceWorker' in navigator && !globalThis.MORECASH_BACKEND && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}
