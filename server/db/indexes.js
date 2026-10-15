// فهارس MongoDB — تُنشأ عند كل تشغيل (createIndex آمن للتكرار). القيود الفريدة هنا هي خط الدفاع
// الأخير ضد التكرار: رقم الإيصال، مفتاح العملية من الجهاز (clientId)، مفاتيح دفتر المخزون والنقاط،
// ووردية مفتوحة واحدة فقط. كل قيد يبدأ بـ tenantId: الرقم 1 في مقهى لا يتصادم مع الرقم 1 في مقهى آخر.

export async function ensureIndexes(db) {
  const ix = (name, key, options = {}) => db.collection(name).createIndex(key, options);
  const t = (key) => ({ tenantId: 1, ...key });
  await Promise.all([
    // ---- المنصة (مشتركة بين المقاهي)
    ix('accounts', { email: 1 }, { unique: true, name: 'uniq_email' }),
    ix('accounts', { tenantId: 1 }, { name: 'by_tenant' }),
    ix('devices', { expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl' }),
    ix('devices', { tenantId: 1 }, { name: 'by_tenant' }),
    ix('devices', { accountId: 1 }, { name: 'by_account' }),
    ix('platform_sessions', { expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl' }),
    ix('platform_errors', { at: 1 }, { expireAfterSeconds: 14 * 86400, name: 'ttl' }),

    // ---- بيانات كل مقهى
    ix('receipts', t({ number: 1 }), { unique: true, name: 'uniq_number' }),
    ix('receipts', t({ clientId: 1 }), { unique: true, name: 'uniq_client_id' }),
    ix('receipts', t({ createdAt: -1 }), { name: 'by_date' }),
    ix('receipts', t({ shiftId: 1, type: 1 }), { name: 'by_shift' }),
    ix('receipts', t({ refundOf: 1 }), { name: 'by_refund_of', sparse: true }),
    ix('receipts', t({ 'prep.status': 1, createdAt: -1 }), { name: 'by_prep' }),
    ix('receipts', { effectsPending: 1 }, { name: 'pending_effects', partialFilterExpression: { effectsPending: true } }),
    ix('shifts', t({ status: 1 }), { unique: true, name: 'one_open_shift', partialFilterExpression: { status: 'open' } }),
    ix('shifts', t({ openedAt: -1 }), { name: 'by_opened' }),
    ix('stock_moves', t({ key: 1 }), { unique: true, name: 'uniq_key' }),
    ix('stock_moves', t({ variantId: 1, at: -1 }), { name: 'by_variant' }),
    ix('stock_moves', t({ at: -1 }), { name: 'by_date' }),
    ix('point_moves', t({ key: 1 }), { unique: true, name: 'uniq_key' }),
    ix('customers', t({ phone: 1 }), { unique: true, name: 'uniq_phone', partialFilterExpression: { phone: { $type: 'string' } } }),
    ix('customers', t({ name: 1 }), { name: 'by_name' }),
    ix('categories', t({ name: 1 }), { unique: true, name: 'uniq_name' }),
    ix('modifiers', t({ name: 1 }), { unique: true, name: 'uniq_name' }),
    ix('discounts', t({ name: 1 }), { unique: true, name: 'uniq_name' }),
    ix('items', t({ name: 1 }), { unique: true, name: 'uniq_name' }),
    ix('variants', t({ itemId: 1 }), { name: 'by_item' }),
    ix('variants', t({ sku: 1 }), { unique: true, name: 'uniq_sku', partialFilterExpression: { sku: { $type: 'string' } } }),
    ix('employees', t({ pinLookup: 1 }), { unique: true, name: 'uniq_active_pin', partialFilterExpression: { active: true } }),
    ix('tickets', t({ updatedAt: -1 }), { name: 'by_updated' }),
    ix('sessions', { expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl' }),
    ix('audit', t({ at: -1 }), { name: 'by_date' }),
    ix('expenses', t({ day: -1 }), { name: 'by_day' }),
    ix('expenses', t({ clientId: 1 }), { unique: true, name: 'uniq_client_id' }),
  ]);
}
