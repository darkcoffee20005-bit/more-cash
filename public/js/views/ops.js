// شاشة التحضير (KDS)، الوردية وإدارة النقد، والعملاء.
import { dateTime, esc, money, parseAmount, time } from '../../../shared/format.js';
import { get, post, uid } from '../api.js';
import { icon } from '../icons.js';
import { busy, can, fail, field, modalFrame, on, openModal, render, state, toast } from '../ui.js';
import { printHtml } from './receipts.js';

const PREP = { new: ['جديد', 'بدء التحضير'], preparing: ['قيد التحضير', 'جاهز'], ready: ['جاهز للتسليم', 'تم التسليم'] };
const LATE_MIN = 8;
let kdsTimer = null;

export const routes = {
  kds(s) {
    const list = s.view.kds;
    const tz = s.settings?.tzOffsetMin ?? 180;
    const counts = { new: 0, preparing: 0, ready: 0 };
    for (const o of list ?? []) counts[o.prep.status] += 1;
    const cards = (list ?? []).map((o) => {
      const mins = Math.floor((Date.now() - new Date(o.createdAt).getTime()) / 60000);
      const late = o.prep.status !== 'ready' && mins >= LATE_MIN;
      return `<article class="kds-card ${o.prep.status} ${late ? 'late' : ''}">
        <header><b class="num">#${o.number}</b><span>${esc(o.diningOption ?? '')}</span><span class="spacer"></span><span class="num small">${time(o.createdAt, tz)} · ${mins} د</span></header>
        ${o.customerName || o.ticketName ? `<div class="who small">${esc(o.ticketName ?? o.customerName)}</div>` : ''}
        <ul>${o.lines.map((l) => `<li class="${l.refundedQty >= l.qty ? 'void' : ''}"><b class="num">${l.qty}×</b><div><b>${esc(l.name)}</b> ${esc(l.variant ?? '')}
          ${l.modifiers.length ? `<div class="muted small">${l.modifiers.map(esc).join(' · ')}</div>` : ''}${l.note ? `<div class="small" style="color:var(--warn)">✎ ${esc(l.note)}</div>` : ''}</div></li>`).join('')}</ul>
        <div class="kds-actions"><button class="btn ${o.prep.status === 'ready' ? 'primary' : 'olive'}" data-action="kds-advance" data-id="${o.id}" data-from="${o.prep.status}">${PREP[o.prep.status][1]}</button>
          ${can('pos.refund') && o.lines.some((l) => l.refundedQty < l.qty) ? `<button class="btn danger" data-action="kds-cancel" data-id="${o.id}" aria-label="إلغاء أو استرجاع الطلب #${o.number}">${icon('refund', 'sm')} إلغاء</button>` : ''}</div>
      </article>`;
    }).join('');
    return `<div class="page" style="max-width:none">
      <div class="page-head"><h1>التحضير</h1>
        <span class="pill petrol">جديد ${counts.new}</span><span class="pill olive">قيد التحضير ${counts.preparing}</span><span class="pill ok">جاهز ${counts.ready}</span>
        <button class="btn sm" data-action="kds-refresh">${icon('clock', 'sm')} تحديث</button></div>
      ${list === undefined ? '<p class="muted">جارٍ التحميل…</p>' : list.length ? `<div class="kds">${cards}</div>` : `<div class="card empty">${icon('cup')}<h2>لا طلبات قيد التحضير</h2><p>تظهر الطلبات هنا فور الدفع، وتتحدث كل 10 ثوانٍ.</p></div>`}
    </div>`;
  },

  shift(s) {
    const sh = s.view.shift;
    if (sh === undefined) return '<div class="page"><p class="muted">جارٍ التحميل…</p></div>';
    if (!sh) {
      return `<div class="page" style="max-width:560px"><div class="card pad empty">${icon('clock')}<h2>لا توجد وردية مفتوحة</h2>
        <p>افتح وردية من شاشة البيع لبدء العمل.</p><a class="btn primary" href="#/pos">إلى شاشة البيع</a></div></div>`;
    }
    const L = sh.live;
    const tz = s.settings?.tzOffsetMin ?? 180;
    const row = (label, value, cls = '') => `<div class="r-line ${cls}"><span>${label}</span><span class="num">${value}</span></div>`;
    const counted = parseAmount(s.view.shiftCounted);
    const diff = Number.isSafeInteger(counted) ? counted - L.expectedCash : null;
    return `<div class="page">
      <div class="page-head"><h1>الوردية #${sh.number}</h1><span class="muted">فُتحت ${dateTime(sh.openedAt, tz)} بواسطة ${esc(sh.openedByName)}</span></div>
      <div class="kpis">
        <div class="kpi lead"><span class="label">النقد المتوقع في الدرج</span><b>${money(L.expectedCash)}</b></div>
        <div class="kpi"><span class="label">صافي المبيعات</span><b>${money(L.net)}</b><span class="muted small">${L.salesCount} إيصال</span></div>
        <div class="kpi"><span class="label">المرتجعات</span><b>${money(L.refunds)}</b><span class="muted small">${L.refundsCount} عملية</span></div>
        <div class="kpi"><span class="label">الخصومات</span><b>${money(L.discounts)}</b></div>
      </div>
      <div class="split-view">
        <section class="card pad stack"><h2>حركة النقد</h2>
          ${row('الرصيد الافتتاحي', money(sh.startingCash))}${row('مبيعات نقدية', `+${money(L.cashSales)}`)}${row('مرتجعات نقدية', `−${money(L.cashRefunds)}`)}
          ${row('إدخال نقد', `+${money(L.payIn)}`)}${row('سحب نقد', `−${money(L.payOut)}`)}<div class="dash"></div>${row('<b>المتوقع</b>', `<b>${money(L.expectedCash)}</b>`)}
          ${sh.movements.length ? `<div class="stack small" style="gap:6px">${sh.movements.map((mv) => `<div class="r-line"><span>${mv.type === 'pay_in' ? 'إدخال' : 'سحب'} · ${esc(mv.note)} <span class="muted">${time(mv.at, tz)} ${esc(mv.byName)}</span></span><span class="num">${mv.type === 'pay_in' ? '+' : '−'}${money(mv.amount)}</span></div>`).join('')}</div>` : ''}
          ${can('shift.cash') ? `<div class="row"><button class="btn" data-action="cash-move" data-type="pay_in">${icon('plus', 'sm')} إدخال نقد</button><button class="btn" data-action="cash-move" data-type="pay_out">${icon('minus', 'sm')} سحب نقد</button></div>` : ''}
          <h3>حسب طريقة الدفع</h3>
          ${L.byPayment.length ? L.byPayment.map((p) => row(esc(p.label), money(p.net))).join('') : '<p class="muted small">لا مدفوعات بعد</p>'}
        </section>
        <form class="card pad stack" data-form="shift-close"><h2>إغلاق الوردية</h2>
          <p class="muted">عدّ النقد في الدرج وأدخله. الفرق يُسجَّل ولا يمكن تعديل الوردية بعد إغلاقها.</p>
          ${field('النقد الفعلي في الدرج', `<input class="amount-input" name="actualCash" id="shift-counted" inputmode="numeric" required value="${esc(s.view.shiftCounted ?? '')}" data-input="shift-counted" autocomplete="off">`)}
          <div class="r-line"><span>الفرق</span><b class="num" style="color:${diff === null ? 'inherit' : diff < 0 ? 'var(--bad)' : diff > 0 ? 'var(--warn)' : 'var(--ok)'}">${diff === null ? '—' : money(diff, { sign: true })}</b></div>
          ${field('ملاحظة', '<input name="note" id="shift-note" maxlength="200">', `مطلوبة إن تجاوز الفرق ${money(s.settings?.cashVarianceAlert ?? 0)}`)}
          ${s.ticketsCount ? `<p class="pill warn">${s.ticketsCount} تذكرة مفتوحة غير مدفوعة</p>` : ''}
          <button class="btn primary lg" type="submit" ${s.busy ? 'disabled' : ''}>إغلاق الوردية</button>
        </form>
      </div>
    </div>`;
  },

  customers(s) {
    const v = s.view.customers ?? {};
    const loyalty = s.settings?.loyalty?.enabled;
    const tz = s.settings?.tzOffsetMin ?? 180;
    return `<div class="page">
      <div class="page-head"><h1>العملاء</h1><button class="btn primary" data-action="customer-new">${icon('plus', 'sm')} عميل جديد</button></div>
      <div class="toolbar"><input type="search" id="cu-search" placeholder="ابحث بالاسم أو الهاتف" value="${esc(v.search ?? '')}" data-input="customers-search" autocomplete="off"></div>
      <div class="table-wrap"><table>
        <thead><tr><th>العميل</th><th>الهاتف</th><th class="num">الزيارات</th><th class="num">إجمالي الإنفاق</th>${loyalty ? '<th class="num">النقاط</th>' : ''}<th>آخر زيارة</th></tr></thead>
        <tbody>${(v.list ?? []).map((c) => `<tr class="click" data-action="customer-edit" data-id="${c.id}"><td><b>${esc(c.name)}</b>${c.note ? `<div class="muted small">${esc(c.note)}</div>` : ''}</td>
          <td dir="ltr" style="text-align:end">${esc(c.phone ?? '')}</td><td class="num">${c.visits}</td><td class="num">${money(c.totalSpent)}</td>
          ${loyalty ? `<td class="num"><span class="pill olive">${c.points}</span></td>` : ''}<td class="muted small">${c.lastVisitAt ? dateTime(c.lastVisitAt, tz) : '—'}</td></tr>`).join('')
          || `<tr><td colspan="6"><div class="empty">${icon('users')}<p>${v.list ? 'لا عملاء مطابقين' : 'جارٍ التحميل…'}</p></div></td></tr>`}</tbody>
      </table></div>
    </div>`;
  },
};

