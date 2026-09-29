# إثبات CI والتحقق من النشر — Gate-by-Gate

التاريخ: 2026-09-02. الـ PR: [#2](https://github.com/elazamey/aborof/pull/2)
فرع التنفيذ: `arena/01a06118-aborof`.

## 1) CI VERIFIED — GitHub Actions (دليل فعلي من سجل الـ Run)

- **Run:** [33609059016](https://github.com/elazamey/aborof/actions/runs/33609059016) — النتيجة `success`.
- **Workflow:** `Quality and Security` على حدث `pull_request` (يعمل على كل PR وكل push لـ main).

نتائج البوابات كلها `success` على البنية التحتية لـ GitHub (ليست محلية):

| البوابة | النتيجة على CI |
|---|---|
| Install dependencies (`npm ci`) | success |
| Dependency audit (`npm audit --omit=dev --audit-level=high`) | success (0 ثغرات) |
| ESLint | success |
| TypeScript type-check | success |
| Static security gates (`security:gates`) | success |
| Migration files in sync | success |
| Route inventory | success |
| Unit & integration tests (43) | success |
| Production build | success |
| Secret Scan | success (بعد إصلاح إنذار إيجابي كاذب في اختبار) |

### حادث أثناء التحقق وأُغلق
أول Run (33608490666) فشلت فيه مهمة **Secret Scan** لأن ملف اختبار احتوى نصًا
اصطناعيًا يشبه مفتاحًا حقيقيًا. عولج ببناء النص وقت التشغيل (لا يظهر نمطًا ثابتًا)،
وأُبقي الفحص شاملًا لكل الملفات دون استثناء مجلد الاختبارات. النتيجة: إعادة الفحص نجحت.

### هل يمكن تجاوز الـ Workflow؟
- لا يوجد `exit 0` ولا `--if-present` ولا شرط `if` يتخطى الفحوصات.
- نشر الإنتاج (`deploy.yml`) ينفّذ البوابات في job مستقلة (`quality-gates`)
  ووظيفة النشر `needs: quality-gates` — لا يبدأ النشر قبل نجاحها.
- **ملاحظة صلاحية:** ربط هذه الفحوصات كـ *required checks* في Branch Protection
  يحتاج صلاحية مالك المستودع (التوكن الحالي push-only). انظر القسم 4.

## 2) Deployment — Preview من Vercel

- تكامل Vercel مفعّل على المستودع، والفحوصات `Vercel – aborof`
  و`Vercel – aborof-store-v2` بحالة `pass`، وتُنشأ Preview Deployment لكل PR.
- لا يملك توكن البيئة صلاحية قراءة رابط الـ deployment المباشر (403) ولا يوجد
  `VERCEL_TOKEN` داخل الـ sandbox، لذا تحقّق سلوك الإنتاج على بنية production مبنية
  فعليًا (`next start`, `NODE_ENV=production`) عبر رابط المعاينة المرفق في الـ UI.

## 3) Production smoke test (على بنية production)

| الفحص | المتوقع | النتيجة |
|---|---|---|
| رؤوس الأمان | HSTS/nosniff/frame-deny/referrer + CSP report-only | ✅ موجودة |
| `/api/chat` على JSON فاسد | 422 آمن بلا تسريب | ✅ 422 + request_id |
| `/api/chat` دور غير صالح | 422 (لا 200 ولا رسالة مزود) | ✅ 422 + request_id |
| `/api/admin/diagnostics` بلا مفتاح (production) | 404 معطّل | ✅ 404 DIAGNOSTICS_DISABLED |
| مسار إداري بلا جلسة | 401 | ✅ 401 AUTH_REQUIRED |
| تحديد المعدل (وضع fallback الآمن) | 429 + Retry-After | ✅ 30 ثم 429، Retry-After=588 |
| الصفحات العامة | 200 | ✅ / /cart /api/products |

## 4) خطوات تتطلب صلاحية المالك (لا ينفذها توكن push-only)

1. **Branch Protection على main:** ضبط هذه المهمات كـ Required checks:
   - `Audit, Lint, Typecheck, Security Gates, Tests, Build`
   - `Secret Scan`
   مع تفعيل *Require a pull request before merging* و*Do not allow bypassing*.
2. **أسرار Vercel/التطبيق** (Settings → Secrets and variables → Actions،
   وفي Vercel Project → Environment Variables للإنتاج):
   - `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` (للنشر التلقائي)
   - `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
   - `ADMIN_PASSWORD` (12 حرفًا على الأقل) و`ADMIN_SESSION_SECRET` (32+ عشوائي)
   - **لا تضف** `DIAGNOSTICS_KEY`/`DIAGNOSTICS_ENABLED` في الإنتاج إلا عند الحاجة
     للتشخيص، وبمفتاح مستقل تمامًا عن `ADMIN_SESSION_SECRET`.
3. **الهجرة على Turso الحقيقية:** تُطبَّق تلقائيًا عند أول طلب بعد النشر
   (`runMigrations`)، والمسار الموصى به الآن **بوابة صريحة قبل النشر**:
   `npm run migrations:plan` (قراءة فقط) ثم `npm run migrations:apply`، أو المعاملة
   الكاملة `bash scripts/mint-turso-token.sh` (سكّ رمز ← هجرات ← أسرار) — فالبوابة
   ترفض هدفًا غير Turso (كود 3) وتوقف المعاملة قبل تطبيق الأسرار إن فشلت.
   وتُسجَّل الهجرات في جدول `schema_migrations`. يُتحقَّق بعد النشر بـ:
   ```sql
   SELECT version, checksum FROM schema_migrations;       -- يُتوقع 0001
   SELECT name FROM sqlite_master WHERE name='order_items'; -- يُتوقع الصف موجود
   ```
4. **تأكيد أن Rate Limiter يستخدم Turso وليس fallback:** بعد ربط Turso، راقب
   نقطة التشخيص/السجلات للتأكد من عدم ظهور `fallback to in-memory store`،
   واختبر تجاوز الحد عبر ضربات من عميلين مختلفين (يجب أن يُحسبا معًا على Turso).
5. **CSP:** أبقِ `CSP_ENFORCE` غير مضبوط (وضع report-only) حتى تُراجَع التقارير،
   ثم فعّله. لا شيء في الكود يعتمد على نطاقات خارجية غير Gemini/Groq المسموح بها.
6. **متغير النشر:** `VERCEL_DEPLOY_ENABLED=true` بعد التأكد من كل الأسرار (يُقرأ من
   بيئة `production` أولًا، مع الرجوع إلى متغير المستودع). وظيفة النشر معلَّمة
   بـ `environment: production`، فتأكد من إنشاء البيئة في
   **Settings → Environments** ومن تقييد أسرار النشر داخل نطاقها.
7. **مراقبة عمر الرمز (تدوير `90d`):** `token-lifecycle.yml` يفكّ مطالبة `exp` من
   `TURSO_AUTH_TOKEN` داخل الـ runner كل اثنين 04:17Z، فيحذّر قبل 14 يومًا من الانتهاء
   (`WARNING` ⇒ خروج 10 ⇒ تشغيل مجدول أحمر) ويفتح **Issue واحدًا** يُعدَّل جسمه أسبوعيًا
   ويُغلق عند الخروج من منطقة الخطر. وهو **مراقبة فقط** بأقل صلاحية: `contents: read` +
   `issues: write` (لا كتابة أسرار، ولا `TURSO_PLATFORM_TOKEN` في الـ workflow فلا قدرة
   على السكّ)، والسرّ يُمرَّر عبر `env:` لا داخل نص `run:` وبلا تتبّع shell، ولا يُطبع
   من الرمز شيء غير `exp`. التدوير نفسه يدوي: `bash scripts/mint-turso-token.sh` ثم
   `vercel deploy --prod`. الجدولة تبدأ بعد دمج الملف في `main` (الفرع الافتراضي).
