# نشر متجر روفيده

## النشر التلقائي

يحتوي المستودع على Workflow باسم `Deploy to Vercel` ينفذ فحوصات الجودة ثم ينشر فرع `main` إلى بيئة Vercel الإنتاجية. حماية النشر متعمدة: لا تبدأ وظيفة النشر حتى يكون المتغير `VERCEL_DEPLOY_ENABLED` مساويًا حرفيًا للنص `true`، ويُقرأ من نطاق **بيئة `production`** أولًا ثم نطاق المستودع.

> **لماذا وظيفة `Deploy gate` منفصلة؟** GitHub يقيّم شرط `if` على مستوى الوظيفة في طور التجميع **قبل** الدخول إلى البيئة، فلا يرى متغيرات البيئة ويراها فارغة دائمًا
> (توثيق مجتمعي مؤكد: `jobs.<id>.if` يقبل `github, needs, vars, inputs` لكن نطاق البيئة يُحلّ في الطور التالي). لذلك تُقرأ البوابة داخل خطوة في وظيفة
> `Deploy gate (VERCEL_DEPLOY_ENABLED)` المرتبطة بنفس البيئة، ثم تُصدَّر كمخرج تقرأه وظيفة النشر عبر `needs.deploy-gate.outputs.enabled`.
> النتيجة: تجاهل هذا التفصيل كان يُبقي وظيفة النشر `skipped` إلى الأبد حتى مع ضبط المتغير على البيئة، وبلا أي رسالة خطأ.

وظيفة النشر مرتبطة أيضًا ببيئة GitHub المسماة `production` (`environment: production`)، أي أنها:

- تقرأ الأسرار والمتغيرات من نطاق البيئة أولًا، ثم ترجع إلى نطاق المستودع إن لم تكن معرّفة هناك؛
- تخضع لقواعد حماية البيئة إن أضفتها (مراجعون مطلوبون، مدة انتظار، أو قصر النشر على فروع محددة) عبر
  **Settings → Environments → production**، وهي طبقة حماية إضافية فوق شرط الفرع والمتغير.

> ⚠️ **فخ حماية البيئة:** إن كانت سياسة فروع النشر على البيئة «**Protected branches only**» وفرع `main` غير محمي،
> فسيُرفض أي نشر بقاعدة الحماية (الرسالة: `Branch "main" is not allowed to deploy to Production due to environment protection rules`)
> حتى لو كان المتغير والأسرار سليمة. اضبطها على **All branches** أو **Allow custom branches** مع `main`، أو فعّل حماية `main`
> (حماية الفروع في المستودعات الخاصة تحتاج خطة مدفوعة). أسماء البيئات غير حساسة لحالة الأحرف، لذا `production` في الـ Workflow
> تحل إلى البيئة المسماة `Production`.

أضف في إعدادات المستودع ضمن **Settings → Secrets and variables → Actions** الأسرار التالية، من دون وضع قيمها في الملفات أو الأوامر:

| الاسم | نوعه | مصدره |
|---|---|---|
| `VERCEL_TOKEN` | Secret | رمز شخصي من إعدادات Vercel |
| `VERCEL_ORG_ID` | Secret | قيمة `orgId` من مشروع Vercel أو إعدادات الفريق |
| `VERCEL_PROJECT_ID` | Secret | قيمة `projectId` من مشروع Vercel |
| `TURSO_DATABASE_URL` | Secret | رابط قاعدة Turso |
| `TURSO_AUTH_TOKEN` | Secret | رمز Turso |
| `ADMIN_PASSWORD` | Secret | كلمة مرور الإدارة القوية (12 حرفًا على الأقل) |
| `ADMIN_SESSION_SECRET` | Secret | سر عشوائي لتوقيع الجلسات فقط، لا يقل عن 32 حرفًا |
| `GEMINI_API_KEY` أو `GROQ_API_KEY` | Secret اختياري | مفتاح مزود الدردشة |
| `ENABLE_AI_AGENT` | Variable اختياري | `true` لتوجيه `/api/chat` إلى محرك الوكيل النمطي الموحّد (المرحلة الأولى)؛ غيابه أو أي قيمة أخرى تُبقي السلوك القديم حرفيًا |
| `NVIDIA_NIM_API_KEY` (أو `NVIDIA_API_KEY`) | Secret اختياري | مفتاح مزود NVIDIA NIM (المرحلة الثانية)؛ غيابه يعني أن المزود غير متاح فيُتخطى صامتًا في السلسلة |
| `NVIDIA_NIM_BASE_URL` / `NVIDIA_NIM_MODEL` | Variable اختياري | رابط NIM مخصّص (**https فقط**؛ أي مخطط آخر يُخرج المزود من السلسلة) واسم النموذج |
| `ENABLE_MCP_TOOLS` | Variable اختياري | `true` لتفعيل طبقة MCP المحكومة للأدوات (المرحلة الثانية)؛ غيابه أو أي قيمة أخرى تُبقي السلوك القديم حرفيًا |
| `MCP_ALLOWED_TOOLS` | Variable اختياري | قائمة أسماء أدوات مفصولة بفواصل؛ غيابها يعني المجموعة الافتراضية للقراءة فقط، وما عداها غير مرئي وغير قابل للتنفيذ |
| `MCP_ALLOW_WRITE_TOOLS` | Variable اختياري | بوابة مستقلة للأدوات الكاتبة؛ مغلقة افتراضيًا وتُرفض الأداة الكاتبة في التسجيل نفسه |
| `MCP_MAX_CALLS_PER_REQUEST` / `MCP_TOOL_TIMEOUT_MS` / `MCP_MAX_RESULT_CHARS` | Variable اختياري | حدود مركزية مقيّدة رياضيًا: 0–8 استدعاءً، 300–10000 مللي ثانية، 200–20000 حرفًا |
| `DIAGNOSTICS_ENABLED` | Variable اختياري | `true` لتفعيل نقطة التشخيص (معطّل في الإنتاج افتراضيًا) |
| `DIAGNOSTICS_KEY` | Secret اختياري | مفتاح **مستقل** عن `ADMIN_SESSION_SECRET` لنقطة `/api/admin/diagnostics` |
| `CSP_ENFORCE` | Variable اختياري | `true` لتشديد CSP من وضع المراقبة إلى الحجب |
| `ENABLE_ORDER_TRACKING` | Variable اختياري | `true` لفتح نقطة تتبع العملاء للطلبات `/api/orders/track`؛ **مغلق افتراضيًا** (لا يفتح إلا بعد فحوص الصفين 13 و14 في قائمة التحقق) |
| `ENABLE_AGENT_FLEET` | Variable اختياري | `true` (مع `ENABLE_AI_AGENT=true`) لتفعيل أسطول وكلاء المتجر: 50 وكيلًا متخصصًا يختار بينهم موجّه حتمي بلا موديل، وكل وكيل يرى مجموعة فرعية من أدوات MCP للقراءة فقط؛ غيابه أو أي قيمة أخرى يُبقي السلوك السابق حرفيًا — التفاصيل في `docs/ai/phase-4-agent-fleet.md` |
| `FLEET_DISABLED_AGENTS` | Variable اختياري | قائمة معرّفات وكلاء مفصولة بفواصل لتعطيلها بلا تغيير كود (القيمة `*` تعطّل كل المتخصصين وتُبقي الافتراضي)؛ غيابه يعني صفر تعطيل. الوكيل الافتراضي لا يُعطَّل، والموضوع الذي يبقى بلا متخصص يسقط للوكيل العام بأمان — التفاصيل في `docs/ai/agent-fleet-operations.md` |
| `AI_PROVIDER_ORDER` | Variable اختياري | قائمة أسماء مزودين مفصولة بفواصل لضبط ترتيب السلسلة (مثلًا `groq,gemini,nvidia-nim`)؛ الأسماء غير المعروفة تُتجاهل و`local` يُثبَّت دائمًا في النهاية. غيابه يُبقي الترتيب التاريخي Gemini ← Groq ← NIM ← محلي |
| `VERCEL_DEPLOY_ENABLED` | Repository variable (أو Environment variable على `production`) | `true` بعد التأكد من الأسرار |

> تفاصيل المرحلة الثانية (الأعلام، الحدود، مصفوفة صفر كسر، التراجع) في `docs/ai/phase-2-nim-mcp.md`.

> **فصل الأسرار إلزامي:** `ADMIN_SESSION_SECRET` لتوقيع الجلسات فقط، و`DIAGNOSTICS_KEY`
> للتشخيص فقط. يفحص حاجز النشر الثابت أنهما غير متطابقين وأن سر الجلسات لا يُذكر
> خارج وحدتي الجلسات والأسرار.

