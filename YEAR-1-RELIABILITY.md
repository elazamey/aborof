# YEAR-1-RELIABILITY — نظام موثوقية المتجر لسنة كاملة

> **الحالة:** نشط — P0 مكتمل (مُثبت في PRE_RELEASE_GATE) · أساس P1 منفّذ (هذا الملف يوثّق)
> **الأولوية (بقرار المستخدم):** PRE_RELEASE_GATE + YEAR-1-RELIABILITY ← ثم Cinematic Frontend ← ثم Final Deployment
> **التاريخ:** 2026-09-02 · **الفرع:** `arena/01a05f01-aborof`

---

## 1. المبدأ

```text
منع المشكلة → اكتشاف مبكر → احتواء → تعافٍ تلقائي → نسخة احتياطية → Rollback
→ تحليل السبب → منع تكرارها
```

الهدف الواقعي: الأعطال **أندر، أقصر، أقل ضررًا، قابلة للاكتشاف والاسترجاع** — لا يوجد نظام لا يتعطل.

### بوابة الفرض على كل ميزة جديدة (إلزامية)

أي شيء يُضاف للمتجر يجب أن يجيب على الأسئلة الخمسة، وإلا "لم تكتمل هندسيًا":

```text
هل أضفت Feature؟ → ماذا يحدث إذا فشلت؟ → هل يمكن اكتشاف الفشل؟
→ هل يمكن احتواؤه؟ → هل يمكن التعافي؟ → هل يوجد Test يمنع تكراره؟
```

---

## 2. نموذج النضج (Maturity Model)

| المستوى | الوصف                 | الحالة الحالية                                                                |
| ------- | --------------------- | ----------------------------------------------------------------------------- |
| R0      | Unverified            | —                                                                             |
| R1      | Tested                | ✅ (L1–L5 + 54+ وحدة + smoke + drills)                                        |
| R2      | Monitored             | 🔶 جزئي (synthetic-monitor.yml موجود؛ الفعّال يحتاج PRODUCTION_URL — TASK-02) |
| R3      | Recoverable           | ✅ (rollback drill مثبت + restore drill + idempotency)                        |
| R4      | Resilient             | 🔶 (قواطع دوائر + retry + timeouts أُضيفت الآن؛ chaos شهري قادم)              |
| R5      | Continuously Hardened | 🔶 (بوابة مستمرة + CI؛ يحتاج جدولة يومية/شهرية بعد النشر)                     |

**هدف السنة: R5** — ويُعاد تقييم المستوى كل ربع سنة في `evidence/reliability/`.

---

## 3. الوحدات الـ12 (YEAR-1-RELIABILITY)

| #   | الوحدة                    | الحالة            | الدليل / التنفيذ                                                               |
| --- | ------------------------- | ----------------- | ------------------------------------------------------------------------------ |
| 01  | PRE_RELEASE_GATE          | ✅ **نشط ومُثبت** | `scripts/pre-release.mjs` — 57 بوابة (بعد إضافة R07) — `evidence/pre-release/` |
| 02  | CONTINUOUS_MONITORING     | 🔶 جاهز جزئيًا    | `synthetic-monitor.yml` (كل 15 دقيقة) — الفعّال يتطلب `PRODUCTION_URL`         |
| 03  | DATA_INTEGRITY            | ✅ **منفّذ**      | `scripts/integrity-watchdog.mjs` + بوابة R07 — 7 فحوصات invariants             |
| 04  | BACKUP_RESTORE            | ✅ منفّذ (عقد)    | بوابة R05 (نسخ→تلف→استعادة→تحقق) + `migrate-check` — الجدولة بعد النشر         |
| 05  | FAILURE_INJECTION         | ✅ منفّذ          | `FAULT_INJECTION` (fail/delay) + DRILL-01..06                                  |
| 06  | INCIDENT_RESPONSE         | 🔶 مسودة          | القسم 7 أدناه (SEV + Runbooks) — توثيق + تنفيذ عند أول incident                |
| 07  | DEPENDENCY_SECURITY       | ✅ منفّذ          | `npm audit` في CI (يفشل عند High/Critical) + secret scan + EX07                |
| 08  | REGRESSION_VAULT          | ✅ أساسه موجود    | 54 اختبار وحدة (أغلبها regressions موثّقة) — يُضاف كل incident                 |
| 09  | RELEASE_PROVENANCE        | ✅ منفّذ          | `evidence/pre-release/pre-release-result.json` (SHA, timestamp, gate results)  |
| 10  | SLO_ERROR_BUDGET          | ✅ آلة الحساب     | `src/lib/reliability/slo.ts` (ErrorBudget) — التغذية الفعلية بعد النشر         |
| 11  | DISASTER_RECOVERY         | 🔶 مسودة          | Runbook أدناه + drill أولي (R05) — تمرين كامل ربع سنوي                         |
| 12  | MONTHLY_RESILIENCE_DRILLS | 🔶 مخطط           | جدول القسم 9 — أول تمرين بعد النشر                                             |

---

## 4. ما نُفّذ في هذه المرحلة (أساس P1) — كلها إضافية

