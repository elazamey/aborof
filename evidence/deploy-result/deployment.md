# Deployment — Evidence (نتائج مُلاحَظة فقط)

> **OBSERVED** — كل قيمة هنا من تشغيل فعلي على GitHub. لا نتائج متوقعة.
> **التاريخ:** 2026-09-01 · **RC_COMMIT (كود):** `579daa6`

## آلية النشر (immutable release ref — صُممت ونُفذت)

```text
tag push (rc-<sha>)
  → deploy workflow (من الـ tag نفسه)
  → Gate ref/SHA (تطابق صارم)
  → Gate VERCEL_DEPLOY_ENABLED (فشل ظاهر لا skip)
  → Gate حضور الإعدادات (أسماء فقط)
  → migration check → vercel build/deploy → verify revision → post-deploy
```

- Commit النشر: `7b2ad32` (deploy.yml الجديد فوق RC) — **تطابق كودي مثبت مع RC**:
  `git diff --stat 579daa6 7b2ad32 -- src scripts tests package.json package-lock.json next.config.mjs tsconfig.json` = **فارغ** (الفرق فقط: `.github/workflows/deploy.yml` + ملفات أدلة).
- CI على commit النشر نفسه: ✅ `success` (run `33570021310`, headSha=`7b2ad32`).

## السجل (observed)

| الحقل | القيمة |
|---|---|
| **RC_COMMIT (كود)** | `579daa6` |
| **TAG** | `rc-7b2ad32d7460ee4590924e7ccc272dcbefa6f04b` → `7b2ad32` (مرفوع ومتحقق) |
| **WORKFLOW_RUN_ID** | `33570046664` |
| **رابط التشغيل** | https://github.com/elazamey/aborof/actions/runs/33570046664 |
| **TIMESTAMP** | 2026-09-01 (~23:05Z) |
| **TARGET** | Vercel production (لم يُنشر) |
| **DEPLOYMENT_ID** | — (لا يوجد — منعت البوابة التنفيذ) |
| **DEPLOYED_SHA** | — (لم يُنشر شيء) |
| **RESULT** | ❌ **BLOCKED — VERCEL_DEPLOY_ENABLED ليست `true`** |

## خطوات التشغيل (observed من GitHub)

| الخطوة | النتيجة |
|---|---|
| Checkout (tag) | ✅ success |
| **Gate — release ref & SHA verification** | ✅ success — التطابق الصارم `EXPECTED_SHA == HEAD` عمل (tag → 7b2ad32) |
| **Gate — VERCEL_DEPLOY_ENABLED** | ❌ **failure** — "VERCEL_DEPLOY_ENABLED is not 'true' — deployment refused" |
| كل خطوات النشر (migration/vercel/post-deploy) | ⏭ skipped (لم تُنفَّذ) — **الإنتاج لم يُمَس** |

## الاستنتاج

```text
Deployment mechanism: جاهز ومُختبَر (بوابة ref/SHA تعمل)
Deployment execution: BLOCKED ❌ — VERCEL_DEPLOY_ENABLED != true (مُلاحَظ في run 33570046664)
لم يُنشر أي شيء — لا DEPLOYMENT_ID، لا DEPLOYED_SHA
```

## المطلوب لإكمال TASK-02 (من مالك المستودع — لا قيم تُرسل لي)

1. متغير المستودع **`VERCEL_DEPLOY_ENABLED=true`**
2. متغير المستودع **`PRODUCTION_URL=https://...`**
3. الأسرار (مستودع أو بيئة `production` — البيئة موجودة): `VERCEL_TOKEN` · `VERCEL_ORG_ID` · `VERCEL_PROJECT_ID` · `TURSO_DATABASE_URL` · `TURSO_AUTH_TOKEN` · `ADMIN_PASSWORD` · `ADMIN_SESSION_SECRET`

> التحقق من حضورها يتم **عند التشغيل** عبر "Gate — production configuration presence" (أسماء فقط، لا قيم) — غير ممكن عبر API من الجلسة (403).

بعد الضبط: أُعيد إطلاق الـ tag (force-push) → workflow يعيد البوابات → إن مرّت كلها: deploy + post-deploy → تُسجَّل النتائج المُلاحَظة هنا (DEPLOYMENT_ID، DEPLOYED_SHA، تطابق `RC_CODE == TAG_SHA app-tree == DEPLOYED_SHA`).

---

# TASK-02 — محاولة النشر الثانية (observed)

> **OBSERVED** — كل قيمة من تشغيل GitHub فعلي (run `33583736020`). لا نتائج متوقعة.

## السجل (observed)

| الحقل | القيمة |
|---|---|
| **RC_SHA** | `53ca4942ce29766a738991cd726d2183bd96a3cc` (رأس أخضر — 81 PASS / 0 FAIL / 11 NC) |
| **TAG** | `rc-53ca4942ce29766a738991cd726d2183bd96a3cc` → `53ca4942ce29766a738991cd726d2183bd96a3cc` (مرفوع ومتحقق) |
| **RC_SHA == TAG_SHA** | ✅ (بوابة الـdeploy "release ref & SHA verification" نجحت بتطابق صارم) |
| **WORKFLOW_RUN_ID** | `33583736020` |
| **TIMESTAMP** | 2026-09-02 ~02:34Z |
| **Gate 3 (migration)** | v5 مثبت محليًا على قاعدة نظيفة (`migrate-check` → schema version 5) — فحص DB الإنتاج لم يُنفَّذ (توقف سابق) |
| **DEPLOYMENT_ID** | — (لا يوجد — منعت البوابة التنفيذ) |
| **DEPLOYED_SHA** | — (لم يُنشر شيء) |
| **POST-DEPLOY (health/ready/product/auth)** | — (لم يُصل إليها — توقف سابق) |
| **RESULT** | ❌ **BLOCKED — Gate "VERCEL_DEPLOY_ENABLED" فشل (الخطوة 4 من 16، وكل ما بعدها skipped)** |

## خطوات التشغيل (observed من GitHub)

| الخطوة | النتيجة |
|---|---|
| Checkout (tag) | ✅ success |
| **Gate — release ref & SHA verification** | ✅ success — `EXPECTED_SHA == HEAD` (tag → 53ca4942…) |
| **Gate — VERCEL_DEPLOY_ENABLED** | ❌ failure — المتغير ليس `true` في بيئة Production |
| Gate — production configuration presence | ⏭ skipped (لم يصل) |
| migration check → build → deploy → post-deploy | ⏭ skipped كلها — **صفر traffic، صفر تغيير** |

## الاستنتاج (observed)

نفس عائق الدورة السابقة (run `33570046664`): **`VERCEL_DEPLOY_ENABLED` غير مضبوط على `true`** في
بيئة Production على GitHub. متغيرات/أسرار البيئة غير قابلة للقراءة من جلسة الوكيل (403) —
التحقق/الضبط يتم من مالك المستودع في GitHub Settings → Environments → Production.
لا شيء نُشر، ولا شيء تغيّر في الإنتاج.
