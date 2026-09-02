# REGRESSION-VAULT — مكتبة الحماية المتراكمة

> **المبدأ (قرار المستخدم):** كل bug حقيقي يظهر قبل الإطلاق يتحول إلى **Regression Test دائم**.
> بهذه الطريقة كل مشكلة تحميك إلى الأبد بدل أن تُعالج مرة وتعود بعد أشهر.
> **التاريخ:** 2026-09-02 · **الحالة:** نشط — يُضاف كل incident جديد.

---

## السجلات

| #                   | العَرَض                                                                        | السبب الجذري                                                                        | الإصلاح                                                                                   | الاختبار الدائم                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **BUG-001**         | كوكي جلسة الـ Admin لا تُحفظ/لا تُقرأ (مشكلة `:` في URL-encoding)              | الـ token يحوي `:` (payload:issuedAt) فيحتاج encoding يختلف بين Set-Cookie والقراءة | Base64URL خالص (A-Z a-z 0-9 - _) بلا `:` إطلاقًا + decodeURIComponent دفاعي               | `tests/unit/auth.test.ts` — "REGRESSION: token is cookie-safe by construction"                                           |
| **BUG-002**         | سيليا لا تجيب على الأسئلة المنتهية بـ "؟" العربية                              | "؟" تلتصق بآخر كلمة فتكسر مطابقة الكلمات مع النصوص المخزنة                          | إزالة علامات الترقيم العربية (`؟؟،،؛؛.!`) قبل التقسيم للكلمات                             | `tests/unit/chat-local.test.ts` — "REGRESSION: answers shipping questions ending with the Arabic question mark"          |
| **BUG-003**         | بعد فشل DB عابر، كل الطلبات التالية تفشل للأبد حتى إعادة التشغيل               | وعد `ensureSchema` المرفوض يبقى مخزّنًا في `_ready` فيُسمَّم إلى الأبد              | إعادة `_ready = null` عند الفشل لتسمح بالمحاولة التالية                                   | `tests/unit/db-recovery.test.ts` — "REGRESSION: after a failure the next call retries instead of being poisoned forever" |
| **BUG-004**         | ErrorBudget يعلن استنفادًا خاطئًا عند الحدّ تمامًا (10% أخطاء مع هدف 90%)      | خطأ فاصلة عائمة: `1 - 0.9 = 0.09999999999999998` فتفشل مقارنة `>`                   | epsilon `1e-9` في مقارنة الاستنفاد                                                        | `tests/unit/reliability.test.ts` — "exhausted when error rate exceeds the allowed budget"                                |
| **BUG-005**         | بَطاقة retry قد تُضاعف التأخير: `backoffDelay(attempt)` يبدأ من المحاولة الخطأ | استدعاء `backoffDelay(1)` للمحاولة الثانية أعطى 2000 بدل 1000                       | الاختبار حتمي يثبت التسلسل `[1000, 2000]` للمحاولات الفاشلة                               | `tests/unit/reliability.test.ts` — "withRetry succeeds on the second attempt..."                                         |
| **BUG-006**         | rate limiter في الذاكرة قد ينمو بلا حدود                                       | `Map` بلا تنظيف                                                                     | `MAX_BUCKETS` + prune للدلاء المنتهية                                                     | `tests/unit/rate-limit.test.ts` — "is bounded: expired buckets are pruned"                                               |
| **BUG-007** (بوابة) | بوابة النشر تفتح خادمًا ثانيًا يفشل بصمت بسبب خادم يتيم يمسك المنفذ            | قتل `npx` الأب لا يقتل `next-server` الابن (process group)                          | `detached: true` + قتل المجموعة `-pid` + فحص `portIsBusy` قبل البدء + انتظار تحرير المنفذ | مضمون في `scripts/pre-release.mjs` (SERVER gate + stopServer)                                                            |
| **BUG-008** (بوابة) | F09 يفشل بعد logout لأن الـ fetch يحتفظ بالكوكي القديم يدويًا                  | المتصفح الحقيقي يمسح الكوكي؛ الاختبار كان يعيد إرساله                               | التحقق بعد logout **بلا كوكي** (محاكاة المتصفح)                                           | مضمون في `scripts/pre-release.mjs` (F09 gate)                                                                            |
| **BUG-009** (بوابة) | تحديث منتج عبر الـ Admin API يفشل 422 عند غياب `category`                      | `validProduct` يتطلب `category` دائمًا — سلوك صحيح للـ API                          | اختبار البوابة يرسل `category` كاملة (السلوك موثّق)                                       | مضمون في `scripts/pre-release.mjs` (F13 gate)                                                                            |

---

## القاعدة

1. أي incident/خلل حقيقي (إنتاج أو بوابة) يُسجَّل هنا.
2. يُكتب اختبار يعيد إنتاج العَرَض (فاشلًا أولًا).
3. يُطبَّق الإصلاح فيمرّ الاختبار.
4. الاختبار يبقى دائمًا في `npm run test:unit` أو في البوابة.

## التغطية الحالية

- **اختبارات وحدة:** 78 (تشمل BUG-001..006).
- **بوابة الإصدار:** 61 بوابة (تشمل BUG-007..009 مضمونة في `npm run pre-release`).
- **اختبارات Providers:** 22 (عقود التكاملات الخارجية success/failure/timeout/duplicate/idempotency/unavailable).
- **Resilience drills L5:** DRILL-01..06 (فشل DB عابر، تزامن، قتل الخادم، جلسات، env، AI fallback).
