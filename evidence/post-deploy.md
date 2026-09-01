# Post-Deploy Verification — Evidence (يُملأ بعد النشر على الرابط الحقيقي)

> النشر لا يُعتبر ناجحاً قبل اجتياز هذه الفحوصات على `PRODUCTION_URL` الحقيقي.

## الفحوصات الإلزامية

| الفحص | المتوقع | النتيجة |
|---|---|---|
| `GET /api/health` | 200 `{"status":"ok"}` | pending |
| `GET /api/ready` | 200 `{"status":"ready","database":"ok"}` | pending |
| `GET /` | 200 + اسم المتجر | pending |
| `GET /product/p1` | 200 (منتج معروف موجود في production) | pending |
| Security headers (CSP / nosniff / X-Request-Id) | موجودة | pending |
| Critical path آمن (طلب اختباري + خصم مخزون واحد + تحديث حالة + إلغاء يعيد المخزون) | كامل | pending |
| Auth: login → cookie → request 200؛ expired/tampered/invalid → 401 | كامل | pending |
| AI: مزوّد فاشل/معلّق → fallback خلال 10 ثوانٍ (لا hanging) | كامل | pending |
| **`DEPLOYED_COMMIT == RC_COMMIT`** | ✅ | pending |

## القاعدة

- أي فحص فاشل = **deployment failed** → تصعيد فوري (Critical incident) → rollback إذا لزم.
- بعد النجاح: يبدأ synthetic monitoring + نافذة الملاحظة 24 ساعة.
