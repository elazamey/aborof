# 📋 قائمة تحقق النشر والتشغيل (Deployment Checklist)

> **المرجع الرئيسي:** وثيقة النشر الكاملة [`DEPLOYMENT.md`](../DEPLOYMENT.md) | دليل التفعيل الحيّ [`handoff/deploy-activation-runbook.md`](../handoff/deploy-activation-runbook.md)  
> **حالة الإصدار:** تم دمج وتحديث هذه القائمة ضمن الإصدار `v0.9.1-docs` لتوحيد سير العمل وإضافة إرشادات استكشاف الأخطاء.

---

## 📌 جدول المتغيرات الموحّدة (Unified Environment Variables)

تأكد من مطابقة أسماء المتغيرات والأسرار حرفياً كما هو موضح أدناه لضمان عمل السكربتات التلقائية وبوابات النشر:

| اسم المتغير / السر | نوعه | النطاق المطلوب | الوصف والاستخدام |
|---|---|---|---|
| `TURSO_DATABASE_URL` | Secret | GitHub (`production`) + Vercel (`Production`) | رابط اتصال قاعدة Turso بصيغة `libsql://<db>-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | Secret | GitHub (`production`) + Vercel (`Production`) | رمز توثيق JWT يبدأ بـ `eyJ...` مكوّن من ثلاثة مقاطع |
| `VERCEL_TOKEN` | Secret | GitHub Actions (`production` أو المستودع) | رمز وصول شخصي من Vercel لإتمام عملية النشر |
| `VERCEL_ORG_ID` | Secret | GitHub Actions (`production` أو المستودع) | معرّف الفريق أو الحساب على Vercel (`orgId`) |
| `VERCEL_PROJECT_ID` | Secret | GitHub Actions (`production` أو المستودع) | معرّف المشروع المستهدف على Vercel (`projectId`) |
| `ADMIN_PASSWORD` | Secret | Vercel (`Production`) | كلمة مرور لوحة الإدارة (12 حرفاً على الأقل) |
| `ADMIN_SESSION_SECRET` | Secret | Vercel (`Production`) | مفتاح عشوائي مشفر لتوقيع جلسات الإدارة (32 حرفاً على الأقل) |
| `DIAGNOSTICS_KEY` | Secret (اختياري) | Vercel (`Production`) | مفتاح **مستقل تماماً** عن سر الجلسة لنقطة `/api/admin/diagnostics` |
| `VERCEL_DEPLOY_ENABLED` | Variable | GitHub Actions (نطاق البيئة `production` أو المستودع) | يجب أن يساوي حرفياً `true` لفتح بوابة النشر |
| `ENABLE_ORDER_TRACKING` | Variable (اختياري) | Vercel (`Production`) | `true` لفتح تتبع الطلبات للعملاء بعد اجتياز الفحوصات |
| `ENABLE_AI_AGENT` | Variable (اختياري) | Vercel (`Production`) | `true` لتفعيل محرك الوكيل الذكي الموحّد |
| `ENABLE_MCP_TOOLS` | Variable (اختياري) | Vercel (`Production`) | `true` لتفعيل أدوات MCP المحكومة |
| `CSP_ENFORCE` | Variable (اختياري) | Vercel (`Production`) | `true` لتحويل سياسة CSP من وضع المراقبة إلى الحجب الصارم |

---

## 🚦 المرحلة الأولى: قائمة التحقق قبل التفعيل (Pre-Deployment)

نفّذ هذه الفحوصات وتأكد من اكتمالها قبل بدء النشر التلقائي أو دمج التغييرات إلى `main`:

- [ ] **إعداد أسرار GitHub Actions:**
  - تمت إضافة `VERCEL_TOKEN` و`VERCEL_ORG_ID` و`VERCEL_PROJECT_ID` في **Settings → Secrets and variables → Actions** (في بيئة `production`).
  - تمت إضافة `TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN` في بيئة `production` لتشغيل مجسّ فحص الأدلة.

- [ ] **إعداد متغيرات بيئة Vercel Runtime:**
  - تمت إضافة `TURSO_DATABASE_URL` برابط اتصال صالح (`libsql://...`).
  - تمت إضافة `TURSO_AUTH_TOKEN` كرمز JWT صالح (`eyJ...`).
  - تمت إضافة `ADMIN_PASSWORD` (مطابق لسياسة 12 حرفاً كحد أدنى).
  - تمت إضافة `ADMIN_SESSION_SECRET` (32 حرفاً على الأقل، ومختلف كلياً عن أي مفتاح تشخيص).
  - *(تذكير هام: أسرار GitHub Actions لا تنتقل تلقائياً لبيئة Vercel Runtime)*.

