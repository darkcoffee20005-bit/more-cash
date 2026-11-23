// خريطة الطاولات: لوحة افتراضية 1000×600 وحدة تُرسم بالنسب المئوية فتتسع لأي شاشة.
// تُستخدم في محرر الإدارة (سحب وتغيير حجم)، وعند حفظ التذكرة (اختيار طاولة)، وفي قائمة التذاكر (فتح تذكرة الطاولة).
import { esc, money } from '../../shared/format.js';
import { render, state } from './ui.js';

export const FLOOR_W = 1000;
export const FLOOR_H = 600;
const SNAP = 10;

export const floorTables = (s = state) => s.settings?.floor?.tables ?? [];
export const hasFloor = (s = state) => floorTables(s).some((t) => t.kind === 'table');

/**
 * mode: 'pick' (اختيار طاولة فارغة) | 'open' (فتح تذكرة طاولة مشغولة) | 'edit' (المحرر)
 * occupied: Map tableId → التذكرة المفتوحة عليها
 */
export function floorMap(tables, { mode, occupied = new Map(), selected = null, current = null } = {}) {
  const els = tables.map((t) => {
    const tk = t.kind === 'table' ? occupied.get(t.id) : null;
    const isCurrent = current && t.id === current;
    const cls = ['ft', t.kind, t.shape, tk ? 'busy' : '', selected === t.id ? 'sel' : '', isCurrent ? 'cur' : ''].join(' ');
    const style = `left:${t.x / 10}%;top:${(t.y / FLOOR_H) * 100}%;width:${t.w / 10}%;height:${(t.h / FLOOR_H) * 100}%`;
    const label = `<b>${esc(t.name)}</b>${t.kind === 'table' ? `<small>${tk ? money(tk.displayTotal) : t.seats ? `${t.seats} مقاعد` : 'فارغة'}</small>` : ''}`;
    if (mode === 'edit') {
      return `<div class="${cls}" style="${style}" data-floor-edit="${esc(t.id)}" role="button" tabindex="0" aria-label="${esc(t.name)}">${label}
        ${selected === t.id ? '<span class="ft-resize" data-floor-resize aria-hidden="true"></span>' : ''}</div>`;
    }
    if (t.kind !== 'table') return `<div class="${cls}" style="${style}" aria-hidden="true">${label}</div>`;
    // الاختيار: الطاولة الفارغة (أو طاولة التذكرة الحالية) تُختار؛ الفتح: المشغولة تُفتح
    const enabled = mode === 'pick' ? !tk || isCurrent : !!tk;
    const action = mode === 'pick' ? 'floor-pick' : 'ticket-open';
    const dataId = mode === 'pick' ? t.id : tk?.id ?? '';
    return `<button type="button" class="${cls}" style="${style}" ${enabled ? `data-action="${action}" data-id="${esc(dataId)}"` : 'disabled'}
      aria-label="${esc(t.name)}${tk ? ` — مشغولة ${money(tk.displayTotal)}` : ' — فارغة'}">${label}</button>`;
  }).join('');
  return `<div class="floor ${mode}"><div class="floor-canvas" data-floor-canvas>${els || '<p class="muted floor-empty">لا طاولات بعد</p>'}</div></div>`;
}

export function floorLegend() {
  return '<div class="row wrap small muted" style="gap:14px"><span class="floor-key free"></span> فارغة <span class="floor-key busy"></span> عليها تذكرة مفتوحة</div>';
}

// ---------------------------------------------------------------- سحب وتغيير حجم في المحرر
// الشاشة تُعاد رسمها كل ثانية (الساعة) فيُستبدل العنصر أثناء السحب: المستمعون على window، والعنصر يُقرأ من جديد مع كل حركة
const snap = (v) => Math.round(v / SNAP) * SNAP;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function installFloorEditor(getEditor) {
  if (typeof document === 'undefined') return;
  document.addEventListener('pointerdown', (e) => {
    const ed = getEditor();
    if (!ed) return;
    const resize = e.target.closest?.('[data-floor-resize]');
    const box = e.target.closest?.('[data-floor-edit]');
    if (!box) return;
    const t = ed.tables.find((x) => x.id === box.dataset.floorEdit);
    if (!t) return;
    e.preventDefault();
    if (ed.selected !== t.id) { ed.selected = t.id; render(); }
    const canvas = document.querySelector('[data-floor-canvas]');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const unitX = FLOOR_W / rect.width;
    const unitY = FLOOR_H / rect.height;
    const start = { x: e.clientX, y: e.clientY, t: { ...t } };
    let moved = false;
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      const dx = (ev.clientX - start.x) * unitX;
      const dy = (ev.clientY - start.y) * unitY;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      if (resize) {
        // المقبض في الزاوية اليمنى السفلى (الموضع بـ left فيبقى طرفه الأيسر ثابتاً)، ولا يتجاوز اللوحة
        t.w = clamp(snap(start.t.w + dx), 30, FLOOR_W - t.x);
        t.h = clamp(snap(start.t.h + dy), 30, FLOOR_H - t.y);
      } else {
        t.x = clamp(snap(start.t.x + dx), 0, FLOOR_W - t.w);
        t.y = clamp(snap(start.t.y + dy), 0, FLOOR_H - t.h);
      }
      const el = document.querySelector(`[data-floor-edit="${CSS.escape(t.id)}"]`);
      if (el) Object.assign(el.style, { left: `${t.x / 10}%`, top: `${(t.y / FLOOR_H) * 100}%`, width: `${t.w / 10}%`, height: `${(t.h / FLOOR_H) * 100}%` });
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (moved) { ed.dirty = true; render(); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  // الأسهم تحرّك العنصر المختار (لوحة مفاتيح أو آيباد بكيبورد)
  document.addEventListener('keydown', (e) => {
    const ed = getEditor();
    const box = e.target.closest?.('[data-floor-edit]');
    if (!ed || !box || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const t = ed.tables.find((x) => x.id === box.dataset.floorEdit);
    if (!t) return;
    e.preventDefault();
    const d = { ArrowLeft: [-SNAP, 0], ArrowRight: [SNAP, 0], ArrowUp: [0, -SNAP], ArrowDown: [0, SNAP] }[e.key];
    t.x = clamp(t.x + d[0], 0, FLOOR_W - t.w);
    t.y = clamp(t.y + d[1], 0, FLOOR_H - t.h);
    ed.dirty = true;
    render();
    document.querySelector(`[data-floor-edit="${CSS.escape(t.id)}"]`)?.focus();
  });
}
