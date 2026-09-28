# تحقق ما بعد النشر — حالة الإنتاج الفعلية (2026-09-28)

المرجع: [`DEPLOYMENT.md`](../DEPLOYMENT.md) (قائمة التحقق) و[`deploy-activation-runbook.md`](./deploy-activation-runbook.md) (تفعيل النشر).
النطاق: `https://aborof.vercel.app` — `main` = `d02c0e7`، والنشر الحيّ = `9a4f3e1` (تشغيل `35317168194`). الفرق بينهما ملفات CI/سكربتات/اختبارات فقط بلا أي تغيير في `src/`، أي أن **كود التطبيق الحيّ مطابق لـ `main`**.

قيود بيئة الوكيل (جعلت بعض الصفوف غير قابلة للتنفيذ من هنا):
لا اتصال شبكي مباشر من صندوق الأدوات إلى نطاق Vercel (`ECONNRESET`)، ولا صلاحية `workflow_dispatch` (`403 Resource not accessible by integration`)، ولا قراءة أسرار Actions (`403`)، ولا `POST` عبر أداة قراءة الصفحات.
لذلك قُرئ رمز الحالة ورؤوس الاستجابة عبر قارئ خارجي (`api.hackertarget.com/httpheaders`) والأجسام عبر جلب الصفحات؛ وكل ما يلزمه `POST` (الصفوف 4 و10–14) يبقى بيد المالك.

---

## 1) الخلاصة

1. **الموقع حيّ وسليم العرض** ✅ — الصفوف 1 و2 و3 و5 و6 + كل الرؤوس الأمنية الأساسية (التفاصيل في §2).
2. **قاعدة Turso غير مربوطة في بيئة الإنتاج** 🔴 — الكتالوج يُخدم من البذرة المحلية (`SEED_PRODUCTS`)، ولذلك **أي طلب حقيقي من الموقع يفشل بـ `503 «قاعدة البيانات غير مربوطة»`** (`createOrder` تشترط `db()` صراحةً). الصفوف 7–11 لا يمكن أن تنجح قبل ضبط `TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN` في Vercel ← Production وإعادة النشر. الأدلة في §3.
3. **سر `VERCEL_TOKEN` ميت** 🔴 — فحص الطيران التمهيدي في التشغيل `35320925636` أعاد `HTTP 404: User not found` من `api.vercel.com/v2/user`، أي أن النشر الآلي متوقف منذ تسعة أيام. العلاج رمز جديد من **لوحة Vercel** (Account Settings → Tokens) لا التوكن التفاعلي الناتج من `vercel login` (تفصيل في §5).

---

## 2) أدلة الصفوف القابلة للقراءة من الخارج

| # | الفحص | المتوقع | الدليل الخام | الحكم |
|---|---|---|---|---|
| 1 | `GET /` | 200 + واجهة | `HTTP/1.1 200 OK` + صفحة كاملة (12 منتجًا، الهيدر، الفوتر) | ✅ |
| 2 | `GET /admin` | 200 + نموذج دخول | `HTTP/1.1 200 OK` + «إدارة روفيده — سجّل الدخول لإدارة المنتجات والطلبات بأمان» | ✅ |
| 3 | `GET /api/admin/session` | 200 `{"authenticated":false}` | `HTTP/1.1 200 OK` + الجسم `{"authenticated":false}` | ✅ |
| 5 | `GET /cart` | 200 | `HTTP/1.1 200 OK` + «سلتك فارغة» | ✅ |
| 6 | `GET /api/admin/mcp/tools` | 404 (الافتراضي) | `{"error":"هذه النقطة غير متاحة","code":"NOT_FOUND"}` | ✅ الطبقة مغلقة كما هو موثّق |
| رؤوس | الرؤوس الأساسية | كلها موجودة | HSTS + nosniff + `X-Frame-Options: DENY` + Referrer-Policy + CSP | ✅ (CSP في وضع المراقبة — انظر أدناه) |
| CSP | وضع `CSP_ENFORCE` | المراقبة افتراضيًا | `Content-Security-Policy-Report-Only` فقط، ولا رأس حاجب | ✅ سلوك افتراضي موثّق |
| إضافي | `GET /api/orders/track` | 405 (المسار منشور) | `HTTP/1.1 405 Method Not Allowed` + `X-Matched-Path: /api/orders/track` | ✅ |
| إضافي | `GET /api/products` | 200 + كتالوج | `200` + 12 منتجًا | ⚠️ انظر §3 |

> **إصلاح أداة نتيجة هذا الفحص:** صف الرؤوس في `scripts/smoke-production.mjs` كان يطلب رأس `content-security-policy` الحاجب حرفيًا، فيُنتج ❌ كاذبة على نشر سليم يعمل بالوضع الافتراضي (Report-Only). صار الفحص يقبل الوضعين ويفصل بينهما في صف `csp-mode`، ويُفرض الحجب فقط بـ `--require-csp-enforce` بعد ضبط `CSP_ENFORCE=true`.

---