- [ ] **بوابة النشر وسياسة الفروع:**
  - المتغير `VERCEL_DEPLOY_ENABLED` مضاف في تبويب **Variables** (وليس Secrets) ومضبوط على `true`.
  - التحقق من سياسة البيئة في GitHub: **Settings → Environments → production → Deployment branches** مضبوطة على **All branches** (أو تتضمن `main`) لتجنب رفض النشر.

- [ ] **فحص الاتصال بقاعدة البيانات محلياً أو عبر السكربت:**
  - تشغيل `bash scripts/apply-turso-secrets.sh --dry-run` للتحقق من سلامة البنية الشكلية.
  - أو فحص الاتصال المباشر بالقراءة فقط:
    ```bash
    TURSO_DATABASE_URL="libsql://..." TURSO_AUTH_TOKEN="eyJ..." npm run verify:turso
    ```

---

## 🔍 المرحلة الثانية: خطوات التحقق بعد النشر (Post-Deployment Steps 1–17)

بعد اكتمال بناء ونشر الموقع على Vercel، نفّذ خطوات التحقق الآتية بالترتيب للتأكد من خلو النظام من العيوب:

| # | الطلب / المسار | الاستجابة المتوقعة | دلالة الاستجابة المخالفة وطريقة العلاج |
|---|---|---|---|
| **1** | `GET /` | `200` مع ظهور واجهة المتجر كاملة | فشل في البناء أو عطل في الخادم؛ راجع سجل نشر Vercel |
| **2** | `GET /admin` | `200` ونموذج تسجيل الدخول يظهر | مسار الإدارة مفقود أو معطّل أثناء عملية البناء |
| **3** | `GET /api/admin/session` | `200` مع `{"authenticated":false}` | طبقة الـ API لا تستجيب أو هناك خطأ في Middleware |
| **4** | `POST /api/admin/login` (بكلمة مرور خاطئة) | `401` مع `{"error":"بيانات الدخول غير صحيحة"}` | راجع تفاصيل الاستجابة: `503` تعني نقص متغير بيئة، `429` تعني تجاوز حد المحاولات |
| **5** | `GET /cart` | `200` مع سلة الشراء | خطأ في مكونات العميل (Client Component) |
| **6** | `GET /api/admin/mcp/tools` | `404` عند تعطيل MCP، أو `401` عند التفعيل | `404` هو السلوك الافتراضي المحمي؛ `401` تعني طلب جلسة إدارة صحيحة |
| **7** | على Turso: `SELECT COUNT(*) FROM order_items;` | نجاح الاستعلام بلا خطأ «no such table» | هجرات قاعدة البيانات P0 لم تُطبّق؛ تأكد من اتصال مسار `@/lib/db` |
| **8** | على Turso: وجود جدول `product_search` | ظهور جدول `product_search` من FTS5 | هجرة `0002_search_fts5` لم تُنفّذ على البيئة الحيّة |
| **9** | على Turso: تطابق عدد صفوف `product_search` و`products` | تطابق العدّين بعد أول طلب أو تحديث | الفهرس غير متزامن؛ تتم المزامنة آلياً مع أول طلب بعد التجهيز |
| **10** | `POST /api/orders` ببيانات طلب تجريبي | `200 {ok:true,...}` وتناقص المخزون | فشل كتابة الطلب: راجع صلاحيات وربط `TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN` |
| **11** | `POST /api/orders` ثانية بعد الخطوة 10 | `200` دون تكرار معرفات أو أخطاء | خلل في معاملة خصم المخزون وإنشاء عناصر الطلب المركّبة |
| **12** | `POST /api/chat` بسؤال عن منتج | استجابة تتضمن بطاقات المنتجات المطابقة | تعطل فهرس FTS5 أو طبقة الأدوات؛ راجع إعدادات الذكاء الاصطناعي |
| **13** | `POST /api/orders/track` (بيانات صحيحة + علم التفعيل) | `200` مع بيانات حالة الطلب وعناصره | مسار التتبع معطّل أو معرّفات الطلب غير صحيحة |
| **14** | `POST /api/orders/track` (بيانات هاتف خاطئة) | `404` بنفس الرسالة الموحدة حرفياً | تسريب لمعلومات وجود الطلب من عدمه (مخالفة أمنية) |
| **15** | `GET /product/p1` (لمنتج موجود) | `200` مع ظهور العنوان والوسوم وسعر المنتج | خطأ Next 16 في قراءة `params` بدون `await` (يؤدي لـ 404 لكافة المنتجات) |
| **16** | `GET /product/<معرف-وهمي>` | `404` صريح مع وسم `noindex` فقط | استجابة `200` تعني "404 ناعم" نتيجة حد تحميل جذري غير معزول |
| **17** | فحص ملفات: `robots.txt`, `sitemap.xml`, `manifest.webmanifest`, `icon.svg` | `200` لجميع الملفات والروابط خالية من `/admin` | فشل في مسارات الميتاداتا الديناميكية في Next.js |

