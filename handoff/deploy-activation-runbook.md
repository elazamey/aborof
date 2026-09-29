# دليل تفعيل النشر والتحقق (الخطوات 1–5)

الفرع: `arena/01a0b342-aborof` — نقطة الانطلاق: `7b4a506` (main).
التاريخ: 2026-09-18. المرجع: [`DEPLOYMENT.md`](../DEPLOYMENT.md) و[`docs/security/03-ci-deployment-verification.md`](../docs/security/03-ci-deployment-verification.md).

> 🔄 **تحديث 2026-09-28:** الموقع صار حيًّا على `https://aborof.vercel.app`، والنشر الآلي متوقف بسبب رمز `VERCEL_TOKEN` ملغى (`404: User not found`)، وقاعدة الإنتاج تعمل من البذرة المحلية (Turso غير مربوطة) فيفشل إنشاء الطلبات بـ `503`. سجل التحقق الحيّ والأوامر المصحّحة: [`post-deploy-verification.md`](./post-deploy-verification.md).

---

## أ) تحديث الحالة بعد دمج PR #11 (2026-09-18 06:57Z)

تم الدمج فعليًا (merge commit `9a4f3e1`) وتشغّل الـ Workflow `Deploy to Vercel` (تشغيل `35317168194`) — **وظيفة النشر ظهرت `skipped` مرة أخرى**، فتشغيل النشر ظلّ على `main` من دون نشر. التشخيص الكامل:

| # | الدليل | الاستنتاج |
|---|---|---|
| 1 | `gh api …/actions/runs/35317168194/jobs` ⇒ `Deploy to Vercel Production: skipped` مع أن الفرع `main` | الشرط `vars.VERCEL_DEPLOY_ENABLED == 'true'` رآها **فارغة** |
| 2 | المرجع: `jobs.<id>.if` يُقيَّم في طور التجميع قبل الدخول إلى البيئة، ولا يرى متغيرات البيئة (والنطاقات المسموحة `github, needs, vars, inputs`) | المتغير المضبوط على بيئة `production` **غير مرئي أبدًا** لشرط على مستوى الوظيفة — إعداد صحيح بنية خاطئة |
| 3 | `gh api /repos/.../environments/production` ⇒ `{"name":"Production", "protection_rules":[{"type":"branch_policy"}], "deployment_branch_policy":{"protected_branches":true}}` | أسماء البيئات **غير حساسة لحالة الأحرف**، فـ `production` في الـ Workflow تحل إلى البيئة `Production` التي عليها سياسة «الفروع المحمية فقط» |
| 4 | `gh api /repos/.../branches/main` ⇒ `{"protected": false}` | `main` غير محمي ⇒ حتى بعد إصلاح البوابة، سترفض قاعدة الحماية وظيفة النشر |

**الإصلاح 1 (كود — في هذا الفرع):** أُضيفت وظيفة `Deploy gate (VERCEL_DEPLOY_ENABLED)` مرتبطة بـ `environment: production` تقرأ المتغير **داخل خطوة shell** (حيث نطاق البيئة فعّال) وتبثّه كمخرج، ووظيفة النشر صارت `needs: [quality-gates, deploy-gate]` بشرط `needs.deploy-gate.outputs.enabled == 'true'` — فيبقى السلوك موثّقًا (`skipped` عند الإغلاق) ويعمل المتغير من نطاق البيئة أو المستودع، مع تحذير مطبوع بالقيمة الفعّالة عند الإغلاق. اختبارات حماية في `tests/deploy-tools.test.ts` تمنع عودة الخطأ.

**الإصلاح 2 (إعداد — بيد المالك، لا يمكن لأي توكن فعله):** **Settings → Environments → Production → Deployment branches** ⇒ اختر *All branches* (أو *Allow custom branches* وأضف `main`). بديل غير متاح عمليًا: تفعيل حماية `main` (حماية الفروع في المستودعات الخاصة تحتاج خطة مدفوعة — الـ API يعيد `Upgrade to GitHub Pro`).

**مسار فوري بديل للإصلاح 1 (بلا دمج كود):** أضف `VERCEL_DEPLOY_ENABLED` في تبويب **Variables** (لا Secrets) على **نطاق المستودع** بقيمة `true`؛ النطاق على مستوى المستودع مرئي لشرط الوظيفة، فيبدأ النشر فورًا مع الـ Workflow الحالي.

