// دالة Vercel: كل طلبات /api/* تمر هنا (انظر vercel.json). الاتصال بـ MongoDB يُحفظ بين الاستدعاءات.
// متغيرات البيئة في Vercel: MONGODB_URI (إلزامي — Atlas)، MONGODB_DB، PIN_PEPPER.
import { connectDb } from '../server/db/connect.js';
import { createPlatform } from '../server/app/platform.js';
import { handleApiRequest } from '../server/http.js';

let ready = null;

/** يصحح أخطاء اللصق الشائعة: مسافات، علامات تنصيص، أو لصق "MONGODB_URI=" مع الرابط */
export function cleanUri(raw) {
  let u = String(raw ?? '').trim();
  u = u.replace(/^MONGODB_URI\s*=\s*/i, '').trim();
  u = u.replace(/^["'`<]+|["'`>]+$/g, '').trim();
  // إن نُسخ نص عربي أو غيره مع الرابط: خذ الرابط نفسه أينما كان، حتى أول مسافة
  const at = u.search(/mongodb(\+srv)?:\/\//);
  if (at > 0) u = u.slice(at);
  return u.split(/\s/)[0].replace(/["'`>]+$/, '');
}

/** وصف شكل الرابط دون كشف أي جزء منه قد يكون سرياً */
function uriShape(u) {
  if (!u) return 'empty';
  if (u.startsWith('mongodb+srv://')) return 'srv';
  if (u.startsWith('mongodb://')) return 'standard (mongodb://)';
  if (/^https?:\/\//i.test(u)) return 'a web link (https://), not a connection string';
  if (/^[a-z0-9]+$/i.test(u)) return 'looks like only a password or a word';
  return `starts with an unexpected character (code ${u.charCodeAt(0)})`;
}

async function init() {
  const uri = cleanUri(process.env.MONGODB_URI);
  if (!uri && process.env.MORECASH_ALLOW_MEMORY !== '1') {
    const e = new Error('MONGODB_URI is not configured');
    e.code = 'DB_NOT_CONFIGURED';
    throw e;
  }
  const { db } = await connectDb({ uri, dbName: process.env.MONGODB_DB ?? 'morecash', memoryFile: null, log: { info() {}, warn() {} }, maxPoolSize: 5 });
  return createPlatform({ db, newId: () => crypto.randomUUID(), pepper: process.env.PIN_PEPPER || null });
}

/** سبب الفشل بلا أي سر (لا الرابط ولا كلمة المرور) */
function reason(e) {
  if (e?.code === 'DB_NOT_CONFIGURED') return 'MONGODB_URI_MISSING';
  const name = e?.codeName || e?.name || 'Error';
  if (/auth/i.test(name) || /auth/i.test(e?.message ?? '')) return 'AUTH_FAILED';
  if (/ServerSelection|Timeout|ECONNREFUSED|ENOTFOUND|querySrv/i.test(`${name} ${e?.message ?? ''}`)) return 'UNREACHABLE';
  const msg = String(e?.message ?? '');
  if (/Invalid scheme/i.test(msg)) return `BAD_URI: must start with mongodb+srv:// — saved value is ${uriShape(cleanUri(process.env.MONGODB_URI))}`;
  if (/unescaped/i.test(msg)) return 'BAD_URI: password has special characters (@ : / ? # %)';
  if (/hostname|domain name|tld/i.test(msg)) return 'BAD_URI: host part is wrong';
  if (/Parse|Invalid|URI|connection string/i.test(`${name} ${msg}`)) {
    // لا نُظهر أي جزء قد يحوي كلمة المرور
    const safe = msg.replace(/\/\/[^\s]*@/g, '//***@').replace(/["'`][^"'`]*["'`]/g, '"…"').slice(0, 120);
    return `BAD_URI: ${safe}`;
  }
  return name.replace(/[^A-Za-z]/g, '').slice(0, 40) || 'UNKNOWN';
}

export default async function handler(req, res) {
  // فحص الحالة: يرد دائماً 200 ليُقرأ بسهولة من المتصفح وأدوات المراقبة
  if (req.method === 'GET' && /^\/api\/health(\/[a-z0-9-]*)?$/.test(String(req.url).split('?')[0])) {
    let body;
    try { ready ??= init(); await ready; body = { ok: true, db: 'connected' }; } catch (e) { ready = null; body = { ok: false, db: reason(e) }; }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify(body));
  }
  try {
    ready ??= init();
    const app = await ready;
    await handleApiRequest(app, req, res, { secureCookie: true, trustProxy: true });
  } catch (e) {
    ready = null; // أعد المحاولة في الطلب التالي (انقطاع مؤقت عن Atlas مثلاً)
    console.error(e);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: e.code === 'DB_NOT_CONFIGURED' ? 'DB_NOT_CONFIGURED' : 'DB_UNAVAILABLE' }));
  }
}
