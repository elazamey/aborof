# ضوابط الأمان المركزية — دليل المطور

يوثّق هذا الملف الطبقات الدفاعية المُضافة، وأين يوجد كل ضابط، وكيف تُمنع عودة
المشكلة. المبدأ الحاكم: **الأمان عقود وسياسات واختبارات، لا اجتهاد فردي في كل مسار.**

## 1. طبقة الأخطاء المركزية — `src/lib/errors/`

- `src/lib/errors/index.ts`: `DomainError` بأكواد مستقرة
  (`VALIDATION_FAILED`, `AUTH_INVALID`, `AUTH_REQUIRED`, `RATE_LIMITED`,
  `NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `SERVICE_UNAVAILABLE`,
  `DIAGNOSTICS_DISABLED`, `INTERNAL_ERROR`).
- `toErrorResponse(error, requestId)`: أي خطأ غير معروف يتحول إلى **500 عام**؛
  لا يُرسَل `error.message` الخام ولا الـ stack trace ولا تفاصيل المزود للعميل.
  التفاصيل الكاملة تُسجَّل داخليًا فقط مع `request_id`، بعد تمريرها على
  `redactSecrets()` التي تُخفي توكنات Gemini/Groq و`Bearer` و`key|token|secret|password`.
- `src/lib/errors/handler.ts`: `apiHandler(route, fn)` يغلّف كل مسارات API:
  يولّد/يلتقط `request_id`، يطبّع الاستجابات، ويسجّل المقاييس. `readJson()`
  يفرض حد الحجم ويحوّل JSON الفاسد إلى `VALIDATION_FAILED`.
- **الحاجز:** `scripts/security-gates.mjs` يفشل إذا استخدم أي مسار API
  غير `apiHandler`، أو أعاد `String(e.message)`/`e.stack` للعميل.

## 2. فصل الأسرار — `src/lib/secrets.ts`

- `ADMIN_SESSION_SECRET`: لتوقيع جلسات الإدارة **فقط** (HMAC).
- `DIAGNOSTICS_KEY`: مفتاح **مستقل** لنقطة `/api/admin/diagnostics`.
  يُرفض (بمقارنة آمنة زمنيًا) استخدام نفس قيمة سر الجلسات كمفتاح تشخيص.
- التشخيص **معطّل في الإنتاج افتراضيًا** ولا يُفعَّل إلا بـ `DIAGNOSTICS_ENABLED=true`
  مع وجود مفتاح قوي مستقل؛ وإلا تعيد النقطة 404 موحّدًا.
- سياسة كلمة المرور الموحّدة: `PASSWORD_POLICY.minLength = 12`، مطبّقة عند
  التجهيز/التغيير وموثّقة في `.env.example`.
- `auditSecretConfiguration()` يُنتج تحذيرات (دون أي قيم) لكلمة المرور الضعيفة
  والأسرار المشتركة والمفاتيح الناقصة.
- **الحاجز:** `security-gates.mjs` يمنع ذكر `ADMIN_SESSION_SECRET` خارج
  `src/lib/auth.ts` و`src/lib/secrets.ts`، ويمنع طباعة متغيرات البيئة الحساسة.

## 3. عقود التحقق الموحدة — `src/lib/validation/contracts.ts`

- عقود Zod مركزية لكل عملية كتابية: `createOrderContract`،
  `productUpsertContract`، `orderStatusContract`، `adminLoginContract`،
  `chatRequestContract`.
- العقود الحساسة (الطلبات، المنتجات، تغيير الحالة، الدردشة) تستخدم `.strict()`
  لرفض الحقول غير المعروفة (مثل `tenantId` أو `isAdmin` القادمة من العميل).
- حدود مالية وكمية وأطوال: السعر 0..1,000,000، الكمية 1..100، الأصناف 1..50،
  حالة الطلب من قائمة محددة، طريقة الدفع من قائمة محددة، طول الرسالة ≤ 2000.
- أي فشل يتحول إلى `VALIDATION_FAILED` (422) مع `request_id`.

## 4. تحديد المعدل الموزع — `src/lib/rate-limit.ts`

- واجهة `RateLimitStore` مستقلة عن التطبيق.
- `TursoRateLimitStore`: جدول `rate_limit_counters` مع قيد `UNIQUE(bucket_key)`؛
  الزيادة والفحص في **عبارة UPSERT ذرية واحدة مع RETURNING**، فلا تتسابق
  الطلبات ولا تتجاوز النسخ المتعددة الحد.
- المفتاح مركّب من الغرض (المسار) + هوية العميل (IP من `x-forwarded-for`).
- يُسجَّل كل رفض في المقاييس وتُعاد `Retry-After` صحيحة.
- عند غياب قاعدة البيانات (تطوير محلي) يسقط آمنًا إلى ذاكرة العملية.

## 5. سلامة قاعدة البيانات والعزل — `src/lib/db/`

- هجرات مُرقّمة في `src/lib/db/migrations/` (المرجع `0001_initial.sql` ويُولَّد
  منه ملف TS عبر `scripts/sync-migrations.mjs`).
- مشغّل `runMigrations()` يسجّل كل هجرة في `schema_migrations` مع **checksum SHA-256**
  داخل معاملة (batch write)؛ تغيّر ملف الهجرة بعد التطبيق يفشل البناء/الاختبار.
- قيود على مستوى قاعدة البيانات:
  - `CHECK`: الأسعار والكميات والحالات وأطوال النصوص.
  - `FOREIGN KEY`: `order_items` تشير إلى `orders` (CASCADE) و`products` (RESTRICT).
  - `UNIQUE`: `rate_limit_counters.bucket_key`.
  - فهارس على المفاتيح الأجنبية والتواريخ.
- كل عملية مركّبة (إنشاء طلب: خصم مخزون + طلب + أصناف) تتم في **معاملة واحدة**
  (`src/lib/orders.ts`)؛ الفشل يُرجع المخزون ولا يترك سجلات يتيمة.
- المسارات الإدارية (`GET/PATCH /api/orders`, `POST/DELETE /api/products`)
  تتطلب جلسة إدارة عبر `isAdminRequest` وتعزل القراءة/الكتابة خلف `AUTH_REQUIRED`.
  في هذا المتجر (مستأجر واحد) العزل هو فصل الأوامر الإدارية عن الواجهة العامة؛
  بنية العقود و`.strict()` تمنع تمرير أي معرّف نطاق من العميل.

## 6. رؤوس HTTP والمراقبة — `src/middleware.ts`, `src/lib/security/headers.ts`

- رؤوس مفعّلة فورًا: `Strict-Transport-Security`، `X-Content-Type-Options: nosniff`،
  `X-Frame-Options: DENY`، `Referrer-Policy`، `Permissions-Policy`،
  `Cross-Origin-Opener-Policy`.
- CSP تُنشر أولًا في وضع **`Content-Security-Policy-Report-Only`** (مراقبة)؛
  تُنقل إلى `Content-Security-Policy` بتعيين `CSP_ENFORCE=true` بعد مراجعة التقارير.
- المقاييس (`src/lib/observability/metrics.ts`): عدّادات 2xx/4xx/429/5xx،
  فشل مزودي الذكاء، أزمنة قاعدة البيانات، رفض تحديد المعدل — تُعرض عبر نقطة
  التشخيص المحمية. لا تحتوي على أي محتوى طلبات.

## 7. الاختبارات والحاجز

- `npm test`: 43 اختبارًا (أخطاء، عقود، تحديد معدل متزامن عبر نسختين، هجرات
  وقيود FK/CHECK/UNIQUE، أسرار، رؤوس، عزل/مصادقة، مسارات API).
- `npm run security:gates`: حاجز static على فصل الأسرار وتسريب الأخطاء وتغليف المسارات.
- `node scripts/sync-migrations.mjs --check`: يمنع اختلاف ملف الهجرة المرجعي عن المنفَّذ.
