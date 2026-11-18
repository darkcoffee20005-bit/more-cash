// نافذة إلغاء الطلب: مشتركة بين شاشة التحضير وصفحة الإيصالات.
// في ملف مستقل حتى لا يستورد ops.js و receipts.js أحدهما الآخر (الاستيراد الدائري يكسر حزمة النسخة التجريبية).
import { esc, money } from '../../../shared/format.js';
import { post, uid } from '../api.js';
import { icon } from '../icons.js';
import { busy, field, modalFrame, on, openModal, render, state, toast } from '../ui.js';

const CANCEL_REASONS = ['لم يستلمه الزبون', 'ألغى الزبون الطلب', 'طلب خاطئ', 'تأخر الطلب', 'مشكلة بالجودة'];
const PREP_LABEL = { new: 'لم يبدأ تحضيره بعد', preparing: 'قيد التحضير', ready: 'جاهز ولم يُسلَّم', served: 'سُلّم' };

/** نافذة الإلغاء مشتركة بين شاشة التحضير وصفحة الإيصالات. order = { id, number, prep, paymentTypeId, lines:[{name, variant, qty, refundedQty, total}] } */
export function openCancel(order, { source = null, after = null } = {}) {
  const qty = {};
  order.lines.forEach((l, i) => { if (l.qty > l.refundedQty) qty[i] = l.qty - l.refundedQty; });
  openModal({ type: 'kds-cancel', order, source, after, qty, reason: null, clientId: uid() });
}

export const modals = {
  'kds-cancel'(s) {
    const m = s.modal;
    const o = m.order;
    const notStarted = o.prep?.status === 'new';
    const waste = !notStarted;
    const types = s.settings.paymentTypes.filter((p) => p.active);
    const refundTotal = o.lines.reduce((a, l, i) => a + (m.qty[i] ? Math.round((l.total * m.qty[i]) / l.qty) : 0), 0);
    const any = Object.values(m.qty).some((q) => q > 0);
    return modalFrame({ title: `إلغاء الطلب #${o.number}`, sub: PREP_LABEL[o.prep?.status] ?? '', body: `
      <div class="stack" style="gap:6px">${o.lines.map((l, i) => {
        const left = l.qty - l.refundedQty;
        if (!left) return '';
        const q = m.qty[i] ?? 0;
        return `<div class="row card" style="padding:6px 10px"><div style="flex:1;min-width:0"><b>${esc(l.name)}</b> ${esc(l.variant ?? '')} <span class="muted small">(${left} من ${l.qty})</span></div>
          <div class="stepper"><button data-action="kds-cancel-qty" data-i="${i}" data-d="-1" aria-label="أقل">−</button><span>${q}</span><button data-action="kds-cancel-qty" data-i="${i}" data-d="1" ${q >= left ? 'disabled' : ''} aria-label="أكثر">+</button></div></div>`;
      }).join('')}</div>
      <form class="stack" data-form="kds-cancel-submit" id="kds-cancel-form">
        <div class="stack" style="gap:6px"><span class="label">السبب</span><div class="row wrap" style="gap:6px">${CANCEL_REASONS.map((r) => `<button type="button" class="chip ${m.reason === r ? 'on' : ''}" data-action="kds-cancel-reason" data-r="${r}">${r}</button>`).join('')}</div></div>
        <div class="grid-2">${field('ملاحظة (اختياري)', '<input name="note" id="kds-cancel-note" maxlength="80" autocomplete="off">')}
        ${types.length > 1 ? field('إرجاع المبلغ', `<select name="paymentTypeId" id="kds-cancel-type"><option value="">كما دفع الزبون</option>${types.map((p) => `<option value="${p.id}">${esc(p.name)} فقط</option>`).join('')}</select>`) : ''}</div>
        ${notStarted ? '<label class="check"><input type="checkbox" name="restockIngredients" id="kds-cancel-ing" checked> إرجاع مكونات المشروبات للمخزون (لم تُحضَّر بعد)</label>' : ''}
        <label class="check"><input type="checkbox" name="restock" id="kds-cancel-restock" ${notStarted ? 'checked' : ''}> إرجاع الأصناف الجاهزة للمخزون (مخبوزات، ماء)</label>
        ${waste ? `<p class="small" style="color:var(--warn);margin:0">${icon('alert', 'sm')} المشروب المحضّر يُسجَّل هدراً: تبقى تكلفته على الربح ويظهر الإلغاء وسببه في التقرير اليومي.</p>` : ''}
      </form>`,
    foot: `<button class="btn danger solid lg" type="submit" form="kds-cancel-form" ${any && m.reason && !s.busy ? '' : 'disabled'}>${icon('refund', 'sm')} ${any ? `إرجاع ${money(refundTotal)} للزبون` : 'اختر الأصناف'}</button>` });
  },

};

on({
  'kds-cancel-qty': (el) => {
    const m = state.modal;
    const o = m.order;
    const i = Number(el.dataset.i);
    const left = o.lines[i].qty - o.lines[i].refundedQty;
    m.qty[i] = Math.max(0, Math.min(left, (m.qty[i] ?? 0) + Number(el.dataset.d)));
    render();
  },
  'kds-cancel-reason': (el) => { state.modal.reason = el.dataset.r; render(); },
  'kds-cancel-submit': (_el, _e, d) => busy(async () => {
    const m = state.modal;
    const o = m.order;
    const lines = Object.entries(m.qty).filter(([, q]) => q > 0).map(([i, q]) => ({ index: Number(i), qty: q }));
    if (!lines.length || !m.reason) return;
    const reason = d.note ? `${m.reason} — ${d.note}` : m.reason;
    const res = await post(`/api/receipts/${o.id}/refund`, {
      clientId: m.clientId, lines, reason, cancel: true, source: m.source ?? undefined, paymentTypeId: d.paymentTypeId || undefined,
      restock: !!d.restock, restockIngredients: !!d.restockIngredients,
    });
    state.modal = null;
    toast(`أُلغي من الطلب #${o.number} · أُرجع ${money(res.receipt.totals.total)}${res.receipt.wasteCost ? ' · سُجّل هدراً' : ''}`, 'ok');
    if (typeof m.after === 'function') await m.after();
  }),
});
