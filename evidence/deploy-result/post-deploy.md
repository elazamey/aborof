# Post-Deploy Verification — Evidence (لم تُنفَّذ — مُلاحَظ)

> **OBSERVED STATUS:** ❌ **NOT EXECUTED** — لم يحدث أي نشر (انظر `deployment.md`).
> لا توجد نتائج post-deploy مسجلة لأن **لا يوجد deployment** — أي نتيجة هنا ستكون مفبركة.

## الفحوصات المطلوبة (تُنفَّذ فور نجاح النشر)

| الفحص | المتوقع | الحالة |
|---|---|---|
| `GET /api/health` | 200 | ⬜ لم يُنفَّذ (لا نشر) |
| `GET /api/ready` | 200 + `database=ok` | ⬜ لم يُنفَّذ |
| `GET /` | 200 | ⬜ لم يُنفَّذ |
| `GET /product/p1` | 200 | ⬜ لم يُنفَّذ |
| Critical safe path (طلب اختباري + مخزون + حالة) | كامل | ⬜ لم يُنفَّذ |
| Auth lifecycle (login/expired/tampered) | 200/401 | ⬜ لم يُنفَّذ |
| `DEPLOYED_COMMIT == RC_COMMIT` | ✅ | ⬜ لم يُنفَّذ |

## القاعدة

- Post-deploy verification تُسجَّل فقط بعد **نشر مُلاحَظ فعلياً**.
- أي فشل في health/ready/homepage/product = Deployment Gate FAIL → STOP + تحقيق + rollback عند الاقتضاء (لا "إعادة محاولة حتى تمر").