> ⚠️ **`VERCEL_TOKEN` لا يُملأ من `~/.vercel/auth.json`:** توكن `vercel login` هو OAuth قصير العمر (`expiresAt` خلال ساعات + `refreshToken`) وموضعه في CLI الحديث تحت `com.vercel.cli` داخل `XDG_DATA_HOME` — يصلح للنشر من جهازك، ولا يصلح سرًّا دائمًا. أنشئ رمزًا من **Vercel → Account Settings → Tokens** بصلاحية Full access على الفريق. فحص الرمز في `deploy.yml` يستدعي `api.vercel.com/v2/user`، و`404: User not found` تعني رمزًا مصادَقًا عليه لكنه ملغى/غير موجود (استبدله)، بينما `403` تعني صلاحية ناقصة على الفريق.

يجب إضافة متغيرات التطبيق مثل `TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN` و`ADMIN_PASSWORD` و`ADMIN_SESSION_SECRET` أيضًا داخل **Vercel Project → Settings → Environment Variables** لبيئة Production؛ أسرار GitHub Actions لا تنتقل تلقائيًا إلى Runtime في Vercel. إن غاب `TURSO_DATABASE_URL` عن بيئة Production فالموقع يظل يعرض المنتجات من البذرة المحلية بينما يفشل كل إنشاء طلب بـ `503` (انظر «قراءة نتائج الـ Smoke بلا لبس» أعلاه).

## التفعيل والتحقق

بعد حفظ الأسرار والمتغير، نفّذ تغييرًا إلى `main` أو شغّل Workflow يدويًا من تبويب **Actions**. يجب أن يظهر أولًا Workflow الجودة، ثم سجل النشر. تحقق من `/` و`/cart` و`/admin`، ثم اختبر إنشاء طلب تجريبي صغير بعد التأكد من أن Turso متصلة. لا تستخدم كلمة مرور حقيقية داخل سجل Git أو ملف `.env` متتبع.

## قائمة تحقق النشر

### قبل التفعيل

- [ ] كل الأسرار في جدول «النشر التلقائي» مضافة في **Settings → Secrets and variables → Actions** (نطاق البيئة `production` أو نطاق المستودع).
- [ ] متغيرات الـ Runtime مضافة أيضًا في **Vercel Project → Settings → Environment Variables** لبيئة Production، فهي لا تنتقل تلقائيًا من GitHub:
  - `TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN`؛
  - `ADMIN_PASSWORD` (12 حرفًا على الأقل وفق سياسة كلمات المرور)؛
  - `ADMIN_SESSION_SECRET` (32 حرفًا على الأقل، لتوقيع الجلسات فقط)؛
  - اختياري: `DIAGNOSTICS_ENABLED=true` مع `DIAGNOSTICS_KEY` **مستقل تمامًا**، و`CSP_ENFORCE=true`.
- [ ] `ADMIN_SESSION_SECRET` يختلف عن `DIAGNOSTICS_KEY` (حاجز النشر الثابت يرفض تطابقهما).
- [ ] `VERCEL_DEPLOY_ENABLED` مضاف في تبويب **Variables** (لا Secrets) ومساوٍ حرفيًا `true` — إمّا متغير مستودع أو متغير بيئة `production`.
- [ ] حماية بيئة النشر لا تمنع `main`: **Settings → Environments → Production → Deployment branches** مساوية *All branches* (أو سياسة مخصّصة تتضمن `main`).
- [ ] (المرحلة الثانية، اختياري) إن فُعّل `ENABLE_MCP_TOOLS` فراجع `MCP_ALLOWED_TOOLS` والحدود الثلاثة قبل النشر، وتذكّر أن الطبقة للقراءة فقط وأن أدوات الكتابة تحتاج بوابة `MCP_ALLOW_WRITE_TOOLS` منفصلة.
- [ ] (المرحلة الثانية، اختياري) إن أُضيف مفتاح NIM فتحقق أن `NVIDIA_NIM_BASE_URL` (إن وُجد) يبدأ بـ `https://` وإلا فالمزود غير متاح.
- [ ] المتغير `VERCEL_DEPLOY_ENABLED` مساوٍ `true`.

### بعد النشر — خطوات تحقق قابلة للتكرار

نفّذ الخطوات بالترتيب؛ أي استجابة غير المتوقعة تعني مشكلة تهيئة يجب علاجها قبل إعلان الجاهزية:

| # | الطلب | الاستجابة المتوقعة | معنى الاستجابة المخالفة |
|---|---|---|---|
| 1 | `GET /` | `200` والواجهة تُعرض | فشل البناء أو النشر |
| 2 | `GET /admin` | `200` ونموذج الدخول يظهر | لوحة الإدارة غائبة من البناء |
| 3 | `GET /api/admin/session` | `200` مع `{"authenticated":false}` | طبقة API لا تعمل |
| 4 | `POST /api/admin/login` بكلمة **خاطئة عمدًا** | `401` مع `{"error":"بيانات الدخول غير صحيحة"}` | راجع تفسير الخطوة 4 أدناه |
| 5 | `GET /cart` | `200` | مشكلة في صفحات العميل |
| 6 | `GET /api/admin/mcp/tools` | `404` بدون `ENABLE_MCP_TOOLS`، و`401` بدونه مع التفعيل | 404 = الطبقة مغلقة (السلوك الافتراضي)؛ 401 = الطبقة مفتوحة فعليًا وجلسة الإدارة مطلوبة |
| 7 | على قاعدة Turso: `SELECT COUNT(*) FROM order_items;` | استعلام ناجح بلا خطأ «no such table» | إصلاح P0 لم يُفعَّل (راجع «إصلاح قاعدة البيانات P0» في نهاية الملف) |
| 8 | على قاعدة Turso: `SELECT name FROM sqlite_master WHERE type='table' AND name='product_search';` | يظهر الصف `product_search` | هجرة `0002` (FTS5) لم تُطبَّق على البيئة الحيّة |
| 9 | على قاعدة Turso: `SELECT COUNT(*) FROM product_search;` | يساوي `SELECT COUNT(*) FROM products;` | الفهرس غير متزامن مع الكتالوج؛ يكفي أول عملية/طلب بعد التجهيز لأن المزامنة في نهاية `runMigrations` (وأعد النشر إن بقيت الفجوة) |
| 10 | `POST /api/orders` بطلي مستخدِم تجريبي | `200 {ok:true,...}` وخفض المخزون وظهور `order_items` | فشل كتابة الطلب: راجع الربط `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` |
| 11 | `POST /api/orders` ثانية بعد الخطوة 10 | `200` بلا أخطاء تكرار معرف أو فقدان أصناف | مشكلة في المعاملة المركّبة (خصم + طلب + أصناف) |
| 12 | `POST /api/chat` بسؤال «منظف أرضيات» مع تفعيل `ENABLE_AI_AGENT` و`ENABLE_MCP_TOOLS` | رد يحمل بطاقات منتجات مطابقة | FTS5 أو طبقة الأدوات عاطلة؛ راجع سجل النشر |
| 13 | `POST /api/orders/track` برقم الطلب من الخطوة 10 وآخر 4 أرقام من هاتفه **مع** `ENABLE_ORDER_TRACKING=true` | `200` مع `{ok:true,status:"جديد",items:[…]}` بلا هاتف كامل ولا عنوان | قناة التتبع عاطلة أو المعرّفات غير صحيحة |
| 14 | `POST /api/orders/track` بنفس رقم الطلب وآخر 4 أرقام **خاطئة** | `404` بنفس رسالة الخطوة 13 («تعذر العثور على الطلب») حرفيًا | تسريب وجود/عدم وجود الطلب (غير مقبول — لا تكشِف الفرق للعميل) |
| 15 | `GET /product/p1` (ولأي معرف حقيقي) | `200`، و`<title>` يحمل اسم المنتج وسعره، و`rel="canonical"` يعود للمسار نفسه | **عطل إنتاجي حقيقي سابق**: كان `params` يُقرأ متزامنًا في Next 16 ⇒ **كل صفحات المنتجات 404**. تأكد أن النشر يحمل الإصلاح (`await params`) |
| 16 | `GET /product/<معرف غير موجود>` | `404` (لا صفحة 200 بمحتوى 404) ووسم `<meta name="robots" content="noindex">` **وحده** | 200 = «404 ناعم» (سببها حدّ تحميل جذري)، ووسمان متعارضان = إعلان `robots` في الـlayout |
| 17 | `GET /robots.txt` · `GET /sitemap.xml` · `GET /manifest.webmanifest` · `GET /icon.svg` | `200` جميعها؛ الخريطة تحوي 13 رابطًا بلا `/admin` | بناء الميتاداتا الديناميكية معطّل (تحقق من مخرجات البناء في `Route (app)`) |

