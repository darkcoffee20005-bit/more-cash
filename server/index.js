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
  const dataFile = env.DATA_FILE ?? join(ROOT, 'data', 'dev-db.json');
  if (!env.MONGODB_URI) mkdirSync(dirname(dataFile), { recursive: true });
  if (env.MONGODB_URI && !env.PIN_PEPPER) console.warn('تنبيه: PIN_PEPPER غير محدد؛ سيُستخدم سر مخزّن في قاعدة البيانات.');

  const { db, kind, close } = await connectDb({ uri: env.MONGODB_URI, dbName: env.MONGODB_DB ?? 'morecash', memoryFile: env.MONGODB_URI ? null : dataFile });
  const app = createPlatform({ db, newId: randomUUID, pepper: env.PIN_PEPPER || null });

  const server = createHttpServer(app, {
    publicDir: join(ROOT, 'public'), sharedDir: join(ROOT, 'shared'),
    secureCookie: env.COOKIE_SECURE === 'true', trustProxy: env.TRUST_PROXY === 'true',
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