---

## 0) الخلاصة أولًا

| الخطوة | من ينفّذها | الحالة الآن |
|---|---|---|
| 1 — فحص الأسرار مقابل DEPLOYMENT.md | **المالك** (أمر واحد أو صفحة الإعدادات) | ⛔ موقوفة: GitHub يمنع أي GitHub App من قراءة أسرار Actions (403 أدناه) — الأدوات جاهزة |
| 2 — تشغيل workflow النشر ومراقبته | **المالك** (إعداد البيئة) + **الوكيل** (مراقبة) | 🔴 نُفِّذ الدمج ودار الـ Workflow لكن وظيفة النشر بقيت `skipped` مرتين — السبب الجذري مشخَّص في القسم (أ) مع إصلاحين |
| 3 — فحصا Turso (اتصال + تطابق هجرات) | **المالك** (تشغيل) أو CI عبر `service-health.yml` | ⏳ أداة الفحص مبنية ومختبرة |
| 4 — Smoke test + `routes:inventory` | **الوكيل** (قراءة فقط) + **المالك** (الطلبات الكاتبة) | ⏳ `routes:inventory` أخضر محليًا؛ baseline إنتاج مسجَّل |
| 5 — فتح `ENABLE_ORDER_TRACKING` والتحقق | **المالك** (فتح العلم) + **الوكيل** (تحقق) | ⛔ لا يُفتح إلا بعد اجتياز الصفين 13 و14 |

### لماذا لا ينفّذ الوكيل الخطوتين 1 و2 بنفسه؟

توكن الوكيل هو GitHub App boundaries بمجموعة صلاحيات مقصورة (contents/PR/checks). المُثبَت عمليًا:

```text
$ gh secret list
failed to get secrets: HTTP 403: Resource not accessible by integration

$ gh api /repos/elazamey/aborof/actions/secrets      → 403
$ gh api /repos/elazamey/aborof/environments/production/secrets → 403
$ gh workflow run service-health.yml --ref main
could not create workflow dispatch event: HTTP 403: Resource not accessible by integration
```

هذا **سلوك GitHub المقصود** لا خلل في الإعداد: أسرار Actions لا تُقرأ إلا بتوكن مالك/إداري
(`Secrets: read`)، ولا يمكن لأي GitHub App الحصول على هذه الصلاحية. كذلك `workflow_dispatch`
يحتاج `Actions: write` غير ممنوحة للتطبيق.

المتاح للوكيل: **قراءة** التشغيلات والمهام والخطوات (`gh api …/actions/runs/…/jobs`) وصلاحيات
المستودع الأخرى — لذا فهو يراقب الخطوات 2–5 ويتحقق من نتائجها، بينما ينفّذ المالك الأوامر.

> نتائج يمكنني قراءتها فعلًا (تحقّقت الآن): كل خطوات `quality-gates` في التشغيل 35314878197
> بحالة `success`، ووظيفة `Deploy to Vercel Production` في التشغيل 35314878275 بحالة `skipped`.

---

## 1) الخطوة 1 — فحص الأسرار

### الطريقة الآلية (أمر واحد على جهاز المالك)

```bash
# على جهازك، بحساب يملك إدارة المستودع:
gh auth status                                  # تأكد أنه حسابك لا حساب بوت
node scripts/verify-deploy-secrets.mjs --repo elazamey/aborof --env production
```

المخرج: جدول بالأسماء فقط (لا قيم سرية مطلقًا) يوضّح لكل سرّ: حاضر/غائب، ونطاقه
(بيئة `production` تُقدَّم على نطاق المستودع)، مع حكم على بوابة `VERCEL_DEPLOY_ENABLED`
وكود خروج `0` إن لم يوجد نقص حاجب. للتشغيل في خط أتمتة: `--json`.

### الطريقة اليدوية (بلا CLI)

**Settings → Secrets and variables → Actions**، وتبويبا *Secrets* و*Variables*،
ثم قارن بالجدول:

