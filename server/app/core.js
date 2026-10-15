// أدوات مشتركة لطبقة الخدمات. لا تستورد أي وحدة خاصة بـ Node: الخدمات تعمل أيضاً داخل المتصفح (النسخة التجريبية).
import { can } from '../../shared/perms.js';

export class AppError extends Error {
  constructor(status, code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.status = status;
    this.code = code;
    this.detail = detail ?? null;
  }
}

export const bad = (code, detail) => new AppError(400, code, detail);
export const notFound = (code = 'NOT_FOUND') => new AppError(404, code);
export const conflict = (code, detail) => new AppError(409, code, detail);
export const forbidden = (perm) => new AppError(403, 'FORBIDDEN', perm);

export function requirePerm(actor, perm) {
  if (!actor) throw new AppError(401, 'NOT_AUTHENTICATED');
  if (!can(actor.role, perm)) throw forbidden(perm);
}

export const isDup = (e) => e?.code === 11000;

// ---------------------------------------------------------------- تحقق من المدخلات
export function str(value, { field, min = 0, max = 120, optional = false } = {}) {
  if (value == null || value === '') {
    if (optional) return null;
    if (min > 0) throw bad('REQUIRED', field);
    return '';
  }
  if (typeof value !== 'string') throw bad('INVALID_TEXT', field);
  const s = value.trim().replace(/\s+/g, ' ');
  if (s.length < min) throw bad('REQUIRED', field);
  if (s.length > max) throw bad('TOO_LONG', field);
  return s;
}

export function int(value, { field, min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  if (value == null || value === '') {
    if (optional) return null;
    throw bad('REQUIRED', field);
  }
  if (!Number.isSafeInteger(value) || value < min || value > max) throw bad('INVALID_NUMBER', field);
  return value;
}

export const bool = (v) => v === true;

export function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw bad('INVALID_CHOICE', field);
  return value;
}

export function id(value, field = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw bad('INVALID_ID', field);
  return value;
}

export const COLORS = ['olive', 'petrol', 'sage', 'teal', 'sand', 'clay', 'mocha', 'slate'];

/** نص بحث آمن للاستخدام داخل $regex */
export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function audit(ctx, action, data = {}) {
  await ctx.db.collection('audit').insertOne({
    _id: ctx.newId(), action, at: ctx.now(), by: ctx.actor?.id ?? null, byName: ctx.actor?.name ?? null, data,
  });
}

export async function nextSeq(db, name) {
  const doc = await db.collection('counters').findOneAndUpdate(
    { _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' },
  );
  return doc.seq;
}

// طرق الدفع الافتراضية القديمة (نقد، بطاقة، زين كاش، FIB) صارت: نقد أو كي
const OLD_PAYMENT_TYPES = JSON.stringify([
  { id: 'cash', name: 'نقد', kind: 'cash', active: true }, { id: 'card', name: 'بطاقة', kind: 'card', active: true },
  { id: 'zain', name: 'زين كاش', kind: 'other', active: true }, { id: 'fib', name: 'FIB', kind: 'other', active: true },
]);
const PAYMENT_TYPES = [
  { id: 'cash', name: 'نقد', kind: 'cash', active: true },
  { id: 'qi', name: 'كي', kind: 'card', active: true },
];

export async function getSettings(db) {
  const s = await db.collection('settings').findOne({ _id: 'store' });
  if (!s) throw new AppError(409, 'NOT_SET_UP');
  // مقهى لم يعدّل طرق الدفع الافتراضية القديمة إطلاقاً (أسماء وأنواع وتفعيل): تُستبدل مرة واحدة (الإيصالات السابقة تحفظ اسم الطريقة)
  if (JSON.stringify(s.paymentTypes?.map(({ id, name, kind, active }) => ({ id, name, kind, active }))) === OLD_PAYMENT_TYPES) {
    s.paymentTypes = PAYMENT_TYPES.map((p) => ({ ...p }));
    await db.collection('settings').updateOne({ _id: 'store' }, { $set: { paymentTypes: s.paymentTypes } });
  }
  return s;
}

/** إخراج مستند للعميل: _id → id، وحذف الحقول الحساسة */
export function out(doc, omit = []) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  for (const k of omit) delete rest[k];
  return { id: _id, ...rest };
}
