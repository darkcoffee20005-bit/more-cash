// بديل MongoDB في الذاكرة يطابق الجزء المستخدم من واجهة الـ driver الرسمي (v6):
// insertOne/insertMany/findOne/find(...).sort().skip().limit().project().toArray()/updateOne/updateMany/
// findOneAndUpdate/replaceOne/deleteOne/deleteMany/countDocuments/createIndex (unique + partial + sparse).
//
// يُستخدم للاختبارات، والنسخة التجريبية في المتصفح، والتشغيل دون MongoDB أثناء التطوير.
// لا يدعم المعاملات ولا التجميع (aggregate) — والتطبيق لا يعتمد عليهما عمداً.

export class MongoServerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MongoServerError';
    this.code = code;
  }
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof RegExp);

function valuesAt(doc, path) {
  let current = [doc];
  for (const key of path.split('.')) {
    const next = [];
    for (const v of current) {
      if (v == null) { next.push(undefined); continue; }
      if (Array.isArray(v) && !/^\d+$/.test(key)) {
        for (const el of v) next.push(el?.[key]);
      } else next.push(v[key]);
    }
    current = next;
  }
  return current;
}

function getPath(doc, path) {
  return path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), doc);
}

function setPath(doc, path, value) {
  const keys = path.split('.');
  let o = doc;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[keys[i]];
  }
  o[keys.at(-1)] = value;
}

function unsetPath(doc, path) {
  const keys = path.split('.');
  const parent = keys.length === 1 ? doc : getPath(doc, keys.slice(0, -1).join('.'));
  if (parent && typeof parent === 'object') delete parent[keys.at(-1)];
}

function cmp(a, b) {
  if (a instanceof Date) a = a.getTime();
  if (b instanceof Date) b = b.getTime();
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a !== typeof b) return String(typeof a).localeCompare(typeof b);
  return a < b ? -1 : 1;
}

function deepEqual(a, b) {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (a === b) return true;
  if (a == null || b == null) return a == b; // null يطابق undefined كما في Mongo
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

function valueMatches(value, cond) {
  if (cond instanceof RegExp) return typeof value === 'string' && cond.test(value);
  if (isPlainObject(cond) && Object.keys(cond).some((k) => k.startsWith('$'))) {
    return Object.entries(cond).every(([op, arg]) => opMatches(value, op, arg, cond));
  }
  if (Array.isArray(value) && !Array.isArray(cond)) return value.some((el) => deepEqual(el, cond));
  return deepEqual(value, cond);
}

function opMatches(value, op, arg, cond) {
  const anyEl = (fn) => (Array.isArray(value) ? value.some(fn) || fn(value) : fn(value));
  switch (op) {
    case '$eq': return valueMatches(value, arg);
    case '$ne': return !valueMatches(value, arg);
    case '$gt': return anyEl((v) => v != null && cmp(v, arg) > 0);
    case '$gte': return anyEl((v) => v != null && cmp(v, arg) >= 0);
    case '$lt': return anyEl((v) => v != null && cmp(v, arg) < 0);
    case '$lte': return anyEl((v) => v != null && cmp(v, arg) <= 0);
    case '$in': return arg.some((a) => valueMatches(value, a));
    case '$nin': return !arg.some((a) => valueMatches(value, a));
    case '$exists': return (value !== undefined) === !!arg;
    case '$size': return Array.isArray(value) && value.length === arg;
    case '$type': {
      const t = value instanceof Date ? 'date' : Array.isArray(value) ? 'array' : value === null ? 'null'
        : typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? (Number.isInteger(value) ? 'int' : 'double') : typeof value;
      return [].concat(arg).some((a) => a === t || (a === 'number' && (t === 'int' || t === 'double')) || (a === 'long' && t === 'int'));
    }
    case '$regex': {
      const re = arg instanceof RegExp ? arg : new RegExp(arg, cond.$options ?? '');
      return anyEl((v) => typeof v === 'string' && re.test(v));
    }
    case '$options': return true;
    case '$elemMatch': return Array.isArray(value) && value.some((el) => (isPlainObject(el) ? matches(el, arg) : valueMatches(el, arg)));
    case '$not': return !valueMatches(value, arg);
    default: throw new MongoServerError(`unsupported operator ${op}`, 2);
  }
}

export function matches(doc, filter = {}) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$and') { if (!cond.every((f) => matches(doc, f))) return false; continue; }
    if (key === '$or') { if (!cond.some((f) => matches(doc, f))) return false; continue; }
    if (key === '$nor') { if (cond.some((f) => matches(doc, f))) return false; continue; }
    const values = valuesAt(doc, key);
    const isNeg = isPlainObject(cond) && ('$ne' in cond || '$nin' in cond || ('$exists' in cond && !cond.$exists));
    // الحقول الممتدة عبر مصفوفات: الإيجابي يكفيه عنصر واحد، والسلبي يجب أن يصح على الكل
    const ok = isNeg ? values.every((v) => valueMatches(v, cond)) : values.some((v) => valueMatches(v, cond));
    if (!ok) return false;
  }
  return true;
}

