# PRODUCTION-HARDENING-01

> **الهدف:** تحويل متجر روفيده من "Web App يبني بنجاح" إلى "Production System له دليل تشغيل قابل لإعادة الإنتاج".
> **القاعدة الحاكمة:** `Build PASS ≠ System PASS`. لا يُعتبر أي إصدار Production Ready إلا باجتياز المستويات الخمسة.
> **قرار الإدارة:** وقف كل الميزات الجديدة (chatbot / payment / UI / marketing / animations / integrations) حتى اكتمال هذا البرنامج.

---

## 1) تعريف PASS الجديد — 5 مستويات

| المستوى                  | المعنى                                                                                                                                | الأمر (محلياً)                                               | في CI                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------ |
| **LEVEL 1 — Static**     | TypeScript + ESLint + Formatting                                                                                                      | `npx tsc --noEmit` + `npm run lint` + `npm run format:check` | job `quality`                  |
| **LEVEL 2 — Build**      | إنتاج build إنتاجي                                                                                                                    | `npm run build`                                              | job `quality`                  |
| **LEVEL 3 — Runtime**    | تشغيل `next start` (وليس dev) + طلبات HTTP حقيقية                                                                                     | `npm run test:smoke` (يبني الخادم بنفسه)                     | job `smoke`                    |
| **LEVEL 4 — Business**   | Login / Products / Cart / Orders / Stock / Admin / Chatbot — بنفس سيناريو المستخدم                                                    | `npm run test:smoke`                                         | job `smoke`                    |
| **LEVEL 5 — Resilience** | حقن أعطال فعلية: DB عابر + استعادة، تزامن طلبات + idempotency، قتل الخادم وسط طلب + اتساق، جلسات منتهية/مزوّرة، نقص env، فشل مزوّد AI | `npm run test:drill` (حقن عبر `FAULT_INJECTION`)             | job `smoke` (بعد unit + smoke) |

**الفتحة الكاملة محلياً:** `npm run verify` (Levels 1–4) ثم `npm run test:drill` (Level 5)، أو `npm run release:check` للاثنين معاً.

### LEVEL 5 — Resilience Drills (البرنامج الإلزامي)

لا يُسمى المشروع Production Ready إلا بعد L1–L5 جميعها. الاختبارات تنفذ على `next start` (إنتاج) وقاعدة بيانات حقيقية، مع حقن فشل عبر بذرة `FAULT_INJECTION` (test-only، بلا أثر في الإنتاج):

| الـ Drill | السيناريو                                                      | الدليل المطلوب                                                                                    |
| --------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| DRILL-01  | فشل DB عابر (أول 4 عمليات DB تفشل)                             | فشل آمن 5xx + `/api/ready` = 503 + تحلّل seed + **تعافٍ تلقائي بدون إعادة تشغيل** + طلب ناجح بعده |
| DRILL-02  | 12 طلباً متزامناً بنفس مفتاح idempotency + 6 بمفاتيح مختلفة    | كل الاستجابات 200 لنفس رقم الطلب + طلب واحد فقط + خصم مخزون واحد فقط + لا مخزون سالب              |
| DRILL-03  | قتل الخادم (SIGKILL) وسط طلب قيد التنفيذ (داخل نافذة المعاملة) | لا حالة وسطى (طلب ⟺ خصم كامل) + إعادة المحاولة بنفس المفتاح = نتيجة حتمية واحدة + طلب جديد ينجح   |
| DRILL-04  | جلسات: منتهية / توقيع مزوّر / كوكي غير صالح                    | 401 آمن + الجلسة الصالحة 200                                                                      |
| DRILL-05  | نقص `TURSO_DATABASE_URL`                                       | STARTUP FAIL فوري برسالة `Environment contract violated`                                          |
| DRILL-06  | مفاتيح Gemini/Groq غير صالحة (فشل مزوّد حقيقي)                 | الشات يرد 200 برد محلي صحيح + مهلة 10 ثوانٍ على المزوّدين                                         |

**قاعدة:** أي خلل يكشفه drill = يُصلَح ويُعاد الـ drill بالكامل، ويُسجَّل دليل جديد في `evidence/` قابل لإعادة التشغيل (`npm run build && npm run test:drill`).

---

## 2) المراحل الثماني — Gates + Acceptance Criteria

### PHASE A — Test Infrastructure

- [x] إطار اختبار وحدة (Vitest) + alias `@/`
- [x] اختبارات وحدة: auth (دورة كوكي كاملة مشفّرة)، shipping، rate-limit (bounded)، chat-local (علامات الترقيم)، db recovery
- [x] `scripts/smoke-test.mjs`: يبني `next start` إنتاجياً ويختبر LEVEL 3+4 على build نفسه
- [x] ربط `test:unit` و`test:smoke` في CI كبوابة إلزامية
- **Gate:** أي bug يُكتشف لاحقاً في Runtime/Business يجب أن يكون له اختبار يمنعه قبل إغلاق المرحلة.

