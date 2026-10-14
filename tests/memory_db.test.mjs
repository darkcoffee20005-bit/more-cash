import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '../server/db/memory.js';
import { ensureIndexes } from '../server/db/indexes.js';

test('استعلامات وتحديثات بنفس سلوك MongoDB', async () => {
  const db = new MemoryDb();
  const c = db.collection('t');
  await c.insertMany([
    { _id: 'a', n: 1, tags: ['x', 'y'], at: new Date('2026-01-01'), sub: { k: 'v' }, lines: [{ q: 1 }, { q: 5 }] },
    { _id: 'b', n: 2, tags: ['y'], at: new Date('2026-02-01'), name: 'لاتيه' },
    { _id: 'c', n: 3, at: new Date('2026-03-01'), name: 'موكا' },
  ]);
  assert.equal(await c.countDocuments({ tags: 'y' }), 2);
  assert.equal(await c.countDocuments({ n: { $gte: 2, $lt: 3 } }), 1);
  assert.equal(await c.countDocuments({ at: { $gte: new Date('2026-02-01') } }), 2);
  assert.equal(await c.countDocuments({ $or: [{ n: 1 }, { name: /موك/ }] }), 2);
  assert.equal(await c.countDocuments({ name: { $exists: false } }), 1);
  assert.equal(await c.countDocuments({ 'sub.k': 'v' }), 1);
  assert.equal(await c.countDocuments({ 'lines.q': { $gt: 3 } }), 1);
  assert.equal(await c.countDocuments({ n: { $in: [1, 3] } }), 2);
  assert.equal(await c.countDocuments({ tags: { $ne: 'x' } }), 2);
  const sorted = await c.find({}).sort({ n: -1 }).limit(2).project({ n: 1 }).toArray();
  assert.deepEqual(sorted, [{ _id: 'c', n: 3 }, { _id: 'b', n: 2 }]);

  await c.updateOne({ _id: 'a' }, { $inc: { n: 10 }, $push: { tags: 'z' }, $set: { 'sub.k2': 1 } });
  const a = await c.findOne({ _id: 'a' });
  assert.equal(a.n, 11);
  assert.deepEqual(a.tags, ['x', 'y', 'z']);
  assert.equal(a.sub.k2, 1);
  assert.ok(a.at instanceof Date, 'التواريخ تبقى Date');

  const conditional = await c.updateOne({ _id: 'b', n: 99 }, { $set: { hit: true } });
  assert.equal(conditional.matchedCount, 0, 'التحديث المشروط لا يطابق');

  const counter = await db.collection('counters').findOneAndUpdate({ _id: 'r' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  assert.equal(counter.seq, 1);
  assert.equal((await db.collection('counters').findOneAndUpdate({ _id: 'r' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' })).seq, 2);
});

test('الفهارس الفريدة والجزئية تعيد الخطأ 11000', async () => {
  const db = new MemoryDb();
  await ensureIndexes(db);
  const shifts = db.collection('shifts');
  await shifts.insertOne({ status: 'open' });
  await assert.rejects(shifts.insertOne({ status: 'open' }), (e) => e.code === 11000, 'وردية مفتوحة واحدة');
  await shifts.insertOne({ status: 'closed' });
  await shifts.insertOne({ status: 'closed' });

  const customers = db.collection('customers');
  await customers.insertOne({ name: 'أ', phone: '0770' });
  await customers.insertOne({ name: 'ب' });
  await customers.insertOne({ name: 'ج' });
  await assert.rejects(customers.insertOne({ name: 'د', phone: '0770' }), (e) => e.code === 11000);
  await assert.rejects(customers.updateOne({ name: 'ب' }, { $set: { phone: '0770' } }), (e) => e.code === 11000);

  const receipts = db.collection('receipts');
  await receipts.insertOne({ number: 1, clientId: 'x' });
  await assert.rejects(receipts.insertOne({ number: 2, clientId: 'x' }), (e) => e.code === 11000);
});

test('الحفظ والاستعادة يحافظان على التواريخ والفهارس', async () => {
  const db = new MemoryDb();
  await ensureIndexes(db);
  await db.collection('receipts').insertOne({ _id: 'r1', number: 1, clientId: 'k', createdAt: new Date('2026-10-14T10:00:00Z') });
  const json = MemoryDb.serialize(db);
  const db2 = new MemoryDb();
  MemoryDb.restore(db2, json);
  const r = await db2.collection('receipts').findOne({ _id: 'r1' });
  assert.ok(r.createdAt instanceof Date);
  await assert.rejects(db2.collection('receipts').insertOne({ number: 1, clientId: 'z' }), (e) => e.code === 11000);
});