function applyUpdate(doc, update, { isInsert = false } = {}) {
  const ops = Object.keys(update);
  if (!ops.every((k) => k.startsWith('$'))) throw new MongoServerError('update document requires atomic operators', 9);
  for (const [op, fields] of Object.entries(update)) {
    for (const [path, arg] of Object.entries(fields)) {
      const cur = getPath(doc, path);
      switch (op) {
        case '$set': setPath(doc, path, clone(arg)); break;
        case '$setOnInsert': if (isInsert) setPath(doc, path, clone(arg)); break;
        case '$unset': unsetPath(doc, path); break;
        case '$inc':
          if (cur !== undefined && typeof cur !== 'number') throw new MongoServerError(`Cannot apply $inc to non-numeric ${path}`, 14);
          setPath(doc, path, (cur ?? 0) + arg); break;
        case '$min': if (cur === undefined || cmp(arg, cur) < 0) setPath(doc, path, clone(arg)); break;
        case '$max': if (cur === undefined || cmp(arg, cur) > 0) setPath(doc, path, clone(arg)); break;
        case '$push': {
          const arr = cur ?? [];
          if (!Array.isArray(arr)) throw new MongoServerError(`$push to non-array ${path}`, 2);
          const items = isPlainObject(arg) && '$each' in arg ? arg.$each : [arg];
          arr.push(...items.map(clone));
          if (isPlainObject(arg) && Number.isInteger(arg.$slice) && arg.$slice < 0) arr.splice(0, Math.max(0, arr.length + arg.$slice));
          setPath(doc, path, arr); break;
        }
        case '$addToSet': {
          const arr = cur ?? [];
          const items = isPlainObject(arg) && '$each' in arg ? arg.$each : [arg];
          for (const it of items) if (!arr.some((x) => deepEqual(x, it))) arr.push(clone(it));
          setPath(doc, path, arr); break;
        }
        case '$pull': {
          if (!Array.isArray(cur)) break;
          setPath(doc, path, cur.filter((el) => !(isPlainObject(arg) && isPlainObject(el) ? matches(el, arg) : valueMatches(el, arg))));
          break;
        }
        default: throw new MongoServerError(`unsupported update operator ${op}`, 2);
      }
    }
  }
  return doc;
}

function project(doc, projection) {
  if (!projection || Object.keys(projection).length === 0) return doc;
  const entries = Object.entries(projection);
  const inclusive = entries.some(([k, v]) => v && k !== '_id');
  if (inclusive) {
    const out = {};
    if (projection._id !== 0) out._id = doc._id;
    for (const [k, v] of entries) if (v && k !== '_id' && getPath(doc, k) !== undefined) setPath(out, k, getPath(doc, k));
    return out;
  }
  const out = clone(doc);
  for (const [k, v] of entries) if (!v) unsetPath(out, k);
  return out;
}