// ---------------------------------------------------------------- تقرير الوردية (يُرسل لصاحب المقهى)
export function shiftReportText(x) {
  const sm = x.summary ?? {};
  const tz = state.settings?.tzOffsetMin ?? 180;
  const lines = [
    `🧾 تقرير الوردية #${x.number} — ${state.settings?.name ?? ''}`,
    `فتح: ${dateTime(x.openedAt, tz)} (${x.openedByName ?? ''})`,
    `إغلاق: ${dateTime(x.closedAt, tz)} (${x.closedByName ?? ''})`, '',
    `صافي المبيعات: ${money(sm.net)} — ${sm.salesCount} إيصال`,
    ...(sm.refundsCount ? [`المرتجعات: ${money(sm.refunds)} (${sm.refundsCount})`] : []),
    ...(sm.discounts ? [`الخصومات: ${money(sm.discounts)}`] : []),
    ...(sm.byPayment ?? []).map((p) => `• ${p.label}: ${money(p.net)}`), '',
    '💵 الدرج:', `بداية: ${money(sm.startingCash)}`, `مبيعات نقدية: ${money(sm.cashSales)}`,
    ...(sm.cashRefunds ? [`استرجاع نقدي: ${money(sm.cashRefunds)}`] : []),
    ...(sm.payIn ? [`إدخال: ${money(sm.payIn)}`] : []), ...(sm.payOut ? [`سحب/مصروف: ${money(sm.payOut)}`] : []),
    `المتوقع: ${money(sm.expectedCash)}`, `الفعلي: ${money(x.actualCash)}`,
    `${x.difference === 0 ? '✅' : '⚠️'} الفرق: ${money(x.difference, { sign: true })}`,
    ...(x.note ? [`ملاحظة: ${x.note}`] : []),
  ];
  return lines.join('\n');
}