### اختبار الخطوة 4 بأمان (فحص جاهزية لوحة الإدارة):

نفّذ الأمر التالي مرة واحدة (حد المعدل هو 8 محاولات لكل 10 دقائق):

```bash
curl -i -X POST https://aborof.vercel.app/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"password":"probe-not-a-real-password"}'
```

- **`401 Unauthorized`:** النظام مهيأ بالكامل، والمتغيرات صحيحة وكلمات المرور الخاطئة تُرفض بأمان.
- **`503 Service Unavailable`:** المتغير ناقص في Vercel، وستذكر رسالة الخطأ الاسم المفقود بدقة (`ADMIN_PASSWORD` أو `ADMIN_SESSION_SECRET`).
- **`429 Too Many Requests`:** تم تجاوز حد المحاولات المسموح؛ انتظر 10 دقائق قبل إعادة المحاولة.

---

## 🛠️ أدوات وسكربتات التحقق المؤتمتة

يحتوي المستودع على أدوات تنفيذية تختصر الوقت وتمنع الأخطاء البشرية:

```bash
# 1. تطبيق أسرار Turso على GitHub وVercel في خطوة واحدة دون كشف القيم
bash scripts/apply-turso-secrets.sh --dry-run
TURSO_DATABASE_URL="libsql://..." TURSO_AUTH_TOKEN="eyJ..." bash scripts/apply-turso-secrets.sh

# 2. فحص اتصال قاعدة البيانات والهجرات الحية (للقراءة فقط)
TURSO_DATABASE_URL="libsql://..." TURSO_AUTH_TOKEN="eyJ..." npm run verify:turso

# 3. فحص الأسرار والمتغيرات المصرح بها مقابل بيئة النشر
npm run verify:secrets -- --env production

# 4. تشغيل فحص الدخان الإنتاجي الشامل (Smoke Test)
npm run smoke:prod

# 5. التحقق من سلامة الواجهة الأمامية والميتاداتا ومنع أخطاء 404
npm run front:check

# 6. جرد المسارات وبوابات الأمان
npm run routes:inventory
```

---

## 🩺 دليل استكشاف الأخطاء وإصلاحها (Troubleshooting Guide)

### 1. خطأ رمز Turso المشوه (`JWT error: Invalid symbol 58, offset 6`)
* **العَرَض:** ظهور الخطأ التالي في السجلات:
  ```text
  JWT error: Base64 error: Invalid symbol 58, offset 6
  ```
* **السبب الجذري:** تم لصق رابط الاتصال `libsql://...` في حقل `TURSO_AUTH_TOKEN`. الرمز 58 في جدول ASCII يمثل النقطتين `:` الموجودة في `libsql:`.
* **الحل:**
  1. ادخل على لوحة تحكم Turso أو استخدم CLI.
  2. أنشئ رمز JWT حقيقي عبر الأمر:
     ```bash
     turso db tokens create azzami-store
     ```
  3. تأكد أن الرمز يبدأ دائماً بـ `eyJ` ويتكون من 3 أجزاء تفصل بينها نقطتان (`.`).
  4. ضعه في حقل `TURSO_AUTH_TOKEN`، وضع الرابط في `TURSO_DATABASE_URL`.

---

### 2. خطأ رابط لوحة التحكم بدلاً من رابط الاتصال (HTTP 400 مقابل HTTP 404)
* **العَرَض:** فشل الاتصال بقاعدة البيانات وظهور رسائل تحويل HTML `HTTP 307 Redirect` أو `HTTP 400`.
* **السبب الجذري:** نسخ رابط لوحة التحكم من المتصفح (مثال: `https://app.turso.tech/org/databases/db`) بدلاً من رابط الاتصال البرمجي.
* **الحل:**
  - انسخ الرابط الصحيح من زر **Connect** في لوحة Turso.
  - الصيغة الصحيحة هي:
    ```text
    libsql://azzami-store-<org>.turso.io
    ```
  - *(ملاحظة تشخيصية: إذا ردت القاعدة بـ 400 برمز خاطئ فهذا يثبت أن اسم القاعدة صحيح وموجود، بينما ردها بـ 404 يعني أن اسم القاعدة نفسه غير موجود).*

