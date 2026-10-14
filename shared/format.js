// تنسيق للعرض فقط — لا يُعاد تحليله ولا يدخل في أي حساب.

const AR = '٠١٢٣٤٥٦٧٨٩';

/** 153000 → "153,000" ؛ مع symbol → "153,000 د.ع". الرقم معزول الاتجاه داخل نص عربي. */
export function money(amount, { symbol = true, sign = false } = {}) {
  if (!Number.isSafeInteger(amount)) return '—';
  const neg = amount < 0;
  const s = Math.abs(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const n = `⁦${neg ? '-' : sign && amount > 0 ? '+' : ''}${s}⁩`;
  return symbol ? `${n} د.ع` : n;
}

export const arabicDigits = (s) => String(s).replace(/\d/g, (d) => AR[d]);

export function dateTime(value, tzOffsetMin = 180) {
  if (!value) return '';
  const d = new Date(new Date(value).getTime() + tzOffsetMin * 60000);
  const p = (n) => String(n).padStart(2, '0');
  let h = d.getUTCHours();
  const ampm = h < 12 ? 'ص' : 'م';
  h = h % 12 || 12;
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${h}:${p(d.getUTCMinutes())} ${ampm}`;
}

export function time(value, tzOffsetMin = 180) {
  if (!value) return '';
  const d = new Date(new Date(value).getTime() + tzOffsetMin * 60000);
  let h = d.getUTCHours();
  const ampm = h < 12 ? 'ص' : 'م';
  h = h % 12 || 12;
  return `${h}:${String(d.getUTCMinutes()).padStart(2, '0')} ${ampm}`;
}

/** تاريخ اليوم المحلي YYYY-MM-DD لمنطقة زمنية بإزاحة ثابتة (العراق UTC+3 بلا توقيت صيفي) */
export function localDate(value = Date.now(), tzOffsetMin = 180) {
  return new Date(new Date(value).getTime() + tzOffsetMin * 60000).toISOString().slice(0, 10);
}

/** بداية يوم محلي ونهايته (حصرية) كـ Date UTC */
export function dayRange(fromDate, toDate, tzOffsetMin = 180) {
  const start = new Date(`${fromDate}T00:00:00.000Z`).getTime() - tzOffsetMin * 60000;
  const end = new Date(`${toDate}T00:00:00.000Z`).getTime() - tzOffsetMin * 60000 + 86400000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('INVALID_RANGE');
  return { from: new Date(start), to: new Date(end) };
}

export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** "1,500" أو "١٥٠٠" → 1500. نص فارغ → null. يرفض الكسور. */
export function parseAmount(text) {
  const s = String(text ?? '').trim().replace(/[٠-٩]/g, (d) => String(AR.indexOf(d))).replace(/[,٬\s]/g, '');
  if (s === '') return null;
  if (!/^\d+$/.test(s)) return NaN;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : NaN;
}

export const pct = (bp) => `${(bp / 100).toString()}%`;
