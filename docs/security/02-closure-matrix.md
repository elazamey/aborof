# مصفوفة الإغلاق وأدلة التحقق

كل خطر له ضابط مركزي واختبار آلي وحاجز نشر. يمكن إعادة التحقق من البند
بتشغيل الأوامر في عمود "الدليل القابل لإعادة التحقق".

| الرمز | الخطر | الضابط المركزي | الاختبار/الحاجز | الدليل القابل لإعادة التحقق |
|---|---|---|---|---|
| P0-A | اعتماديات عالية الخطورة | تثبيت `package-lock.json`؛ `npm ci` | بوابة audit في quality وdeploy | `npm audit --omit=dev --audit-level=high` |
| P0-B | تسريب الأخطاء الداخلية | `src/lib/errors/` + `apiHandler` + `redactSecrets` + `request_id` | `tests/errors.test.ts`, `tests/routes.test.ts`, `security-gates.mjs` | `npm test`؛ فحص استجابة `/api/chat` لخطأ لا تحوي stack/رسالة مزود |
| P0-C | خلط سر الجلسات بالتشخيص | `src/lib/secrets.ts`: `DIAGNOSTICS_KEY` مستقل، تشخيص معطّل في الإنتاج | `tests/secrets.test.ts`, حاجز static في `security-gates.mjs` | `npm run security:gates` |
| P0-D | جلسة الإدارة تُرفض بعد تسجيل دخول ناجح (ترميز الكوكي) | `src/lib/auth.ts`: رمز الجلسة بحروف آمنة داخل الكوكي (فاصل `.`) + فك ترميز قيمة الكوكي قبل التحقق + توافق مع الصيغة القديمة | `tests/admin-session-http.test.ts` (دخول فعلي ثم مسار محمي بالقيمة الحرفية للترويسة) | `npm test`؛ دخول صحيح ثم `GET /api/admin/session` ⇒ `{"authenticated":true}` |
| P1-A | بوابات CI غير إلزامية | `quality.yml` + `deploy.yml`: audit/lint/typecheck/gates/tests/build، فحص أسرار، أقل صلاحيات، artifacts | الـ Workflow نفسه (لا `exit 0`، لا `--if-present`) | أي فشل يوقف النشر؛ راجع تبويب Actions |
| P1-B | تحقق مدخلات غير موحّد | `src/lib/validation/contracts.ts` (Zod، `.strict()`، حدود) | `tests/contracts.test.ts`, `tests/routes.test.ts` | `npm test`؛ إرسال حقل غير معروف يعيد 422 |
| P1-C | تحديد معدل عبر نسخ متعددة | `TursoRateLimitStore` بـ UPSERT ذري | `tests/rate-limit.test.ts` (20 ضربة متزامنة عبر نسختين) | `npm test`؛ التحقق من `Retry-After` |
| P1-D | سلامة البيانات/العزل | هجرات مُرقّمة + FK/CHECK/UNIQUE + معاملات + عزل إداري | `tests/migrations.test.ts`, `tests/headers-isolation.test.ts` | `npm test`؛ إدخال حالة/سعر مخالف يُرفض |
| P2-A | رؤوس HTTP ومراقبة | `src/middleware.ts` + `src/lib/security/headers.ts` + المقاييس + نقطة تشخيص | `tests/headers-isolation.test.ts` | `curl -I` يُظهر الرؤوس؛ `/api/admin/diagnostics` محمي |
| P2-B | تنفيذ أدوات الموديل بلا حدود | `src/lib/ai/mcp/`: علم مستقل + قائمة سماح + تحقق صارم + مهلة + سقف استدعاءات + اقتصاص + قراءة فقط افتراضيًا + لا مسار HTTP للتنفيذ | `tests/mcp-tools.test.ts`, `tests/agent-tools.test.ts`, `tests/mcp-route.test.ts` | `npm test`؛ `GET /api/admin/mcp/tools` ⇒ 404 دون تفعيل |
| P2-E | تسرّب بيانات عملاء إلى ذاكرة الاسترجاع | `src/lib/ai/memory/corpus.ts` يبني الذاكرة من المنتجات والأسئلة وبيانات المتجر فقط، وقائمة حقول `metadata` مغلقة | `tests/memory.test.ts` (فحص أن الذاكرة خالية من أي سجل طلبات)، `tests/mcp-knowledge.test.ts` | `npm test`؛ البحث في الذاكرة لا يُعيد أي بيانات عميل |
| P2-D | حقن محتوى في الواجهة عبر مخرجات الأدوات | `src/lib/ai/cards.ts`: عقد صارم `.strict()` + حقول الكتالوج فقط + سقف 3 بطاقات + إزالة التكرار | `tests/cards.test.ts`, `tests/chat-route.test.ts`, `tests/mcp-tools.test.ts` | `npm test`؛ حقول زائدة أو قيمة سالبة تُسقط البطاقة |
| P2-C | تسريب مفتاح مزود ثانٍ في السجلات | نمط `nvapi-…` في `redactSecrets` + مزود NIM عبر العميل الموحّد + https إلزامي للرابط | `tests/nvidia-nim.test.ts` | `npm test`؛ خطأ مزود بمفتاح وهمي لا يظهر في الرسالة |

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
| حقول زائدة تصل للواجهة من مخرجات الأدوات | صفر | ✅ تنقية بعقد صارم + سقف بطاقات |
| بيانات عملاء في ذاكرة RAG | صفر | ✅ الذاكرة كتالوج ومعلومات متجر فقط، واختبار يفحصها |
| لوحة إدارة غير قابلة للاستخدام بعد الدخول | صفر | ✅ اختبار HTTP كامل من الدخول إلى مسار محمي بالقيمة الحرفية للكوكي |

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