### `src/lib/reliability/` — مجموعة أدوات موثوقية (مختبرة حتميًا)

| المكوّن         | الملف                | الوظيفة                                                                             |
| --------------- | -------------------- | ----------------------------------------------------------------------------------- |
| Circuit Breaker | `circuit-breaker.ts` | CLOSED/OPEN/HALF_OPEN + `withCircuitBreaker` (يفشل بسرعة دون قصف المزوّد)           |
| Retry ذكية      | `retry.ts`           | Exponential backoff + jitter + maxRetries + مهلة لكل محاولة + `RetryExhaustedError` |
| Timeout Budget  | `timeout-budget.ts`  | `withTimeout` — لا `await externalCall()` بدون حد زمني                              |
| Outbox + DLQ    | `outbox.ts`          | أحداث ما بعد الطلب (إشعارات/تحليلات) خارج المعاملة + إعادة محاولة + Dead Letter     |
| Error Budget    | `slo.ts`             | نافذة متحركة، `consumed`/`exhausted` — يوقف الميزات عند استنفاد الميزانية           |

### توصيل فعلي

- **Circuit breaker في `/api/chat`**: لكل مزوّد AI (Gemini/Groq) قاطع خاص (3 إخفاقات → OPEN 30s → تجربة استكشافية). الفشل المتكرر لم يعد يقصف المزوّد — ينتقل فورًا للرد المحلي (سيليا).
- **Data Integrity Watchdog**: `npm run integrity:watchdog -- --db <db>` — يفحص: مخزون سالب، طلبات تالفة (items/total/status)، مفاتيح idempotency مكررة، مراجع يتيمة. خروج 0/1. **أُضيف كبوابة R07 داخل PRE_RELEASE_GATE** (يعمل على قاعدة جلسة الاختبار بعد كل عمليات HTTP).

### اختبارات (حتمية — لا وقت/شبكة/عشوائية)

- `tests/unit/reliability.test.ts`: **23 اختبارًا** (قاطع: فتح/إغلاق/cooldown/استكشاف؛ retry: backoff/jitter/nفاد/مهلة؛ timeout؛ outbox: dedupe/backoff/DLQ؛ error budget: نافذة/استنفاد).

---

## 5. القرارات المعمارية المعلّقة (تحتاج موافقتك — تجميد schema)

1. **Outbox في DB** (migration v4 + جدول `outbox_events` + `dead_letter`): التنفيذ الحالي مرجع عقد in-memory. للإنتاج يُفضَّل جدول DB لضمان عدم فقدان الأحداث عند إعادة التشغيل. **يتطلب كسر تجميد schema** — بانتظار قرارك.
2. **Queue خارجي** (Upstash/BullMQ): غير ضروري في المرحلة الأولى (Vercel serverless) — Outbox + drain عند الطلب يكفي؛ القرار عند الحاجة الفعلية.
3. **Canary**: البنية الحالية (Vercel) لا تدعم canary حقيقيًا بدون تعقيد — **لا يُضاف الآن** (مبدأك: لا تعقيد لمجرد الاسم).
4. **SLO/Error Budget**: الأهداف معتمدة (أدناه) لكن التغذية تحتاج مقاييس إنتاج — تبدأ بعد النشر.

---

## 6. SLO / Error Budget

| المؤشر                                      | الهدف      | ملاحظة                           |
| ------------------------------------------- | ---------- | -------------------------------- |
| Availability                                | ≥ 99.9%    | ميزانية شهرية ≈ 43 دقيقة         |
| Critical API success (orders/auth/checkout) | ≥ 99.95%   |                                  |
| MTTD                                        | ≤ 15 دقيقة | synthetic monitoring كل 15 دقيقة |
| MTTR                                        | ≤ 4 ساعات  | runbooks + rollback جاهز         |
| RPO                                         | ≤ 24 ساعة  | نسخة يومية (بعد النشر)           |
| RTO                                         | ≤ 4 ساعات  | restore drill مثبت (R05)         |
| Data-loss incidents                         | 0          | invariants يوميًا (R07) + backup |

**القاعدة:** عند استنفاد الميزانية → إيقاف feature work والتركيز على reliability (تُحسب عبر `ErrorBudget`).

---

## 7. نظام الحوادث (Incident System)

| المستوى | التعريف                  | مثال                       |
| ------- | ------------------------ | -------------------------- |
| SEV-1   | المتجر كله/الطلبات معطلة | DB down، 5xx شامل          |
| SEV-2   | وظيفة حرجة متدهورة       | orders بطيئة، login مكسور  |
| SEV-3   | وظيفة ثانوية             | AI/chat معطل (المتجر يعمل) |
| SEV-4   | تنبيه/ملاحظة             | إنذار عابر، قياس خارج الحد |

**دورة الحادث:** detection → containment → rollback → recovery → RCA → prevention.
**Postmortem:** ما الذي حدث؟ لماذا لم يُكتشف؟ لماذا لم يعمل التعافي؟ ما التغيير الذي يمنع التكرار؟ (أضِف regression test للجذر — لا للعرض فقط.)

### Runbooks (مسودة — لكل سيناريو: اكتشاف/احتواء/تعافٍ/تحقق)

