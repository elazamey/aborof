# Deployment — Evidence (نتائج مُلاحَظة فقط)

> **OBSERVED** — لا توجد نتائج متوقعة. هذا الملف يوثّق **محاولة النشر الفعلية** ونتيجتها.
> **التاريخ:** 2026-09-01

## محاولة التنفيذ

| الخطوة | النتيجة المُلاحَظة |
|---|---|
| تثبيت النشر على RC_COMMIT بالضبط (Same-SHA) | ✅ tag `rc-579daa6` → `579daa6` (مرفوع ومتحقق: `git ls-remote`) |
| تشغيل workflow النشر عبر dispatch على `ref=rc-579daa6` | ❌ **HTTP 403 — Resource not accessible by integration** (لا صلاحية `actions:write` للتطبيق) |
| مسار النشر عبر push إلى main | ⚠️ غير متاح: يتطلب `VERCEL_DEPLOY_ENABLED=true` — والدليل المُلاحَظ أن آخر push إلى main (f10df28) أنتج deploy workflow **`skipped`** (run `32776075993`) |

## الاستنتاج (observed)

```text
Deployment mechanism: BLOCKED ❌
سببان قاطعان:
  1. VERCEL_DEPLOY_ENABLED ليست 'true' (مثبت: run 32776075993 = skipped)
  2. لا يمكن dispatch (403 — صلاحية actions للتطبيق مقيدة)
لم يُنشر أي شيء — لا deployment ID، لا deployed SHA، لا timestamp
```

## ما هو مطلوب لإكمال هذه البوابة (من مالك المستودع)

1. إضافة أسرار Vercel في إعدادات المستودع: `VERCEL_TOKEN` · `VERCEL_ORG_ID` · `VERCEL_PROJECT_ID`
2. إضافة أسرار البيئة: `TURSO_DATABASE_URL` · `TURSO_AUTH_TOKEN` · `ADMIN_PASSWORD` · `ADMIN_SESSION_SECRET`
3. متغير `VERCEL_DEPLOY_ENABLED=true` + `PRODUCTION_URL` (متغيرات مستودع)
4. ثم: إما منح `actions:write` مؤقتاً للـ dispatch، أو دمج PR #1 في main (سيشغّل deploy workflow عند `push` إلى main على commit مثبّت)

**القاعدة:** لا يُعتبر أي من هذا ناجحاً إلا بنتيجة workflow مُلاحَظة + تطابق `DEPLOYED_COMMIT == RC_COMMIT == 579daa6`.
