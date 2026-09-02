# PRE_RELEASE_GATE — بوابة الإصدار الرسمية

> **الغرض:** لا يُسمح بأي Production Release إلا بعد إثبات جاهزية المتجر وظيفيًا وأمنيًا وتشغيليًا — بأدلة مُلاحَظة، لا نتائج مفترضة.
> **التشغيل:** `npm run pre-release` — المخرجات في `evidence/pre-release/pre-release-result.json` + `pre-release-report.md`.
> **الربط:** `npm run release:check` يشمل البوابة (يفشل عند فشل أي P0)، وCI job مستقل `.github/workflows/pre-release-gate.yml`.

---

## 1. الحالات الثلاث (لا PASS/FAIL فقط)

| الحالة           | المعنى                                                                       |
| ---------------- | ---------------------------------------------------------------------------- |
| `PASS`           | مُختبر فعليًا في هذا التشغيل وأثبت سلوكه (أدلة مُلاحَظة).                    |
| `FAIL`           | مُختبر فعليًا وفشل (أو فحص ساكن وجد خللًا).                                  |
| `NOT_CONFIGURED` | غير قابل للتشغيل في هذه البيئة لغياب إعداد/خدمة/أداة — يُوضَّح السبب دائمًا. |

### قواعد صارمة

1. **لا PASS لشيء لم يُختبر فعليًا.** أي ادعاء PASS بلا ملاحظة = خلل في البوابة نفسها.
2. **الخدمة الخارجية غير المهيأة:** لا تُسقط الاختبار ولا تُزيف النتيجة —
   يُضاف Adapter/Test Double حتمي، يُختبر العقد والسلوك (success/failure/timeout/duplicate/idempotency/unavailable)،
   وتُسجَّل الخدمة `NOT_CONFIGURED` (اختيارية لا تمنع) — بينما أي **P0 NOT_CONFIGURED → RELEASE_BLOCKED**.
3. **لا أسرار:** تُطبع الأسماء فقط؛ لا قيم. لا تُطلب قيم أسرار من أي أحد.
4. **لا خدمات مدفوعة** تُضاف فقط لتجميل النتيجة — الأولوية: المكدس الحالي ← doubles محلية مجانية ← sandbox إن وُجد ← مزوّد حقيقي عند تهيئته.

## 2. قرار الإصدار

```text
RELEASE_READY   ⟺  كل P0 = PASS
                  ∧ لا يوجد أي P1 = FAIL
                  ∧ Production Config = PASS
                  ∧ Rollback = READY
                  ∧ Monitoring = PASS
                  ∧ Evidence = complete
                  ∧ الـ SHA ثابت (مُسجَّل في النتيجة)

خلاف ذلك → RELEASE_BLOCKED (exit 1)
```

## 3. التقسيم (P0 / P1)

```text
P0 Critical Business:  Auth · Product · Cart · Checkout · Order · Inventory · Admin
P0 Release:           Production config · Monitoring · Backup/Restore · Rollback · Post-deploy smoke
P1 Reliability:       Database · Idempotency · Transactions · Notifications · Webhooks · Recovery
P1 Security:          AuthN/AuthZ · Input validation · XSS/SQLi/IDOR · Session · Rate limits · Secrets
P1 Platform:          Mobile · RTL · Performance · SEO · Accessibility
P1 External:          Payment · Email · WhatsApp · AI · Storage (عقود عبر Test Doubles)
```

## 4. خريطة الطبقات العشرين → معرّفات البوابة

