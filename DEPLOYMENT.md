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
| `DIAGNOSTICS_ENABLED` | Variable اختياري | `true` لتفعيل نقطة التشخيص (معطّل في الإنتاج افتراضيًا) |
| `DIAGNOSTICS_KEY` | Secret اختياري | مفتاح **مستقل** عن `ADMIN_SESSION_SECRET` لنقطة `/api/admin/diagnostics` |
| `CSP_ENFORCE` | Variable اختياري | `true` لتشديد CSP من وضع المراقبة إلى الحجب |
| `VERCEL_DEPLOY_ENABLED` | Repository variable (أو Environment variable على `production`) | `true` بعد التأكد من الأسرار |

> **فصل الأسرار إلزامي:** `ADMIN_SESSION_SECRET` لتوقيع الجلسات فقط، و`DIAGNOSTICS_KEY`
> للتشخيص فقط. يفحص حاجز النشر الثابت أنهما غير متطابقين وأن سر الجلسات لا يُذكر
> خارج وحدتي الجلسات والأسرار.

يجب إضافة متغيرات التطبيق مثل `TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN` و`ADMIN_PASSWORD` و`ADMIN_SESSION_SECRET` أيضًا داخل **Vercel Project → Settings → Environment Variables** لبيئة Production؛ أسرار GitHub Actions لا تنتقل تلقائيًا إلى Runtime في Vercel.

## التفعيل والتحقق

بعد حفظ الأسرار والمتغير، نفّذ تغييرًا إلى `main` أو شغّل Workflow يدويًا من تبويب **Actions**. يجب أن يظهر أولًا Workflow الجودة، ثم سجل النشر. تحقق من `/` و`/cart` و`/admin`، ثم اختبر إنشاء طلب تجريبي صغير بعد التأكد من أن Turso متصلة. لا تستخدم كلمة مرور حقيقية داخل سجل Git أو ملف `.env` متتبع.

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