| إلزامي | اختياري |
|---|---|
| `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | `DIAGNOSTICS_KEY` (مستقل عن سر الجلسات) |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | `GEMINI_API_KEY` أو `GROQ_API_KEY` |
| `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET` | `NVIDIA_NIM_API_KEY` (أو `NVIDIA_API_KEY`) |
| متغير: `VERCEL_DEPLOY_ENABLED=true` | متغيرات MCP/NIM/DIAGNOSTICS/CSP/`ENABLE_ORDER_TRACKING` |

### تنبيه نطاق البيئة (مهم)

`deploy.yml` يستخدم `environment: production` (بحروف صغيرة)، وقائمة البيئات في المستودع
تُظهر `Production` (بحرف كبير) وبيئات أخرى. أضف الأسرار إمّا على **نطاق المستودع**
(تعمل دائمًا) أو على بيئة اسمها **`production` بالحرف الصغير** — وإن أنشأها GitHub تلقائيًا
عند أول تشغيل فستكون فارغة، فيقرأ الـ Workflow من نطاق المستودع وقتها.

### ما لا يُقرأ من GitHub (تحقق يدوي في Vercel)

أسرار Actions **لا تنتقل** إلى Runtime: تأكد من وجود `TURSO_DATABASE_URL`، `TURSO_AUTH_TOKEN`،
`ADMIN_PASSWORD`، `ADMIN_SESSION_SECRET` في **Vercel Project → Settings → Environment
Variables → Production**، وأن `ADMIN_SESSION_SECRET` ≠ `DIAGNOSTICS_KEY`.

---

## 2) الخطوة 2 — تشغيل workflow النشر ومراقبته

### تشغيله (أحد ثلاثة مسارات، كلها بيد المالك)

1. **من الواجهة:** Actions → «Deploy to Vercel» → Run workflow (الفرع `main`، الهدف `production`).
2. **من جهازك:** `gh workflow run deploy.yml --ref main`.
3. **تلقائيًا:** أي push/دمج إلى `main` (مثلًا دمج هذا الفرع).
4. **مع ضبط الأسرار في نفس الأمر:** `node scripts/apply-vercel-link.mjs --dispatch` — يربط مشروع Vercel، ويحقّق حيًّا أن `VERCEL_PROJECT_ID`/`VERCEL_ORG_ID` يحلّان إلى `aborof`، ويضبط الأسرار عبر `stdin`، ثم يشغّل الـ workflow ويتابعه. هذا هو المسار المختصر حين يكون العطل في المعرّفين (الحالة المرصودة: `404 Project not found` مع رمز صالح).

### علامة النجاح المطلوبة

وظيفة `Deploy gate (VERCEL_DEPLOY_ENABLED)` تُقرأ فيها القيمة الفعّالة (تظهر في سطر التحذير إن كانت مغلقة)، ثم تنتقل وظيفة `Deploy to Vercel Production` من `skipped` إلى `success` مع نجاح خطوتي:

```text
Verify required deployment secrets      → All required deployment secrets are present.
Vercel preflight                        → ::notice:: مشروع Vercel متاح — الاسم: aborof
                                          + ::notice:: تطابق الاسم المتوقع
