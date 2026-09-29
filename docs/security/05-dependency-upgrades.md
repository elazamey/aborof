# تحديثات الأمان والحزم (Security & Dependency Updates)

سجل مركزي لترقيات الاعتماديات الأمنية — لكل ترقية: الحزمة، الإصداران، معرّف
الثغرة، السبب، وإثبات قابل لإعادة التحقق. يُستكمل به مصفوفة الإغلاق في
[`02-closure-matrix.md`](./02-closure-matrix.md) (البند P0-A: اعتماديات عالية الخطورة).

### [2026-09-29] ترقية Drizzle ORM لإغلاق ثغرة SQL Injection

- **الحزمة**: `drizzle-orm`
- **الترقية**: من `0.38.4` إلى `0.45.3`
- **معرف الثغرة**: [GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9)
- **السبب**: معالجة ثغرة محتملة في بناء الاستعلامات الديناميكية ورفع حصانة طبقة البيانات قبل تفعيل نظام الصلاحيات (RBAC).
- **التحقق**: تم تشغيل كافّة اختبارات الهجرة والـ ORM (`390/390` ناجح).

**الإثبات القابل لإعادة التحقق:**

```bash
npm ls drizzle-orm                          # → drizzle-orm@0.45.3
npm audit --omit=dev --audit-level=high     # → found 0 vulnerabilities
npm test                                    # → # tests 390 | # fail 0
```

- **نطاق الاستخدام في المستودع**: محصور في `drizzle-orm/libsql` و`sql`/`sqliteTable`/`eq` — لا استخدام لبناء استعلامات ديناميكي خارج هذا النطاق.
- **المرجع**: الالتزام `a721d17` (`fix(deps): ترقية drizzle-orm 0.38.4 → 0.45.3`) ضمن [PR #22](https://github.com/elazamey/aborof/pull/22).

### [2026-09-29] ترقية Next.js إلى 16.3.7 وإغلاق js-yaml وتنظيف تحذيرات بناء Vercel

سجل بناء Vercel (`Redeploy` لنفس الالتزام) انتهى بنجاح لكنه حمل تحذيرات؛ هذا ما أُغلق منها وما بقي عمدًا ولماذا.

**أُغلق:**

| البند | قبل | بعد | السبب والدليل |
|---|---|---|---|
| `next` / `eslint-config-next` | `16.3.5` / `16.3.2` | `16.3.7` | يتضمّن إصلاح 16.3.6 لـ[GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j) (تنفيذ تعليمات عن بُعد في `ImageResponse` لـ`next/og` على Node؛ المتأثر `>=16.2.0 <16.3.6`). **المستودع لا يستخدم `next/og`** فلا استغلال ممكن، لكن الحدّ الأدنى صار مُرقَّعًا حتى لو أُضيف استخدامه لاحقًا |
| `js-yaml` (عبر ESLint، تطوير فقط) | `4.3.1` | `4.3.2` | [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh) (عالية) — `npm audit fix` بلا `--force` |
| اصطلاح `middleware` | `src/middleware.ts` | `src/proxy.ts` | تحذير Next 16 «The "middleware" file convention is deprecated. Please use "proxy" instead» — السلوك واحد، انظر `tests/proxy.test.ts` |
| `npm warn install-scripts 4 packages have install scripts not yet covered by allowScripts` | لا قرار صريح | حقل `allowScripts` | انظر أدناه |

**سياسة `allowScripts` (npm ≥ 11.16، وهو ما تستخدمه حاويات Vercel؛ وفي npm 12 تُحجب سكربتات التبعيات افتراضيًا):**

```json
"allowScripts": { "esbuild": true, "fsevents": true, "unrs-resolver": true }
```

- الحزم الثلاث **أدوات بناء/تطوير فقط** (`esbuild` عبر `tsx` و`drizzle-kit`، `unrs-resolver` محلّل ESLint الأصلي، `fsevents` اختياري لماك)؛ لا واحدة منها تبعية إنتاج ولا تُحمَّل في دالة Vercel.
- الاعتماد بالاسم لا بالإصدار عمدًا: `drizzle-kit` يجرّ عدة نسخ من `esbuild` (`0.18.20` و`0.19.12` و`0.28.2`) ولا نملك تثبيت إصداراتها؛ والقفل `package-lock.json` هو الذي يثبّت الإصدار الفعلي.
- `tests/install-scripts-policy.test.ts` يُبقي القائمة صادقة بالاتجاهين: أي حزمة جديدة بسكربت تثبيت في القفل بلا قرار صريح **تُفشل CI**، وأي مدخل لا يقابله شيء في القفل يُفشله أيضًا.

**الإثبات القابل لإعادة التحقق** (npm 11.19.1 يُنتج التحذير نفسه بحزمه الأربع كما في سجل Vercel):

```bash
# قبل: على الالتزام bdd7376 — يطبع التحذير بحزمه الأربع بالضبط
mkdir -p /tmp/before && git show bdd7376:package.json > /tmp/before/package.json && git show bdd7376:package-lock.json > /tmp/before/package-lock.json
(cd /tmp/before && npx -y npm@11.19.1 ci --no-audit --no-fund)   # ⇒ npm warn install-scripts 4 packages have install scripts…
# بعد: على هذا الفرع
npx -y npm@11.19.1 ci --no-audit --no-fund                        # ⇒ لا سطر install-scripts
npm test                                                          # ⇒ tests/install-scripts-policy.test.ts
```

**بقي عمدًا (مقبول ومُوثَّق، لا يمسّ الإنتاج):**

| البند | لماذا لم يُغلق |
|---|---|
| `npm warn deprecated eslint@9.39.5` («no longer supported») | كل إصدارات 9.x منذ 9.39.3 موسومة بذلك؛ **الإصدار 10 غير قابل للتشغيل اليوم مع `eslint-config-next@16.3.7`**: `eslint-plugin-react@7.37.5` (آخر إصدار منشور، قيد peer حتى ESLint 9.x) يفشل بـ`TypeError: Error while loading rule 'react/display-name': contextOrFilename.getFilename is not a function` (جُرِّب `eslint@10.11.0`). الترقية تكسر `npm run lint` ولا تؤثّر في البناء. يُعاد الفحص عند صدور `eslint-plugin-react` يدعم ESLint 10 |
| `npm warn deprecated @esbuild-kit/esm-loader` و`@esbuild-kit/core-utils` («Merged into tsx») + 4 ثغرات متوسطة في `npm audit` (`esbuild ≤ 0.24.2`، [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)) | تأتي كلها من `drizzle-kit` (أداة تطوير لا تُشغَّل في الإنتاج ولا في CI، ولا تُشغّل خادم `esbuild` التطويري موضوع الثغرة). **جُرِّبت ترقية `drizzle-kit` إلى `0.31.11` (ما يقترحه `npm audit fix --force`): لا تزيل `@esbuild-kit` (ما زالت في `dependencies` عنده) ولا الثغرات** — فلا قيمة فيها. تُحلّ عند إسقاط `drizzle-kit` لها أو ترقيته إلى 1.0 المستقر (يغيّر تنسيق مجلد الهجرات). بوابة CI (`npm audit --omit=dev --audit-level=high`) تبقى خضراء لأنها على حزم الإنتاج فقط |