---

### 3. انتهاء صلاحية رمز Turso JWT (`401 Unauthorized`)
* **العَرَض:** خطأ مصادقة `401 Unauthorized` عند استعلام القاعدة رغم صحة اسم المستخدم والرابط.
* **السبب الجذري:** إنشاء توكن ذي صلاحية زمنية محددة انتهت مدتها.
* **الحل:**
  - أنشئ توكن دائم للإنتاج:
    ```bash
    turso db tokens create azzami-store --expiration never
    ```
  - حدّث السر فوراً في بيئة Vercel وبيئة GitHub production باستخدام سكربت:
    ```bash
    TURSO_DATABASE_URL="libsql://..." TURSO_AUTH_TOKEN="eyJ..." bash scripts/apply-turso-secrets.sh
    ```

---

### 4. فخ حماية البيئة في GitHub Actions (`Branch "main" is not allowed to deploy`)
* **العَرَض:** فشل مهمة النشر بالرسالة:
  ```text
  Branch "main" is not allowed to deploy to Production due to environment protection rules
  ```
* **السبب الجذري:** بيئة `production` في GitHub مضبوطة على خيار «Protected branches only»، وفرع `main` غير مدرج كفرع محمي (خصوصاً في المستودعات المجانية الخاصة).
* **الحل:**
  - توجه إلى **Settings → Environments → production**.
  - تحت قسم **Deployment branches**، غيّر الخيار إلى **All branches** أو اختر **Allow custom branches** وأضف `main`.

---

### 5. مهمة النشر `Deploy to Vercel` تظهر `skipped` دائماً
* **العَرَض:** انتهاء سير العمل دون تنفيذ وظيفة النشر وبلا أي رسالة خطأ واضحة.
* **السبب الجذري:** شرط `if` على مستوى الوظيفة في GitHub Actions يُقيّم قبل تحميل متغيرات نطاق البيئة، فيرى المتغير `VERCEL_DEPLOY_ENABLED` فارغاً دائماً.
* **الحل:**
  - تم حل المشكلة برمجياً عبر وظيفة وسيطة `deploy-gate`.
  - تأكد من إضافة المتغير `VERCEL_DEPLOY_ENABLED=true` إما على نطاق المستودع العام (Variables) أو نطاق بيئة `production`.

---

### 6. تسريب الكتالوج من البذرة المحلية وفشل الطلبات بـ `503` (Seed Fallback)
* **العَرَض:** واجهة المتجر تعمل وتعرض المنتجات، ولكن أي محاولة لإنشاء طلب تجريبي تفشل بخطأ:
  ```json
  {"error": "قاعدة البيانات غير مربوطة"}
  ```
* **السبب الجذري:** غياب `TURSO_DATABASE_URL` أو `TURSO_AUTH_TOKEN` عن متغيرات بيئة Vercel، مما يجعل النظام يتراجع صامتاً لعرض بيانات المنتجات الثابتة المضمنة محلياً، بينما تعجز مسارات كتابة الطلبات عن العمل.
* **الحل:**
  - أضف السرّين إلى إعدادات Vercel Project → Environment Variables لبيئة Production، ثم أعد نشر آخر إصدار (Redeploy).

---

### 7. خطأ 404 في صفحات المنتجات الفردية (`/product/[id]`)
* **العَرَض:** الصفحة الرئيسية تعمل، ولكن الدخول على أي منتج مثل `/product/p1` يُعيد صفحة `404 Not Found`.
* **السبب الجذري:** في ترقية Next.js 16، أصبحت خاصية `params` في مكونات الصفحات وعداً (Promise) يستلزم استخدام `await params`.
* **الحل:**
  - تأكد من اجتياز فحص `npm run front:check` الذي يمنع وجود أي تراجع في هذه النقطة.

---

### 8. رأس سياسة أمان المحتوى CSP بين المراقبة والحجب
* **العَرَض:** تحذيرات في لوحة تحكم المتصفح حول CSP أو فشل بعض أدوات التحقق.
* **السبب والحل:**
  - افتراضياً، يعمل الرأس في وضع التقرير فقط: `Content-Security-Policy-Report-Only` لجمع الملاحظات دون حجب الموارد.
  - لتفعيل الحجب الصارم في الإنتاج، اضبط المتغير `CSP_ENFORCE=true` في Vercel بعد التأكد من عدم وجود موارد خارجية محجوبة بالخطأ.
