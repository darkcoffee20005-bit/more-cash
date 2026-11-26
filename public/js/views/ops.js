// شاشة التحضير (KDS)، الوردية وإدارة النقد، والعملاء.
import { dateTime, esc, money, parseAmount, time } from '../../../shared/format.js';
import { get, post, uid } from '../api.js';
import { icon } from '../icons.js';
import { busy, can, fail, field, modalFrame, on, openModal, render, state, toast } from '../ui.js';
import { printHtml } from './receipts.js';
import { openCancel } from './cancel.js';
import { loyaltyOf, nextTier, tierOf } from '../../../shared/loyalty.js';

const PREP = { new: ['جديد', 'بدء التحضير'], preparing: ['قيد التحضير', 'جاهز'], ready: ['جاهز للتسليم', 'تم التسليم'] };
const LATE_MIN = 8;
/** عدد البطاقات بالصفحة حسب عرض الشاشة (بلا تمرير على الآيباد) */
const kdsPerPage = () => { const w = globalThis.innerWidth ?? 1366; return w >= 1600 ? 5 : w >= 1180 ? 4 : w >= 860 ? 3 : w >= 600 ? 2 : 99; };
let kdsTimer = null;

export const routes = {
  kds(s) {
    const all = s.view.kds;
    const tz = s.settings?.tzOffsetMin ?? 180;
    const canCancel = can('pos.cancel') || can('pos.refund');
    if (all === undefined) return '<div class="page"><p class="muted">جارٍ التحميل…</p></div>';
    const nowMs = Date.now();
    // ما وصل المطبخ من قبل (طلب طاولة QR دُفع لاحقاً) لا يُعرض مرة ثانية
    const orders = all.map((o) => ({ ...o, lines: o.lines.map((l) => ({ ...l, show: l.qty - (l.sentQty ?? 0) })).filter((l) => l.show > 0) })).filter((o) => o.lines.length).map((o) => {
      const mins = Math.floor((nowMs - new Date(o.createdAt).getTime()) / 60000);
      const done = o.prep.status === 'served';
      const late = !done && o.prep.status !== 'ready' && mins >= LATE_MIN;
      return { ...o, mins, done, late, urgent: !done && !!o.prep.urgent };
    });
    const active = orders.filter((o) => !o.done);
    const counts = { all: active.length, urgent: active.filter((o) => o.urgent).length, late: active.filter((o) => o.late).length,
      new: active.filter((o) => o.prep.status === 'new').length, done: orders.filter((o) => o.done).length };
    const f = s.view.kdsFilter ?? 'all';
    const pick = { all: active, urgent: active.filter((o) => o.urgent), late: active.filter((o) => o.late), new: active.filter((o) => o.prep.status === 'new'), done: orders.filter((o) => o.done) }[f] ?? active;
    // العاجل أولاً، ثم المتأخر، ثم الأقدم
    const list = f === 'done' ? pick : [...pick].sort((a, b) => (b.urgent - a.urgent) || (b.late - a.late) || (new Date(a.createdAt) - new Date(b.createdAt)));
    const per = kdsPerPage();
    const pages = Math.max(1, Math.ceil(list.length / per));
    const page = Math.min(s.view.kdsPage ?? 0, pages - 1);
    const shown = list.slice(page * per, page * per + per);
    const CHIPS = [['all', 'جميع الطلبات'], ['urgent', 'عاجل'], ['late', 'متأخر'], ['new', 'جديد'], ['done', 'مكتمل']];
    const card = (o) => {
      const tone = o.done ? 'done' : o.late ? 'late' : o.urgent ? 'urgent' : o.prep.status;
      const where = o.ticketName ? ['table', o.ticketName] : [o.diningOptionId === 'takeaway' ? 'sale' : o.diningOptionId === 'delivery' ? 'arrow' : 'cup', o.diningOption ?? ''];
      const state = o.done ? 'سُلّم' : o.late ? 'متأخر' : PREP[o.prep.status][0];
      const action = o.done ? '' : o.prep.status === 'ready'
        ? `<button class="kd-go" data-action="kds-advance" data-id="${o.id}" data-from="ready" data-to="served">تم التسليم</button>`
        : `<button class="kd-go" data-action="kds-advance" data-id="${o.id}" data-from="${o.prep.status}" data-to="ready">جاهز</button>`;
      return `<article class="kd-card ${tone}">
        <header><b>رقم #${o.number}</b><span class="kd-time">${icon('clock', 'sm')} ${time(o.createdAt, tz)}${o.done ? '' : ` · ${o.mins} د`}</span></header>
        <div class="kd-sub"><span>${icon(where[0], 'sm')} ${esc(where[1])}</span>${o.qr ? '<span class="kd-flag qr">QR</span>' : ''}${o.urgent ? `<span class="kd-flag">${icon('bolt', 'sm')} عاجل</span>` : ''}<span class="kd-state">${state}</span></div>
        ${o.customerName ? `<div class="kd-who">${icon('user', 'sm')} ${esc(o.customerName)}</div>` : ''}
        <ul class="kd-lines">${o.lines.map((l) => `<li class="${l.refundedQty >= l.qty ? 'void' : ''}">
          <div class="kd-line"><b>${esc(l.name)}${l.variant ? ` <small>${esc(l.variant)}</small>` : ''}</b><span class="kd-qty">×${l.show}</span></div>
          ${l.modifiers.length ? `<div class="kd-box add"><span class="kd-tag">إضافة</span><ul>${l.modifiers.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>` : ''}
          ${l.note ? `<div class="kd-box note"><span class="kd-tag">ملاحظة</span><ul><li>${esc(l.note)}</li></ul></div>` : ''}</li>`).join('')}</ul>
        <footer>${action}
          <div class="kd-tools">${o.done ? '' : `<button class="icon-btn ${o.urgent ? 'on' : ''}" data-action="kds-urgent" data-id="${o.id}" data-v="${o.urgent ? '0' : '1'}" aria-label="${o.urgent ? 'إلغاء العاجل' : 'تعليم كعاجل'}" title="عاجل">${icon('bolt', 'sm')}</button>`}
          ${o.prep.status === 'new' ? `<button class="btn sm" data-action="kds-advance" data-id="${o.id}" data-from="new" data-to="preparing">بدء التحضير</button>` : ''}
          ${canCancel && !o.qr && o.lines.some((l) => l.refundedQty < l.qty) ? `<button class="icon-btn danger" data-action="kds-cancel" data-id="${o.id}" aria-label="إلغاء الطلب #${o.number}" title="إلغاء">${icon('refund', 'sm')}</button>` : ''}</div></footer>
      </article>`;
    };
    return `<div class="kd">
      <div class="kd-head"><h1>شاشة التحضير</h1>
        <div class="kd-chips">${CHIPS.map(([k, t]) => `<button class="${f === k ? 'on' : ''} ${k}" data-action="kds-filter" data-k="${k}">${t} <b>${counts[k]}</b></button>`).join('')}</div>
        <button class="icon-btn" data-action="kds-refresh" aria-label="تحديث">${icon('clock', 'sm')}</button></div>
      ${shown.length ? `<div class="kd-grid" style="--per:${per}">${shown.map(card).join('')}</div>`
        : `<div class="card empty">${icon('cup')}<h2>${f === 'all' ? 'لا طلبات قيد التحضير' : 'لا طلبات هنا'}</h2><p>تظهر الطلبات هنا فور الدفع، وتتحدث كل 10 ثوانٍ.</p></div>`}
      ${pages > 1 ? `<nav class="kd-pager" aria-label="صفحات الطلبات"><button class="icon-btn" data-action="kds-page" data-d="-1" ${page === 0 ? 'disabled' : ''} aria-label="السابق">${icon('arrow', 'sm')}</button>
        <span>${page + 1} / ${pages}</span><button class="icon-btn" data-action="kds-page" data-d="1" ${page >= pages - 1 ? 'disabled' : ''} aria-label="التالي">${icon('back', 'sm')}</button></nav>` : ''}
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
    const L = loyaltyOf(s.settings);
    const loyalty = L.enabled;
    const tz = s.settings?.tzOffsetMin ?? 180;
    const away = !!v.away;
    const days = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400_000) : null);
    // رسالة ترجّع الزبون الغائب: باسمه ونقاطه (رقم عراقي 07… يصير 9647…)
    const wa = (c) => {
      const n = String(c.phone ?? '').replace(/\D/g, '').replace(/^0/, '964');
      const msg = `هلا ${c.name}، اشتاقينالك بـ${s.settings?.name ?? 'مقهانا'} ☕${loyalty && c.points ? ` عندك ${c.points} نقطة تنتظرك، تگدر تستبدلها بزيارتك الجاية.` : ''} نشوفك قريب!`;
      return n.length >= 10 ? `https://wa.me/${n}?text=${encodeURIComponent(msg)}` : null;
    };
    const tierPill = (c) => { const t = tierOf(c.totalSpent, L.tiers); return `<span class="pill tier-${esc(t.id)}">${esc(t.name)}</span>`; };
    return `<div class="page">
      <div class="page-head"><h1>العملاء</h1><button class="btn primary" data-action="customer-new">${icon('plus', 'sm')} عميل جديد</button></div>
      <div class="toolbar"><div class="seg"><button class="${away ? '' : 'on'}" data-action="customers-away" data-v="0">الكل</button><button class="${away ? 'on' : ''}" data-action="customers-away" data-v="1">الغائبون (${L.awayDays} يوم+)</button></div>
        ${away ? '' : `<input type="search" id="cu-search" placeholder="ابحث بالاسم أو الهاتف" value="${esc(v.search ?? '')}" data-input="customers-search" autocomplete="off">`}</div>
      ${away ? `<p class="muted small" style="margin:0">زبائن زاروا من قبل وما رجعوا من ${L.awayDays} يوم أو أكثر. أرسل لهم رسالة واتساب ترجّعهم${loyalty ? ' وتذكّرهم بنقاطهم' : ''}.</p>` : ''}
      <div class="table-wrap"><table>
        <thead><tr><th>العميل</th><th>الهاتف</th><th class="num">الزيارات</th><th class="num">إجمالي الإنفاق</th>${loyalty ? '<th>المستوى</th><th class="num">النقاط</th>' : ''}<th>آخر زيارة</th>${away ? '<th></th>' : ''}</tr></thead>
        <tbody>${(v.list ?? []).map((c) => `<tr class="click" data-action="customer-edit" data-id="${c.id}"><td><b>${esc(c.name)}</b>${c.note ? `<div class="muted small">${esc(c.note)}</div>` : ''}</td>
          <td dir="ltr" style="text-align:end">${esc(c.phone ?? '')}</td><td class="num">${c.visits}</td><td class="num">${money(c.totalSpent)}</td>
          ${loyalty ? `<td>${tierPill(c)}</td><td class="num"><span class="pill olive">${c.points}</span></td>` : ''}<td class="muted small">${c.lastVisitAt ? `${dateTime(c.lastVisitAt, tz)}${away ? `<div>قبل ${days(c.lastVisitAt)} يوم</div>` : ''}` : '—'}</td>
          ${away ? `<td>${wa(c) ? `<a class="btn sm" href="${wa(c)}" target="_blank" rel="noopener" data-stop>${icon('chat', 'sm')} واتساب</a>` : ''}</td>` : ''}</tr>`).join('')
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

// السحب من الدرج: إما مصروف (يُخصم من الربح) أو نقل نقد لا يمس الربح
const OUT_KINDS = { supplies: 'مصروف: مشتريات (ثلج، حليب…)', maintenance: 'مصروف: صيانة', salaries: 'مصروف: رواتب وأجور', utilities: 'مصروف: كهرباء وماء', other: 'مصروف: أخرى', transfer: 'ليس مصروفاً: إيداع بالبنك أو تسليم للمالك' };

export const modals = {
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
      ${t === 'pay_out' ? field('نوع السحب', `<select name="kind" id="move-kind">${Object.entries(OUT_KINDS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>`,
        'المصروف يُخصم من صافي الربح ويظهر في المصروفات. الإيداع بالبنك أو التسليم للمالك لا يُعد مصروفاً.') : ''}
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
async function loadCustomers() {
  const v = state.view.customers;
  v.list = await get('/api/customers', v.away ? { away: '1' } : { search: v.search });
  render();
}

on({
  'kds-refresh': () => loadKds().catch(fail),
  'kds-cancel': (el) => {
    const o = (state.view.kds ?? []).find((x) => x.id === el.dataset.id);
    if (o) openCancel(o, { source: 'kds', after: loadKds });
  },
  'kds-filter': (el) => { state.view.kdsFilter = el.dataset.k; state.view.kdsPage = 0; render(); },
  'kds-page': (el) => { state.view.kdsPage = Math.max(0, (state.view.kdsPage ?? 0) + Number(el.dataset.d)); render(); },
  'kds-urgent': (el) => busy(async () => { await post(`/api/kds/${el.dataset.id}/urgent`, { urgent: el.dataset.v === '1' }); await loadKds(); }),
  'kds-advance': (el) => busy(async () => {
    const r = await post(`/api/kds/${el.dataset.id}/advance`, { from: el.dataset.from, ...(el.dataset.to ? { to: el.dataset.to } : {}) });
    if (r.status === 'served') toast('سُلّم الطلب', 'ok');
    await loadKds();
  }),
  'cash-move': (el) => openModal({ type: 'cash-move', moveType: el.dataset.type, clientId: uid() }),
  'cash-move-submit': (_el, _e, data) => busy(async () => {
    const amount = parseAmount(data.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('أدخل مبلغاً صحيحاً');
    const m = state.modal;
    if (m.moveType === 'pay_out' && data.kind && data.kind !== 'transfer') {
      // مصروف من الدرج: يُسجَّل في المصروفات ويُسحب من الوردية بنفس العملية (لا يتكرر عند إعادة المحاولة)
      await post('/api/admin/expenses', { clientId: m.clientId, amount, category: data.kind, note: data.note, fromDrawer: true });
      state.view.shift = await get('/api/shifts/current');
    } else {
      state.view.shift = await post('/api/shifts/move', { clientId: m.clientId, type: m.moveType, amount, note: data.note });
    }
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
  'customers-away': (el) => { const v = state.view.customers; v.away = el.dataset.v === '1'; v.list = null; render(); loadCustomers().catch(fail); },
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
