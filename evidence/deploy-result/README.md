# Deploy Result — Evidence (سيُملأ عند النشر)

هذا المجلد يوثّق **دليل النشر نفسه** (من workflow `Deploy to Vercel`). يُملأ فقط بعد قرار النشر، وليس الآن.

## ما يجب تسجيله (عند النشر)

1. **الـ commit المنشور** (نفس commit CI PASS — قاعدة Same-Commit)
2. **رابط تشغيل النشر**: `https://github.com/elazamey/aborof/actions/runs/<run-id>`
3. **الرابط الإنتاجي** `PRODUCTION_URL` المستخدم
4. نتيجة مراحل النشر: validate → smoke → vercel build → deploy → post-deploy verification
5. أي ملاحظات (زمن النشر، منصة Vercel، preview URL إن وُجد)

## المتطلبات المسبقة للنشر (من DEPLOYMENT.md)

- متغير المستودع `VERCEL_DEPLOY_ENABLED=true`
- أسرار: `VERCEL_TOKEN` · `VERCEL_ORG_ID` · `VERCEL_PROJECT_ID` · `TURSO_DATABASE_URL` · `TURSO_AUTH_TOKEN` · `ADMIN_PASSWORD` · `ADMIN_SESSION_SECRET`
- متغير المستودع `PRODUCTION_URL` (إلزامي لمرحلة post-deploy verification — بدونها يفشل النشر عمداً)
