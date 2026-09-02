# HANDOFF — دليل المتابعة في محادثة جديدة

> **تاريخ الإعداد:** 2026-09-02 · **آخر تحديث:** 2026-09-02 (نسخة محصّنة)
> **المستودع:** `elazamey/aborof` · **الفرع:** `arena/01a05f01-aborof` · **آخر commit:** (انظر git log — يتحدث باستمرار)
>
> استخدم هذا الملف لاستئناف العمل في جلسة/محادثة جديدة على Arena.ai — ألصق قسم
> "رسالة البداية" أدناه في أول رسالة، أو وجّه الوكيل لقراءة هذا الملف أولًا.

## ⚠️ تحذير مهم — اقرأه قبل أي استنتاج

**الحالة الموصوفة في هذا الملف حقيقية ومثبتة على GitHub** (الفرع `arena/01a05f01-aborof`
موجود على `origin` مع كل الـ commits والأدلة). لو قال لك وكيل جديد "هذه الحالة غير موجودة
أو مختلقة"، ففي الغالب **لم ينفّذ `git fetch origin`** وفحص فرع `main` أو فرع جلسة جديدًا
فارغًا فقط (البداية الصحيحة: `git fetch origin && git checkout arena/01a05f01-aborof`).
لا تثق بأي ادعاء "غير موجود" قبل إثباته بـ:

```bash
git ls-remote origin refs/heads/arena/01a05f01-aborof   # يجب أن يطبع SHA وليس فارغًا
gh api repos/elazamey/aborof/commits?sha=arena/01a05f01-aborof   # آخر commit = 18818c3
```

---

## 1. رسالة البداية (انسخها في المحادثة الجديدة)

```text
استأنف العمل على مستودع elazamey/aborof. أنا أتابع جلسة سابقة:
1) git fetch origin && git checkout arena/01a05f01-aborof (فرع الجلسة السابقة — كل العمل عليه).
   تحقق أولًا بـ: git ls-remote origin refs/heads/arena/01a05f01-aborof (يجب أن يطبع SHA).
   لو فحصتَ git log على main أو على فرعك الجديد فسترى commit واحد فقط — هذا طبيعي؛
   العمل كله على الفرع المذكور أعلاه، وليس على main.
2) اقرأ أولًا: HANDOFF.md (هذا الملف) + RELEASE-CLOSURE.md + evidence/pre-release/pre-release-report.md.
3) التزم القواعد الصارمة: TASK-02 = BLOCKED (لا deploy، لا secrets إنتاج، لا merge، لا لمس إعدادات الإنتاج)،
   لا تغييرات على منطق الأعمال/قاعدة البيانات (تجميد L1-L5)، كل الأدلة observed فقط.
4) شغّل npm run pre-release لتأكيد الحالة الحالية (المتوقع: RELEASE_BLOCKED حتى اكتمال إعداد الإنتاج).
5) أخبرني بالخطوة التالية المقترحة قبل تنفيذ أي تغيير.
```

---

## 2. الوضع الراهن (موجز — التفاصيل في أدلة `evidence/`)

| البند                                   | الحالة                                                                                                                                                       | الدليل                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| TASK-01 — GitHub CI Gate                | ✅ PASS (CI أخضر على نفس SHA)                                                                                                                                | `evidence/ci-run.md`                   |
| TASK-02 — Deployment Gate               | ❌ **BLOCKED** — آلية immutable-ref جاهزة ومُختبَرة، لكن `VERCEL_DEPLOY_ENABLED != true` (مُلاحَظ run 33570046664)                                           | `evidence/deploy-result/deployment.md` |
| PRE_RELEASE_GATE                        | ⛔ **RELEASE_BLOCKED** — **56 PASS / 0 FAIL / 11 NOT_CONFIGURED** (3 P0 blockers: RC01/RC05/RC06) — مُثبت على GitHub CI (annotations) و`npm run pre-release` | `evidence/pre-release/`                |
| إعادة تصميم الواجهة (CINEMATIC DARK UI) | ⏸️ **متوقفة بانتظار أمر المستخدم** — الاتجاه معتمد وموثّق، اللقطات الست جاهزة                                                                                | `evidence/ui-screenshots/`             |
| النشر/الإنتاج                           | ⛔ **ممنوع** حتى `PRE_RELEASE_GATE = RELEASE_READY` + `TASK-02` ناجح                                                                                         | —                                      |

