// الاتصال: MongoDB الحقيقي عند تحديد MONGODB_URI (الإنتاج)، أو بديل الذاكرة مع حفظ في ملف (تطوير/تجربة).
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MemoryDb } from './memory.js';
import { ensureIndexes } from './indexes.js';

export async function connectDb({ uri, dbName = 'morecash', memoryFile = null, log = console, maxPoolSize = 20 } = {}) {
  if (uri) {
    let mongodb;
    try {
      mongodb = await import('mongodb');
    } catch {
      throw new Error('حزمة mongodb غير مثبتة. شغّل: npm install');
    }
    const client = new mongodb.MongoClient(uri, { serverSelectionTimeoutMS: 8000, appName: 'morecash', maxPoolSize });
    await client.connect();
    const db = client.db(dbName);
    await ensureIndexes(db);
    log.info?.(`MongoDB: متصل بقاعدة ${dbName}`);
    return { db, kind: 'mongodb', close: () => client.close() };
  }

  let timer = null;
  const db = new MemoryDb({
    newId: () => randomUUID(),
    onChange: () => {
      if (!memoryFile) return;
      clearTimeout(timer);
      timer = setTimeout(save, 200);
    },
  });
  function save() {
    const tmp = `${memoryFile}.tmp`;
    writeFileSync(tmp, MemoryDb.serialize(db));
    renameSync(tmp, memoryFile); // كتابة ذرية
  }
  if (memoryFile && existsSync(memoryFile)) MemoryDb.restore(db, readFileSync(memoryFile, 'utf8'));
  await ensureIndexes(db);
  log.warn?.(`تحذير: يعمل بدون MongoDB (تخزين في ${memoryFile ?? 'الذاكرة فقط'}). للإنتاج حدّد MONGODB_URI.`);
  return { db, kind: 'memory', close: async () => { clearTimeout(timer); if (memoryFile) save(); } };
}