### PHASE B — Runtime Reliability

- [x] `GET /api/health` (Liveness): التطبيق حي؟
- [x] `GET /api/ready` (Readiness): DB قابلة للخدمة؟ `{status, database}` + 503 عند الفشل
- [x] Environment Contract عند الإقلاع: نقص متغير حرج في الإنتاج = STARTUP FAIL (وليس "admin مكسور بغموض")
- [x] `.env.example` مطابق للـ runtime (تمت مراجعته)
- **Gate:** تشغيل `next start` بدون `TURSO_DATABASE_URL` أو `ADMIN_SESSION_SECRET` يجب أن يفشل برسالة واضحة.

### PHASE C — Authentication/Security

- [x] استبدال تنسيق `userId:timestamp:signature` الخام بـ **Base64URL cookie-safe** + strict parsing (جزءان بالضبط، base64url صالح، فحص توقيع `timingSafeEqual`، فحص انتهاء + سماحية فرق ساعة)
- [x] Security Headers: CSP + `X-Content-Type-Options` + `Referrer-Policy` + `X-Frame-Options` + `Permissions-Policy` + `poweredByHeader: false`
- [x] Rate limiter **bounded**: تنظيف انتهاء الصلاحية عند تجاوز حد الحجم
- [ ] ملاحظة معمارية: على serverless متعدد النسخ لا يُعتمد على الذاكرة المحلية — يُوثَّق القرار في README (حل خارجي عند الحاجة)
- **Gate:** اختبار وحدة لدورة كوكي كاملة (raw + URL-encoded) — يمنع تكرار bug الجلسة.

### PHASE D — Database/Data Integrity

- [x] نظام Migrations: جدول `schema_meta` + `version` + سجل هجرة `src/lib/migrations.ts` + تطبيق تسلسلي
- [x] التحقق من `version` عند الإقلاع (يُبلَّغ في `/api/ready`)
- [ ] اختبار ترحيل DB قائمة من v1 → v3 (محلياً بـ file: SQLite)
- **Gate:** لا يُعدَّل schema خارج migrations.

### PHASE E — Business Invariants

- [x] **المخزون لا يصبح سالباً** (تحقق شرطي `stock>=?` داخل معاملة — قائم) + اختبار
- [x] **إلغاء الطلب يعيد المخزون** (PATCH → «ملغى» يسترجع الكميات، مرة واحدة فقط)
- [x] **إنشاء الطلب Idempotent**: مفتاح `idempotencyKey` (عمود فريد + فحص مسبق + معالجة تعارض UNIQUE متزامن)
- [x] **الطلب المكرر لا يخصم المخزون مرتين** (اختبار smoke يثبتها)
- [ ] اختبار concurrency (طلبان متوازيان بنفس المفتاح → طلب واحد)
- **Gate:** طلب مكرر بنفس المفتاح = نفس رقم الطلب، وخصم واحد.

### PHASE F — Observability

- [x] Request ID: `middleware.ts` يضيف `x-request-id` (يستقبل `x-vercel-id` إن وُجد)
- [x] سجل منظم JSON: `{level, ts, request_id, route, error, durationMs, order_id...}` عبر `src/lib/log.ts`
- [x] تسجيل في المسارات الحرجة: orders POST/PATCH، chat، login، products، ready
- [ ] **بدون** تسجيل passwords أو session secrets أو بيانات حساسة (فحص في المراجعة)
- **Gate:** أي خطأ 500 يظهر في السجل مع request_id + route + error.

### PHASE G — Deployment Verification

- [x] بوابة CI: Static → Build → Unit → Smoke → Deploy
- [x] Post-deploy verification في workflow النشر: فحص `/api/health` + `/api/ready` + `/` + `/product/{معروف}` بعد النشر مباشرة (FAIL → فشل الـ job)
- [x] Synthetic Monitoring: workflow مجدول يفحص الموقع كل 15 دقيقة (Homepage / Product / Health / Ready) ويفشل عند الانقطاع (تنبيه GitHub)
- **Gate:** لا يُنشر قبل اجتياز smoke؛ لا يُعتبر النشر ناجحاً قبل post-deploy checks.

### PHASE H — Failure/Recovery Testing