function sorter(sort) {
  const keys = Object.entries(sort ?? {});
  return (a, b) => {
    for (const [k, dir] of keys) {
      const c = cmp(getPath(a, k), getPath(b, k));
      if (c) return c * dir;
    }
    return 0;
  };
}

class Cursor {
  constructor(collection, filter, options = {}) {
    this.c = collection;
    this.filter = filter;
    this.opts = { ...options };
  }
  sort(s) { this.opts.sort = s; return this; }
  skip(n) { this.opts.skip = n; return this; }
  limit(n) { this.opts.limit = n; return this; }
  project(p) { this.opts.projection = p; return this; }
  async toArray() {
    let docs = this.c._docs().filter((d) => matches(d, this.filter));
    if (this.opts.sort) docs.sort(sorter(this.opts.sort));
    if (this.opts.skip) docs = docs.slice(this.opts.skip);
    if (this.opts.limit) docs = docs.slice(0, this.opts.limit);
    return docs.map((d) => project(clone(d), this.opts.projection));
  }
}

class Collection {
  constructor(db, name) {
    this.db = db;
    this.collectionName = name;
    this.map = new Map();
    this.indexes = [];
  }
  _docs() { return [...this.map.values()]; }

  _checkUnique(doc, ignoreId) {
    for (const idx of this.indexes) {
      if (!idx.unique) continue;
      if (idx.partialFilterExpression && !matches(doc, idx.partialFilterExpression)) continue;
      const fields = Object.keys(idx.key);
      const key = fields.map((f) => getPath(doc, f));
      if (idx.sparse && key.every((v) => v === undefined)) continue;
      for (const other of this.map.values()) {
        if (other._id === ignoreId) continue;
        if (idx.partialFilterExpression && !matches(other, idx.partialFilterExpression)) continue;
        if (fields.every((f, i) => deepEqual(getPath(other, f) ?? null, key[i] ?? null))) {
          throw new MongoServerError(`E11000 duplicate key error collection: ${this.collectionName} index: ${idx.name}`, 11000);
        }
      }
    }
  }

  async createIndex(key, options = {}) {
    const name = options.name ?? Object.entries(key).map(([k, v]) => `${k}_${v}`).join('_');
    if (!this.indexes.some((i) => i.name === name)) this.indexes.push({ key, name, ...options });
    return name;
  }

  async insertOne(doc) {
    const d = clone(doc);
    if (d._id === undefined) d._id = this.db.newId();
    if (this.map.has(d._id)) throw new MongoServerError(`E11000 duplicate key error collection: ${this.collectionName} index: _id_`, 11000);
    this._checkUnique(d);
    this.map.set(d._id, d);
    this.db.touch();
    return { acknowledged: true, insertedId: d._id };
  }

  async insertMany(docs) {
    const ids = [];
    for (const d of docs) ids.push((await this.insertOne(d)).insertedId);
    return { acknowledged: true, insertedCount: ids.length, insertedIds: ids };
  }

  async findOne(filter = {}, options = {}) {
    const [doc] = await new Cursor(this, filter, { ...options, limit: 1 }).toArray();
    return doc ?? null;
  }

  find(filter = {}, options = {}) { return new Cursor(this, filter, options); }

  async countDocuments(filter = {}) { return this._docs().filter((d) => matches(d, filter)).length; }

  _upsertDoc(filter, update) {
    const base = {};
    for (const [k, v] of Object.entries(filter)) {
      if (!k.startsWith('$') && !(isPlainObject(v) && Object.keys(v).some((x) => x.startsWith('$')))) setPath(base, k, clone(v));
    }
    applyUpdate(base, update, { isInsert: true });
    if (base._id === undefined) base._id = this.db.newId();
    return base;
  }

  _updateDoc(original, update) {
    const next = applyUpdate(clone(original), update);
    if (next._id !== original._id) throw new MongoServerError('Performing an update on the path _id would modify the immutable field', 66);
    this._checkUnique(next, original._id);
    this.map.set(next._id, next);
    return next;
  }

