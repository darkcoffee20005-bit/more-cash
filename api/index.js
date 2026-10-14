// دالة Vercel: كل طلبات /api/* تمر هنا (انظر vercel.json). الاتصال بـ MongoDB يُحفظ بين الاستدعاءات.
// متغيرات البيئة في Vercel: MONGODB_URI (إلزامي — Atlas)، MONGODB_DB، PIN_PEPPER.
import { connectDb } from '../server/db/connect.js';
import { createPlatform } from '../server/app/platform.js';
import { handleApiRequest } from '../server/http.js';

let ready = null;

async function init() {
  const uri = process.env.MONGODB_URI;
  if (!uri && process.env.MORECASH_ALLOW_MEMORY !== '1') {
    const e = new Error('MONGODB_URI is not configured');
    e.code = 'DB_NOT_CONFIGURED';
    throw e;
  }
  const { db } = await connectDb({ uri, dbName: process.env.MONGODB_DB ?? 'morecash', memoryFile: null, log: { info() {}, warn() {} }, maxPoolSize: 5 });
  return createPlatform({ db, newId: () => crypto.randomUUID(), pepper: process.env.PIN_PEPPER || null });
}

export default async function handler(req, res) {
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