| #   | الطبقة (مطلوب المستخدم) | بوابات التنفيذ في `scripts/pre-release.mjs`                                                                                          |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Functional              | F01–F13 (home/products/detail/404/cart/order COD/idempotency/double-submit/validation/login/logout/authz/lifecycle+cancel/chat/CRUD) |
| 2   | Checkout/Payment        | F05, F06, F07, F08, F11, EX01 (PAYMENT_MODE=COD دورة كاملة؛ بوابة إلكترونية NOT_CONFIGURED مع عقد Fake)                              |
| 3   | Inventory               | F05 (خصم), F06 (مرة واحدة), F11 (استرجاع مرة واحدة), R04 (لا مخزون سالب), R03 (قيود)                                                 |
| 4   | Security                | S01–S09 (headers, cookie flags, authz 401, XSS, SQLi, secrets scan, leak, rate limits, CORS/framing)                                 |
| 5   | Database                | R01 (migration نظيف v3), R02 (idempotency), R03 (PRAGMA constraints/indexes), R05 (backup/restore), R06 (drills)                     |
| 6   | API                     | F08 battery (valid/invalid/missing/oversized/duplicate/malformed/429/404) + F10 (unauthorized)                                       |
| 7   | Frontend                | PL01 (RTL), PL02 (responsive), PL03 (nav landmarks), PL04 (a11y), PL05 (reduced-motion), PL12 (404)                                  |
| 8   | Performance             | PL06 (TTFB budgets), PL07 (bundle budgets), PL08 (LCP/INP/CLS → NOT_CONFIGURED بلا متصفح)                                            |
| 9   | SEO                     | PL09 (title/description), PL10 (robots), PL11 (canonical/OG/sitemap/JSON-LD → NOT_CONFIGURED بلا PRODUCTION_URL)                     |
| 10  | Media/Product data      | R03 (حقول المنتجات), F02 (اكتمال الحقول), EX05 (storage NOT_CONFIGURED + عقد Fake)                                                   |
| 11  | Orders/Notifications    | F05–F11 (snapshot السعر/الكمية في الطلب، الحالة، الاسترجاع)، EX02/EX03 (إشعارات NOT_CONFIGURED + عقد)                                |
| 12  | External integrations   | EX01–EX07 (واجهات + Test Doubles في `src/lib/providers/` + `tests/unit/providers.test.ts`)                                           |
| 13  | Failure/Recovery        | R06 (DRILL-01..06: DB fail/timeout, concurrency, restart, sessions, env, AI fallback)                                                |
| 14  | E2E                     | E2E01 (رحلة حرجة HTTP-level)، E2E02 (browser → NOT_CONFIGURED بلا متصفح)                                                             |
| 15  | Production config       | RC01 (أسماء المتغيرات فقط — الحضور/الغياب + إشارة أدلة deploy)                                                                       |
| 16  | Backup/Restore          | R05 (نسخ→تلف→استعادة→تحقق schema+بيانات)                                                                                             |
| 17  | Rollback                | RC02 (migrations إضافية فقط)، RC03 (دليل rollback-readiness الملاحَظ)                                                                |
| 18  | Observability           | RC07 (request-id echo, structured logs, health/ready, لا تسريب أسرار في السجلات)                                                     |
| 19  | Release decision        | `pre-release-result.json` (SHA, timestamp, counts, blockers, decision)                                                               |
| 20  | Gating rule             | القسم 2 أعلاه — `RELEASE_READY` فقط بالشروط كلها                                                                                     |

## 5. معمارية Provider Interface

```text
PaymentProvider / NotificationProvider / AIProvider / StorageProvider / WebhookVerifier
        ↓
┌───────────────────────┬──────────────────────────┐
│ Real (إنتاج)          │ Test Double / Fake (CI)  │
│ CODProvider           │ createFakePaymentProvider │
│ NoopNotification      │ createFakeNotification…   │
│ (chat-local fallback) │ createFakeAIProvider      │
│ MemoryStorageProvider │ createFailingStorage…     │
│ HmacWebhookVerifier   │ RejectAllWebhookVerifier  │
└───────────────────────┴──────────────────────────┘
```

- الحالة الحالية لكل مزوّد مُسجَّلة صراحة في `src/lib/providers/index.ts` ونتيجة البوابة (EX01–EX06).
- **لم يُعاد توصيل منطق الأعمال** بالمزوّدات في هذه المرحلة (تجميد السلوك) — الواجهات إضافية وجاهزة للتوصيل عند وجود مزوّد حقيقي.

## 6. النزاهة

- البوابة تفتح خادم `next start` (إنتاج) على قاعدة SQLite محلية نظيفة بقيم اختبار وهمية — لا تلمس أي إعداد إنتاج أو نشر.
- كل فحص HTTP يستخدم عناوين IP افتراضية معزولة لدلاء الـ rate limit.
- `npm run pre-release` يشمل: lint, tsc, routes, format, unit (بما فيها عقود الـ providers), build, drills L5، بطارية HTTP، الفحوصات الساكنة، ثم القرار.
- البوابة الحالية متوقعة `RELEASE_BLOCKED` حتى اكتمال **TASK-02** (Production Config / Monitoring / Post-deploy NOT_CONFIGURED) — هذا صحيح ومقصود: لا يُنشر قبل اكتمال الإعدادات.

