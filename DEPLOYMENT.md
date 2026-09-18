# نشر متجر روفيده

## النشر التلقائي

يحتوي المستودع على Workflow باسم `Deploy to Vercel` ينفذ فحوصات الجودة ثم ينشر فرع `main` إلى بيئة Vercel الإنتاجية. حماية النشر متعمدة: لا يبدأ الـ Workflow حتى يكون متغير المستودع `VERCEL_DEPLOY_ENABLED` مساويًا للنص `true`.

وظيفة النشر مرتبطة أيضًا ببيئة GitHub المسماة `production` (`environment: production`)، أي أنها:

- تقرأ الأسرار والمتغيرات من نطاق البيئة أولًا، ثم ترجع إلى نطاق المستودع إن لم تكن معرّفة هناك؛
- تخضع لقواعد حماية البيئة إن أضفتها (مراجعون مطلوبون، مدة انتظار، أو قصر النشر على فروع محددة) عبر
  **Settings → Environments → production**، وهي طبقة حماية إضافية فوق شرط الفرع والمتغير.

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
| `ENABLE_RAG` | Variable اختياري | `true` لتفعيل ذاكرة المتجر (المرحلة الثالثة): تستدعي أداة `search_knowledge` المنتجات والأسئلة الشائعة وبيانات المتجر بلا أي مفتاح. تحتاج `ENABLE_MCP_TOOLS=true` معها |
| `RAG_ENGINE` / `RAG_TOP_K` / `RAG_MIN_SCORE` / `RAG_MAX_DOCUMENTS` | Variable اختياري | المحرك (`keyword` الافتراضي؛ أي قيمة أخرى تسقط للنصي) وحدود مركزية مقيّدة: 1–5 نتائج، 1–50 للدرجة، 50–2000 مستندًا |
| `DIAGNOSTICS_ENABLED` | Variable اختياري | `true` لتفعيل نقطة التشخيص (معطّل في الإنتاج افتراضيًا) |
| `DIAGNOSTICS_KEY` | Secret اختياري | مفتاح **مستقل** عن `ADMIN_SESSION_SECRET` لنقطة `/api/admin/diagnostics` |
| `CSP_ENFORCE` | Variable اختياري | `true` لتشديد CSP من وضع المراقبة إلى الحجب |
| `VERCEL_DEPLOY_ENABLED` | Repository variable (أو Environment variable على `production`) | `true` بعد التأكد من الأسرار |

> تفاصيل المرحلة الثانية (الأعلام، الحدود، مصفوفة صفر كسر، التراجع) في `docs/ai/phase-2-nim-mcp.md`،
> والمرحلة الثالثة (التسهيلات) في `docs/ai/phase-3-ux-roadmap.md`، والذاكرة/RAG في `docs/ai/phase-4-rag-memory.md`.

> **فصل الأسرار إلزامي:** `ADMIN_SESSION_SECRET` لتوقيع الجلسات فقط، و`DIAGNOSTICS_KEY`
> للتشخيص فقط. يفحص حاجز النشر الثابت أنهما غير متطابقين وأن سر الجلسات لا يُذكر
> خارج وحدتي الجلسات والأسرار.

يجب إضافة متغيرات التطبيق مثل `TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN` و`ADMIN_PASSWORD` و`ADMIN_SESSION_SECRET` أيضًا داخل **Vercel Project → Settings → Environment Variables** لبيئة Production؛ أسرار GitHub Actions لا تنتقل تلقائيًا إلى Runtime في Vercel.

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
- [ ] (المرحلة الثانية، اختياري) إن فُعّل `ENABLE_MCP_TOOLS` فراجع `MCP_ALLOWED_TOOLS` والحدود الثلاثة قبل النشر، وتذكّر أن الطبقة للقراءة فقط وأن أدوات الكتابة تحتاج بوابة `MCP_ALLOW_WRITE_TOOLS` منفصلة.
- [ ] (المرحلة الثانية، اختياري) إن أُضيف مفتاح NIM فتحقق أن `NVIDIA_NIM_BASE_URL` (إن وُجد) يبدأ بـ `https://` وإلا فالمزود غير متاح.
- [ ] شغّل `npm run health:providers` محليًا قبل النشر (وقبل تفعيل أي مزود جديد): يسمّي المشكلة بدقة بلا طباعة أي قيمة سرية، والمفاتيح الغائبة تحذير لا فشل.
- [ ] (المرحلة الثالثة، اختياري) إن فُعّل `ENABLE_RAG` فتأكد أن `ENABLE_MCP_TOOLS=true` معه، وأن `RAG_TOP_K` داخل 1–5.
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
| 7 | `GET /api/admin/mcp/tools` بجلسة إدارة | `200` وقائمة الأدوات | مع `ENABLE_RAG=true` يظهر `search_knowledge`؛ وبدونه تبقى أربع أدوات فقط |

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

يمكن أيضًا تشغيل وظيفة **Production probe** من تبويب **Actions** للحصول على نتيجة الخطوة 4 من داخل GitHub (بدون أسرار، ومحاولة واحدة لكل تشغيل).

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
