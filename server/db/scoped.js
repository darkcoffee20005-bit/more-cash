// عزل بيانات كل مقهى: غلاف فوق قاعدة البيانات يضيف tenantId تلقائياً لكل قراءة وكتابة.
// طبقة الخدمات (server/app/*) لا تعرف شيئاً عن تعدد المقاهي؛ تستلم هذا الغلاف بدل القاعدة نفسها،
// فيستحيل أن يقرأ مقهى بيانات مقهى آخر حتى لو نسيت خدمةٌ ما شرطاً في استعلامها.
//
// المستندات ذات المعرّف الثابت (settings: 'store'، counters: 'receipt'…) تُخزَّن بمعرّف مسبوق
// بالمقهى ('<tenantId>:store') كي لا تتصادم بين المقاهي، ويُعاد المعرّف الأصلي عند القراءة.

const FIXED_ID = new Set(['settings', 'counters']);

export function scopeDb(db, tenantId) {
  if (typeof tenantId !== 'string' || !tenantId) throw new Error('tenantId required');
  const cache = new Map();
  return {
    tenantId,
    collection(name) {
      if (!cache.has(name)) cache.set(name, new ScopedCollection(db.collection(name), tenantId, FIXED_ID.has(name)));
      return cache.get(name);
    },
  };
}

class ScopedCollection {
  constructor(coll, tenantId, fixedIds) {
    this.c = coll;
    this.t = tenantId;
    this.fixed = fixedIds;
    this.prefix = `${tenantId}:`;
  }

  _id(v) {
    if (!this.fixed) return v;
    if (typeof v === 'string') return this.prefix + v;
    if (v && typeof v === 'object' && Array.isArray(v.$in)) return { ...v, $in: v.$in.map((x) => this.prefix + x) };
    return v;
  }

  filter(f = {}) {
    const out = { ...f, tenantId: this.t };
    if ('_id' in f) out._id = this._id(f._id);
    return out;
  }

  doc(d) {
    const out = { ...d, tenantId: this.t };
    if (this.fixed && '_id' in d) out._id = this._id(d._id);
    return out;
  }

  /** يعيد المستند كما تعرفه الخدمات: بلا tenantId وبمعرّفه الأصلي */
  view(d) {
    if (!d) return d;
    const { tenantId, ...rest } = d;
    if (this.fixed && typeof rest._id === 'string' && rest._id.startsWith(this.prefix)) rest._id = rest._id.slice(this.prefix.length);
    return rest;
  }

  find(filter, options) { return new ScopedCursor(this.c.find(this.filter(filter), options), (d) => this.view(d)); }
  async findOne(filter, options) { return this.view(await this.c.findOne(this.filter(filter), options)); }
  async countDocuments(filter, options) { return this.c.countDocuments(this.filter(filter), options); }
  async insertOne(doc, options) { return this.c.insertOne(this.doc(doc), options); }
  async insertMany(docs, options) { return this.c.insertMany(docs.map((d) => this.doc(d)), options); }
  async updateOne(filter, update, options) { return this.c.updateOne(this.filter(filter), guard(update), options); }
  async updateMany(filter, update, options) { return this.c.updateMany(this.filter(filter), guard(update), options); }
  async deleteOne(filter, options) { return this.c.deleteOne(this.filter(filter), options); }
  async deleteMany(filter, options) { return this.c.deleteMany(this.filter(filter), options); }
  async findOneAndUpdate(filter, update, options) {
    return this.view(await this.c.findOneAndUpdate(this.filter(filter), guard(update), options));
  }
  aggregate(pipeline = [], options) {
    return new ScopedCursor(this.c.aggregate([{ $match: { tenantId: this.t } }, ...pipeline], options), (d) => this.view(d));
  }
}

/** لا يُسمح لأي تحديث بتغيير tenantId */
function guard(update) {
  for (const op of Object.values(update ?? {})) {
    if (op && typeof op === 'object' && 'tenantId' in op) throw new Error('tenantId is immutable');
  }
  return update;
}

class ScopedCursor {
  constructor(cursor, view) { this.cur = cursor; this.v = view; }
  sort(s) { this.cur = this.cur.sort(s); return this; }
  limit(n) { this.cur = this.cur.limit(n); return this; }
  skip(n) { this.cur = this.cur.skip(n); return this; }
  project(p) { this.cur = this.cur.project(p); return this; }
  async toArray() { return (await this.cur.toArray()).map(this.v); }
  async next() { return this.v(await this.cur.next()); }
  async *[Symbol.asyncIterator]() { for await (const d of this.cur) yield this.v(d); }
}