## 7. المحاور العشرة (Final Release Gate — R1..R10)

كل محور هو **نظرة فوق بوابات** موجودة (لا فحص جديد مستقل) — القرار النهائي من القسم 2:

| المحور                      | البوابات المغطية                                                                                                                 | الحالة (آخر تشغيل)                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **R1 Code Quality**         | L1-LINT, L1-TSC, L1-ROUTES, L1-FMT, L1-UNIT, L2-BUILD                                                                            | ✅ PASS                           |
| **R2 Runtime**              | F01..F04, PL06, PL12, RC07 (health/ready/rid/logs)                                                                               | ✅ PASS                           |
| **R3 Business**             | F05..F13, E2E01                                                                                                                  | ✅ PASS                           |
| **R4 Data Integrity**       | R01, R02, R03, R04, R05, R07 (watchdog 9 فحوصات: schema/stock/orders/totals/status/idempotency/orphans/snapshots/reconciliation) | ✅ PASS                           |
| **R5 Security**             | S01..S10 (headers, cookie, authz, XSS, SQLi, secrets HEAD + history S06B, leak, rate limits, CORS, timeouts)                     | ✅ PASS                           |
| **R6 Checkout/Inventory**   | F05..F08, F11, C1 (same-key ×20), C2 (oversell ×60), R04                                                                         | ✅ PASS                           |
| **R7 External Services**    | EX01..EX07 + عقود providers (22 اختبار)                                                                                          | ✅ PASS + NOT_CONFIGURED اختيارية |
| **R8 Performance/UI**       | PL02, PL05, PL06, PL07, PL08 (NC), E2E02 (NC)                                                                                    | ✅ PASS + NC                      |
| **R9 Deployment/Rollback**  | RC01 (NC), RC02, RC03, RC06 (NC), RC10, RC11                                                                                     | ⛔ حتى TASK-02                    |
| **R10 Monitoring/Recovery** | RC04, RC05 (NC), R06 (drills), R05 (restore)                                                                                     | ⛔ حتى TASK-02                    |

## 8. Full Release Rehearsal (بروفة الإصدار الكاملة)

تُنفَّذ قبل أول نشر — نفس الـ artifact/configuration المتوقع استخدامها في الإنتاج قدر الإمكان:

```text
Fresh Environment → Install (npm ci) → Migration (v3) → Seed → Build
→ CI (L1-L5) → Smoke (L3/L4) → Resilience (L5 drills) → Backup → Restore drill
→ Deploy Candidate (من rc-<sha> tag) → Post-Deploy smoke → Monitoring
```

- **المراحل حتى Backup/Restore:** منفّذة ومثبتة في `npm run pre-release` (بوابات R01..R07 + R06 + R05).
- **Deploy Candidate + Post-Deploy + Monitoring:** `NOT_CONFIGURED` حتى اكتمال TASK-02 (المتغيرات والأسرار) — تُنفَّذ عبر deploy workflow (تاج `rc-<sha>`).
- **القاعدة:** أي تغيير على الكود بعد البروفة يبدأ دورة تحقق جديدة (Release Freeze).

## 9. قائمة إطلاق P0 (شروط الإطلاق — حالة التنفيذ)

