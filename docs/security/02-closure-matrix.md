# مصفوفة الإغلاق وأدلة التحقق

كل خطر له ضابط مركزي واختبار آلي وحاجز نشر. يمكن إعادة التحقق من البند
بتشغيل الأوامر في عمود "الدليل القابل لإعادة التحقق".

| الرمز | الخطر | الضابط المركزي | الاختبار/الحاجز | الدليل القابل لإعادة التحقق |
|---|---|---|---|---|
| P0-A | اعتماديات عالية الخطورة | تثبيت `package-lock.json`؛ `npm ci` | بوابة audit في quality وdeploy | `npm audit --omit=dev --audit-level=high`؛ سجل الترقيات الأمنية: [`05-dependency-upgrades.md`](./05-dependency-upgrades.md) |
| P0-B | تسريب الأخطاء الداخلية | `src/lib/errors/` + `apiHandler` + `redactSecrets` + `request_id` | `tests/errors.test.ts`, `tests/routes.test.ts`, `security-gates.mjs` | `npm test`؛ فحص استجابة `/api/chat` لخطأ لا تحوي stack/رسالة مزود |
| P0-C | خلط سر الجلسات بالتشخيص | `src/lib/secrets.ts`: `DIAGNOSTICS_KEY` مستقل، تشخيص معطّل في الإنتاج | `tests/secrets.test.ts`, حاجز static في `security-gates.mjs` | `npm run security:gates` |
| P1-A | بوابات CI غير إلزامية | `quality.yml` + `deploy.yml`: audit/lint/typecheck/gates/tests/build، فحص أسرار، أقل صلاحيات، artifacts | الـ Workflow نفسه (لا `exit 0`، لا `--if-present`) | أي فشل يوقف النشر؛ راجع تبويب Actions |
| P1-B | تحقق مدخلات غير موحّد | `src/lib/validation/contracts.ts` (Zod، `.strict()`، حدود) | `tests/contracts.test.ts`, `tests/routes.test.ts` | `npm test`؛ إرسال حقل غير معروف يعيد 422 |
| P1-C | تحديد معدل عبر نسخ متعددة | `TursoRateLimitStore` بـ UPSERT ذري | `tests/rate-limit.test.ts` (20 ضربة متزامنة عبر نسختين) | `npm test`؛ التحقق من `Retry-After` |
| P1-D | سلامة البيانات/العزل | هجرات مُرقّمة + FK/CHECK/UNIQUE + معاملات + عزل إداري | `tests/migrations.test.ts`, `tests/headers-isolation.test.ts` | `npm test`؛ إدخال حالة/سعر مخالف يُرفض |
| P2-A | رؤوس HTTP ومراقبة | `src/middleware.ts` + `src/lib/security/headers.ts` + المقاييس + نقطة تشخيص | `tests/headers-isolation.test.ts` | `curl -I` يُظهر الرؤوس؛ `/api/admin/diagnostics` محمي |
| P2-B | تنفيذ أدوات الموديل بلا حدود | `src/lib/ai/mcp/`: علم مستقل + قائمة سماح + تحقق صارم + مهلة + سقف استدعاءات + اقتصاص + قراءة فقط افتراضيًا + لا مسار HTTP للتنفيذ | `tests/mcp-tools.test.ts`, `tests/agent-tools.test.ts`, `tests/mcp-route.test.ts` | `npm test`؛ `GET /api/admin/mcp/tools` ⇒ 404 دون تفعيل |
| P2-D | حقن محتوى في الواجهة عبر مخرجات الأدوات | `src/lib/ai/cards.ts`: عقد صارم `.strict()` + حقول الكتالوج فقط + سقف 3 بطاقات + إزالة التكرار | `tests/cards.test.ts`, `tests/chat-route.test.ts`, `tests/mcp-tools.test.ts` | `npm test`؛ حقول زائدة أو قيمة سالبة تُسقط البطاقة |
| P1-E | تصعيد صلاحيات إداري (الكل أو لا شيء بكلمة مرور مشتركة) | `src/lib/rbac/`: كتالوج صلاحيات + `requirePermission` على كل مسار إداري + جلسات v2 بإصدار توكن | `tests/rbac.test.ts` (مصفوفة فرض + رفض ذاتي)، وبوابة تطابق الكتالوج مع نقاط الفرض في `security-gates.mjs` | `npm test`؛ مستخدم بصلاحية `orders:read` ⇒ 403 على الكتابة واللوحة والسجل وسيليا، و`ENABLE_RBAC` مغلق ⇒ 404 |
| P1-F | الإغلاق الكامل على الفريق (فقدان آخر حائز صلاحية الحكم) | حصانة إغلاق في `src/lib/rbac/store.ts`: آخر حائز فعّال على `rbac:write` لا يُنزع/يُعطَّل/يُحذف، والأدوار المدمجة محصّنة، ولا يُحذف دور مُسنَد | `tests/rbac.test.ts` (409 في الحالات الأربع + السماح بعد إضافة حائز ثانٍ) | `npm test`؛ `DELETE /api/admin/rbac/users?id=<آخر مالك>` ⇒ 409 |
| P2-E | تسريب بيانات اعتماد أو تعداد حسابات | scrypt + ملح لكل مستخدم + `timingSafeEqual` + `DUMMY_HASH` عند غياب الحساب + قفل 15 دقيقة بعد 5 محاولات + رسالة 401 موحّدة | `tests/rbac.test.ts` (بصمات، رسائل موحّدة، قفل)، وبوابة static تمنع `password_hash` خارج المخزن ودوال التجزئة السريعة | `npm test`؛ `npm run security:bundle` (لا أسماء أسرار في الحزمة) | نمط `nvapi-…` في `redactSecrets` + مزود NIM عبر العميل الموحّد + https إلزامي للرابط | `tests/nvidia-nim.test.ts` | `npm test`؛ خطأ مزود بمفتاح وهمي لا يظهر في الرسالة |

