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
