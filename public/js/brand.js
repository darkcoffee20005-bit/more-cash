// علامة مور كاش: حبة بن شقّها حافة إيصال ممزقة (قهوة + كاشير في رمز واحد).
const CREASE = 'M32 10.5l3.2 4.8-6.4 4.8 6.4 4.8-6.4 4.8 6.4 4.8-6.4 4.8 6.4 4.8-6.4 4.8 3.2 2.4';

export function mark(cls = 'mark') {
  return `<svg class="${cls}" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><rect width="64" height="64" rx="18" fill="#0b4a4a"/><g transform="rotate(32 32 32)"><ellipse cx="32" cy="32" rx="14" ry="22" fill="#b4c83d"/><path d="${CREASE}" fill="none" stroke="#0b4a4a" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/></g></svg>`;
}

export const wordmark = (href = '#/') => `<a class="wordmark" href="${href}" aria-label="مور كاش — الرئيسية">${mark()}<span>مور كاش</span></a>`;
