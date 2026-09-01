# CI Run — Evidence (يُملأ بعد تشغيل GitHub CI)

> يُسجَّل هنا دليل GitHub Actions للـ Release Candidate. **لا يُغلق GitHub CI Gate إلا بعد اكتمال هذا الملف وثبات `CI_COMMIT == RC_COMMIT`.**

## السجل

| الحقل | القيمة |
|---|---|
| **Workflow run ID** | <من `gh run list`> |
| **رابط التشغيل** | <https://github.com/elazamey/aborof/actions/runs/RUN_ID> |
| **CI_COMMIT (headSha)** | <من `gh run view RUN_ID --json headSha`> |
| **RC_COMMIT** | <نفس القيمة — إلزامي التطابق> |
| **التاريخ** | <ISO> |
| **الخلاصة** | pending |

## حالة الوظائف (Job)

| Job | النتيجة |
|---|---|
| quality (L1: lint/format/tsc/routes + unit 32/32 + build) | pending |
| smoke (L3/L4: 36/36 على next start) | pending |
| drill (L5: 36/36 حقن أعطال) | pending |
| dependency-audit | pending |
| secret-scan | pending |

## الالتقاط (أمر التشغيل)

```bash
gh run list --branch arena/01a05f01-aborof --limit 3
gh run view <run-id> --json displayTitle,headSha,status,conclusion,jobs
```

## القاعدة

- أي Job أحمر = **CI Gate مفتوح** — لا نشر.
- `CI_COMMIT != RC_COMMIT` = **بوابة الحالة مكسورة** — لا نشر حتى التطابق.
