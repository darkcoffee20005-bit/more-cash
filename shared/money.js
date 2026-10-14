// مبالغ الدينار العراقي: أعداد صحيحة فقط (docs/04_financial_rules.md §1–2).
//
// JavaScript لا يملك int64 أصلياً. القاعدة في هذا التطبيق:
//  - كل مبلغ Number صحيح ضمن Number.isSafeInteger (حتى 9 × 10^15 د.ع) ويُفحص عند كل عملية.
//  - أي ضرب أو قسمة قد يتجاوز النطاق الآمن يتم داخلياً بـ BigInt ثم يُعاد ويُفحص.
//  - لا كسور أبداً؛ النسب بالـ basis points (10000 = 100%).
// بذلك تكون كل العمليات المالية دقيقة تماماً، ومطابقة لـ BIGINT في PostgreSQL.

export class MoneyError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}:${detail}`);
    this.name = 'MoneyError';
    this.code = code;
    this.detail = detail;
  }
}

/** يتحقق أن القيمة مبلغ صحيح آمن ويعيده. */
export function iqd(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new MoneyError('INVALID_AMOUNT', String(value));
  }
  return value;
}

function checked(result) {
  if (!Number.isSafeInteger(result)) throw new MoneyError('AMOUNT_OVERFLOW');
  return result;
}

export const add = (a, b) => checked(iqd(a) + iqd(b));
export const sub = (a, b) => checked(iqd(a) - iqd(b));
export const sum = (values) => values.reduce((acc, v) => add(acc, v), 0);

/** ضرب مبلغ في كمية صحيحة. */
export function times(amount, quantity) {
  iqd(amount);
  if (!Number.isSafeInteger(quantity)) throw new MoneyError('INVALID_QUANTITY', String(quantity));
  return checked(Number(BigInt(amount) * BigInt(quantity)));
}

/** basis points صالحة: عدد صحيح 0..10000 */
export function bp(value) {
  if (!Number.isInteger(value) || value < 0 || value > 10000) throw new MoneyError('INVALID_BASIS_POINTS', String(value));
  return value;
}

/**
 * قاعدة R1: نسبة من مبلغ، تقريب إلى أقرب دينار والنصف لأعلى.
 * percentOf(amount, bp) = floor((amount × bp + 5000) / 10000)
 * مطابق لـ private.percent_of.
 */
export function percentOf(amount, basisPoints) {
  iqd(amount);
  bp(basisPoints);
  if (amount < 0) throw new MoneyError('NEGATIVE_AMOUNT');
  return checked(Number((BigInt(amount) * BigInt(basisPoints) + 5000n) / 10000n));
}

/**
 * توزيع مبلغ على أسس بطريقة Largest Remainder (04 §4). المجموع يساوي المبلغ تماماً،
 * والتعادل يُحسم بالترتيب الأصلي. مطابق لـ private.allocate_proportionally.
 */
export function allocateProportionally(bases, amount) {
  iqd(amount);
  if (amount < 0) throw new MoneyError('NEGATIVE_AMOUNT');
  let total = 0n;
  for (const b of bases) {
    iqd(b);
    if (b < 0) throw new MoneyError('NEGATIVE_BASE');
    total += BigInt(b);
  }
  if (amount === 0 || bases.length === 0) return bases.map(() => 0);
  if (BigInt(amount) > total) throw new MoneyError('ALLOCATION_EXCEEDS_BASE', `amount=${amount} base=${total}`);

  const A = BigInt(amount);
  const shares = bases.map((b) => (A * BigInt(b)) / total);
  const remainders = bases.map((b) => (A * BigInt(b)) % total);
  let left = A - shares.reduce((x, y) => x + y, 0n);

  const order = bases.map((_, i) => i).sort((i, j) => {
    if (remainders[i] === remainders[j]) return i - j;
    return remainders[j] > remainders[i] ? 1 : -1;
  });
  for (const i of order) {
    if (left === 0n) break;
    shares[i] += 1n;
    left -= 1n;
  }
  return shares.map((s) => Number(s));
}

/** تحويل نص أدخله المستخدم إلى مبلغ صحيح؛ يقبل الأرقام العربية والفواصل. يرفض الكسور. */
export function parseIqd(text) {
  const normalized = String(text ?? '')
    .trim()
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[,٬\s]/g, '');
  if (normalized === '') return null;
  if (!/^\d+$/.test(normalized)) throw new MoneyError('INVALID_AMOUNT', String(text));
  return iqd(Number(normalized));
}
