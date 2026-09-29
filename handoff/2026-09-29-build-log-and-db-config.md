# سجل بناء Vercel (`bdd7376`) — ما فيه، وما كان المعطَّل فعلًا، وما تغيّر (2026-09-29)

المدخل: سجل بناء `Redeploy` لمشروع `aborof` على Vercel (الالتزام `bdd7376` = بعد دمج #27، Next 16.3.5، وnpm حديث — صيغة تحذير `install-scripts` تعود لـ11.16+) مع طلب «حل المشكلة».

## 0) الخلاصة

1. **البناء نفسه نجح** (`Deployment completed`). لا خطأ في السجل؛ فيه أربعة تحذيرات، كلها قابلة للتقليل إلا ما هو أصله في مكتبات خارجية (§3).
2. **المشكلة الحقيقية وقت التشغيل لا وقت البناء:** بعد ذلك النشر بدقائق (20:41Z) كان `GET /api/products` يردّ
   `503 {"error":"إعداد الاتصال بقاعدة البيانات غير صالح.","code":"SERVICE_UNAVAILABLE"}` والرئيسية تعرض «حصلت مشكلة مؤقتة».
   هذه الرسالة تصدر **فقط** حين يرمي `createClient()` — أي أن قيمة `TURSO_DATABASE_URL` الفعلية على Vercel (مشروع `aborof`) غير قابلة للاستخدام.
   تطبيع PR #27 (قلب الحقلين + إزالة `KEY=` والتنصيص العادي) لم يكفِ، فالقيمة شيء آخر.
3. **لا أستطيع قراءة متغيّرات Vercel من هنا**، فلا أعرف القيمة. لذلك عُمّم الاستخراج ليُصلح كل الأشكال الشائعة آليًا، وصار السبب يُكتب في السجل بدقة (§2).

## 1) أدلة (قراءة فقط)

| الدليل | النتيجة |
|---|---|
| `GET https://aborof.vercel.app/api/products` (2026-09-29 20:41Z) | `503` برسالة «إعداد **الاتصال**…» (وليست «إعداد **الرابط**…» الخاصة برابط لوحة Turso، ولا «غير مهيأة») ⇒ `createClient` رمى |
| `GET /api/admin/session` | `{"authenticated":false,"rbac":false,"actor":null}` ⇒ النشر الحيّ هو `main` الأحدث (حقلا `rbac` و`actor` من #22) فكود #27 مُطبَّق وما زال الفشل |
| `GET /cart` | يعمل (صفحة ثابتة لا تلمس القاعدة) |
| `GET /sitemap.xml` | وثيقة فارغة على الإنتاج؛ وعلى `next start` محلي بقيمة رابط غير صالحة يعطي **500** بجسم فارغ — نفس العرَض (الخريطة تقرأ المنتجات). وكذلك `/product/p1` ⇒ 500 والرئيسية ⇒ 200 بواجهة الخطأ |
| حالة الالتزام `bdd7376` | ثلاثة مشاريع Vercel تبني المستودع: `aborof` و`aborof-store-v2` و`aborof-updated-17d3397` — **لكل منها متغيّراتها**. الـ Redeploy في السجل كان لمشروع `aborof` (حالة `Vercel – aborof` 20:36:29Z) |
| بيئات GitHub | يوجد **بيئة باسم `TURSO_AUTH_TOKEN`** (أُنشئت 19:53Z) — أثر خطأ ترتيب معاملات في أمر `gh secret set … --env …`؛ لا تأثير لها ويمكن حذفها |
| `Deploy to Vercel` (GitHub Actions) | يفشل في الفحص التمهيدي (`TOKEN_SEES_NO_PROJECTS`) — مسألة منفصلة موثّقة في `2026-09-29-production-state.md`؛ النشر الفعلي يجري عبر تكامل Git |

## 2) ما تغيّر في الكود

- `src/lib/db/turso-config.ts` (جديد): استخراج الرابط والرمز من أي ترتيب لهذه الحالات بدل إسقاط المتجر — أحرف اتجاه/عرض صفري خفية من نسخ نص عربي (`RLM`…)،
  تنصيص/باكتيك/أقواس/`**`/`KEY=`/`export`، كتلة `.env` كاملة في خانة واحدة، رمز مكسور على أسطر، شرطات مطبعية، حقلان متبادلان، مضيف بلا `libsql://`،
  رابط لوحة تحكم (يُشتقّ منه `libsql://<db>-<org>.turso.io` — المضيف الذي أثبت المجسّ وجوده)، و`?authToken=` داخل الرابط. قيم `file:` و`:memory:` والخوادم الذاتية تمرّ كما كانت.
- `src/lib/db/index.ts`: يستخدمه `db()`؛ حالة «غير مضبوط» كما كانت (`null`)، وما لا يُصلَح يبقى **503 مغلقًا** (سياسة fail-closed محفوظة) لكن يكتب سطرًا منظَّمًا
  `db_config_invalid` (أو `db_config_repaired` عند الإصلاح الآلي) فيه **نوع** القيمة في كل متغيّر وطولها وسبب الفشل وعلاج بالعربية — **لا قيمة أبدًا**. وفشل الاستعلام صار يسجّل حالة HTTP (`http=401` رمز، `404` قاعدة، `400` صيغة) وسبب الشبكة (`cause=ENOTFOUND`).
  رابط Turso بلا رمز يفشل فورًا بدل طلب شبكة مصيره 401.
- `/api/admin/diagnostics` يعيد `db_config` بالوصف نفسه (لمن يملك مفتاح التشخيص فقط). الاستجابات العامة بلا أي حقل جديد (`tests/db-config.test.ts`).
- `src/middleware.ts` → `src/proxy.ts` (`export function proxy`): يُزيل تحذير Next 16 «The "middleware" file convention is deprecated». السلوك واحد (`tests/proxy.test.ts`).
- `package.json`: `allowScripts` (`esbuild` و`fsevents` و`unrs-resolver`) يزيل تحذير `npm warn install-scripts` — **جُرِّب بـnpm 11.19.1**: ظهر التحذير بحزمه الأربع بنصّه كما في السجل على `bdd7376` واختفى بعد التعديل؛ مع حارس `tests/install-scripts-policy.test.ts`.
- ترقيات: `next`/`eslint-config-next` إلى 16.3.7 (يشمل إصلاح 16.3.6 لـGHSA-vcvr-r3jv-pc5j في `next/og`، والمستودع لا يستخدمه)، و`js-yaml` 4.3.2 (عالية، تطوير فقط).

## 3) تحذيرات باقية عمدًا (لماذا)

تفصيلها ودليلها في [`docs/security/05-dependency-upgrades.md`](../docs/security/05-dependency-upgrades.md):
`eslint@9.39.5` (ESLint 10 يفشل مع `eslint-config-next@16.3.7`: `eslint-plugin-react` لا يدعمه بعد) و`@esbuild-kit/*` (تبعية `drizzle-kit` نفسه؛ ترقيته إلى 0.31.11 لا تزيلها).

## 4) المطلوب من المالك لعودة المتجر (لا يمكن تنفيذه من المستودع)

1. **Turso** ← القاعدة ← **Connect**: انسخ رابط الاتصال (`libsql://<db>-<org>.turso.io`) وأنشئ رمزًا بصلاحية Full access (`eyJ…`).
2. **Vercel** ← مشروع **`aborof`** (هو الذي يخدم `aborof.vercel.app`) ← Settings ← Environment Variables ← **Production**:
   `TURSO_DATABASE_URL` = الرابط، `TURSO_AUTH_TOKEN` = الرمز، **كلٌّ بقيمة واحدة في سطر واحد**. أو بأمر واحد:
   `bash scripts/apply-turso-secrets.sh` (يتحقق من الاتصال حيًّا قبل أي لمس).
3. **Redeploy** للمشروع نفسه.
4. تحقّق: `https://aborof.vercel.app/api/products` ⇒ `200` وفيه `products`. إن بقي `503`: Vercel ← Logs ← ابحث `db_config_invalid` وأرسل السطر (لا يحوي أسرارًا) — يسمّي المتغيّر الخاطئ ونوع قيمته.
