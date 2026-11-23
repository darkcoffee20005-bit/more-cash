// نقطة التشغيل: npm start
// المتغيرات (ملف .env أو البيئة):
//   MONGODB_URI      رابط MongoDB (مطلوب للإنتاج). بدونه يعمل التطبيق بتخزين ملف محلي للتجربة.
//   MONGODB_DB       اسم القاعدة (افتراضي morecash)
//   PORT             المنفذ (افتراضي 3000)
//   HOST             واجهة الاستماع (افتراضي 0.0.0.0 ليصل إليه التابلت على الشبكة المحلية)
//   PIN_PEPPER       سر إضافي لرموز الدخول (يُنصح به؛ لا يُغيَّر بعد الإعداد وإلا بطلت الرموز)
//   COOKIE_SECURE    true عند التشغيل خلف HTTPS
//   TRUST_PROXY      true عند التشغيل خلف وكيل عكسي (nginx)
//   DATA_FILE        ملف التخزين في وضع التجربة (افتراضي data/dev-db.json)
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { connectDb } from './db/connect.js';
import { createPlatform } from './app/platform.js';
import { createInvoiceReader } from './app/invoice.js';
import { createHttpServer } from './http.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function main() {
  loadEnvFile();
  const env = process.env;
  // على خادم الإنتاج (Render) لا يُسمح بالتشغيل بملف محلي: يتوقف بوضوح بدل أن يبدأ مقهى بقاعدة فارغة
  if (env.REQUIRE_MONGODB === 'true' && !env.MONGODB_URI) throw new Error('MONGODB_URI غير محدد (REQUIRE_MONGODB=true)');
  const dataFile = env.DATA_FILE ?? join(ROOT, 'data', 'dev-db.json');
  if (!env.MONGODB_URI) mkdirSync(dirname(dataFile), { recursive: true });
  if (env.MONGODB_URI && !env.PIN_PEPPER) console.warn('تنبيه: PIN_PEPPER غير محدد؛ سيُستخدم سر مخزّن في قاعدة البيانات.');

  const { db, kind, close } = await connectDb({ uri: env.MONGODB_URI, dbName: env.MONGODB_DB ?? 'morecash', memoryFile: env.MONGODB_URI ? null : dataFile });
  const readInvoice = env.ANTHROPIC_API_KEY ? createInvoiceReader({ apiKey: env.ANTHROPIC_API_KEY }) : null;
  const app = createPlatform({ db, newId: randomUUID, pepper: env.PIN_PEPPER || null, readInvoice, admins: (env.PLATFORM_ADMINS ?? '').split(','), support: env.SUPPORT_WHATSAPP || null,
    // كل حساب جديد ينتظر موافقتك: مفعّل افتراضياً مع MongoDB (الإنتاج)، ومعطّل للتطوير المحلي بالملف؛ REQUIRE_APPROVAL يفرض أحدهما
    approval: env.REQUIRE_APPROVAL ? env.REQUIRE_APPROVAL === 'true' : Boolean(env.MONGODB_URI) });

  const server = createHttpServer(app, {
    publicDir: join(ROOT, 'public'), sharedDir: join(ROOT, 'shared'),
    secureCookie: env.COOKIE_SECURE === 'true', trustProxy: env.TRUST_PROXY === 'true',
    health: async () => {
      await db.collection('tenants').findOne({}); // يفشل إن انقطعت قاعدة البيانات
      return { ok: true, db: kind === 'mongodb' ? 'connected' : 'local-file', invoiceScan: Boolean(readInvoice) };
    },
  });
  const port = Number(env.PORT ?? 3000);
  server.listen(port, env.HOST ?? '0.0.0.0', () => {
    console.log(`مور كاش يعمل: http://localhost:${port}  (التخزين: ${kind === 'mongodb' ? 'MongoDB' : 'ملف محلي للتجربة'})`);
  });

  const shutdown = async () => {
    server.close();
    await close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('تعذر التشغيل:', e.message);
  process.exit(1);
});
