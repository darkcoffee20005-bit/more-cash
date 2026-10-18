// صلاحيات الأدوار (على غرار Loyverse Access Rights). الخادم يفرضها؛ الواجهة تخفي ما لا يُسمح به فقط.

export const ROLES = Object.freeze({
  owner: 'المالك',
  manager: 'مدير',
  cashier: 'كاشير',
  barista: 'باريستا',
});

export const PERMISSIONS = Object.freeze({
  'pos.sell': 'البيع',
  'pos.tickets': 'التذاكر المفتوحة',
  'pos.discount': 'تطبيق الخصومات',
  'pos.discount_restricted': 'الخصومات المقيدة',
  'pos.refund': 'الاسترجاع',
  'pos.cancel': 'إلغاء طلب من الوردية الحالية (هدر أو لم يُستلم)',
  'pos.void_saved': 'حذف تذكرة محفوظة',
  'shift.manage': 'فتح وإغلاق الوردية',
  'shift.cash': 'إدخال وسحب نقد',
  'receipts.view': 'عرض الإيصالات',
  'kds.use': 'شاشة التحضير',
  'customers.manage': 'إدارة العملاء',
  'admin.reports': 'التقارير',
  'admin.catalog': 'المنتجات والإضافات والخصومات',
  'admin.inventory': 'المخزون',
  'admin.employees': 'الموظفون',
  'admin.settings': 'الإعدادات',
});

const ALL = Object.keys(PERMISSIONS);

export const ROLE_PERMISSIONS = Object.freeze({
  owner: ALL,
  manager: ALL.filter((p) => p !== 'admin.employees' && p !== 'admin.settings'),
  cashier: ['pos.sell', 'pos.tickets', 'pos.discount', 'pos.cancel', 'shift.manage', 'receipts.view', 'kds.use', 'customers.manage'],
  barista: ['kds.use', 'receipts.view'],
});

export const can = (role, perm) => (ROLE_PERMISSIONS[role] ?? []).includes(perm);
export const permissionsOf = (role) => [...(ROLE_PERMISSIONS[role] ?? [])];