| الشرط                                          | الحالة                   | الدليل                                                                    |
| ---------------------------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| Release Freeze (RC SHA ثابت)                   | ✅                       | RC11 + قاعدة "أي تغيير = دورة جديدة"                                      |
| Production Configuration Gate                  | 🔶 NOT_CONFIGURED        | RC01 — بانتظار الأسرار/المتغيرات (TASK-02)                                |
| Backup + Restore فعلي                          | ✅                       | R05 (نسخ→تلف→استعادة→تحقق) + R07                                          |
| Transaction Integrity                          | ✅                       | F05/F06/F11 (stock/order/cancel مرة واحدة) + R04                          |
| Double-Submit / Race                           | ✅                       | C1 (20× نفس المفتاح) + C2 (60× oversell) + DRILL-02                       |
| Kill Switch للتكاملات                          | ✅ AI (AI_ENABLED=false) | `src/app/api/chat/route.ts` — البقية عند وجودها                           |
| Global Timeout Policy                          | ✅                       | S10 + `AbortSignal.timeout` في chat + `withTimeout`                       |
| Idempotency Audit                              | ✅                       | orders (key+UNIQUE)، product upsert، PATCH إلغاء مرة واحدة، Outbox dedupe |
| Webhook Replay Protection                      | ✅ (عقد)                 | `createHmacWebhookVerifier` + `createWebhookDeduplicator` (EX06)          |
| Secret History Scan                            | ✅                       | S06B (git log --all -p)                                                   |
| Dependency Supply-Chain                        | ✅                       | EX07 + npm audit (CI) + no new deps                                       |
| Admin Hardening                                | ✅                       | auth (HMAC/HttpOnly/rate-limit/audit) + F09/F10                           |
| Data Invariant Scanner                         | ✅                       | R07 watchdog (9 فحوصات، يومي)                                             |
| Reconciliation                                 | ✅                       | watchdog totals + R07                                                     |
| Snapshot Integrity                             | ✅                       | watchdog snapshots + R07                                                  |
| 3D ليس شرطًا للتشغيل                           | 🔶 مخطط                  | مع مرحلة CINEMATIC UI (progressive enhancement)                           |
| Performance Budget قبل التصميم                 | ✅                       | PL06/PL07 + قاعدة PR تجاوز budget = FAIL                                  |
| Mobile-first Checkout                          | 🔶 مخطط                  | مع مرحلة CINEMATIC UI                                                     |
| SEO Release Audit                              | 🔶 جزئي                  | PL09/PL10/PL12 ✅ · PL11 (canonical/OG/sitemap) NC                        |
| Error/Business Alerts                          | ✅ (هوية)               | M03 + كواشف المراقبة (OTP/recovery/source/session) + لوحة Security Center |
| Synthetic Monitoring                           | 🔶 مخطط                  | بعد PRODUCTION_URL                                                        |
| Runbooks                                       | ✅ مسودة                 | `YEAR-1-RELIABILITY.md` §7                                                |
| Rollback Drill                                 | ✅                       | RC03 + evidence/deploy-result/rollback-readiness.md                       |
| Deployment Provenance                          | ✅                       | deploy.yml (SHA gate) + RC11 + evidence                                   |
| Feature Flags / Maintenance Mode / Incident ID | 🔶 مخطط                  | P2 — مع النشر/الواجهة                                                     |

## 10. SECURITY-MONITORING (P0 Security — IDENTITY SECURITY MONITORING HOOKS)

المراقبة الأمنية للهوية مدمجة في البوابة كشرط P0 قبل أول Production:

```
SECURITY-MONITORING
├── M01-MONITOR-INSTRUMENTED  — كل الأحداث القانونية (24) مبعوثة فعليًا من التدفقات
├── M02-MONITOR-METRICS       — عدادات تتحرك بعد دورة OTP حقيقية + لا أسرار في الاستجابة
├── M03-MONITOR-ALERTS        — كاشف تعسف الاسترداد (WARNING) + حد المعدل يُحتسب
├── M04-MONITOR-FAILOPEN      — MONITOR_DISABLED=1: المصادقة/التحقق تعمل واللوحة degraded
└── M05-MONITOR-THRESHOLDS    — العتبات في وحدة سياسة (12 مفتاح MONITOR_*)، لا hard-code
```

**البنية:** Event (security_events) → Aggregation (metrics خفيف — نفس قاعدة البيانات) →
Threshold (MonitoringPolicy قابلة للضبط بالبيئة) → Alert (security_alerts، levels
INFO/WARNING/CRITICAL، dedupe لكل نافذة زمنية) → Dashboard (لوحة المراقبة في Security Center).

**الكواشف:** OTP failure spike · many accounts from one source (IP hash) ·
impossible identity change (risk score) · recovery abuse · session revoke spike.

**الخصوصية:** لا OTP ولا كلمات مرور ولا رموز جلسات في الأحداث (تطهير metadata + hashes).
**العزل:** أي فشل في التسجيل/الكشف = degraded ولا يكسر login/verification/change أبدًا.
**الاحتفاظ:** hot 30 يومًا · audit 365 · alerts 90 (قابلة للضبط).
