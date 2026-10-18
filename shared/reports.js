// التقارير تُحسب من مستندات الإيصالات نفسها (بيع واسترجاع) — نفس النتيجة على MongoDB وعلى بديل الذاكرة.
//
// التعريفات (على نهج Loyverse):
//   إجمالي المبيعات = مجموع أسعار الأصناف قبل الخصم
//   المرتجعات       = إجمالي الأصناف المسترجعة قبل الخصم
//   الخصومات        = خصومات المبيعات − خصومات الأصناف المسترجعة
//   صافي المبيعات   = إجمالي المبيعات − المرتجعات − الخصومات
//   تكلفة البضاعة   = تكلفة المباع − تكلفة المسترجع
//   الربح الإجمالي  = صافي المبيعات − الضريبة المشمولة − تكلفة البضاعة
//   الضريبة         = ضريبة المبيعات − ضريبة المرتجعات (تُعرض منفصلة)
import { localDate } from './format.js';

const blank = () => ({ gross: 0, refunds: 0, discounts: 0, net: 0, tax: 0, cogs: 0, profit: 0, salesCount: 0, refundsCount: 0, qty: 0, refundedQty: 0 });

function addLine(acc, line, sign, taxIncluded) {
  acc.qty += sign > 0 ? line.qty : 0;
  acc.refundedQty += sign < 0 ? line.qty : 0;
  if (sign > 0) acc.gross += line.gross;
  else acc.refunds += line.gross;
  acc.discounts += sign * line.discount;
  acc.net += sign * line.net;
  acc.tax += sign * line.tax;
  acc.cogs += sign * (line.cost ?? 0);
  acc.profit += sign * (line.net - (taxIncluded ? line.tax : 0) - (line.cost ?? 0));
}

function bucket(map, key, label, extra = {}) {
  if (!map.has(key)) map.set(key, { key, label, ...blank(), ...extra });
  return map.get(key);
}

export function buildReport(receipts, { tzOffsetMin = 180 } = {}) {
  const summary = blank();
  const byItem = new Map();
  const byCategory = new Map();
  const byEmployee = new Map();
  const byPayment = new Map();
  const byModifier = new Map();
  const byDiscount = new Map();
  const byDining = new Map();
  const byDay = new Map();
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, net: 0, salesCount: 0 }));
  let cashIn = 0;
  let wasteCost = 0;
  let cancelledCount = 0;

  for (const r of receipts) {
    const sign = r.type === 'refund' ? -1 : 1;
    const taxIncluded = r.totals.taxMode === 'included';
    const local = new Date(new Date(r.createdAt).getTime() + tzOffsetMin * 60000);
    const day = localDate(r.createdAt, tzOffsetMin);
    const emp = bucket(byEmployee, r.employeeId ?? '-', r.employeeName ?? '-');
    const dayB = bucket(byDay, day, day);
    const dining = bucket(byDining, r.diningOption ?? '-', r.diningOption ?? '-');

    if (sign > 0) {
      summary.salesCount += 1; emp.salesCount += 1; dayB.salesCount += 1; dining.salesCount += 1;
      byHour[local.getUTCHours()].salesCount += 1;
    } else {
      summary.refundsCount += 1; emp.refundsCount += 1; dayB.refundsCount += 1;
      // هدر: مشروب حُضّر ثم أُلغي أو أُرجع؛ تكلفته باقية في تكلفة البضاعة وتُعرض منفصلة
      wasteCost += r.wasteCost ?? 0;
      if (r.cancel) cancelledCount += 1;
    }
    byHour[local.getUTCHours()].net += sign * r.totals.net;

    for (const line of r.lines) {
      for (const acc of [summary, emp, dayB, dining,
        bucket(byItem, `${line.itemId}:${line.variantId}`, line.variantName ? `${line.itemName} — ${line.variantName}` : line.itemName),
        bucket(byCategory, line.categoryId ?? '-', line.categoryName || 'بلا تصنيف')]) {
        addLine(acc, line, sign, taxIncluded);
      }
      for (const m of line.modifiers ?? []) {
        const b = bucket(byModifier, m.name, m.name, { count: 0, amount: 0 });
        b.count += sign * line.qty;
        b.amount += sign * m.price * line.qty;
      }
    }
    for (const p of r.payments ?? []) {
      const b = bucket(byPayment, p.typeId, p.typeName, { paid: 0, refunded: 0, count: 0 });
      if (sign > 0) { b.paid += p.amount; b.count += 1; } else b.refunded += p.amount;
      if (p.kind === 'cash') cashIn += sign * p.amount;
    }
    if (sign > 0) {
      for (const d of r.discounts ?? []) {
        const b = bucket(byDiscount, d.name, d.name, { count: 0, amount: 0 });
        b.count += 1;
        b.amount += d.amount;
      }
    }
  }

  const finish = (m, sortKey = 'net') => [...m.values()].sort((a, b) => b[sortKey] - a[sortKey]);
  for (const p of byPayment.values()) p.net = p.paid - p.refunded;
  summary.avgSale = summary.salesCount ? Math.round(summary.net / summary.salesCount) : 0;
  summary.cashNet = cashIn;
  summary.wasteCost = wasteCost;
  summary.cancelledCount = cancelledCount;
  for (const e of byEmployee.values()) e.avgSale = e.salesCount ? Math.round(e.net / e.salesCount) : 0;

  return {
    summary,
    byItem: finish(byItem),
    byCategory: finish(byCategory),
    byEmployee: finish(byEmployee),
    byPayment: finish(byPayment),
    byModifier: finish(byModifier, 'amount'),
    byDiscount: finish(byDiscount, 'amount'),
    byDining: finish(byDining),
    byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byHour,
  };
}
