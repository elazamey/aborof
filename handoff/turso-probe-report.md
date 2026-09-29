# تقرير مجسّ Turso — الصفوف conn · mig-table · mig-parity · row-7 · row-8 · row-9 · tables

الفرع: `arena/01a0e7d5-aborof` · نقطة الانطلاق: `main` = `5412e04` · التاريخ: 2026-09-28
طلب الدمج: [#15](https://github.com/elazamey/aborof/pull/15) · آخر تشغيل: [run 36421481779](https://github.com/elazamey/aborof/actions/runs/36421481779)

## 0) الخلاصة — السبب الجذري نهائي، والقاعدة **موجودة**

المشكلة **ليست في القاعدة ولا في الكود**: الحقلان كلاهما يحمل قيمة خاطئة من نوع مختلف.

| الحقل | القيمة الفعلية (وصفًا لا نصًّا) | ما ينبغي أن يكون |
|---|---|---|
| `TURSO_DATABASE_URL` | **صفحة لوحة تحكم**: 47 حرفًا · المضيف `app.turso.tech` · مقاطع المسار `8/9/5` (`/org/databases/db`) | رابط اتصال: `libsql://<db>-<org>.turso.io` (~32 حرفًا) |
| `TURSO_AUTH_TOKEN` | **رابط اتصال**: 51 حرفًا يبدأ بـ `libsql://` والنقطتان `:` في الموضع 6، وبلا معامل `authToken` داخله | رمز **JWT** يبدأ بـ `eyJ…` (ثلاث مقاطع مفصولة بنقاط) |

**لماذا هذا هو الدليل القاطع؟** الخادم نفسه نطق بالسبب: على اسم القاعدة القانوني ردّ
`HTTP 400 — {"error":"JWT error: Base64 error: Invalid symbol 58, offset 6."}` — والرمز 58 هو `:`
والموضع 6 هو ما بعد `libsql`، أي أن **الخادم قرأ قيمة حقل الرمز، فوجدها رابطًا لا JWT**.

**والأهم: قاعدة البيانات موجودة.** طُلب الاسم **المعكوس** (`<org>-<db>.turso.io`) بنفس الرمز المعطوب
فأعاد **`404 لا قاعدة بهذا الاسم`**، بينما الاسم **القانوني** (`<db>-<org>.turso.io`) أعاد **`400`**.
أي أن **التحقق من وجود القاعدة يسبق التحقق من الرمز**: لو لم تكن القاعدة موجودة لكان الاسم القانوني أعاد 404 أيضًا.
⇒ لا حاجة لإنشاء قاعدة جديدة؛ الناقص هو **رمز JWT صالح** فقط، وتحريك القيم إلى حقولها الصحيحة.

---

## 1) الجدول المطلوب — مُعبَّأ

| PROBE | STATUS | EVIDENCE | FAILURE DOMAIN |
|---|---|---|---|
| conn | ❌ | HTML بدل JSON على قيمة اللوحة (`HTTP 307 · Redirecting...`)، وقيمتان في غير محلهما (الجدول §0) | **إعداد/مصادقة** |
| mig-table | ⛔ محجوب | لا اتصال بعد. جدول الهجرات في هذا المستودع اسمه **`schema_migrations`** لا `_prisma_migrations`/`drizzle_migrations` (انظر §4) | إعداد (نفس السبب) |
| mig-parity | ⛔ محجوب | المستودع فيه هجرتان فقط: `0001_initial` و`0002_search_fts5` — **لا وجود لـ 0003** (الرقم في `handoff/` ترقيم رِقاع لا هجرة) · المقارنة ✅ على قاعدة محلية | كود↔قاعدة (محجوب) |
| row-7 | ⛔ محجوب | `SELECT COUNT(*) FROM order_items` = `0` بلا `no such table` على قاعدة جديدة ✅ | بنية (محجوب) |
| row-8 | ⛔ محجوب | `product_search` موجود ✅ (من `0002`/FTS5) | بنية (محجوب) |
| row-9 | ⛔ محجوب | `products=12 / product_search=0` بعد أول طلب، ثم `12/12` مع أول عملية جديدة (المزامنة في نهاية `runMigrations`) | بنية (محجوب) |
| tables | ⛔ محجوب | الجداول السبعة كلها حاضرة محليًا ✅ | بنية (محجوب) |
| **OVERALL** | 🔴 | الموقع يخدم البذرة المحلية (صف `db-binding` ❌ في تشغيل CI) ⇒ أي طلب حقيقي يفشل | إعداد/تهيئة |

### أدلة الواجهة الحيّة من تشغيل CI نفسه (GET فقط)

`1 ✅ · 2 ✅ · 3 ✅ · 5 ✅ · 6 ✅ (404 مقصود) · headers ✅ · csp-mode ✅ (Report-Only) · extra-products ✅ 12 منتجًا ·`
`db-binding ❌ (البذرة المحلية) · 15 ✅ (صفحة المنتج بـ title وcanonical) · 16 ✅ · 16b ✅ · 17 ✅ · extra-track-route ✅ (405)`

---

## 2) كيف قيست (بلا أي سرّ في المخرجات)

| المكوّن | الدور |
|---|---|
| `.github/workflows/turso-evidence.yml` | مجسّ **قراءة فقط** على `pull_request` و`workflow_dispatch`: وظيفة لأسرار نطاق المستودع، وأخرى تعمل **فقط عند غيابها** لجرّب بيئة `production` (النتيجة: الأسرار على **بيئة production** لا على نطاق المستودع) |
| `.github/workflows/token-lifecycle.yml` | فحص **أسبوعي مجدول** (كل اثنين 04:17Z + يدوي ببوابة `threshold_days`): يفكّ `exp` من `TURSO_AUTH_TOKEN` داخل الـ runner ويحكم عليه مقابل 14 يومًا — **مراقبة فقط** (`contents: read` + `issues: write`، ولا `TURSO_PLATFORM_TOKEN` أصلًا). يأخذ خلاصة الجدول أعلاه بأن السرّ على بيئة `production` فيجعلها النطاق الأساسي ويُبقي نطاق المستودع احتياطًا |
| `scripts/audit-token-lifecycle.mjs` + `scripts/token-lifecycle-ci.sh` | الأول تدقيق نقّي بلا تبعيات (`--json`/`--now`/`--threshold-days`/`--token-env`) يطبع كتلة أدلة ثابتة؛ والثاني غلاف CI: ملخّص + إشعار + **Issue واحد** لمنطقة الخطر (فتح ← تعديل الجسم ← إغلاق) فلا ضوضاء أسبوعية |
| `scripts/probe-turso-ci.sh` | يشغّل الفحص، يطبع الجدول في السجل والملخّص، **وينشره تعليقًا على الـ PR** (يُحدَّث لا يتكدّس)، ويلحق قراءة سطح الإنتاج الحيّ |
| `scripts/apply-turso-secrets.sh` | يضبط السرّين في GitHub (بيئة `production`) و Vercel (Production) بأمر واحد، بتحقق شكلي وبلا طباعة أي قيمة (تُمرَّر عبر `stdin` فقط) |
| `scripts/lib/db-url.mjs` | تشخيص آمن: نوع المضيف وطوله، **شكل مقاطع المسار بالأطوال** (`8/9/5`)، تمييز «قيمة موضعية»، ترجمة رمز الحالة إلى حكم (`404` ⇒ أنشئ القاعدة · `401` ⇒ جدّد الرمز)، وتحليل قيمة حقل الرمز (JWT أم رابط) |
| `scripts/verify-turso.mjs` | يطبع الجدول **دائمًا** (حتى فشل الاتصال)، ويصف بنية القيم، ويجرّب أزواج (رابط، رمز) بعلم `--allow-secret-repair` ويُعلن أي زوج نجح |

**ضمانات:** كل قيمة سرية داخل قائمة حجب قبل أي طباعة؛ لا يُطبع إلا نوع القيمة وطولها وموضع النقطتين ورمز HTTP.
الفحص كله `SELECT`/`GET` — لا هجرة ولا كتابة ولا لمس لـ `ensureSchema`.
**تغطية الاختبارات:** 237/237 ✅ (منها اختبار لفرع فشل الاتصال نفسه، واختبار يمنع طباعة أي قيمة)، `lint` ✅، `typecheck` ✅، `security:gates` ✅ (74 ملفًا)، `sync-migrations --check` ✅.

---

## 3) الإصلاح — ثلاث خطوات (دقيقتان)

<div dir="rtl">

1. **من Turso:** افتح <https://app.turso.tech/elazamey> → القاعدة (اسمها 5 أحرف — هي نفسها في رابط اللوحة الحالي) →
   - **Connect** → انسخ **Database URL** (يبدأ `libsql://` — وهذا كل المطلوب من هذه الخطوة).
   - تبويب **Tokens** → **Create Token** → Full Access → مدة محدودة (**90 يومًا** هي افتراضي المستودع الآن؛ كان الاختيار وقتها Never expire) → انسخ الرمز (يبدأ بـ `eyJ`).
   - إن تفضّل CLI: `turso db show <db> --url` و`turso db tokens create <db>` (لو أن CLI الجديد لا يدعم الأمرين فزر Connect في اللوحة هو المرجع).
2. **في Vercel (بيئة Production)** — عدّل الحقلين ثم **Redeploy**:
   - `TURSO_DATABASE_URL` = رابط `libsql://…` (وليس صفحة اللوحة).
   - `TURSO_AUTH_TOKEN` = رمز JWT (وليس رابط الاتصال).
3. **في GitHub** — نفس القيمتين على بيئة `production` (هي النطاق المقروء فعلًا؛ لا حاجة لوضعهما على نطاق المستودع):
   ```bash
   gh secret set TURSO_DATABASE_URL --env production --body "libsql://<db>-<org>.turso.io"
   gh secret set TURSO_AUTH_TOKEN   --env production --body "eyJ…"
   ```
</div>

### المسار الأسرع: أمران على جهازك ثم أمر واحد في المستودع

```bash
# (1) على جهازك — بحسابك في Turso، مرة واحدة لكل قيمة (لا تلصق أي قيمة في محادثة)
turso auth login                                  # أو: export TURSO_API_TOKEN=... (توكن المنصّة)
turso db list                                     # اسم القاعدة: 5 أحرف

# (2) القيم تُلتقط في متغيرات بيئة بلا ظهور على الشاشة ولا في سجل الأوامر
export TURSO_DATABASE_URL="$(turso db show <db> --url)"                       # يبدأ بـ libsql://
export TURSO_AUTH_TOKEN="$(turso db tokens create <db> --expiration never)"   # JWT يبدأ بـ eyJ…

# (3) من داخل المستودع — أمر واحد يضبط GitHub (بيئة production) و Vercel (Production) معًا
bash scripts/apply-turso-secrets.sh --dry-run     # عرض ما سيحدث أولًا
bash scripts/apply-turso-secrets.sh               # التنفيذ الفعلي
vercel deploy --prod                              # أو Redeploy من اللوحة — المتغيرات تُقرأ في نشر جديد
```

> `--expiration never` هو الصيغة الموثّقة لدوام التوكن (اقبل `never` أو مدة مثل `7d`، توثيق Turso: `db tokens create`).
> بديل بلا CLI — Platform API على جهازك (لا من هذه البيئة): `POST https://api.turso.tech/v1/organizations/elazamey/databases/<db>/auth/tokens?expiration=never&authorization=full-access` بترويسة `Authorization: Bearer <platform-token>`.
> وهذا السكربت **يرفض** مسبقًا كلا الخطأين المكتشفين في الإنتاج: رابط لوحة التحكم في حقل الرابط، ورابط اتصال في حقل الرمز.

**كيف يُشغَّل المجسّ بعد الإصلاح؟** لاحظ أن `probe-production.yml` و`service-health.yml` فقط هما من يستمع لـ`workflow_dispatch`، أما هذا المجسّ فيعمل أيضًا **تلقائيًا على أي دفع إلى الفرع**:

```bash
# الأبسط: أي تحديث على الفرع يعيد التشغيل وينشر الجدول في تعليق الـ PR
git commit --allow-empty -m "chore: إعادة تشغيل مجسّ Turso بعد تصحيح الأسرار" && git push
```
وبعد **دمج هذا الفرع في `main`** يعمل أيضًا الأمر الذي ورد في خطتك:
```bash
gh workflow run turso-evidence.yml --ref main
```
> تنبيه: قبل الدمج لا يعمل `--ref main`، لأن الملف لا وجود له على `main` بعد.
> وتنبيه آخر: توكن وكيل Arena الحالي لا يملك `workflow_dispatch` (`403 Resource not accessible by integration`)،
> لذا تشغيل المجسّ من جهازك أو أي دفع إلى الفرع هو المسار المتاح.

---

## 4) تصحيحات دقيقة لخطة الإصلاح كما وردت

| البند | التصحيح |
|---|---|
| **`mig-table`** | الجدول المتوقع ليس `_prisma_migrations` ولا `drizzle_migrations` — المستودع لا يستخدم Prisma ولا Drizzle. الاسم الصحيح **`schema_migrations`** (`src/lib/db/migrate.ts` سطر 68)، وأعمدته: `version, name, checksum, applied_at`. |
| **`mig-parity`** | «تطابق 0001/0002/0003» — **لا وجود لـ `0003`**: `ls src/lib/db/migrations/*.sql` يعطي ملفين فقط. الرقم `0003` في `handoff/0003-feat-orders.patch` هو ترتيب رِقعة داخل سلسلة رِقاع، وليس هجرة. المعيار الصحيح: الهجرتان مطابقتان بالبصمة `sha256("\n" + sql + "\n")`. |
| **`row-7/8/9`** | «تأكيد عدم الاعتماد على البذرة»: بعد نجاح `conn` لا تُقرأ البذرة أصلًا في صفوف Turso — البذرة تُرى في مسار **الواجهة** (`db-binding`). كما أن `row-9` لا يحتاج «إعادة نشر» بعينها: المزامنة في نهاية `runMigrations` فتُشفى مع أول عملية جديدة (أُصلح وصفه في `DEPLOYMENT.md`). |
| **`--env production` في GitHub** | صحيح، وهو النطاق المقروء فعليًا كما أثبت المجسّ. لكن ليس هو الذي يغذّي **الموقع**: Vercel → Settings → Environment Variables → Production هو الذي يغذّي وقت التشغيل، ولا علاقة له بأسرار Actions. |
| **أمر الاشتقاق** | الاستنتاج في خطتك («الرابط يجب أن يكون `libsql://<db>-<org>.turso.io`») صحيح ومؤيَّد بالأدلة أعلاه؛ والتحقق من الاسم الفعلي للقاعدة يأتي من زر Connect مباشرة. |

---

## 5) ما يتبقى بعد الإصلاح

| البند | الحالة الآن | الخطوة |
|---|---|---|
| القاعدة نفسها | ✅ **موجودة** (دليل 400 مقابل 404 بنفس الرمز المعطوب) | لا شيء |
| رمز JWT صالح | 🔴 غائب (حقل الرمز يحمل رابطًا) | §3-1 |
| `TURSO_DATABASE_URL` صحيح | 🔴 صفحة لوحة تحكم | §3-1 و§3-2 |
| الصفوف 7–9 | ⛔ محجوبة | تزول تلقائيًا مع أول تشغيل بعد §3 |
| `db-binding` (الواجهة تخدم البذرة) | ❌ | يزول مع Redeploy بعد §3-2 |
| الصفان 10 و11 (طلب حقيقي) | ⏸ لا يُنفَّذان بلا موافقة صريحة | بعد نجاح §3 |
