# Post-Deploy Result — Evidence (سيُملأ بعد النشر)

هذا المجلد يوثّق **التحقق بعد النشر على الرابط الحقيقي**. يُملأ فقط بعد النشر الفعلي.

## الفحوصات الإلزامية (تُنفذ في workflow النشر + يدوياً)

| الفحص | المتوقع |
|---|---|
| `GET {PRODUCTION_URL}/api/health` | `200 {"status":"ok"}` |
| `GET {PRODUCTION_URL}/api/ready` | `200 {"status":"ready","database":"ok"}` |
| `GET {PRODUCTION_URL}/` | 200 + اسم المتجر |
| `GET {PRODUCTION_URL}/product/p1` | 200 + اسم منتج (كشف تراجع الصفحات الديناميكية) |
| `GET {PRODUCTION_URL}/cart` | 200 |
| Security headers (CSP, nosniff, X-Request-Id) | موجودة |
| طلب تجريبي صغير عبر API | 200 + id + خصم مخزون واحد |
| الشات (رد محلي أو مزوّد) | 200 مع `reply` |

## أمر الالتقاط المقترح

```bash
curl -fsS "$PRODUCTION_URL/api/health"
curl -fsS "$PRODUCTION_URL/api/ready"
curl -fsS -o /dev/null -w '%{http_code}' "$PRODUCTION_URL/product/p1"
# ووضع النتائج هنا مع التاريخ
```

## القاعدة

- **أي فحص فاشل = deployment failed** → تصعيد فوري ومراجعة (لا يعتبر الإصدار Production).
- بعد النجاح: المراقبة الاصطناعية (`synthetic-monitor.yml` كل 15 دقيقة) تتولى الكشف المستمر.