مثال على الخطوة 4 (نفّذها **مرة واحدة** — حد المعدل 8 محاولات لكل 10 دقائق):

```bash
curl -i -X POST https://aborof.vercel.app/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"password":"probe-not-a-real-password"}'
```

تفسير نتائج الخطوة 4:

- `401` ← **مهيأ بالكامل**: المتغيران مضبوطان على Vercel، والنظام يرفض أي كلمة خاطئة دون تسريب أي معلومة.
- `503` ← رسالة الخطاب تسمّي الآن **المتغير الناقص بدقة** (مثلًا: `لوحة الإدارة غير مهيأة بعد: ADMIN_SESSION_SECRET غير مُعيَّن.`)؛ أضِف المتغير المذكور في إعدادات Vercel ثم أعد النشر.
- `429` ← استُهلك حد المعدل؛ انتظر 10 دقائق وأعد المحاولة مرة واحدة.

> **لا تختبر بكلمة المرور الحقيقية عبر سطر أوامر أو شبكة غير موثوقة.**
> الاختبار بكلمة خاطئة كافٍ لإثبات الجاهزية، والدخول الفعلي يكون من صفحة `/admin` مباشرة.

> **تفعيل تتبع الطلبات (الصفان 13–14):** لا يفتح `ENABLE_ORDER_TRACKING` إلا بعد اجتياز الصفين 13 و14 معًا — الأول يثبت أن التتبع يعمل للعميل الصحيح، والثاني يثبت أن الرسالة موحّدة ولا تكشف وجود الطلب من عدمه. أي فرق بين الرسالتين يعني تسريب تعداد، فأبقِ العلم مغلقًا.

## إصلاح قاعدة البيانات P0 — بسط مسار `@/lib/db`

كان هناك ملفان متنافسان: `src/lib/db.ts` (قديم، ينشئ الجداول وقت التشغيل **دون تشغيل الهجرات**) و`src/lib/db/index.ts` (حديث، يشغّل الهجرات المرقّمة). وبما أن محرّر TypeScript يحسم `@/lib/db` لملف `.ts` قبل المجلد `db/index.ts`، كانت مسارات الإنتاج تمر بالملف القديم فلا تُنشأ `order_items` أبدًا ← فشل إنشاء الطلبات في البيئة الحيّة (`no such table: order_items`).

**الحسم:** حُذف `src/lib/db.ts` وأصبح `@/lib/db` يحل حصريًا إلى `db/index.ts` الذي يشغّل الهجرات (بما فيها `order_items` وقيودها). بعد الدمج تحقق عبر الصف 7 ثم الصفين 10–11 من الجدول أعلاه.

### بوابة الواجهة الإلزامية (تمنع تراجع هذه الإصلاحات)

```bash
npm run front:check     # 22 فحصًا: الحدود الأربعة، ميتاداتا المنتج، sitemap/robots/manifest
                        # + await params (سبب 404 المنتجات) + منع حدّ تحميل يلفّ /product/[id]
```

البوابة تعمل في `quality.yml` (بعد جرد المسارات) وفي `deploy.yml` (قبل النشر)، وأي نقص يُفشل البناء برسالة عربية تحدّد الملف المفقود.

يمكن أيضًا تشغيل وظيفة **Production probe** من تبويب **Actions** للحصول على نتيجة الخطوة 4 من داخل GitHub (بدون أسرار، ومحاولة واحدة لكل تشغيل).

## أدوات التحقق الجاهزة (سكربتات)

بدل تنفيذ الفحوص يدويًا، المستودع يتضمن أدوات تنفّذها بالنيابة عنك:

| الأمر | ما يفحصه | ملاحظة |
|---|---|---|
| `npm run verify:secrets -- --env production` | يطابق أسرار/متغيرات Actions مع جدول «النشر التلقائي»، ويفحص حماية البيئة وحماية `main` | يحتاج توكن **المالك** (`Secrets: read`)؛ بلا هذه الصلاحية يطبع الفحوص غير السرية ويخرج بكود 2 |
| `bash scripts/apply-turso-secrets.sh` | يضبط `TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN` في المكانين معًا (GitHub بيئة `production` + Vercel Production) بعد تحقق شكلي: يرفض رابط لوحة التحكم ويرفض رابطًا في حقل الرمز | القيم من متغيرات البيئة أو مدخل مخفي، **ولا تُطبع أبدًا** وتُمرَّر عبر `stdin`؛ `--dry-run` يعرض ما سيُفعل بلا تنفيذ |
| `TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… npm run verify:turso` | اتصال حقيقي + تطابق بصمات الهجرات مع المستودع + الصفوف 7 و8 و9 | للقراءة فقط، ولا يطبّق أي هجرة؛ بلا `TURSO_AUTH_TOKEN` يقبل `file:` للتحقق المحلي |
| `npm run smoke:prod` | الصفوف 1 و2 و3 و5 و6 و**15 و16 و16b و17** (صفحة منتج حقيقية، منع 404 الناعم، مسار غير موجود، ملفات robots/sitemap/manifest/icon) + رؤوس الأمان + وضع CSP + قرينة ربط قاعدة البيانات + وجود مسار التتبع، مع `<span dir="ltr">--admin-probe</span>` للصف 4، و`--chat-probe` للصف 12، و`--allow-mutations --orders-body` للصفين 10 و11، و`--track <id> --last4 <4>` للصفين 13 و14 | قراءة فقط افتراضيًا، وحاجز SSRF وشبكة عامة فقط (لا يعمل على localhost عن قصد) |
| `npm run security:bundle` | فحص ما ينزّله المتصفح فعلاً (`.next/static`): أسماء وقيم أسرار الخادم | يُشغَّل آليًا بعد `npm run build` في `quality.yml` و`deploy.yml` |
| `npm run routes:inventory` | جرد المسارات وبواباتها (نفس بوابة CI) | يفشل إن غاب أي مسار مطلوب |

### قراءة نتائج الـ Smoke بلا لبس

- **وضع CSP**: الرأس يُنشر افتراضيًا في وضع المراقبة (`Content-Security-Policy-Report-Only`) حتى يُفعَّل `CSP_ENFORCE=true`؛ لذلك صف الرؤوس يقبل الوضعين، وصف `csp-mode` يبيّن الوضع الفعلي، ولا يُفرض الحجب إلا مع `--require-csp-enforce` (استخدمه بعد ضبط `CSP_ENFORCE=true` وإلا فشل الفحص عمدًا).
- **قرينة ربط قاعدة البيانات (صف `db-binding`)**: مسار Turso في `getProducts()` يمرّر مفتاح `old_price` في كل صف دائمًا (ولو `null`)، بينما الاحتياطي يعيد كائنات `SEED_PRODUCTS` كما هي. ظهور صف بلا المفتاح يعني أن الكتالوج من البذرة المحلية ⇒ على الأرجح `TURSO_DATABASE_URL` غير مضبوط في Vercel، وعندها يفشل أي طلب حقيقي بـ `503 «قاعدة البيانات غير مربوطة»` (الصفان 10 و11). القرينة **ليست إثباتًا**: إثبات الاتصال هو الصفوف 7–9 (`npm run verify:turso`). التنازل الصريح عن القرينة: `--allow-seed-fallback`.
- **`503` في الصف 4**: الرسالة تسمّي المتغير الناقص بدقة على Vercel؛ و`401` تعني أن اللوحة مهيأة فعلًا.
- **الصف 15 (`/product/<id>`)**: فشله بـ`404` يعني عودة العطل الإنتاجي «`params` غير مُنتظر» (Next 16 يجعل `params` وعدًا) — الإصلاح والبوابتان في `src/app/product/[id]/page.tsx` و`npm run front:check`.
- **الصف 16**: `200` بدل `404` = «404 ناعم» يسبّبه أي `loading.tsx` في جذر `src/app/`؛ ووسم `index, follow` بجانب `noindex` = إعلان `robots` صريح في الـlayout.

تفاصيل الاستخدام والتشخيص في [`handoff/deploy-activation-runbook.md`](handoff/deploy-activation-runbook.md)، وسجل آخر تحقق حيّ في [`handoff/post-deploy-verification.md`](handoff/post-deploy-verification.md).

## تشغيل محلي

انسخ `.env.example` إلى `.env.local` وأدخل قيمًا محلية فقط، ثم شغّل:

```bash
npm ci
npm audit --omit=dev --audit-level=high
npm run lint
npm run typecheck
npm run security:gates
node scripts/sync-migrations.mjs --check
npm run routes:inventory
npm test
npm run build
npm run dev
```

تفاصيل الضوابط الأمنية ومصفوفة الإغلاق في [`docs/security/`](docs/security/).