Deploy prebuilt artifact (vercel deploy --prebuilt --prod) → نشر ناجح وطباعة رابط الـ deployment
```

إن فشلت خطوة `Vercel preflight` فالتعليقات تحمل حكمًا مُصنَّفًا لا رسالة `404` جافة:
`PROJECT_NOT_FOUND_WRONG_SCOPE` (نطاق فريق بينما المشروع شخصي) · `PROJECT_NOT_FOUND_STALE_ID`
(معرّف قديم بعد إعادة إنشاء المشروع) · `PROJECT_NOT_VISIBLE_TO_TOKEN` (حساب Vercel مختلف) ·
`TOKEN_SEES_NO_PROJECTS` (صلاحية ناقصة) · `PROJECT_NAME_MISMATCH` (نشر ناجح وإنتاج لم يتغير)،
ومع الحكم تُطبع **أسماء** المشاريع التي يراها الرمز في النطاقين — وهي المعلومة التي تحسم
السبب. الجدول الكامل والإجراءات في DEPLOYMENT.md §«ربط مشروع Vercel وضبط أسرار النشر بأمر واحد».

إن بقيت `skipped` فالمتغير `VERCEL_DEPLOY_ENABLED` ليس `'true'` في النطاق الفعّال،
وإن فشلت خطوة «Verify required deployment secrets» فاسم السر الناقص مطبوع في السجل.

**ما يراقبه الوكيل:** `gh run watch <id>` وإن تعذّر (تنزيل السجلات محجوب عن الشبكة هنا)
فالمهام والخطوات تُقرأ عبر `gh api /repos/elazamey/aborof/actions/runs/<id>/jobs`.

> ⚠️ ملاحظة تشغيلية: المستودع مرتبط بثلاثة مشاريع Vercel (`aborof`, `aborof-store-v2`,
> `aborof-updated-17d3397`) وتكامل Git في Vercel ينشرها كلها تلقائيًا عند كل push.
> تأكد أن `VERCEL_PROJECT_ID` يشير إلى المشروع الذي يخدم نطاق `aborof.vercel.app`،
> وإلا نجح النشر في Actions بينما الخدمة الإنتاجية لم تتغير.

---

## 3) الخطوة 3 — فحصا Turso (اتصال + تطابق هجرات)

```bash
# على جهاز المالك (أو في CI: Actions → Service health probe):
TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/verify-turso.mjs
```

يفحص **للقراءة فقط** وبنفس مسار `@libsql/client` المستخدم في الإنتاج:

| الفحص | يقابل |
|---|---|
| `SELECT 1` اتصال حقيقي | الصف 7 في قائمة التحقق |
| وجود `schema_migrations` + تطابق كل بصمة مع ملفات المستودع | تطابق الهجرات (يرصد تعديل هجرة بعد تطبيقها) |
| `SELECT COUNT(*) FROM order_items` | الصف 7 — تثبيت إصلاح P0 (`no such table`) |
| وجود `product_search` | الصف 8 — هجرة `0002` (FTS5) |
| `COUNT(product_search) = COUNT(products)` | الصف 9 — الفهرس متزامن مع الكتالوج |
| الجداول الأساسية السبعة | اكتمال المخطط |

كود الخروج: `0` أخضر، `1` نقص حاجب، `2` تهيئة ناقصة (رابط غائب). أي ❌ يُطبع معه التفصيل
وبرقم الصف المقابل في DEPLOYMENT.md.

---

## 4) الخطوة 4 — التحقق المزدوج

```bash
# 1) جرد المسارات محليًا (بوابة CI نفسها)
npm run routes:inventory

# 2) Smoke test على الإنتاج (للقراءة فقط افتراضيًا — 7 فحوص)
node scripts/smoke-production.mjs --base https://aborof.vercel.app

# 3) الصف 4 (محاولة واحدة بكلمة خاطئة عمدًا — حد المعدل 8/10 دقائق)
node scripts/smoke-production.mjs --base https://aborof.vercel.app --admin-probe
```

يفحص افتراضيًا: الصفوف 1، 2، 3، 5، 6 + رؤوس الأمان + `/api/products` + وجود مسار
`/api/orders/track` في البناء المنشور (GET ⇒ 405)، ويطبع جدولًا بكل فحص والمتوقع والفعلي،
وكود خروج غير صفري عند أي فشل. الفحوص الكاتبة (10، 11، 13، 14) تحتاج أعلامًا صريحة.

### baseline مسجَّل الآن على الإنتاج (قراءة فقط، قبل أي نشر جديد)

| الفحص | النتيجة |
|---|---|
| `GET /` | صفحة المتجر كاملة (12 منتجًا، وصف، فوتر) |
| `GET /api/admin/session` | `{"authenticated":false}` |
| `GET /api/admin/mcp/tools` | `{"error":"هذه النقطة غير متاحة","code":"NOT_FOUND"}` ⇒ `ENABLE_MCP_TOOLS` مغلق (الافتراضي) |
| `GET /api/orders/track` | صفحة 405 فارغة ⇒ المسار **منشور** في البناء الحالي (حالة العلم لا تُقرأ بـ GET) |
| تكامل Vercel على `7b4a506` | ثلاثة فحوص `Vercel – …` بحالة `success` (06:26–06:27Z) — نشر تكامل Git لا نشر Actions |

---

## 5) الخطوة 5 — فتح `ENABLE_ORDER_TRACKING` (بعد نجاح 1–4 فقط)

1. في **Vercel Project → Settings → Environment Variables → Production**: `ENABLE_ORDER_TRACKING=true`.
2. أعد النشر (Deployments → Redeploy، أو خطوة 2 نفسها بعد أي push إلى `main`).
3. أنشئ طلبًا تجريبيًا واحدًا صغيرًا ثم افحص الصفين 13 و14:

```bash
# ملف جسم الطلب: {customer, phone, address, governorate, payment, items:[{id,qty}]}
node scripts/smoke-production.mjs --allow-mutations --orders-body ./order.json

