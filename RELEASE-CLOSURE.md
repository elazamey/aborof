# Release Closure — خطة إغلاق الإصدار

> **الحالة:** Release Freeze مفعّل — لا Features، لا Refactoring، لا تغيير dependencies، لا Business Logic، لا Deploy يدوي.
> **المسموح فقط:** CI / Deployment / Evidence / Configuration / Blocking fixes.
> **الهدف:** من `Local PASS → GitHub ⚠️ → Deploy ⛔` إلى `GitHub CI PASS → Deployment Gate PASS → Production Deploy → Post-Deploy Verification PASS → Production Accepted`.

---

## الـ Gates الثلاثة (تُغلق بالترتيب، لا تجاوز)

```text
TASK-01  GitHub CI Gate   → CI يثبت L1–L5 على GitHub نفسه (نفس RC SHA)
TASK-02  Deployment Gate  → Pre-deploy (env/migration) + Post-deploy verification
TASK-03  Production Deploy + Post-Deploy + 24h Observation → PRODUCTION STABLE
```

---

## TASK-01 — GitHub CI Gate

**الشرط الأساسي:** ملفات `.github/workflows/` الثلاثة (quality / deploy / synthetic-monitor) موجودة فعلياً على GitHub. العائق: GitHub App ناقص صلاحية `workflows` — الحل (المساران المصرحان):

- **A:** رفع من جهاز موثوق بحساب مصرح له (`ci-workflows.patch` جاهز).
- **B:** منح التطبيق صلاحية `workflows` مؤقتاً → رفع فوري → التحقق → تقليل الصلاحية.

**المطلوب عند التشغيل (لا يكفي "workflow completed"):**

| Gate            | النتيجة المطلوبة             |
| --------------- | ---------------------------- |
| Lint            | ✅                           |
| Typecheck       | ✅                           |
| Routes          | ✅                           |
| Format          | ✅                           |
| Unit            | ✅ 32/32                     |
| Build           | ✅                           |
| Smoke (L3/L4)   | ✅ 36/36                     |
| Resilience (L5) | ✅ 36/36                     |
| لا فشل مُتجاهَل | ✅ (لا `                     |     | true` — كل فشل exit != 0) |
| Same Commit     | ✅ `CI headSha == RC_COMMIT` |

**قواعد صارمة:**

- Dependency determinism: `npm ci` فقط (lockfile) — لا `npm install`.
- CI test environment ≠ Production secrets: الاختبارات تستخدم `file:` DB + قيم test — لا `TURSO_DATABASE_URL`/`ADMIN_SESSION_SECRET`/AI keys حقيقية داخل الريبو.
- لا التفاف (لا workflows خارج `.github/workflows/`).

---

## TASK-02 — Deployment Gate

### Pre-deploy

1. **Environment Contract:** `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` + `ADMIN_PASSWORD` + `ADMIN_SESSION_SECRET` + `PRODUCTION_URL` كاملة في Vercel/سكريتس — لا أسرار في Git.
2. **Database Compatibility:** تشغيل نظام migrations على DB الإنتاج (`scripts/migrate-check.mjs`) — `current version == required version` أو تُطبَّق الهجرات، وأي فشل = **deployment FAIL** (لا "server starts anyway").
3. **Rollback Path:** تحديد `PREVIOUS_KNOWN_GOOD_RELEASE` قبل النشر (Vercel rollback متاح) — لا أول تفكير في rollback أثناء outage.

### Post-deploy (على الرابط الحقيقي)

- `GET /api/health` → 200 · `GET /api/ready` → 200 `database=ok`
- `GET /` → 200 · `GET /product/p1` → 200 (معروف موجود في production)
- Critical path آمن (بدون بيانات حقيقية مؤثرة): طلب اختباري + خصم مخزون واحد + تحديث حالة + إلغاء يعيد المخزون
- Auth: login → cookie → authenticated request → 200؛ expired/tampered/invalid → 401
- AI: مزوّد ناجح → رد؛ مزوّد فاشل/معلّق → fallback محلي خلال 10 ثوانٍ (لا hanging)
- `DEPLOYED_COMMIT == RC_COMMIT` (إلزامي)

---

## TASK-03 — Production Deploy + Observation

- **أول 15 دقيقة:** مراقبة مكثفة عند t+0 / t+5 / t+10 / t+15 (health, ready, homepage, product, error rate, latency) + synthetic monitor يعمل.
- **أول 24 ساعة = PRODUCTION OBSERVATION** (ليس Stable): مراقبة 5xx / DB errors / timeouts / auth failures / AI timeouts / readiness failures / rate-limit anomalies.
- **Synthetic monitoring** كل 15 دقيقة: health + ready + `/` + `/product/<known>` — الفشل يُسجَّل دائماً (لا يتحول green لمجرد نجاح الطلب التالي).
- **تعريف Incident (Critical):** health down / ready down / login مكسور / orders مكسور / DB غير متاحة → stop feature work → investigate → rollback إذا لزم.

---

## الـ 7 شروط المانعة للنشر

لا يُنشر إذا تحقق أيٌّ مما يلي:

1. CI workflow غير موجود على GitHub
2. CI لم ينجح على **نفس** commit
3. L5 لم ينجح
4. Production env غير مكتمل
5. Migration state غير معروف
6. Post-deploy verification غير موجود
7. لا توجد rollback path

---

## Gate Sequence (الأمر التنفيذي)

```bash
npm run release:check        # محلياً — تم ✅ (دليل: evidence/release-check/)
# ← رفع workflows (العائق الحالي)
# ← GitHub CI على نفس RC SHA
# ← CI PASS + evidence (evidence/ci-run.md)
# ← Pre-deploy (env + migration + rollback)
# ← Deploy RC_COMMIT (وليس branch floating)
# ← Post-deploy verification (evidence/post-deploy.md)
# ← Synthetic monitoring + 24h observation (evidence/monitoring.md)
# ← PRODUCTION STABLE
```

---

## حالة البوابة الحالية (تُحدَّث عند كل خطوة)

| البوابة                       | الحالة                                                                                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1–L5 محلياً + release:check  | ✅ PASS (evidence/release-check/ + evidence/l5-resilience/)                                                                                                                                                                        |
| الفرع `arena/01a05f01-aborof` | ✅ مرفوع (كود + أدلة) — workflows commit جاهز محلياً                                                                                                                                                                               |
| GitHub CI Gate                | ⚠️ **TASK-01 مفتوح** — بانتظار رفع workflows (صلاحية `workflows`)                                                                                                                                                                  |
| Deployment Gate               | ❌ **BLOCKED (TASK-02)** — immutable-ref آلية جاهزة ومُختبَرة (SHA gate PASS)، لكن `VERCEL_DEPLOY_ENABLED != true` (مُلاحَظ run 33570046664) — الأدلة: evidence/deploy-result/deployment.md                                        |
| PRE_RELEASE_GATE              | ⛔ **BLOCKED (متوقع حتى اكتمال TASK-02)** — `npm run pre-release` = **67 PASS / 0 FAIL / 11 NOT_CONFIGURED** → RELEASE_BLOCKED (العوائق P0 فقط: RC01 الإعداد، RC05 مراقبة فعلية، RC06 post-deploy) — الأدلة: evidence/pre-release/ |
| Production Deploy             | ⛔ ممنوع                                                                                                                                                                                                                           |
