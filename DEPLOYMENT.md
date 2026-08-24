# نشر متجر روفيده

## النشر التلقائي

يحتوي المستودع على Workflow باسم `Deploy to Vercel` ينفذ فحوصات الجودة ثم ينشر فرع `main` إلى بيئة Vercel الإنتاجية. حماية النشر متعمدة: لا يبدأ الـ Workflow حتى يكون متغير المستودع `VERCEL_DEPLOY_ENABLED` مساويًا للنص `true`.

أضف في إعدادات المستودع ضمن **Settings → Secrets and variables → Actions** الأسرار التالية، من دون وضع قيمها في الملفات أو الأوامر:

| الاسم | نوعه | مصدره |
|---|---|---|
| `VERCEL_TOKEN` | Secret | رمز شخصي من إعدادات Vercel |
| `VERCEL_ORG_ID` | Secret | قيمة `orgId` من مشروع Vercel أو إعدادات الفريق |
| `VERCEL_PROJECT_ID` | Secret | قيمة `projectId` من مشروع Vercel |
| `TURSO_DATABASE_URL` | Secret | رابط قاعدة Turso |
| `TURSO_AUTH_TOKEN` | Secret | رمز Turso |
| `ADMIN_PASSWORD` | Secret | كلمة مرور الإدارة القوية |
| `ADMIN_SESSION_SECRET` | Secret | سر عشوائي طويل، لا يقل عن 32 بايت |
| `GEMINI_API_KEY` أو `GROQ_API_KEY` | Secret اختياري | مفتاح مزود الدردشة |
| `VERCEL_DEPLOY_ENABLED` | Repository variable | `true` بعد التأكد من الأسرار |

يجب إضافة متغيرات التطبيق مثل `TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN` و`ADMIN_PASSWORD` و`ADMIN_SESSION_SECRET` أيضًا داخل **Vercel Project → Settings → Environment Variables** لبيئة Production؛ أسرار GitHub Actions لا تنتقل تلقائيًا إلى Runtime في Vercel.

## التفعيل والتحقق

بعد حفظ الأسرار والمتغير، نفّذ تغييرًا إلى `main` أو شغّل Workflow يدويًا من تبويب **Actions**. يجب أن يظهر أولًا Workflow الجودة، ثم سجل النشر. تحقق من `/` و`/cart` و`/admin`، ثم اختبر إنشاء طلب تجريبي صغير بعد التأكد من أن Turso متصلة. لا تستخدم كلمة مرور حقيقية داخل سجل Git أو ملف `.env` متتبع.

## تشغيل محلي

انسخ `.env.example` إلى `.env.local` وأدخل قيمًا محلية فقط، ثم شغّل:

```bash
npm ci
npm run lint
npx tsc --noEmit
npm run routes:inventory
npm run build
npm run dev
```