# الصفان 13 و14 (ضع رقم الطلب من الصف 10 وآخر 4 أرقام من هاتفه)
node scripts/smoke-production.mjs --track "<orderId>" --last4 1234
```

شرط الإغلاق: الصف 13 ⇒ `200 {ok:true,status:"جديد",items:[…]}` **بلا** هاتف كامل ولا عنوان؛
الصف 14 ⇒ `404` بنفس الرسالة حرفيًا «تعذر العثور على الطلب». **أي فرق بين الرسالتين يعني
تسريب تعداد، فيبقى العلم مغلقًا.**

> حد المعدل على التتبع 5 محاولات/10 دقائق، وعدد محاولات الفحص هنا اثنتان بالضبط.

---

## 6) جدول تفسير الاستجابات

| الاستجابة | المعنى | الإجراء |
|---|---|---|
| `POST /api/admin/login` ⇒ `401` | لوحة الإدارة مهيأة بالكامل | ✅ |
| ⇒ `503` | رسالة تسمّي المتغير الناقص بدقة على Vercel | أضف المتغير وأعد النشر |
| ⇒ `429` | استُهلك حد المعدل | انتظر 10 دقائق، محاولة واحدة |
| `GET /api/admin/mcp/tools` ⇒ `404` | طبقة MCP مغلقة (الافتراضي) | ✅ |
| ⇒ `401` | الطبقة مفتوحة فعلًا وتتطلب جلسة | ✅ (تحقق من `MCP_ALLOWED_TOOLS`) |
| `Deploy to Vercel Production` ⇒ `skipped` | `VERCEL_DEPLOY_ENABLED ≠ "true"` | فعّل المتغير في نطاقه الفعّال |
| `Deploy to Vercel Production` ⇒ `failure` في خطوة الأسرار | سر إلزامي غائب (الاسم مطبوع) | أضفه وأعد التشغيل |

## 6.1) تشخيص «skipped» في دقيقة واحدة

| الملاحظة | المعنى | الإصلاح |
|---|---|---|
| `Deploy gate` رُفضت قبل أي خطوة برسالة `not allowed to deploy to Production due to environment protection rules` | سياسة فروع البيئة «الفروع المحمية فقط» و`main` غير محمي | Environments → Production → Deployment branches → *All branches* |
| `Deploy gate` نجحت وكتبت `enabled=false` مع القيمة الفعلية | المتغير غائب من النطاقين أو قيمته ليست `true` حرفيًا | أضف/صحّح `VERCEL_DEPLOY_ENABLED=true` في **Variables** (لا Secrets) |
| القيمة المطبوعة فاضية تمامًا وأنت متأكد من ضبطها | ضُبط في تبويب Secrets، أو على بيئة أخرى غير `production`/`Production` | انقله إلى Variables أو إلى البيئة الصحيحة |
| `Deploy to Vercel Production` ما زالت `skipped` بينما `Deploy gate` كتبت `enabled=true` | الـ Workflow قديم قبل إصلاح البوابة | تأكد أن آخر دمج إلى main يتضمن `.github/workflows/deploy.yml` الجديد |

## 7) قواعد ثابتة

- لا كلمة مرور حقيقية في سطر أوامر أو سجل أو ملف متتبَّع؛ الفحص بكلمة خاطئة عمدًا كافٍ.
- لا تُطبع أي قيمة سرية في أي مخرج (كل الأدوات هنا تطبع الأسماء والحالات فقط).
- `ENABLE_ORDER_TRACKING` لا يُفتح إلا بعد اجتياز الصفين 13 و14 معًا.
- أي فحص ناقص = تهيئة يجب إغلاقها قبل إعلان الجاهزية، لا استثناء يُتجاوز.
- لا تُقرأ بوابة النشر في `if` على مستوى الوظيفة أبدًا (متغيرات البيئة غير مرئية هناك) — البوابة خطوة داخل وظيفة `Deploy gate` فقط.