## مؤشرات النجاح مقابل الأهداف

| المؤشر | الهدف | الحالة |
|---|---:|---|
| High/Critical في الاعتماديات | صفر | ✅ صفر (audit gate) |
| تسريب رسائل داخلية في استجابات الإنتاج | صفر | ✅ اختبار يفحص غياب stack/token |
| مسارات كتابية بلا تحقق مركزي | صفر | ✅ كلها عبر عقود Zod |
| نشر Production بعد فشل Gate | صفر | ✅ البوابات حاجز في deploy.yml |
| تجاوز Rate Limit عبر instance أخرى | صفر | ✅ اختبار تزامن عبر نسختين |
| حوادث عزل/سجلات يتيمة | صفر | ✅ FK + معاملات + اختبارات |
| تغطية المسارات الحساسة | 100% | ✅ auth/orders/products/chat مغطّاة |
| 5xx مجهول السبب | <1% مع request_id | ✅ كل استجابة خطأ تحمل `request_id` |
| تنفيذ أدوات خارج البوابة المحكومة | صفر | ✅ لا يوجد أي مسار تنفيذ عبر HTTP، وكل الأدوات المدرجة قراءة فقط |
| ظهور مفتاح مزود (Gemini/Groq/NVIDIA) في السجلات أو الاستجابات | صفر | ✅ أنماط المفاتيح محجوبة واختبارات تثبته |
| تنفيذ إداري بلا صلاحية صريحة | صفر | ✅ كل مسار إداري يمر بـ`requirePermission` وبوابة تطابق الكتالوج مع نقاط الفرض |
| نصوص/بصمات كلمات مرور في الاستجابات أو الحزمة | صفر | ✅ `scrypt` فقط، ولا بصمة في أي كائن عام (اختبار + بوابة static + فحص الحزمة) |
| احتمال الإغلاق الكامل على الفريق | صفر | ✅ آخر حائز صلاحية الحكم محصّن باختبار 409 |
| حقول زائدة تصل للواجهة من مخرجات الأدوات | صفر | ✅ تنقية بعقد صارم + سقف بطاقات |

## أوامر التحقق الشامل

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
```