## 3) الأدلة الثلاثة على أن مسار Turso غير مستخدم في الإنتاج

الرمز: `getProducts()` في `src/lib/db/index.ts` — إذا كان `db()` فارغًا (غياب `TURSO_DATABASE_URL`) أو فشل الاستعلام، تُعاد `SEED_PRODUCTS` كما هي. ومسار قاعدة البيانات يمرّر كل صف عبر كائن **يرتّب** `ORDER BY featured DESC, rowid ASC` و**يحمل مفتاح `old_price` دائمًا** (ولو `null`). الرد الحيّ انحرف عن المسارين:

1. **ترتيب الرد** `p1…p12` تسلسليًا بالمعرّف، بلا تكتيل المميّزات (`featured`) في المقدمة الذي يفرضه استعلام القاعدة.
2. **غياب المفتاح**: المنتج `p3` في الرد الحيّ لا يحمل مفتاح `old_price` أصلًا، بينما مسار القاعدة كان سيضع `"old_price":null`.
3. **نصوص FAQ**: الصفحة الرئيسية تعرض نصوص `getFaq()` الاحتياطية («فودافون كاش على 01095032221 أو الدفع عند الاستلام.»، «50 جنيه، ومجاني فوق 1000 جنيه. التوصيل خلال 1-3 أيام.»)، لا النصوص المُعبَّأة في القاعدة عند أول تجهيز («…داخل القاهرة والجيزة»، «من 1 إلى 3 أيام عمل…»).

**الأثر التشغيلي:** واجهة الموقع تعمل ويعرض المنتجات، لكن الضغط على «إتمام الطلب» ينتهي بـ `503` لأن `createOrder` ترفض العمل بلا قاعدة (`if (!c) throw Errors.serviceUnavailable("قاعدة البيانات غير مربوطة")`)، وصفحة طلبات الإدارة تعيد `{orders: []}` صامتة. الأثر مال مباشر ⇒ اربط المتغيرين قبل أي شيء آخر.

> هذه **قرينة قوية لا إثبات**: الإثبات هو الصفوف 7–9 (`npm run verify:turso`) التي تتصل بقاعدة الإنتاج فعليًا.

---

## 4) الصفوف التي تحتاج المالك (وسبب كل واحد)

| الصف | لماذا لا ينفّذه الوكيل | من ينفّذه |
|---|---|---|
| 4 (`POST /api/admin/login` بكلمة خاطئة) | لا `POST` عبر أدواته، وحد المعدل 8/10 دقائق | المالك (أمر واحد) |
| 7 و8 و9 (Turso: الجداول والفهرس والتزامن) | تحتاج `TURSO_AUTH_TOKEN` (لا يستطيع قراءة أسرار Actions) | المالك أو `service-health.yml` |
| 10 و11 (إنشاء طلب حقيقي) | كتابة فعلية في قاعدة الإنتاج + تحتاج موافقة صريحة | المالك — **بعد** إصلاح §3 |
| 12 (`POST /api/chat`) | `POST` | المالك |
| 13 و14 (تتبع الطلب) | `POST` + لا تُفتح بـ `ENABLE_ORDER_TRACKING` قبل نجاحهما | المالك |

---

## 5) تصحيح مسار CLI كما ورد في الطلب

المسار صحيح كفكرة — `vercel login` يحل مشكلة النشر فورًا بلا أي توكن — لكن فيه ثلاث نقاط كانت ستُضلّل:

1. **`~/.vercel/auth.json` ليس مسار CLI الحديث، والقيمة داخله غير صالحة لسر GitHub.**
   المسار الفعلي تحت `com.vercel.cli` داخل `XDG_DATA_HOME`:
   Linux `~/.local/share/com.vercel.cli/auth.json` · macOS `~/Library/Application Support/com.vercel.cli/auth.json` · Windows `%APPDATA%\Roaming\xdg.data\com.vercel.cli\auth.json`.
   والأهم: القيمة داخل الملف توكن OAuth قصير العمر (`token` + `expiresAt` + `refreshToken`) **ينتهي خلال ساعات**؛ يصلح لجهازك، ولا يصلح سرًّا دائمًا لـ `VERCEL_TOKEN`. لسر GitHub أنشئ رمزًا من <https://vercel.com/account/tokens> (صلاحية Full access على الفريق).
2. **`vercel env add NAME production` تفاعلي.** في سكربت/سطر أوامر واحد: `vercel env add NAME production --value "…" --yes` أو تمرير القيمة عبر stdin. وبعد أي تغيير في المتغيرات **لا بد من نشر جديد** ليتأثر (خطوة 4 عندك تفعل ذلك).
3. **`gh run rerun 35320925636 --failed` لن ينجح قبل استبدال `VERCEL_TOKEN`** — أعد التشغيل بعده فقط، وإلا فشل الطيران التمهيدي بنفس `404`.

