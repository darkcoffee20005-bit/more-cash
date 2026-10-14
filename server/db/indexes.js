// فهارس MongoDB — تُنشأ عند كل تشغيل (createIndex آمن للتكرار). القيود الفريدة هنا هي خط الدفاع
// الأخير ضد التكرار: رقم الإيصال، مفتاح العملية من الجهاز (clientId)، مفاتيح دفتر المخزون والنقاط،
// ووردية مفتوحة واحدة فقط.

export async function ensureIndexes(db) {
  const ix = (name, key, options = {}) => db.collection(name).createIndex(key, options);
  await Promise.all([
    ix('receipts', { number: 1 }, { unique: true, name: 'uniq_number' }),
    ix('receipts', { clientId: 1 }, { unique: true, name: 'uniq_client_id' }),
    ix('receipts', { createdAt: -1 }, { name: 'by_date' }),
    ix('receipts', { shiftId: 1, type: 1 }, { name: 'by_shift' }),
    ix('receipts', { refundOf: 1 }, { name: 'by_refund_of', sparse: true }),
    ix('receipts', { 'prep.status': 1, createdAt: -1 }, { name: 'by_prep' }),
    ix('receipts', { effectsPending: 1 }, { name: 'pending_effects', partialFilterExpression: { effectsPending: true } }),
    ix('shifts', { status: 1 }, { unique: true, name: 'one_open_shift', partialFilterExpression: { status: 'open' } }),
    ix('shifts', { openedAt: -1 }, { name: 'by_opened' }),
    ix('stock_moves', { key: 1 }, { unique: true, name: 'uniq_key' }),
    ix('stock_moves', { variantId: 1, at: -1 }, { name: 'by_variant' }),
    ix('point_moves', { key: 1 }, { unique: true, name: 'uniq_key' }),
    ix('customers', { phone: 1 }, { unique: true, name: 'uniq_phone', partialFilterExpression: { phone: { $type: 'string' } } }),
    ix('customers', { name: 1 }, { name: 'by_name' }),
    ix('categories', { name: 1 }, { unique: true, name: 'uniq_name' }),
    ix('modifiers', { name: 1 }, { unique: true, name: 'uniq_name' }),
    ix('discounts', { name: 1 }, { unique: true, name: 'uniq_name' }),
    ix('items', { name: 1 }, { unique: true, name: 'uniq_name' }),
    ix('variants', { itemId: 1 }, { name: 'by_item' }),
    ix('variants', { sku: 1 }, { unique: true, name: 'uniq_sku', partialFilterExpression: { sku: { $type: 'string' } } }),
    ix('employees', { pinLookup: 1 }, { unique: true, name: 'uniq_active_pin', partialFilterExpression: { active: true } }),
    ix('tickets', { updatedAt: -1 }, { name: 'by_updated' }),
    ix('sessions', { expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl' }),
    ix('audit', { at: -1 }, { name: 'by_date' }),
  ]);
}
