# مور كاش (MoreCash) — تعليمات للمساعد

نظام كاشير وإدارة للكوفي شوب، متعدد المقاهي. Node.js 20+ بلا إطار. الاعتماديات: MongoDB (driver v6)، و`@anthropic-ai/sdk` لقراءة صور الفواتير فقط.
الواجهة SPA عربية RTL بلا مكتبات. ردّ على صاحب المشروع بالعربية.

## الأوامر
- `npm test` — كل الاختبارات (node:test). يجب أن تنجح قبل أي commit.
- `npm start` — خادم محلي على 3000 (بلا MONGODB_URI يستخدم ملف data/dev-db.json).
- `node tests/browser/smoke.mjs [dir]` — فحص متصفح حقيقي (Playwright). `--vercel` بعد `node scripts/build_vercel.mjs`.
- `node scripts/build_demo.mjs docs/index.html` — يعيد بناء النسخة التجريبية لـ GitHub Pages بعد أي تغيير في الواجهة أو الخادم.

## البنية الأساسية
- `server/app/platform.js` — حسابات المقاهي (بريد + كلمة مرور)، ربط الأجهزة (كوكي mc_device)، توجيه كل طلب لتطبيق مقهاه.
- `server/db/scoped.js` — عزل البيانات: كل قراءة/كتابة تُقيَّد بـ tenantId تلقائياً. لا تمرّر قاعدة البيانات الخام لخدمات المقهى أبداً.
- `server/app/*` — خدمات المقهى (لا تعرف بتعدد المقاهي). `shared/` يعمل في الخادم والمتصفح.
- `api/index.js` — دالة Vercel. `GET /api/health` يعرض حالة القاعدة بلا أسرار.
- `public/` — الواجهة. `public/js/views/account.js` الصفحة الرئيسية والحسابات. `public/js/brand.js` الشعار.
- الوصفات: كل حجم يحمل `recipe` (كميات تقريبية من المكونات) تُطرح من المخزون مع كل بيع؛ `GET /api/admin/reports/daily` يجمع مبيعات اليوم والموارد المصروفة (طباعة 80 مم + مشاركة).
- الواجهة مصممة للآيباد: لوحة الطلب يمين وأضيق قليلاً من الأصناف، بلا تمرير (100dvh)، وبألوان فاتحة دائماً.
- استلام المشتريات: يدوياً أو بتصوير فاتورة (`server/app/invoice.js`، نموذج claude-opus-5-5، يعمل فقط إن وُجد ANTHROPIC_API_KEY). القراءة لا تكتب شيئاً؛ المستخدم يراجع ثم `POST /api/admin/inventory/receive`. لا تستورد invoice.js من خدمات المقهى (النسخة التجريبية تُبنى منها للمتصفح) — يُمرَّر `readInvoice` من نقاط الدخول.
- لوحة المزوّد `#/platform` (`server/app/platform-admin.js`): للبريد في PLATFORM_ADMINS فقط؛ كل المقاهي ونشاطها، إيقاف/تفعيل (`tenants.disabled` → SHOP_DISABLED)، وكلمة مرور مؤقتة (`mustChangePassword`). هي الطبقة الوحيدة التي تقرأ عبر المقاهي.
- المصروفات (`server/app/expenses.js`) تُطرح من الربح الإجمالي → `netProfit` في التقارير. سجل العمليات `GET /api/admin/audit` للمالك.
- العمل بلا إنترنت: `public/sw.js` (نسخة التطبيق، الشبكة أولاً، لا يخزّن /api) و`public/js/offline.js` (آخر جلسة وقائمة محفوظة، وطابور مبيعات يُرسل عند عودة الاتصال). الخادم يقبل `offlineAt` ضمن الوردية وآخر 72 ساعة. المبيعات المرفوضة عند الإرسال تظهر للمراجعة.
- الفروع (`server/app/branches.js`): `accounts.branches` = مقاهي المالك (كل فرع tenant مستقل). إنشاء فرع (نسخ القائمة بمعرّفات جديدة ومخزون صفر)، تبديل فرع الجهاز (`devices.tenantId`، للمالك فقط)، وتقرير مجمّع. الدخول من جهاز جديد يفتح الفرع الرئيسي `accounts.tenantId`.
- الإلغاء (`cancel:true` على استرجاع الإيصال): من شاشة التحضير (بما فيها «سُلّم مؤخراً») أو صفحة الإيصالات. صلاحية `pos.cancel` للكاشير لطلبات ورديته الحالية فقط؛ المالك/المدير بلا قيد. `restockIngredients` يعيد مكونات الوصفة فقط إن كان `prep.status='new'`؛ ما لم يعد للمخزون يُسجَّل هدراً (`wasteCost` في سطر الاسترجاع، و`cost=0` فتبقى التكلفة على الربح). الإيصال الملغى يحمل `cancelled {reason, byName, at, full}`، والتقرير اليومي يعرض `cancelled[]` و`summary.wasteCost`.
- طرق الدفع الافتراضية: نقد أو كي. الكوكيز SameSite=Lax (Strict يكسر Safari عند الفتح من رابط).

## قواعد لا تُكسر
- المال أعداد صحيحة بالدينار العراقي فقط (لا float). النسب basis points.
- كل عملية كتابة من الجهاز تحمل clientId فريداً (idempotency).
- كل قيد فريد في `server/db/indexes.js` يبدأ بـ tenantId.
- لا تكتب أي سر (MONGODB_URI، كلمات مرور) في الكود أو السجلات أو الرسائل.

## النشر
- GitHub: darkcoffee20005-bit/more-cash (فرع main). Vercel ينشر تلقائياً مع كل push (مشروع more-cash، منطقة hkg1).
- متغيرات Vercel: MONGODB_URI (Production)، MONGODB_DB=morecash، و PIN_PEPPER اختياري، و ANTHROPIC_API_KEY لقراءة الفواتير، و PLATFORM_ADMINS (بريد المزوّد)، و SUPPORT_WHATSAPP (رقم الدعم بصيغة 964…).
- MongoDB Atlas: Cluster0 (AP_EAST_1)، مستخدم التطبيق morecash_app، الوصول 0.0.0.0/0.

## الوضع الحالي
- الإصدار v1.0.0 منشور على https://more-cash.vercel.app (2026-10-15). `/api/health` → `{"ok":true,"db":"connected"}`.
- اختبار حي شامل قبل الإصدار (37 فحصاً عبر HTTP على الإنتاج): تسجيل، بيع نقد/كي، تكرار العملية، استرجاع، تقرير يومي،
  استلام مشتريات، إغلاق وردية، دخول بجهاز جديد، وعزل كامل بين مقهيين — كلها ناجحة.
- 2026-10-15: حُذفت قاعدة morecash (بيانات الاختبار) وأُعيد النشر فأُنشئت الفهارس؛ القاعدة نظيفة للتوزيع.
  المزوّد (PLATFORM_ADMINS) يسجّل حسابه الحقيقي من #/signup ثم يدخل #/platform. لا تشغّل اختبارات حية تكتب في الإنتاج بعد الآن.
  أدوات الكتابة في Atlas MCP تنتهي مهلتها؛ الحذف يتم من واجهة Atlas.
- قراءة صور الفواتير تنتظر ANTHROPIC_API_KEY في Vercel (`invoiceScan:false` في /api/health).
- قبل الاستخدام التجاري: خطة Vercel Hobby للاستخدام غير التجاري فقط (يلزم Pro)، و Atlas M0 بلا نسخ احتياطي (يلزم M10/Flex بنسخ احتياطي).