| السيناريو       | الاكتشاف                         | الاحتواء                                               | التعافي                                  | التحقق            |
| --------------- | -------------------------------- | ------------------------------------------------------ | ---------------------------------------- | ----------------- |
| DB down (Turso) | `/api/ready` + watchdog          | لا تغيير كود — المتجر يفشل بأمان (seed fallback للعرض) | انتظار المزوّد/التبديل للنسخة الاحتياطية | ready + orders    |
| Vercel outage   | synthetic monitor                | إبلاغ العملاء (وضع صيانة اختياري)                      | الانتظار/rollback لآخر ناجح              | health + `/`      |
| AI outage       | chat source=local + breaker OPEN | تلقائي (الرد المحلي)                                   | تلقائي بعد cooldown                      | chat 200          |
| Payment outage  | (عند وجود بوابة)                 | تعطيل الدفع الإلكتروني → COD                           | عودة المزوّد                             | طلب COD           |
| High 5xx        | metrics + monitor                | rollback فوري                                          | rollback                                 | post-deploy smoke |
| Auth failure    | login 401 spike                  | rate-limit + مراجعة SECRET                             | تدوير مخطط لـ ADMIN_SESSION_SECRET       | login + session   |
| Data corruption | **watchdog يومي (R07)**          | تجميد الكتابة؟ / عزل                                   | استعادة من نسخة (R05)                    | integrity 7/7     |

---

## 8. لوحة التشغيل (Dashboard) — قالب الهدف

```text
SYSTEM ● HEALTHY
Availability 99.97% · 5xx 0.03% · DB Healthy · AI Degraded
Orders Healthy · Queue 0 pending · Backup PASS · Last deploy <SHA>
Reliability Score الأسبوعي: 96/100 (لا يستبدل الأدلة الخام)
```

---

## 9. دورة الصيانة السنوية

| التكرار      | المهام                                                                                        | الحالة                                       |
| ------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **يومي**     | synthetic monitoring (كل 15 د) · integrity watchdog · backup verification · مراجعة 5xx/errors | monitoring 🔶 (يبدأ بعد النشر) · watchdog ✅ |
| **أسبوعي**   | dependency/security review · failed-events review (DLQ) · slow-query review                   | أداة جاهزة                                   |
| **شهري**     | chaos drill · concurrency drill (10→50→100 موازٍ) · restore drill · security regression       | drills ✅ (يُجدول)                           |
| **ربع سنوي** | release audit · DR exercise · SLO review · maturity re-score · architecture/cost review       | مخطط                                         |

**مؤشرات السنة الخمسة:** Availability · Error rate · MTTD · MTTR · Data-loss incidents.

---

## 10. دين موثوقية (Reliability Debt) الحالي

| الدين                            | الأولوية | الحل                              |
| -------------------------------- | -------- | --------------------------------- |
| لا DB-backed Outbox              | P1       | migration v4 (قرارك)              |
| لا بوابة دفع إلكترونية / sandbox | P1       | عند اعتماد الدفع الإلكتروني       |
| لا جدولة تلقائية للنسخ الاحتياطي | P1       | بعد النشر (cron/CI)               |
| لا مقاييس إنتاج (p50/p95/p99)    | P1       | بعد النشر (Vercel analytics)      |
| لا SBOM                          | P2       | `npm sbom`/أداة — شهريًا          |
| لا Status Page                   | P2       | عند النضج التجاري                 |
| لا Distributed Tracing كامل      | P2       | request-id موجود — التوسيع لاحقًا |

---

## 11. خارطة السنة (Roadmap) — بالتوازي مع TASK-02/النشر

```text
MONTH 0  Production Hardening      → ✅ PRE_RELEASE_GATE + أساس P1 (هذه المرحلة)
MONTH 1  Monitoring + Alerts + Backup (يبدأ بعد النشر — PRODUCTION_URL)
MONTH 2  Security Hardening        → تدوير مخطط، RBAC مستقبلي، login abuse
MONTH 3  Database + Concurrency    → migrations v4+، concurrency drills شهرية
MONTH 4  External Integrations     → Outbox DB، webhook inbox، fallback matrix
MONTH 5  Performance               → budgets p95، pagination، cache
MONTH 6  Disaster Recovery         → تمرين DR كامل
MONTH 7  Load/Stress
MONTH 8  Security Re-audit
MONTH 9  Dependency + Supply Chain → SBOM، pinning
MONTH 10 Chaos Engineering
MONTH 11 Full Recovery Exercise
MONTH 12 Annual Reliability Audit  → الهدف R5 + تقرير سنة
```

---

## 12. الأدلة

- `evidence/pre-release/pre-release-result.json` — قرار البوابة (SHA مثبت) + `pre-release-report.md`
- `evidence/l5-resilience/` — تمارين حقن الأعطال (DRILL-01..06)
- `evidence/deploy-result/` — rollback drill + pre-deploy (TASK-02 BLOCKED)
- `tests/unit/reliability.test.ts` + `tests/unit/providers.test.ts` — عقود الموثوقية والتكاملات
- `npm run pre-release` — إعادة التشغيل الكاملة في أي وقت
