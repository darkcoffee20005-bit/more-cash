// الإيصالات: البحث، التفاصيل، إعادة الطباعة، والاسترجاع (كلي أو جزئي).
import { dateTime, esc, localDate, money, time } from '../../../shared/format.js';
import { get, post, uid } from '../api.js';
import { icon } from '../icons.js';
import { busy, can, fail, field, modalFrame, on, openModal, render, state, toast } from '../ui.js';

const STATUS = { paid: ['مدفوع', 'ok'], partially_refunded: ['مسترجع جزئياً', 'warn'], refunded: ['مسترجع', 'bad'] };

export const routes = {
  receipts(s) {
    const v = s.view.receipts ?? {};
    const list = v.list;
    const selected = v.detail;
    const tz = s.settings?.tzOffsetMin ?? 180;
    let lastDay = '';
    const rows = (list ?? []).map((r) => {
      const day = localDate(r.createdAt, tz);
      const head = day !== lastDay ? `<tr><th colspan="4">${day === localDate(Date.now(), tz) ? 'اليوم' : day}</th></tr>` : '';
      lastDay = day;
      return `${head}<tr class="click ${selected?.id === r.id ? 'sel' : ''}" data-action="receipt-open" data-id="${r.id}">
        <td><b class="num">#${r.number}</b> ${r.type === 'refund' ? '<span class="pill bad">استرجاع</span>' : r.status !== 'paid' ? `<span class="pill ${STATUS[r.status][1]}">${STATUS[r.status][0]}</span>` : ''}
          <div class="muted small">${esc(r.payments.join(' + '))}${r.customerName ? ` · ${esc(r.customerName)}` : ''}</div></td>
        <td class="muted small">${time(r.createdAt, tz)}</td><td class="muted small">${esc(r.employeeName)}</td>
        <td class="num">${r.type === 'refund' ? '−' : ''}${money(r.total)}</td></tr>`;
    }).join('');
    return `<div class="page">
      <div class="page-head"><h1>الإيصالات</h1></div>
      <div class="split-view">
        <div class="stack">
          <div class="toolbar"><input type="search" id="rc-search" placeholder="رقم الإيصال أو اسم العميل" value="${esc(v.search ?? '')}" data-input="receipts-search" autocomplete="off">
            <input type="date" id="rc-date" value="${esc(v.date ?? '')}" data-change="receipts-date" aria-label="اليوم"></div>
          <div class="table-wrap" style="max-height:calc(100vh - 190px);overflow:auto">
            ${list === undefined ? '<p class="muted" style="padding:16px">جارٍ التحميل…</p>' : list.length ? `<table><tbody>${rows}</tbody></table>` : `<div class="empty">${icon('receipt')}<p>لا إيصالات</p></div>`}
          </div>
        </div>
        <div>${selected ? receiptCard(selected, s) : `<div class="card empty">${icon('receipt')}<p>اختر إيصالاً لعرض تفاصيله</p></div>`}</div>
      </div>
    </div>`;
  },
};

