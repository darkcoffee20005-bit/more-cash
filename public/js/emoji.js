// إيموجي الصنف على شاشة البيع: ما اختاره المالك، وإلا تخمين من اسم الصنف ثم تصنيفه.
export const EMOJIS = ['☕', '🍵', '🧋', '🫖', '🥤', '🧃', '🥛', '🧊', '🍫', '🥐', '🍰', '🍪', '🧁', '🍩', '🥪', '💧', '🍋', '🍓', '🍦', '🥯'];

const RULES = [
  [/ماتشا|matcha/i, '🍵'],
  [/آيس ?كريم|ايس ?كريم|جيلاتو|ice ?cream|gelato/i, '🍦'],
  [/شاي|tea|كرك/i, '🫖'],
  [/فرابي|فراب|frapp|سموذي|smooth|ميلك ?شيك|shake|موهيتو|mojito/i, '🥤'],
  [/عصير|juice|برتقال/i, '🧃'],
  [/ليمون|lemon/i, '🍋'],
  [/آيس|ايس|مثلج|بارد|\bice\b|iced|cold/i, '🧋'],
  [/ماء|مي |water/i, '💧'],
  [/كرواس|croiss/i, '🥐'],
  [/كوكي|cookie|بسكو/i, '🍪'],
  [/مافن|كب ?كيك|muffin|cupcake/i, '🧁'],
  [/دونات|donut/i, '🍩'],
  [/كيك|كيكة|تشيز|cake|براوني|brown/i, '🍰'],
  [/ساندو|سندويش|sandw|توست|toast/i, '🥪'],
  [/بيغل|bagel|معجن|فطير/i, '🥯'],
  [/هوت ?شوك|شوكولا|كاكاو|choco|cocoa/i, '🍫'],
  [/حلو|مخبوز|dessert|bake/i, '🍰'],
  [/قهوة|اسبريسو|إسبريسو|لاتيه|كابت|موكا|امريكان|أمريكان|coffee|espresso|latte|mocha/i, '☕'],
  [/حليب|milk/i, '🥛'],
];

export function guessEmoji(name = '', categoryName = '') {
  for (const text of [name, categoryName]) {
    for (const [re, e] of RULES) if (re.test(text)) return e;
  }
  return '☕';
}

/** الإيموجي الظاهر للصنف */
export const itemEmoji = (item, categoryName) => item?.emoji || guessEmoji(item?.name, categoryName);