  async updateOne(filter, update, options = {}) {
    const doc = this._docs().find((d) => matches(d, filter));
    if (!doc) {
      if (!options.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
      const created = this._upsertDoc(filter, update);
      this._checkUnique(created);
      this.map.set(created._id, created);
      this.db.touch();
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: created._id };
    }
    const next = this._updateDoc(doc, update);
    this.db.touch();
    return { acknowledged: true, matchedCount: 1, modifiedCount: deepEqual(doc, next) ? 0 : 1, upsertedCount: 0, upsertedId: null };
  }

  async updateMany(filter, update) {
    const docs = this._docs().filter((d) => matches(d, filter));
    // تحقق من كل التحديثات قبل تطبيق أي منها
    const nexts = docs.map((d) => applyUpdate(clone(d), update));
    for (const n of nexts) this._checkUnique(n, n._id);
    for (const n of nexts) this.map.set(n._id, n);
    if (docs.length) this.db.touch();
    return { acknowledged: true, matchedCount: docs.length, modifiedCount: docs.length };
  }

  async replaceOne(filter, replacement, options = {}) {
    const doc = this._docs().find((d) => matches(d, filter));
    const next = clone(replacement);
    if (!doc) {
      if (!options.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      if (next._id === undefined) next._id = filter._id ?? this.db.newId();
      this._checkUnique(next);
      this.map.set(next._id, next);
      this.db.touch();
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: next._id };
    }
    next._id = doc._id;
    this._checkUnique(next, doc._id);
    this.map.set(doc._id, next);
    this.db.touch();
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  }

  /** مثل driver v6: يعيد المستند نفسه (أو null) */
  async findOneAndUpdate(filter, update, options = {}) {
    let docs = this._docs().filter((d) => matches(d, filter));
    if (options.sort) docs.sort(sorter(options.sort));
    const doc = docs[0];
    if (!doc) {
      if (!options.upsert) return null;
      const created = this._upsertDoc(filter, update);
      this._checkUnique(created);
      this.map.set(created._id, created);
      this.db.touch();
      return options.returnDocument === 'after' ? project(clone(created), options.projection) : null;
    }
    const next = this._updateDoc(doc, update);
    this.db.touch();
    return project(clone(options.returnDocument === 'after' ? next : doc), options.projection);
  }

  async deleteOne(filter) {
    const doc = this._docs().find((d) => matches(d, filter));
    if (doc) { this.map.delete(doc._id); this.db.touch(); }
    return { acknowledged: true, deletedCount: doc ? 1 : 0 };
  }

  async deleteMany(filter = {}) {
    const docs = this._docs().filter((d) => matches(d, filter));
    for (const d of docs) this.map.delete(d._id);
    if (docs.length) this.db.touch();
    return { acknowledged: true, deletedCount: docs.length };
  }
}

export class MemoryDb {
  constructor({ newId, onChange } = {}) {
    this.collections = new Map();
    this.newId = newId ?? (() => crypto.randomUUID());
    this.onChange = onChange ?? (() => {});
    this.databaseName = 'memory';
  }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Collection(this, name));
    return this.collections.get(name);
  }
  touch() { this.onChange(); }

  /** تصدير/استيراد لحفظ الحالة في ملف أثناء التطوير، مع الحفاظ على التواريخ */
  static serialize(db) {
    const out = {};
    for (const [name, c] of db.collections) out[name] = { indexes: c.indexes, docs: c._docs() };
    return JSON.stringify(out, function replacer(key, value) {
      const raw = this[key];
      return raw instanceof Date ? { $date: raw.toISOString() } : value;
    });
  }
  static restore(db, json) {
    const data = JSON.parse(json, (k, v) => (v && typeof v === 'object' && typeof v.$date === 'string' && Object.keys(v).length === 1 ? new Date(v.$date) : v));
    for (const [name, { indexes, docs }] of Object.entries(data)) {
      const c = db.collection(name);
      c.indexes = indexes;
      for (const d of docs) c.map.set(d._id, d);
    }
  }
}