**بديل دائم بلا أي رمز:** اربط المستودع بالمشروع من Vercel (Project → Settings → Git) واجعل Production Branch = `main`؛ بعدها كل دفع إلى `main` ينشر تلقائيًا، ويبقى `Quality and Security` بوابةً للجودة. أما مسار Actions الحالي (بوابة + `vercel build` + `deploy --prebuilt`) فيبقى أفضل إن أردت أن تُبنى الحزمة بعد اجتياز البوابات محليًا.

---

## 6) أوامر المالك الجاهزة

### أ) النشر الفوري عبر CLI

```bash
npm i -g vercel
vercel login                                  # مرة واحدة: تحقق من المتصفح
cd /path/to/aborof
vercel link --yes --project aborof            # أو اختر المشروع تفاعليًا

# الإلزامي على بيئة production (يمنع التكرار: احذف القديم ثم أضف)
printf '%s' 'libsql://<db>.turso.io'   | vercel env add TURSO_DATABASE_URL production --yes
printf '%s' '<turso-token>'            | vercel env add TURSO_AUTH_TOKEN production --yes
printf '%s' '<12+ char password>'      | vercel env add ADMIN_PASSWORD production --yes
printf '%s' '<32+ char session secret>'| vercel env add ADMIN_SESSION_SECRET production --yes
# اختياري: GEMINI_API_KEY / GROQ_API_KEY / CSP_ENFORCE=true …

vercel deploy --prod                          # رابط النشر يظهر في المخرج
```

> بعد النشر تحقّق أن `ADMIN_SESSION_SECRET ≠ DIAGNOSTICS_KEY` (حاجز النشر الثابت يرفض تطابقهما).

### ب) إصلاح مسار Actions (اختياري لكنه يوقف الاعتماد على جهازك)

```bash
# 1) رمز جديد من https://vercel.com/account/tokens — لا من auth.json
gh secret set VERCEL_TOKEN      --body "<الرمز الجديد>"
# 2) معرّفات المشروع: تظهر في .vercel/project.json بعد vercel link
cat .vercel/project.json        # orgId و projectId
gh secret set VERCEL_ORG_ID     --body "<orgId>"
gh secret set VERCEL_PROJECT_ID --body "<projectId>"
# 3) البوابة (Variable لا Secret)
gh variable set VERCEL_DEPLOY_ENABLED --body true
# 4) إن كانت حماية بيئة Production تمنع main: Settings → Environments → Production → Deployment branches → All branches
# 5) ثم أعد تشغيل الفاشل
gh run rerun 35320925636 --failed
```

### ج) التحقق بعد النشر (بالترتيب)

```bash
# الصفوف 7–9 (Turso) — الأهم أولًا: يشرح لماذا تفشل الطلبات الآن
TURSO_DATABASE_URL='libsql://<db>.turso.io' TURSO_AUTH_TOKEN='<token>' npm run verify:turso
# بديل من GitHub بلا تمرير أسرار إلى سطر الأوامر:
gh workflow run service-health.yml --ref main

# الصفوف 1 و2 و3 و5 و6 + الرؤوس + وضع CSP + قرينة ربط القاعدة (قراءة فقط)
npm run smoke:prod
# بعد ضبط CSP_ENFORCE=true أضف: -- --require-csp-enforce

# الصف 4 — محاولة واحدة فقط (حد المعدل 8/10 دقائق)، والمتوقع 401
npm run smoke:prod -- --admin-probe
# أو من GitHub: gh workflow run probe-production.yml --ref main \
#   -f path=/api/admin/login -f method=POST -f body='{"password":"probe-not-a-real-password"}'

# الصفوف 10 و11 — تُنشئ طلبًا حقيقيًا: بعد إصلاح §3 وبموافقة صريحة
node scripts/smoke-production.mjs --allow-mutations --orders-body ./order.json

# الصفان 13 و14 — بعد فتح ENABLE_ORDER_TRACKING فقط
node scripts/smoke-production.mjs --track <orderId> --last4 <آخر 4 أرقام>
```

`npm run smoke:prod` يخرج الآن بصف `db-binding` يفضح حالة «البذرة المحلية» التي كانت ستمرّ صامتة، وبصف `csp-mode` يفرّق بين غياب الرأس ووجوده في وضع المراقبة.

---

## 7) ما يتبقى بعد كل ما سبق

| البند | الحالة الآن | الخطوة التالية |
|---|---|---|
| ارتفاع الموقع وتقديمه | ✅ مُتحقَّق | — |
| لوحة الإدارة (تهيئة `ADMIN_PASSWORD`/`ADMIN_SESSION_SECRET`) | ⏳ غير معروفة | الصف 4 (401 = مهيأة) |
| قاعدة Turso في الإنتاج | 🔴 غير مربوطة (قرينة قوية) | §6-أ ثم §6-ج (الصفوف 7–9) |
| إنشاء الطلبات الحقيقي | 🔴 يفشل بـ 503 الآن | بعد ربط Turso: الصفان 10 و11 |
| النشر الآلي من Actions | 🔴 متوقف (رمز ميت) | §6-ب |
| `ENABLE_ORDER_TRACKING` | مغلق (سلوك افتراضي) | لا يُفتح إلا بعد نجاح 13 و14 |