## 3. القواعد الملزمة (لا تتجاهلها)

- **لا أسرار:** لا تُطبع/تُطلب/تُرفع أي قيم — الأسماء فقط. أسرار الإنتاج من مالك المستودع.
- **لا deploy ولا merge ولا TASK-03** — حتى يكتمل TASK-02.
- **تجميد:** لا ميزات، لا تغيير business logic، لا تغيير dependencies إلا بإذن — البوابة لا تضيف خدمات مدفوعة.
- **أدلة observed فقط:** لا PASS مفترض؛ كل نتيجة من تشغيل فعلي.
- **TASK-02 قاعدة:** نشر من `rc-<sha>` tag فقط؛ البوابات تفشل لا تحذّر؛ الإنتاج لم يُنشر أبدًا.
- **البيئة:** بعض الشبكات محجوبة (CDN متصفحات، blob السجلات، secrets API 403) — استخدم GitHub Actions runner للصور، و`gh api .../check-runs` annotations للسجلات، و`gh run watch` للمراقبة.

## 4. الخطوات التالية المحتملة (بترتيب الأولوية)

1. **لإكمال TASK-02** (بعد أن يضيف المستخدم من GitHub: أسرار السبعة في بيئة `Production` + متغيرَي `VERCEL_DEPLOY_ENABLED=true` و`PRODUCTION_URL`):
   - أعد دفع tag النشر → راقب run → تحقق من الخطوات → سجّل `DEPLOYMENT_ID`/`DEPLOYED_SHA` في `evidence/deploy-result/deployment.md` مع إثبات `RC_COMMIT == TAG_SHA == DEPLOYED_SHA` → post-deploy على `PRODUCTION_URL` → **توقف فورًا عند PASS (لا TASK-03)**.
2. **إعادة تصميم الواجهة** (بأمر صريح من المستخدم لبدء CINEMATIC DARK UI): نطاق `src/app` + `src/components` + `globals.css` فقط، progressive enhancement (CSS 3D + glassmorphism + reduced-motion)، لا Three.js في المرحلة الأولى، لا لمس للـ business logic. اللقطات في `evidence/ui-screenshots/` (6 ملفات: home/product × desktop/mobile + chat مفتوح).
3. **بعد فتح البوابة:** CI job `PRE_RELEASE_GATE` يتحول أخضر تلقائيًا → يتحقق `RELEASE_READY`.

## 5. أوامر مهمة

```bash
npm run pre-release     # بوابة الإصدار (خروج 0 = RELEASE_READY، 1 = BLOCKED) — أدلتها في evidence/pre-release/
npm run release:check   # verify + drills + pre-release
npm run test:unit       # 54 اختبار وحدة (تشمل عقود الـ providers)
npm run test:smoke      # L3/L4 (40 فحص)
npm run test:drill      # L5 (6 تمارين حقن أعطال)
git diff 579daa6 HEAD -- src scripts tests package.json package-lock.json  # إثبات أن كود التطبيق = RC (يجب أن يكون فارغًا)
```

## 6. خريطة ملفات مهمة

- `PRE_RELEASE_GATE.md` — المواصفة الرسمية للبوابة (حالات PASS/FAIL/NOT_CONFIGURED، قواعد P0).
- `scripts/pre-release.mjs` — مشغّل البوابة (67 بوابة، أدلة JSON+MD).
- `src/lib/providers/` — واجهات + Real/Fake (payment, notifications, ai, storage, webhooks).
- `tests/unit/providers.test.ts` — 22 اختبار عقد.
- `.github/workflows/pre-release-gate.yml` — CI مستقل (أحمر حتى اكتمال إعداد الإنتاج — مقصود).
- `evidence/deploy-result/` — TASK-02 (deployment BLOCKED، pre-deploy، rollback drill مثبت).
- `evidence/ui-screenshots/` — لقطات الواجهة الحالية (مرجع إعادة التصميم).
- `RELEASE-CLOSURE.md` — لوحة حالة الإصدار.