- [x] DB failure ثم استعادتها → الطلب التالي ينجح (اختبار وحدة `ensureSchema` retry)
- [x] Invalid cookie / expired session / tampered token → 401 آمن
- [x] Malformed request (JSON خاطئ) → 400 واضح (وليس 500 غامض)
- [x] طلب مكرر (idempotency) → نتيجة واحدة
- [x] المخزون = 0 أو كمية أكبر من المتاح → 409
- [x] `GET /api/ready` عند فشل DB → 503 `{database:"error"}` (اختبار يدوي/وحدة)
- [ ] AI provider unavailable (Gemini/Groq معطّلان) → رد محلي — اختبار حقن عبر تعطيل env
- [ ] Restart during request — اختبار يدوي موثق
- **Gate:** النظام يفشل بأمان (خطأ واضح + تعافٍ تلقائي) في كل سيناريو.

---

## 3) سيناريوهات Recovery الإلزامية (Failure Injection)

| السيناريو                         | السلوك المطلوب                                                  | الاختبار           |
| --------------------------------- | --------------------------------------------------------------- | ------------------ |
| DB غير متاحة                      | الطلب يفشل بأمان + `/api/ready` → 503 + المحاولة التالية تتعافى | unit + smoke       |
| DB timeout                        | نفس السلوك مع `durationMs` في السجل                             | unit (محاكاة)      |
| كوكي غير صالح                     | 401                                                             | unit + smoke       |
| جلسة منتهية                       | 401                                                             | unit               |
| طلب مشوّه (JSON)                  | 400 برسالة واضحة                                                | smoke              |
| طلب مكرر (idempotency)            | نفس رقم الطلب + خصم واحد                                        | smoke              |
| منتج غير موجود                    | 409                                                             | smoke              |
| stock = 0 أو كمية أكبر من المخزون | 409                                                             | smoke              |
| API خارجي (Gemini/Groq) معطل      | رد محلي من قاعدة البيانات                                       | unit + smoke       |
| متغير بيئة ناقص                   | STARTUP FAIL في الإنتاج                                         | unit (validateEnv) |
| إلغاء طلب                         | استرجاع المخزون مرة واحدة                                       | smoke              |
| إعادة تشغيل                       | أعمال نظيفة بدون حالة عالقة (معاملات rollback)                  | documented         |

---

## 4) Environment Contract

| المتغير                           | الحالة                | عند النقص                |
| --------------------------------- | --------------------- | ------------------------ |
| `TURSO_DATABASE_URL`              | required (production) | STARTUP FAIL             |
| `TURSO_AUTH_TOKEN`                | required مع Turso     | فشل الاتصال برسالة واضحة |
| `ADMIN_SESSION_SECRET`            | required ≥ 32 حرفاً   | STARTUP FAIL             |
| `ADMIN_PASSWORD`                  | required للوحة التحكم | 503 «غير مهيأة»          |
| `GEMINI_API_KEY` / `GROQ_API_KEY` | اختياري               | رد محلي                  |
| `GEMINI_MODEL` / `GROQ_MODEL`     | اختياري               | default                  |

> يُطبَّق الفحص في `src/lib/env.ts` عبر `instrumentation.ts` — في الإنتاج يوقف الإقلاع، وفي التطوير يحذّر فقط.

---

## 5) خط أنابيب النشر (Deployment Gate)

```
Commit → Typecheck → Lint → Format → Build → Unit tests → Production Smoke (next start) → Security checks → Deploy → Post-deploy smoke → PASS
```

- الفرع المباشر على production ممنوع؛ كل تغيير عبر PR + CI + review.
- فشل أي مرحلة = `CI FAIL` + `Deployment BLOCKED`.

## 6) سجل الحالة (يتحدث مع التنفيذ)

| المرحلة                     | الحالة    | ملاحظات                                                                                                                    |
| --------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| A — Test Infrastructure     | ✅ مكتملة | vitest + smoke + CI                                                                                                        |
| B — Runtime Reliability     | ✅ مكتملة | health/ready/env contract                                                                                                  |
| C — Auth/Security           | ✅ مكتملة | Base64URL token + headers + bounded limiter                                                                                |
| D — DB/Data Integrity       | ✅ مكتملة | migrations + schema_meta                                                                                                   |
| E — Business Invariants     | ✅ مكتملة | idempotency + restock + stock ≥ 0                                                                                          |
| F — Observability           | ✅ مكتملة | request-id + structured logs                                                                                               |
| G — Deployment Verification | ✅ مكتملة | post-deploy smoke + synthetic monitor                                                                                      |
| H — Failure/Recovery        | ✅ مكتملة | DRILL-01..06 تنفذ فعلياً وتنجح؛ الأدلة في `evidence/l5-resilience-*.md` — مهلة 10 ثوانٍ أُضيفت لمزوّدي AI (كشفها DRILL-06) |
