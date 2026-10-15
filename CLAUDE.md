# مور كاش (MoreCash) — تعليمات للمساعد

نظام كاشير وإدارة للكوفي شوب، متعدد المقاهي. Node.js 20+ بلا إطار، MongoDB (driver v6) هو الاعتمادية الوحيدة.
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

## قواعد لا تُكسر
- المال أعداد صحيحة بالدينار العراقي فقط (لا float). النسب basis points.
- كل عملية كتابة من الجهاز تحمل clientId فريداً (idempotency).
- كل قيد فريد في `server/db/indexes.js` يبدأ بـ tenantId.
- لا تكتب أي سر (MONGODB_URI، كلمات مرور) في الكود أو السجلات أو الرسائل.

## النشر
- GitHub: darkcoffee20005-bit/more-cash (فرع main). Vercel ينشر تلقائياً مع كل push (مشروع more-cash، منطقة hkg1).
- متغيرات Vercel: MONGODB_URI (Production)، MONGODB_DB=morecash، و PIN_PEPPER اختياري.
- MongoDB Atlas: Cluster0 (AP_EAST_1)، مستخدم التطبيق morecash_app، الوصول 0.0.0.0/0.

## الوضع الحالي
- الموقع منشور على https://more-cash.vercel.app لكن `/api/health` يرد `AUTH_FAILED`:
  كلمة المرور في MONGODB_URI لا تطابق مستخدم morecash_app. يجب ضبطها في Atlas ثم تحديث المتغير في Vercel وإعادة النشر.
- بعد نجاح الاتصال: أنشئ حساب مقهى تجريبياً على الموقع للتأكد، ثم احذف بياناته.
