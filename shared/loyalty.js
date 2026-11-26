// برنامج الولاء: مستويات ترقّي تلقائياً حسب إجمالي صرف الزبون، وكل مستوى يزيد النقاط المكتسبة بنسبة.
// يعمل في الخادم (حساب النقاط عند البيع) وفي المتصفح (عرض مستوى الزبون وما يبقى له للترقية).
import { percentOf } from './money.js';
import { pointsEarned } from './calc.js';

export const BASE_TIER = { id: 'bronze', name: 'برونزي', minSpent: 0, bonusBp: 0 };
export const DEFAULT_TIERS = [
  { id: 'silver', name: 'فضي', minSpent: 150_000, bonusBp: 2500 },
  { id: 'gold', name: 'ذهبي', minSpent: 500_000, bonusBp: 5000 },
];
export const DEFAULT_AWAY_DAYS = 30;

/** إعدادات الولاء مكتملة بالقيم الافتراضية (الإعدادات القديمة بلا مستويات تعمل كما هي) */
export function loyaltyOf(settings) {
  const l = settings?.loyalty ?? {};
  return {
    enabled: !!l.enabled, rateBp: l.rateBp ?? 0, welcomePoints: l.welcomePoints ?? 0,
    tiers: Array.isArray(l.tiers) ? l.tiers : DEFAULT_TIERS, awayDays: l.awayDays ?? DEFAULT_AWAY_DAYS,
  };
}

/** مستوى الزبون: أعلى مستوى وصل حدّه */
export function tierOf(totalSpent, tiers = DEFAULT_TIERS) {
  let best = BASE_TIER;
  for (const t of tiers) if ((totalSpent ?? 0) >= t.minSpent && t.minSpent >= best.minSpent) best = t;
  return best;
}

/** المستوى التالي وكم باقٍ عليه (null في أعلى مستوى) */
export function nextTier(totalSpent, tiers = DEFAULT_TIERS) {
  const next = [...tiers].sort((a, b) => a.minSpent - b.minSpent).find((t) => t.minSpent > (totalSpent ?? 0));
  return next ? { tier: next, remaining: next.minSpent - (totalSpent ?? 0) } : null;
}

/** نقاط فاتورة: النسبة الأساسية من الصافي، وزيادة المستوى على النقاط (أعداد صحيحة دائماً) */
export function earnPoints(net, loyalty, totalSpent) {
  if (!loyalty?.enabled) return 0;
  const base = pointsEarned(net, loyalty.rateBp);
  const bonus = tierOf(totalSpent, loyalty.tiers).bonusBp;
  return base + (bonus > 0 ? percentOf(base, bonus) : 0);
}
