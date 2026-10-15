// قراءة صورة فاتورة مشتريات عبر Claude (رؤية + مخرجات JSON مقيدة بمخطط).
// تعيد أسطراً مرتبة مطابَقة لمواد المخزون الموجودة؛ المستخدم يراجعها ويؤكدها قبل أي إضافة للمخزون.
import Anthropic from '@anthropic-ai/sdk';

export const INVOICE_MODEL = 'claude-opus-5-5';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['supplier', 'date', 'total', 'lines'],
  properties: {
    supplier: { type: ['string', 'null'] },
    date: { type: ['string', 'null'], description: 'YYYY-MM-DD إن ظهر في الفاتورة' },
    total: { type: ['number', 'null'], description: 'إجمالي الفاتورة بالدينار العراقي' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'invoiceQty', 'invoiceUnit', 'lineTotal', 'matchId', 'stockQty'],
        properties: {
          description: { type: 'string', description: 'اسم المادة كما كُتب في الفاتورة' },
          invoiceQty: { type: ['number', 'null'] },
          invoiceUnit: { type: ['string', 'null'], description: 'الوحدة كما في الفاتورة: كيلو، لتر، كرتون، علبة…' },
          lineTotal: { type: ['number', 'null'], description: 'مبلغ السطر بالدينار العراقي' },
          matchId: { type: ['string', 'null'], description: 'معرّف المادة المطابقة من قائمة المخزون، أو null إن لم توجد' },
          stockQty: { type: ['number', 'null'], description: 'الكمية محوّلة إلى وحدة المادة المطابقة في المخزون' },
        },
      },
    },
  },
};

const SYSTEM = `أنت مساعد إدخال مشتريات لمقهى في العراق. تقرأ صورة فاتورة شراء (قد تكون مطبوعة أو بخط اليد، بالعربية أو الإنجليزية) وتستخرج كل سطر مشتريات.
- المبالغ بالدينار العراقي أعداداً صحيحة. إن كُتبت بالآلاف (مثل "25" تحت عمود "الف دينار") فحوّلها إلى دنانير.
- طابق كل سطر مع مادة واحدة من قائمة المخزون المعطاة حسب المعنى (مثلاً "حليب المراعي" ← "حليب كامل"، "بن برازيلي" ← "بن إسبريسو"). إن لم تكن هناك مادة مناسبة فاجعل matchId = null.
- stockQty هي الكمية بوحدة المادة المطابقة: كيلو → غ (×1000)، لتر → مل (×1000)، كرتون أو علبة → عدد القطع إن ظهر في الفاتورة. إن تعذّر التحويل بثقة فاجعلها null.
- لا تخترع أسطراً غير موجودة في الصورة. إن لم تكن الصورة فاتورة فأعد قائمة أسطر فارغة.`;

/**
 * @param {{ apiKey: string, model?: string }} opts
 * @returns {(input: { image: string, mediaType: string, stock: {id:string,name:string,unit:string}[] }) => Promise<object>}
 */
export function createInvoiceReader({ apiKey, model = INVOICE_MODEL }) {
  // محاولتان × 25 ثانية تبقى تحت حد الدالة في Vercel (60 ثانية) فيصل للمستخدم خطأ واضح لا انقطاع
  const client = new Anthropic({ apiKey, timeout: 25_000, maxRetries: 1 });
  return async function readInvoice({ image, mediaType, stock }) {
    const list = stock.map((s) => `${s.id} | ${s.name} | ${s.unit}`).join('\n');
    const response = await client.beta.messages.create({
      model,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          { type: 'text', text: `مواد المخزون (المعرّف | الاسم | الوحدة):\n${list || '(لا توجد مواد بعد)'}\n\nاستخرج أسطر هذه الفاتورة.` },
        ],
      }],
    });
    if (response.stop_reason === 'refusal') throw Object.assign(new Error('refused'), { code: 'SCAN_FAILED' });
    if (response.stop_reason === 'max_tokens') throw Object.assign(new Error('truncated'), { code: 'SCAN_FAILED' });
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error('bad json'), { code: 'SCAN_FAILED' });
    }
  };
}
