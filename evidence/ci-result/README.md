# CI Result — Evidence (سيُملأ بعد رفع workflows)

هذا المجلد يوثّق **دليل GitHub CI** للـ Release Candidate. يُملأ بعد أن يجتاز الفرع بوابة CI على GitHub.

## ما يجب تسجيله (عند التشغيل)

1. **رابط تشغيل GitHub Actions**: `https://github.com/elazamey/aborof/actions/runs/<run-id>`
2. **الـ commit الذي اجتاز CI** (يجب أن يطابق commit الـ release-check):
   ```bash
   git rev-parse HEAD   # أو من صفحة التشغيل: "head_sha"
   ```
3. **حالة كل job**: quality (L1/L2 + unit) · smoke (L3/L4) · drill (L5) · dependency-audit · secret-scan
4. لقطة من ملخص التشغيل (`gh run view <run-id> --json status,conclusion,jobs`)

## أمر الالتقاط المقترح

```bash
gh run list --branch arena/01a05f01-aborof --limit 3
gh run view <run-id> --json displayTitle,headSha,status,conclusion,jobs
```

## القاعدة

- **CI FAIL = الإصدار ليس Release Candidate** — لا يُنشر.
- **Same-Commit Policy:** يجب أن يتطابق `headSha` هنا مع commit الـ release-check وcommit الـ deploy.
