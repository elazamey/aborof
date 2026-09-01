# Monitoring — Evidence (يُملأ بعد النشر)

## Synthetic Monitoring (كل 15 دقيقة — GitHub Actions)

| الفحص | المتوقع |
|---|---|
| `GET /api/health` | 200 `status=ok` |
| `GET /api/ready` | 200 `status=ready, database=ok` |
| `GET /` | 200 |
| `GET /product/p1` | 200 |
| `POST /api/chat` | 200 مع `reply` |

**قاعدة:** الفشل يُسجَّل دائماً كـ incident (لا يتحول green لمجرد نجاح الطلب التالي).

## أول 15 دقيقة بعد النشر (مراقبة مكثفة)

| النقطة | health | ready | homepage | product | error rate | latency |
|---|---|---|---|---|---|---|
| t+0 | | | | | | |
| t+5 | | | | | | |
| t+10 | | | | | | |
| t+15 | | | | | | |

## أول 24 ساعة (PRODUCTION OBSERVATION — ليس Stable بعد)

نراقب: 5xx · DB errors · timeouts · auth failures · AI timeouts · readiness failures · rate-limit anomalies.

| المؤشر | ملاحظات أول 24 ساعة |
|---|---|
| أخطاء 5xx | |
| أخطاء DB | |
| timeouts | |
| فشل مصادقة | |
| AI timeouts | |
| readiness failures | |

## تعريف Incident (Critical)

- health down · ready down · login مكسور تماماً · orders مكسور · DB غير متاحة
- عند Critical: **stop feature work → investigate → rollback if needed**

## قرار النهاية

- بعد 24 ساعة نظيفة: **PRODUCTION STABLE** — يُسجَّل هنا بالتاريخ والدليل.