function receiptCard(r, s) {
  const tz = s.settings?.tzOffsetMin ?? 180;
  const refundable = r.type === 'sale' && r.lines.some((l) => l.refundedQty < l.qty);
  return `<article class="receipt-paper">
    <div class="row"><div><h2 class="num">#${r.number}</h2><div class="muted small">${dateTime(r.createdAt, tz)} · ${esc(r.employeeName)} · ${esc(r.diningOption ?? '')}</div></div>
      <span class="spacer"></span>${r.type === 'refund' ? `<span class="pill bad">استرجاع للإيصال #${r.refundOfNumber}</span>` : `<span class="pill ${STATUS[r.status][1]}">${STATUS[r.status][0]}</span>`}</div>
    ${r.customerName ? `<div class="row small">${icon('user', 'sm')} ${esc(r.customerName)}${r.pointsEarned ? ` · <span class="pill olive">+${r.pointsEarned} نقطة</span>` : ''}${r.pointsRedeemed ? ` · <span class="pill">استبدل ${r.pointsRedeemed}</span>` : ''}</div>` : ''}
    ${r.reason ? `<div class="small muted">السبب: ${esc(r.reason)}</div>` : ''}
    <div class="dash"></div>
    ${r.lines.map((l) => `<div class="r-line"><div><b>${l.qty}× ${esc(l.itemName)}</b> ${l.variantName ? `<span class="muted">${esc(l.variantName)}</span>` : ''}
        ${l.modifiers.length ? `<div class="muted small">${l.modifiers.map((m) => esc(m.name)).join('، ')}</div>` : ''}
        ${l.note ? `<div class="muted small">✎ ${esc(l.note)}</div>` : ''}
        ${l.refundedQty ? `<div class="small" style="color:var(--bad)">مسترجع ${l.refundedQty}</div>` : ''}</div>
      <div class="num" style="text-align:end">${money(l.gross)}${l.discount ? `<div class="muted small">−${money(l.discount)}</div>` : ''}</div></div>`).join('')}
    <div class="dash"></div>
    <div class="r-line"><span class="muted">المجموع</span><span class="num">${money(r.totals.gross)}</span></div>
    ${r.totals.discountTotal ? `<div class="r-line"><span class="muted">الخصومات${r.discounts?.length ? ` (${esc(r.discounts.map((d) => d.name).join('، '))})` : ''}</span><span class="num">−${money(r.totals.discountTotal)}</span></div>` : ''}
    ${r.totals.tax ? `<div class="r-line"><span class="muted">الضريبة${r.totals.taxMode === 'included' ? ' (مشمولة)' : ''}</span><span class="num">${money(r.totals.tax)}</span></div>` : ''}
    <div class="r-line"><h3>${r.type === 'refund' ? 'المبلغ المسترجع' : 'الإجمالي'}</h3><h3 class="num">${money(r.totals.total)}</h3></div>
    ${r.payments.map((p) => `<div class="r-line small"><span>${esc(p.typeName)}${p.tendered > p.amount ? ` · مستلم ${money(p.tendered)}` : ''}</span><span class="num">${money(p.amount)}${p.change ? ` · باقي ${money(p.change)}` : ''}</span></div>`).join('')}
    ${r.refunds?.length ? `<div class="dash"></div><div class="small"><b>الاسترجاعات:</b> ${r.refunds.map((x) => `<a href="#/receipts" data-action="receipt-open" data-id="${x.id}">#${x.number}</a> (${money(x.totals.total)})`).join(' · ')}</div>` : ''}
    <div class="row wrap" style="margin-top:6px">
      <button class="btn" data-action="receipt-print">${icon('print', 'sm')} طباعة</button>
      ${refundable && can('pos.refund') ? `<button class="btn danger" data-action="refund-start">${icon('refund', 'sm')} استرجاع</button>` : ''}
    </div>
  </article>`;
}

export const modals = {
  refund(s) {
    const m = s.modal;
    const r = s.view.receipts.detail;
    const types = s.settings.paymentTypes.filter((p) => p.active);
    const lines = r.lines.map((l, i) => {
      const left = l.qty - l.refundedQty;
      if (!left) return '';
      const q = m.qty[i] ?? 0;
      return `<div class="row wrap card pad" style="padding:12px"><div style="flex:1;min-width:0"><b>${esc(l.itemName)}</b> ${esc(l.variantName ?? '')}<div class="muted small">متبقٍ ${left} · ${money(l.net)} بعد الخصم للكمية ${l.qty}</div></div>
        <div class="stepper"><button data-action="refund-qty" data-i="${i}" data-d="-1">−</button><span>${q}</span><button data-action="refund-qty" data-i="${i}" data-d="1" ${q >= left ? 'disabled' : ''}>+</button></div></div>`;
    }).join('');
    const any = Object.values(m.qty).some((q) => q > 0);
    return modalFrame({ title: `استرجاع من الإيصال #${r.number}`, cls: 'wide', body: `
      <div class="row"><button class="btn sm" data-action="refund-all">استرجاع الكل</button></div>
      ${lines}
      <form class="stack" data-form="refund-submit" id="refund-form">
        <div class="grid-2">
          ${field('طريقة إرجاع المبلغ', `<select name="paymentTypeId" id="refund-type">${types.map((p) => `<option value="${p.id}" ${p.id === r.payments[0]?.typeId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`)}
          ${field('السبب', '<input name="reason" id="refund-reason" required minlength="2" maxlength="120" placeholder="طلب خاطئ، جودة…">')}
        </div>
        <label class="check"><input type="checkbox" name="restock" id="refund-restock"> إعادة الأصناف الجاهزة إلى المخزون (المشروبات المحضّرة لا تعود)</label>
        <button class="btn danger solid lg" type="submit" ${any && !s.busy ? '' : 'disabled'}>${icon('refund', 'sm')} تنفيذ الاسترجاع</button>
      </form>` });
  },
  'receipt-preview'(s) {
    return modalFrame({ title: s.modal.title ?? 'معاينة الإيصال', body: `<div style="background:#fff;border-radius:8px;padding:8px">${s.modal.html}</div>
      <p class="muted small">الطباعة متاحة في التطبيق المثبت على جهازك؛ هذه معاينة فقط.</p>` });
  },
};

export async function enter(params) {
  if (!state.view.receipts) state.view.receipts = { search: '', date: '' };
  await loadList();
  if (params.sub) await openReceipt(params.sub);
}

async function loadList() {
  const v = state.view.receipts;
  const q = { search: v.search, limit: 120 };
  if (v.date) Object.assign(q, { from: v.date, to: v.date });
  v.list = await get('/api/receipts', q);
  render();
}

async function openReceipt(id) {
  state.view.receipts.detail = await get(`/api/receipts/${id}`);
  render();
}

on({
  'receipts-search': (el) => {
    const v = state.view.receipts;
    v.search = el.value;
    clearTimeout(v.timer);
    v.timer = setTimeout(() => loadList().catch(fail), 250);
  },
  'receipts-date': (el) => { state.view.receipts.date = el.value; loadList().catch(fail); },
  'receipt-open': (el) => openReceipt(el.dataset.id).catch(fail),
  'receipt-print': () => printReceipt(state.view.receipts.detail),
  'refund-start': () => openModal({ type: 'refund', qty: {}, clientId: uid() }),
  'refund-qty': (el) => {
    const m = state.modal;
    const i = Number(el.dataset.i);
    const line = state.view.receipts.detail.lines[i];
    m.qty[i] = Math.max(0, Math.min(line.qty - line.refundedQty, (m.qty[i] ?? 0) + Number(el.dataset.d)));
    render();
  },
  'refund-all': () => {
    const m = state.modal;
    state.view.receipts.detail.lines.forEach((l, i) => { m.qty[i] = l.qty - l.refundedQty; });
    render();
  },
  'refund-submit': (_el, _e, data) => busy(async () => {
    const m = state.modal;
    const r = state.view.receipts.detail;
    const lines = Object.entries(m.qty).filter(([, q]) => q > 0).map(([i, q]) => ({ index: Number(i), qty: q }));
    const res = await post(`/api/receipts/${r.id}/refund`, { clientId: m.clientId, lines, reason: data.reason, paymentTypeId: data.paymentTypeId, restock: data.restock });
    state.modal = null;
    toast(`تم الاسترجاع: ${money(res.receipt.totals.total)} · إيصال #${res.receipt.number}`, 'ok');
    await openReceipt(r.id);
    await loadList();
  }),
});

// ---------------------------------------------------------------- الطباعة (80 مم)
export function receiptHtml(r, settings) {
  const s = settings ?? state.settings ?? {};
  const tz = s.tzOffsetMin ?? 180;
  const m = (n) => money(n, { symbol: false });
  return `<div class="paper80" dir="rtl">
    <div class="c big">${esc(s.name ?? '')}</div>
    ${s.address ? `<div class="c">${esc(s.address)}</div>` : ''}${s.phone ? `<div class="c" dir="ltr">${esc(s.phone)}</div>` : ''}
    ${s.receipt?.header ? `<div class="c">${esc(s.receipt.header)}</div>` : ''}
    <hr><div class="row80"><b>${r.type === 'refund' ? 'استرجاع' : 'إيصال'} #${r.number}</b><span>${esc(r.diningOption ?? '')}</span></div>
    <div>${dateTime(r.createdAt, tz)}</div><div>الكاشير: ${esc(r.employeeName)}</div>
    ${r.customerName && s.receipt?.showCustomer !== false ? `<div>العميل: ${esc(r.customerName)}</div>` : ''}
    ${r.ticketName ? `<div>${esc(r.ticketName)}</div>` : ''}<hr>
    ${r.lines.map((l) => `<div class="row80"><span>${l.qty}× ${esc(l.itemName)}${l.variantName ? ` ${esc(l.variantName)}` : ''}</span><span>${m(l.gross)}</span></div>
      ${l.modifiers.length ? `<div>&nbsp;&nbsp;+ ${l.modifiers.map((x) => esc(x.name)).join('، ')}</div>` : ''}`).join('')}
    <hr><div class="row80"><span>المجموع</span><span>${m(r.totals.gross)}</span></div>
    ${r.totals.discountTotal ? `<div class="row80"><span>الخصم</span><span>-${m(r.totals.discountTotal)}</span></div>` : ''}
    ${r.totals.tax ? `<div class="row80"><span>الضريبة${r.totals.taxMode === 'included' ? ' (مشمولة)' : ''}</span><span>${m(r.totals.tax)}</span></div>` : ''}
    <div class="row80 big"><span>الإجمالي د.ع</span><span>${m(r.totals.total)}</span></div>
    ${r.payments.map((p) => `<div class="row80"><span>${esc(p.typeName)}</span><span>${m(p.tendered ?? p.amount)}</span></div>${p.change ? `<div class="row80"><span>الباقي</span><span>${m(p.change)}</span></div>` : ''}`).join('')}
    ${r.pointsEarned ? `<div>نقاط مكتسبة: ${r.pointsEarned}</div>` : ''}
    <hr>${s.receipt?.footer ? `<div class="c">${esc(s.receipt.footer)}</div>` : ''}
  </div>`;
}

export function printReceipt(r) {
  printHtml(receiptHtml(r));
}

/** طباعة ورقة 80 مم (الإيصال أو التقرير اليومي). النسخة التجريبية تعرض معاينة بدل نافذة الطباعة */
export function printHtml(html, title = 'معاينة الإيصال') {
  if (globalThis.MORECASH_BACKEND) { openModal({ type: 'receipt-preview', html, title }); return; }
  let area = document.getElementById('print-area');
  if (!area) { area = document.createElement('div'); area.id = 'print-area'; document.body.appendChild(area); }
  area.innerHTML = html;
  window.print();
}
