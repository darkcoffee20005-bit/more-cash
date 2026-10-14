// شاشة التحضير (KDS)، الوردية وإدارة النقد، والعملاء.
import { dateTime, esc, money, parseAmount, time } from '../../../shared/format.js';
import { get, post, uid } from '../api.js';
import { icon } from '../icons.js';
import { busy, can, fail, field, modalFrame, on, openModal, render, state, toast } from '../ui.js';

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
        <button class="btn ${o.prep.status === 'ready' ? 'primary' : 'olive'}" data-action="kds-advance" data-id="${o.id}" data-from="${o.prep.status}">${PREP[o.prep.status][1]}</button>
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

export const modals = {
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
  }),
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