function shiftReportHtml(x) {
  return `<div class="paper80"><div class="c big">${esc(state.settings?.name ?? '')}</div>${shiftReportText(x).split('\n').map((l) => (l ? `<div>${esc(l)}</div>` : '<hr>')).join('')}</div>`;
}

const CANCEL_REASONS = ['ألغى الزبون الطلب', 'طلب خاطئ', 'تأخر الطلب', 'مشكلة بالجودة', 'أُرجع الطلب'];

export const modals = {
  'kds-cancel'(s) {
    const m = s.modal;
    const o = (s.view.kds ?? []).find((x) => x.id === m.id);
    if (!o) return modalFrame({ title: 'الطلب غير موجود', body: '<p class="muted">ربما سُلّم أو أُلغي من جهاز آخر.</p>' });
    const notStarted = o.prep.status === 'new';
    const types = s.settings.paymentTypes.filter((p) => p.active);
    const refundTotal = o.lines.reduce((a, l, i) => a + (m.qty[i] ? Math.round((l.total * m.qty[i]) / l.qty) : 0), 0);
    const any = Object.values(m.qty).some((q) => q > 0);
    return modalFrame({ title: `إلغاء / استرجاع الطلب #${o.number}`, sub: notStarted ? 'لم يبدأ تحضيره بعد' : PREP[o.prep.status][0], body: `
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
        ${types.length > 1 ? field('إرجاع المبلغ', `<select name="paymentTypeId" id="kds-cancel-type">${types.map((p) => `<option value="${p.id}" ${p.id === o.paymentTypeId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`) : ''}</div>
        ${notStarted ? '<label class="check"><input type="checkbox" name="restockIngredients" id="kds-cancel-ing" checked> إرجاع مكونات المشروبات للمخزون (لم تُحضَّر بعد)</label>' : ''}
        <label class="check"><input type="checkbox" name="restock" id="kds-cancel-restock" ${notStarted ? 'checked' : ''}> إرجاع الأصناف الجاهزة للمخزون (مخبوزات، ماء)</label>
      </form>`,
    foot: `<button class="btn danger solid lg" type="submit" form="kds-cancel-form" ${any && m.reason && !s.busy ? '' : 'disabled'}>${icon('refund', 'sm')} ${any ? `إرجاع ${money(refundTotal)} للزبون` : 'اختر الأصناف'}</button>` });
  },

  'shift-report'(s) {
    const x = s.modal.shift;
    const phone = s.settings?.reportPhone;
    const wa = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(shiftReportText(x))}` : null;
    return modalFrame({ title: `أُغلقت الوردية #${x.number}`, body: `
      <div class="kpis" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <div class="kpi"><span class="label">صافي المبيعات</span><b>${money(x.summary?.net ?? 0)}</b></div>
        <div class="kpi"><span class="label">النقد الفعلي</span><b>${money(x.actualCash)}</b></div>
        <div class="kpi"><span class="label">الفرق</span><b style="color:${x.difference === 0 ? 'var(--ok)' : 'var(--bad)'}">${money(x.difference, { sign: true })}</b></div></div>
      ${wa ? `<a class="btn primary lg block" href="${wa}" target="_blank" rel="noopener">${icon('arrow', 'sm')} إرسال التقرير على واتساب</a>`
        : `<p class="muted small">${can('admin.settings') ? 'أضف رقم واتساب في الإعدادات ليُرسل التقرير بضغطة واحدة.' : 'لم يُضبط رقم واتساب للتقرير بعد (من الإعدادات).'}</p>`}
      <div class="row"><button class="btn" style="flex:1" data-action="shift-report-share">مشاركة</button><button class="btn" style="flex:1" data-action="shift-report-print">${icon('print', 'sm')} طباعة</button></div>`,
      foot: '<button class="btn" data-action="shift-report-close">تم</button>' });
  },

  'cash-move'(s) {
    const t = s.modal.moveType;
    return modalFrame({ title: t === 'pay_in' ? 'إدخال نقد للدرج' : 'سحب نقد من الدرج', body: `<form class="stack" data-form="cash-move-submit">
      ${field('المبلغ (د.ع)', '<input class="amount-input" name="amount" id="move-amount" inputmode="numeric" required autofocus autocomplete="off">')}
      ${field('السبب', `<input name="note" id="move-note" required maxlength="120" placeholder="${t === 'pay_in' ? 'فكة من المالك' : 'شراء ثلج، أجرة توصيل'}">`)}
      <button class="btn primary lg" type="submit" ${s.busy ? 'disabled' : ''}>تسجيل</button></form>` });
  },
  'customer-form'(s) {
    const c = s.modal.customer ?? {};
    return modalFrame({ title: c.id ? c.name : 'عميل جديد', cls: 'wide', body: `<form class="stack" data-form="customer-save">
      <div class="grid-2">${field('الاسم', `<input name="name" id="cf-name" required minlength="2" maxlength="50" value="${esc(c.name ?? '')}">`)}
        ${field('الهاتف', `<input name="phone" id="cf-phone" inputmode="tel" maxlength="20" dir="ltr" value="${esc(c.phone ?? '')}">`)}</div>
      ${field('ملاحظة', `<input name="note" id="cf-note" maxlength="200" value="${esc(c.note ?? '')}" placeholder="يفضل حليب الشوفان…">`)}
      <button class="btn primary" type="submit">حفظ</button></form>
      ${c.receipts ? `<h3>آخر الإيصالات</h3><div class="table-wrap"><table><tbody>${c.receipts.map((r) => `<tr><td class="num">#${r.number}</td><td class="muted small">${dateTime(r.createdAt, s.settings?.tzOffsetMin)}</td><td class="num">${r.type === 'refund' ? '−' : ''}${money(r.total)}</td></tr>`).join('') || '<tr><td class="muted">لا إيصالات</td></tr>'}</tbody></table></div>` : ''}` });
  },
};

export async function enter() {
  clearInterval(kdsTimer);
  if (state.route === 'kds') {
    await loadKds();
    kdsTimer = setInterval(() => { if (state.route === 'kds' && !state.modal) loadKds().catch(() => {}); else if (state.route !== 'kds') clearInterval(kdsTimer); }, 10_000);
  } else if (state.route === 'shift') {
    state.view.shift = undefined;
    render();
    state.view.shift = await get('/api/shifts/current');
    state.shift = state.view.shift;
  } else if (state.route === 'customers') {
    state.view.customers = state.view.customers ?? { search: '' };
    await loadCustomers();
  }
}

async function loadKds() { state.view.kds = await get('/api/kds'); render(); }
async function loadCustomers() { state.view.customers.list = await get('/api/customers', { search: state.view.customers.search }); render(); }

on({
  'kds-refresh': () => loadKds().catch(fail),
  'kds-cancel': (el) => {
    const o = (state.view.kds ?? []).find((x) => x.id === el.dataset.id);
    if (!o) return;
    const qty = {};
    o.lines.forEach((l, i) => { if (l.qty > l.refundedQty) qty[i] = l.qty - l.refundedQty; });
    openModal({ type: 'kds-cancel', id: o.id, qty, reason: null, clientId: uid() });
  },
  'kds-cancel-qty': (el) => {
    const m = state.modal;
    const o = state.view.kds.find((x) => x.id === m.id);
    const i = Number(el.dataset.i);
    const left = o.lines[i].qty - o.lines[i].refundedQty;
    m.qty[i] = Math.max(0, Math.min(left, (m.qty[i] ?? 0) + Number(el.dataset.d)));
    render();
  },
  'kds-cancel-reason': (el) => { state.modal.reason = el.dataset.r; render(); },
  'kds-cancel-submit': (_el, _e, d) => busy(async () => {
    const m = state.modal;
    const o = state.view.kds.find((x) => x.id === m.id);
    const lines = Object.entries(m.qty).filter(([, q]) => q > 0).map(([i, q]) => ({ index: Number(i), qty: q }));
    if (!lines.length || !m.reason) return;
    const reason = d.note ? `${m.reason} — ${d.note}` : m.reason;
    const res = await post(`/api/receipts/${o.id}/refund`, {
      clientId: m.clientId, lines, reason, source: 'kds', paymentTypeId: d.paymentTypeId || o.paymentTypeId || undefined,
      restock: !!d.restock, restockIngredients: !!d.restockIngredients,
    });
    state.modal = null;
    toast(`أُلغي من الطلب #${o.number} · أُرجع ${money(res.receipt.totals.total)} (إيصال #${res.receipt.number})`, 'ok');
    await loadKds();
  }),
  'kds-advance': (el) => busy(async () => {
    const r = await post(`/api/kds/${el.dataset.id}/advance`, { from: el.dataset.from });
    if (r.status === 'served') toast('سُلّم الطلب', 'ok');
    await loadKds();
  }),
  'cash-move': (el) => openModal({ type: 'cash-move', moveType: el.dataset.type, clientId: uid() }),
  'cash-move-submit': (_el, _e, data) => busy(async () => {
    const amount = parseAmount(data.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('أدخل مبلغاً صحيحاً');
    state.view.shift = await post('/api/shifts/move', { clientId: state.modal.clientId, type: state.modal.moveType, amount, note: data.note });
    state.modal = null;
    toast('سُجّلت الحركة', 'ok');
  }),
  'shift-counted': (el) => { state.view.shiftCounted = el.value; render(); },
  'shift-close': (_el, _e, data) => busy(async () => {
    const actualCash = parseAmount(data.actualCash);
    if (!Number.isSafeInteger(actualCash)) throw new Error('أدخل النقد المعدود');
    const closed = await post('/api/shifts/close', { actualCash, note: data.note || null });
    state.shift = null;
    state.view.shift = null;
    state.view.shiftCounted = '';
    toast(`أُغلقت الوردية. الفرق ${money(closed.difference, { sign: true })}`, closed.difference === 0 ? 'ok' : '');
    // تقرير الوردية جاهز للإرسال لصاحب المقهى (واتساب/مشاركة/طباعة)
    openModal({ type: 'shift-report', shift: closed });
  }),
  'shift-report-share': async () => {
    const text = shiftReportText(state.modal.shift);
    if (navigator.share) {
      try { await navigator.share({ title: 'تقرير الوردية', text }); } catch (e) { if (e?.name !== 'AbortError') toast('تعذرت المشاركة', 'bad'); }
      return;
    }
    try { await navigator.clipboard.writeText(text); toast('نُسخ التقرير', 'ok'); } catch { toast('تعذر النسخ', 'bad'); }
  },
  'shift-report-print': () => printHtml(shiftReportHtml(state.modal.shift), 'معاينة تقرير الوردية'),
  'shift-report-close': () => {
    state.modal = null;
    render();
  },
  'customers-search': (el) => {
    const v = state.view.customers;
    v.search = el.value;
    clearTimeout(v.timer);
    v.timer = setTimeout(() => loadCustomers().catch(fail), 250);
  },
  'customer-new': () => openModal({ type: 'customer-form', customer: null }),
  'customer-edit': async (el) => { openModal({ type: 'customer-form', customer: await get(`/api/customers/${el.dataset.id}`) }); },
  'customer-save': (_el, _e, data) => busy(async () => {
    await post('/api/customers', { id: state.modal.customer?.id, name: data.name, phone: data.phone || null, note: data.note || null });
    state.modal = null;
    toast('حُفظ العميل', 'ok');
    await loadCustomers();
  }),
});
