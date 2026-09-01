# Deployment — Evidence (يُملأ عند النشر فقط)

> **لا يُنشر** إلا بعد: GitHub CI PASS على RC_COMMIT + Pre-deploy كامل (env + migration + rollback). النشر يكون لـ **RC_COMMIT** وليس فرعاً متحركاً.

## Pre-deploy checklist

| البند | الحالة |
|---|---|
| Environment Contract: `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` + `ADMIN_PASSWORD` + `ADMIN_SESSION_SECRET` في Vercel | pending |
| `PRODUCTION_URL` (متغير مستودع) مضبوط | pending |
| Migration check على DB الإنتاج (`scripts/migrate-check.mjs`) — أي فشل = deploy FAIL | pending |
| `PREVIOUS_KNOWN_GOOD_RELEASE` محدد (مسار rollback) | pending |

## السجل

| الحقل | القيمة |
|---|---|
| **RC_COMMIT المنشور** | <SHA> |
| **DEPLOYED_COMMIT** | <من Vercel deployment> |
| **التطابق `DEPLOYED_COMMIT == RC_COMMIT`** | pending |
| **Workflow run ID** | <ID> |
| **التاريخ** | <ISO> |
| **PRODUCTION_URL** | <URL> |

## Rollback path (جاهز قبل النشر)

```text
Production failure (Critical incident)
  → Vercel rollback إلى PREVIOUS_KNOWN_GOOD_RELEASE
  → health + ready verification
  → إخطار + تحقيق
```
