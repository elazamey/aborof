# What-If Test Matrix — متجر أبو رفيدة العزامي

> **مختبر قرار، لا اختبار «هل وقع الموقع».** كل سيناريو يُقاس عبر السلسلة:
> `INPUT → INTENT → DATA → POLICY → AUTHORIZATION → EXECUTION → EVIDENCE → OUTCOME`

| بند | قيمة |
|---|---|
| تاريخ التشغيل | `2026-09-28T08:10:27.135Z` |
| معرّف التشغيل | `run7` |
| الـ Runtime قيد القياس | `http://127.0.0.1:3000` (Next.js على `0.0.0.0:3000`) |
| نسخة DB-down | `http://127.0.0.1:3001` (نفس الكود، `TURSO_DATABASE_URL` فارغ) |
| قاعدة البيانات | `file:local.db` عبر `@libsql/client` — نفس مسار كود Turso |
| حالة خط الأساس | orders=`26` · order_items=`26` · orphans=`0` · negative_stock=`0` |
| الحالة النهائية | orders=`31` · order_items=`31` · orphans=`0` · negative_stock=`0` |

## الملخّص

| الحالة | العدد |
|---|---|
| ✅ PASS | 12 |
| ❌ FAIL | 4 |
| **الإجمالي** | **16** |

**ثوابت سلامة لم تُكسر في أي سيناريو:** `orphan_order_items = 0` و`negative_stock_rows = 0`.

---

## المصفوفة


### WF-001 — المنتج موجود والمخزون يكفي — «عايز 20 عبوة من منظف الأرضيات باللافندر»

**✅ PASS** · 8/8 فحوص · 76ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/orders {items:[{p1,20}]} |
| PRECONDITION | p1: stock=50, price=180 |
| EXPECTED_DECISION | FIND → CHECK STOCK → ACCEPT |
| EXPECTED_SIDE_EFFECT | طلب واحد، subtotal=3600، شحن=0 (فوق 1000)، المخزون 50→30 |
| EVIDENCE_REQUIRED | 200 + رقم طلب + المخزون بعد + صف الطلب في DB |

**الفحوص**

- ✅ HTTP 200 (المتوقع 200)
- ✅ ok=true
- ✅ subtotal=3600 (المتوقع 3600 = 20×180)
- ✅ shipping=0 (المتوقع 0 — فوق حد الشحن المجاني 1000)
- ✅ total=3600 (المتوقع 3600)
- ✅ المخزون 50 → 30 (المتوقع 30)
- ✅ صفوف بمخزون سالب = 0
- ✅ أصناف يتيمة = 0

**ACTUAL (دليل خام)**

```json
{
  "http": 200,
  "request_id": "req_5bbdff49-f3d7-4081-888b-3c67f0dda4b2",
  "body": {
    "ok": true,
    "id": "ORD-83026187-e6287d92",
    "subtotal": 3600,
    "shipping": 0,
    "total": 3600
  },
  "stock_before": 50,
  "stock_after": 30,
  "db": {
    "orders": 27,
    "order_items": 27,
    "orphan_order_items": 0,
    "negative_stock_rows": 0,
    "last_order": {
      "id": "ORD-83026187-e6287d92",
      "total": 3600,
      "shipping_fee": 0,
      "items": "[{\"id\":\"p1\",\"name\":\"منظف أرضيات برائحة اللافندر 5 لتر\",\"price\":180,\"qty\":20}]"
    }
  }
}
```


### WF-002 — منتج غير موجود — بحث + محاولة شراء

**✅ PASS** · 7/7 فحوص · 46ms

| الحقل | القيمة |
|---|---|
| INPUT | chat: «عندكم منظف زئبق للقمر؟» ثم POST /api/orders {items:[{p-ghost,1}]} |
| PRECONDITION | لا يوجد منتج بهذا المعرف/الاسم |
| EXPECTED_DECISION | SEARCH → NOT_FOUND → SAFE RESPONSE / 409 CONFLICT |
| EXPECTED_SIDE_EFFECT | لا طلب، لا خصم مخزون، رد آمن بلا اختراع منتج |
| EVIDENCE_REQUIRED | رد الدردشة + 409 + ثبات المخزون وعدد الطلبات |

**الفحوص**

- ✅ chat HTTP 200
- ✅ الدردشة ردّت نصًا آمنًا
- ✅ الرد لم يؤكّد توافر منتج غير موجود
- ✅ HTTP 409 (المتوقع 409)
- ✅ code=CONFLICT (المتوقع CONFLICT)
- ✅ عدد الطلبات 27 → 27 (بلا تغيير)
- ✅ أصناف يتيمة = 0

**ACTUAL (دليل خام)**

```json
{
  "chat_http": 200,
  "chat_source": "local",
  "chat_reply": "أهلاً بيك 👋 دي المنتجات المناسبة لطلبك:\n• منظف أرضيات برائحة اللافندر 5 لتر — 180 جنيه\n• كلوركس مبيض ومطهر 4 لتر — 95 جنيه\n• سائل غسيل أطباق ليمون 2 لتر — 70 ج",
  "http": 409,
  "code": "CONFLICT",
  "request_id": "req_8f0e9851-8b70-4464-8d44-cc1d66c20007",
  "body": {
    "error": "أحد المنتجات لم يعد متاحًا",
    "code": "CONFLICT",
    "request_id": "req_8f0e9851-8b70-4464-8d44-cc1d66c20007"
  },
  "orders_before": 27,
  "orders_after": 27
}
```


### WF-003 — الكمية أكبر من المخزون — طلب 20 والمتاح 7

**✅ PASS** · 6/6 فحوص · 52ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/orders {items:[{p1,20}]} |
| PRECONDITION | p1: stock=7 |
| EXPECTED_DECISION | VALIDATE QUANTITY → BLOCK → EXPLAIN WHY |
| EXPECTED_SIDE_EFFECT | لا طلب، المخزون يبقى 7، رسالة تسمّي المنتج |
| EVIDENCE_REQUIRED | 409 + نص الرسالة + المخزون قبل/بعد + عدد الطلبات |

**الفحوص**

- ✅ HTTP 409 (المتوقع 409)
- ✅ code=CONFLICT
- ✅ الرسالة تشرح السبب: «الكمية المطلوبة من منظف أرضيات برائحة اللافندر 5 لتر غير متاحة»
- ✅ الرسالة تسمّي المنتج المعني
- ✅ المخزون 7 → 7 (لم يُخصم شيء)
- ✅ عدد الطلبات 27 → 27 (لم يُنشأ طلب)

**ACTUAL (دليل خام)**

```json
{
  "http": 409,
  "code": "CONFLICT",
  "message": "الكمية المطلوبة من منظف أرضيات برائحة اللافندر 5 لتر غير متاحة",
  "request_id": "req_6f0329e7-8b55-459f-a272-597073490326",
  "stock_before": 7,
  "stock_after": 7,
  "orders_before": 27,
  "orders_after": 27
}
```


### WF-004 — المخزون صفر — AVAILABILITY = FALSE

**✅ PASS** · 6/6 فحوص · 41ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/orders {items:[{p1,1}]} |
| PRECONDITION | p1: stock=0 |
| EXPECTED_DECISION | CHECK STOCK → ORDER_BLOCKED |
| EXPECTED_SIDE_EFFECT | لا طلب، المخزون يبقى 0 |
| EVIDENCE_REQUIRED | 409 + ثبات المخزون وعدد الطلبات |

**الفحوص**

- ✅ precondition: stock=0
- ✅ HTTP 409 (المتوقع 409)
- ✅ code=CONFLICT
- ✅ المخزون بعد = 0 (لم يصبح سالبًا)
- ✅ عدد الطلبات 27 → 27
- ✅ صفوف بمخزون سالب = 0

**ACTUAL (دليل خام)**

```json
{
  "http": 409,
  "code": "CONFLICT",
  "message": "الكمية المطلوبة من منظف أرضيات برائحة اللافندر 5 لتر غير متاحة",
  "request_id": "req_7d9e8e61-a597-41af-929e-807370ee07a5",
  "stock_before": 0,
  "stock_after": 0,
  "orders_after": 27
}
```


### WF-005 — حمولة غير صحيحة — مفتاح غير معروف + سلة فارغة

**✅ PASS** · 8/8 فحوص · 33ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/chat {message:...} ثم POST /api/orders {items:[]} |
| PRECONDITION | لا شيء |
| EXPECTED_DECISION | ZOD STRICT → 422 VALIDATION_FAILED |
| EXPECTED_SIDE_EFFECT | لا طلب، لا كتابة في DB، request_id للربط بالسجلات |
| EVIDENCE_REQUIRED | 422 + code + request_id + ثبات عدد الطلبات |

**الفحوص**

- ✅ chat HTTP 422 (المتوقع 422)
- ✅ chat code=VALIDATION_FAILED
- ✅ العقد strict رفض المفتاح: Unrecognized key(s) in object: 'message'
- ✅ request_id=req_1e21e510-9bd8-4bb7-8f9c-2947373a7713
- ✅ orders HTTP 422 (المتوقع 422)
- ✅ orders code=VALIDATION_FAILED
- ✅ رسالة عربية مفهومة: items: السلة فارغة
- ✅ عدد الطلبات 27 → 27 (بلا تغيير)

**ACTUAL (دليل خام)**

```json
{
  "chat_http": 422,
  "chat_code": "VALIDATION_FAILED",
  "chat_error": "Unrecognized key(s) in object: 'message'",
  "chat_request_id": "req_1e21e510-9bd8-4bb7-8f9c-2947373a7713",
  "order_http": 422,
  "order_code": "VALIDATION_FAILED",
  "order_error": "items: السلة فارغة",
  "order_request_id": "req_0488fc32-780c-467d-962e-9eb111af89e9",
  "orders_before": 27,
  "orders_after": 27
}
```


### WF-010 — الضغط على «إرسال الطلب» مرتين — double submit

**✅ PASS** · 5/5 فحوص · 66ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/orders مرتين بنفس الحمولة ونفس هوية العميل |
| PRECONDITION | p1: stock=10 |
| EXPECTED_DECISION | لكل طلب قرار مستقل — لا مفتاح idempotency في العقد |
| EXPECTED_SIDE_EFFECT | طلبان منفصلان، المخزون 10→8، بلا تجاوز للمخزون |
| EVIDENCE_REQUIRED | رقما طلبين مختلفين + المخزون بعد + عدم وجود سجلات يتيمة |

**الفحوص**

- ✅ HTTP 200 / 200
- ✅ رقما الطلبين مختلفان: ORD-83026425-ef3bab2d , ORD-83026443-44b687d6
- ✅ المخزون 10 → 8 (خصم 2 — طلب واحد لكل ضغطة)
- ✅ صفوف بمخزون سالب = 0
- ✅ أصناف يتيمة = 0

**ACTUAL (دليل خام)**

```json
{
  "http_1": 200,
  "http_2": 200,
  "id_1": "ORD-83026425-ef3bab2d",
  "id_2": "ORD-83026443-44b687d6",
  "request_id_1": "req_b231e634-9b4e-4f8f-a0b9-f8739be07e88",
  "request_id_2": "req_1af675be-ef1b-4a09-9059-0d2e044fa517",
  "stock_before": 10,
  "stock_after": 8,
  "db": {
    "orders": 29,
    "order_items": 29,
    "orphan_order_items": 0,
    "negative_stock_rows": 0,
    "last_order": {
      "id": "ORD-83026443-44b687d6",
      "total": 230,
      "shipping_fee": 50,
      "items": "[{\"id\":\"p1\",\"name\":\"منظف أرضيات برائحة اللافندر 5 لتر\",\"price\":180,\"qty\":1}]"
    }
  },
  "finding": "لا يوجد idempotency key في createOrderContract — التكرار يُنشئ طلبين"
}
```


### WF-011 — السعر تغيّر بين العرض وتأكيد الطلب + محاولة تزوير السعر

**✅ PASS** · 9/9 فحوص · 59ms

| الحقل | القيمة |
|---|---|
| INPUT | عرض 180 ← الإدارة ترفعه إلى 250 ← POST /api/orders {items:[{p1,1}]} |
| PRECONDITION | p1: price=180 ثم price=250 (old_price=null) |
| EXPECTED_DECISION | إعادة حساب السعر من مصدر موثوق؛ العقد لا يقبل سعرًا من العميل |
| EXPECTED_SIDE_EFFECT | الطلب يُسعَّر بـ 250 لا 180؛ الحمولة المزوّرة تُرفض 422 |
| EVIDENCE_REQUIRED | total=300 (250+50) + price داخل items + 422 للتزوير |

**الفحوص**

- ✅ precondition: السعر المعروض = 180
- ✅ HTTP 200
- ✅ subtotal=250 (المتوقع 250 — سعر وقت التنفيذ لا وقت العرض)
- ✅ shipping=50 (المتوقع 50 — تحت حد 1000)
- ✅ total=300 (المتوقع 300)
- ✅ السعر المخزّن في صف الطلب = 250
- ✅ تزوير السعر → HTTP 422 (المتوقع 422)
- ✅ code=VALIDATION_FAILED
- ✅ العقد strict رفض حقل price: items.0: Unrecognized key(s) in object: 'price'

**ACTUAL (دليل خام)**

```json
{
  "price_viewed_by_customer": 180,
  "price_at_commit": 250,
  "http": 200,
  "subtotal": 250,
  "shipping": 50,
  "total": 300,
  "stored_items": "[{\"id\":\"p1\",\"name\":\"منظف أرضيات برائحة اللافندر 5 لتر\",\"price\":250,\"qty\":1}]",
  "tamper_http": 422,
  "tamper_code": "VALIDATION_FAILED",
  "tamper_error": "items.0: Unrecognized key(s) in object: 'price'",
  "request_id": "req_25a290e4-19f0-406f-954c-0a777fbe7850"
}
```


### WF-016 — قاعدة البيانات غير متاحة أثناء إنشاء الطلب

**✅ PASS** · 7/7 فحوص · 28ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/orders على نسخة Runtime بلا TURSO_DATABASE_URL (:3001) |
| PRECONDITION | TURSO_DATABASE_URL فارغ — db() يُعيد null |
| EXPECTED_DECISION | SERVICE_UNAVAILABLE — لا نجاح كاذب |
| EXPECTED_SIDE_EFFECT | لا طلب، والقراءة تتدهور بأمان إلى منتجات البذر |
| EVIDENCE_REQUIRED | 503 + code + request_id + 200 على القراءة + عدم ظهور طلب في DB الحقيقية |

**الفحوص**

- ✅ HTTP 503 (المتوقع 503)
- ✅ code=SERVICE_UNAVAILABLE
- ✅ لا يوجد ok:true في الاستجابة (لا نجاح كاذب)
- ✅ لا رقم طلب في الاستجابة
- ✅ request_id=req_8f588099-68fd-4d63-bd2a-677803ae87fd للربط بالسجلات
- ✅ قراءة المنتجات HTTP 200 (تدهور آمن)
- ✅ طلبات DB الحقيقية 30 → 30 (لم يُكتب شيء)

**ACTUAL (دليل خام)**

```json
{
  "http": 503,
  "code": "SERVICE_UNAVAILABLE",
  "message": "قاعدة البيانات غير مربوطة",
  "request_id": "req_8f588099-68fd-4d63-bd2a-677803ae87fd",
  "read_http": 200,
  "read_products": 12,
  "real_db_orders_before": 30,
  "real_db_orders_after": 30
}
```


### WF-017 — مستخدم عادي يحاول تنفيذ إجراء إداري

**✅ PASS** · 8/8 فحوص · 78ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/products و PATCH /api/orders و GET /api/orders — بلا كوكيز، وبكوكيز مزوّر |
| PRECONDITION | لا جلسة إدارة صالحة |
| EXPECTED_DECISION | AUTHORIZATION → 401 AUTH_REQUIRED |
| EXPECTED_SIDE_EFFECT | لا كتابة، لا كشف بيانات الطلبات، لا تغيير مخزون |
| EVIDENCE_REQUIRED | 401 على المسارات الأربعة + ثبات المخزون وعدد الطلبات |

**الفحوص**

- ✅ POST /api/products بلا كوكيز → 401
- ✅ PATCH /api/orders بلا كوكيز → 401
- ✅ GET /api/orders بلا كوكيز → 401
- ✅ code=AUTH_REQUIRED (لا كشف لبيانات الطلبات)
- ✅ كوكيز موقّع تزويرًا → 401 (HMAC مرفوض)
- ✅ DELETE /api/products بلا كوكيز → 401
- ✅ المخزون 49 → 49 (لم يتغير)
- ✅ عدد الطلبات 30 → 30

**ACTUAL (دليل خام)**

```json
{
  "post_products": 401,
  "patch_orders": 401,
  "list_orders": 401,
  "list_code": "AUTH_REQUIRED",
  "forged_cookie": 401,
  "delete_product": 401,
  "stock_before": 49,
  "stock_after": 49,
  "orders_before": 30,
  "orders_after": 30
}
```


### WF-018 — تنفيذ جزئي — صنفان يفشل ثانيهما، ثم تسابق على نفس المخزون

**✅ PASS** · 11/11 فحوص · 200ms

| الحقل | القيمة |
|---|---|
| INPUT | أ) items:[{p1,1},{p2,1}] والمخزون p2=0  ب) طلبان متزامنان qty=4 والمخزون 5 |
| PRECONDITION | أ) p1.stock=10, p2.stock=0   ب) p1.stock=5 |
| EXPECTED_DECISION | أ) الكل أو لا شيء — لا خصم جزئي  ب) طلب واحد فقط ينجح |
| EXPECTED_SIDE_EFFECT | أ) p1 يبقى 10 ولا طلب  ب) المخزون 1 لا −3، وطلب واحد فقط |
| EVIDENCE_REQUIRED | 409 + ثبات p1 + نتائج التزامن + أصناف يتيمة = 0 |

**الفحوص**

- ✅ أ) HTTP 409 (المتوقع 409)
- ✅ أ) code=CONFLICT
- ✅ أ) p1: 10 → 10 (لا خصم جزئي للصنف الناجح)
- ✅ أ) عدد الطلبات 30 → 30 (لا طلب)
- ✅ أ) أصناف يتيمة = 0
- ✅ ب) نتائج التزامن [200, 409] (المتوقع 200 و409 — رابح واحد)
- ✅ ب) عدد الطلبات الناجحة = 1
- ✅ ب) المخزون 5 → 1 (المتوقع 1 لا سالب)
- ✅ ب) طلبات DB 30 → 31 (+1 فقط)
- ✅ ب) صفوف بمخزون سالب = 0
- ✅ ب) أصناف يتيمة = 0

**ACTUAL (دليل خام)**

```json
{
  "a_http": 409,
  "a_code": "CONFLICT",
  "a_message": "الكمية المطلوبة من كلوركس مبيض ومطهر 4 لتر غير متاحة",
  "a_p1_before": 10,
  "a_p1_after": 10,
  "a_orders": [
    30,
    30
  ],
  "b_http": [
    200,
    409
  ],
  "b_codes": [
    null,
    "CONFLICT"
  ],
  "b_stock_before": 5,
  "b_stock_after": 1,
  "b_orders_created": [
    30,
    31
  ],
  "b_request_ids": [
    "req_0c8140bf-dec9-4f6f-a468-fb31828dbcc3",
    "req_25fe491d-eb51-4776-9115-966916e0ddce"
  ],
  "db": {
    "orders": 31,
    "order_items": 31,
    "orphan_order_items": 0,
    "negative_stock_rows": 0,
    "last_order": {
      "id": "ORD-83026799-a9f141f5",
      "total": 1000,
      "shipping_fee": 0,
      "items": "[{\"id\":\"p1\",\"name\":\"منظف أرضيات برائحة اللافندر 5 لتر\",\"price\":250,\"qty\":4}]"
    }
  }
}
```


### WF-012 — أحجام متعددة والعميل قال «هات الكبير»

**❌ FAIL** · 3/4 فحوص · 80ms

| الحقل | القيمة |
|---|---|
| INPUT | chat: «هات الكبير من منظف الأرضيات باللافندر» |
| PRECONDITION | صنفان بنفس الاسم يختلفان في الحجم: 1 لتر (60 ج) و5 لتر (180 ج) |
| EXPECTED_DECISION | INTENT: resolve «الكبير» → المتغير 5 لتر، لا الأصغر |
| EXPECTED_SIDE_EFFECT | الرد يسمّي العبوة 5 لتر تحديدًا |
| EVIDENCE_REQUIRED | نص الرد + هل ذكر 5 لتر + هل تجنّب الادعاء الخاطئ |

**الفحوص**

- ✅ chat HTTP 200
- ✅ precondition مؤكّد: العبوة الصغيرة هي الأولى في ترتيب الكتالوج
- ✅ الرد ذكر العبوة الكبيرة (5 لتر): true
- ❌ حسم «الكبير» لصالح 5 لتر رغم تصدر الصغيرة (ذكر 5 لتر=true، ذكر 1 لتر=true)

**ACTUAL (دليل خام)**

```json
{
  "http": 200,
  "source": "local",
  "reply": "أهلاً بيك 👋 دي المنتجات المناسبة لطلبك:\n• منظف أرضيات برائحة اللافندر 5 لتر — 180 جنيه\n• كلوركس مبيض ومطهر 4 لتر — 95 جنيه\n• منظف أرضيات برائحة اللافندر 1 لتر — 60 جنيه\n\nتقدر تضيفهم للسلة وتكمل الطلب، والدفع فودافون كاش على 01095032221 أو عند الاستلام.",
  "first_recommendation": "• منظف أرضيات برائحة اللافندر 5 لتر — 180 جنيه",
  "precondition_small_is_featured": true,
  "precondition_small_ranks_first_in_catalog": true,
  "mentions_5l": true,
  "mentions_1l": true,
  "resolved_size": "كلاهما (بلا حسم)"
}
```


### WF-013 — «هات أرخص منظف أرضيات متاح» — ترتيب بالسعر + فلتر توافر

**❌ FAIL** · 2/5 فحوص · 41ms

| الحقل | القيمة |
|---|---|
| INPUT | chat: «هات أرخص منظف أرضيات متاح» |
| PRECONDITION | أ) اقتصادي 30 ج مخزون 0 (الأرخص لكن نافد) ب) مركز 45 ج مخزون 10 ج) فاخر 180 ج مخزون 10 |
| EXPECTED_DECISION | DATA+POLICY: استبعاد النافد ثم أدنى سعر → (ب) 45 ج |
| EXPECTED_SIDE_EFFECT | الرد يرشّح 45 ج، ولا يرشّح 30 ج النافد |
| EVIDENCE_REQUIRED | نص الرد + الأسعار المذكورة + هل ذُكر النافد |

**الفحوص**

- ✅ chat HTTP 200
- ❌ لم يخطف سؤالُ المنتجات جوابٌ عن الدفع (FAQ hijack = true)
- ❌ رشّح الأرخص المتاح (45 ج): false
- ✅ لم يرشّح النافد (30 ج): true
- ❌ أدنى سعر مذكور = null (المتوقع 45)

**ACTUAL (دليل خام)**

```json
{
  "http": 200,
  "source": "local",
  "reply": "الدفع عن طريق فودافون كاش على رقم 01095032221، أو الدفع عند الاستلام داخل القاهرة والجيزة.",
  "prices_mentioned": [],
  "cheapest_mentioned": null,
  "recommends_expected_45": false,
  "recommends_out_of_stock_30": false,
  "faq_hijack": true,
  "mechanism": "localAnswer يفحص FAQ أولًا؛ «متاح» ⊂ «المتاحة» في سؤال طرق الدفع، فأجاب عن الدفع بدل المنتجات",
  "expected": "أرخص *متاح* = 45 ج (منظف أرضيات مركز 1 لتر)، واستبعاد 30 ج لأن مخزونه 0"
}
```


### WF-014 — منتجان متشابهان جدًا — هل يحسم أم يوضّح؟

**❌ FAIL** · 1/3 فحوص · 62ms

| الحقل | القيمة |
|---|---|
| INPUT | chat: «عايز منظف حمامات» |
| PRECONDITION | صنفان يتطابق اسمهما إلا في الرائحة: ليمون 72 ج ولافندر 74 ج |
| EXPECTED_DECISION | AMBIGUITY: عرض الاثنين أو طلب توضيح — لا حسم صامت |
| EXPECTED_SIDE_EFFECT | لا يُقدَّم صنف واحد على أنه المطلوب الوحيد |
| EVIDENCE_REQUIRED | نص الرد + هل ذُكر الصنفان + هل طُلب توضيح |

**الفحوص**

- ✅ chat HTTP 200
- ❌ ذكر أحد الصنفين المتشابهين (ليمون=false، لافندر=false)
- ❌ لم يحسم صامتًا: عرض الاثنين=false أو طلب توضيح=false

**ACTUAL (دليل خام)**

```json
{
  "http": 200,
  "source": "local",
  "reply": "أهلاً بيك 👋 دي المنتجات المناسبة لطلبك:\n• كلوركس مبيض ومطهر 4 لتر — 95 جنيه\n• منظف حمامات ومزيل جير 1 لتر — 75 جنيه\n• جل تسليك مواسير 1 لتر — 130 جنيه\n\nتقدر تضيفهم للسلة وتكمل الطلب، والدفع فودافون كاش على 01095032221 أو عند الاستلام.",
  "listed_recommendations": [
    "كلوركس مبيض ومطهر 4 لتر — 95 جنيه",
    "منظف حمامات ومزيل جير 1 لتر — 75 جنيه",
    "جل تسليك مواسير 1 لتر — 130 جنيه"
  ],
  "mentions_lemon": false,
  "mentions_lavender": false,
  "asks_clarification": false,
  "fixture_keyword_eligibility": {
    "wf14a": {
      "name": "منظف حمامات برائحة الليمون 1 لتر",
      "matched_words": [
        "منظف",
        "حمامات"
      ]
    },
    "wf14b": {
      "name": "منظف حمامات برائحة اللافندر 1 لتر",
      "matched_words": [
        "منظف",
        "حمامات"
      ]
    }
  },
  "behavior": "حسم صامت واستبعاد الصنفين المتشابهين",
  "mechanism": "localAnswer يرتب بالدرجة ثم يقطع عند 3؛ عند التعادل يفوز الأسبق في ترتيب الكتالوج (featured ثم rowid)، والصنفان المُدرجان أخيرًا فيُستبعدان رغم مطابقتهما"
}
```


### WF-015 — خدمة الذكاء الاصطناعي توقفت — فشل المزودين

**✅ PASS** · 5/5 فحوص · 53ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/chat على نسخة بمفاتيح موجودة لكن المزودين غير متاحين (:3002) |
| PRECONDITION | GEMINI_API_KEY و GROQ_API_KEY معيَّنان؛ الاتصال بهما يفشل |
| EXPECTED_DECISION | CHAIN FALLBACK: gemini ← groq ← local، بلا 5xx |
| EXPECTED_SIDE_EFFECT | رد مفيد من القاعدة، ولا تسريب مفتاح أو stack |
| EVIDENCE_REQUIRED | 200 + source=local + غياب المفاتيح و stack عن جسم الرد |

**الفحوص**

- ✅ HTTP 200 (لا 5xx رغم فشل المزودين)
- ✅ source=local (المتوقع local)
- ✅ رد مفيد رغم توقف الخدمة
- ✅ لا مفتاح API في جسم الرد
- ✅ لا stack trace للعميل

**ACTUAL (دليل خام)**

```json
{
  "http": 200,
  "code": null,
  "source": "local",
  "reply": "أهلاً بيك 👋 دي المنتجات المناسبة لطلبك:\n• منظف أرضيات برائحة اللافندر 5 لتر — 180 جنيه\n• كلوركس مبيض ومطهر 4 لتر — 95 جنيه\n• سائل غسيل أطباق ليمون 2 لتر — 70 جنيه\n\nتقدر تضيفهم للسلة وتكمل الطلب، والد",
  "request_id": "req_58de38a0-1dfb-4b61-b4bb-2f5fc4e7ba5e",
  "leaked_api_key": false,
  "leaked_stack": false,
  "provider_failure_mode": "fetch failed — انقطاع اتصال على مستوى TLS في بيئة الاختبار، لا رفض مفتاح؛ كلا المسارين يُنتجان نفس قرار التراجع"
}
```


### WF-019 — أمر غامض — «محتاج حاجة»

**✅ PASS** · 4/4 فحوص · 21ms

| الحقل | القيمة |
|---|---|
| INPUT | chat: «محتاج حاجة» |
| PRECONDITION | لا شيء |
| EXPECTED_DECISION | INTENT غامض → استيضاح أو عرض عام، لا اختراع منتج أو سعر |
| EXPECTED_SIDE_EFFECT | لا رقم طلب، لا التزام، لا سعر مختلَق |
| EVIDENCE_REQUIRED | نص الرد + ثبات عدد الطلبات |

**الفحوص**

- ✅ chat HTTP 200
- ✅ لم يختلق رقم طلب: true
- ✅ عدد الطلبات 31 → 31 (لا تنفيذ من محادثة)
- ✅ رد مفيد يستوضح أو يعرض خيارات

**ACTUAL (دليل خام)**

```json
{
  "http": 200,
  "source": "local",
  "reply": "أهلاً بحضرتك في روفيده 🧼\nأنا سيليا، تحت أمرك. عندنا منظفات أرضيات ومطابخ وحمامات ومعطرات وأدوات نظافة.\nقولّي محتاج إيه بالظبط وأرشحلك الأنسب، أو كلمنا واتساب على 01095032221.",
  "fabricates_order_id": false,
  "orders_before": 31,
  "orders_after": 31
}
```


### WF-020 — جلسة إدارة صالحة تُرفض — defect ترميز الكوكيز (اكتشاف المختبر)

**❌ FAIL** · 3/6 فحوص · 47ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/admin/login (كلمة مرور صحيحة) ← GET /api/admin/session و GET /api/orders بنفس الكوكيز |
| PRECONDITION | ADMIN_PASSWORD و ADMIN_SESSION_SECRET صحيحان |
| EXPECTED_DECISION | login 200 + جلسة مقبولة على كل المسارات الإدارية |
| EXPECTED_SIDE_EFFECT | authenticated:true وقراءة الطلبات 200 |
| EVIDENCE_REQUIRED | 200 على الدخول + authenticated + حالة المسارات الإدارية + قيمة الكوكيز على السلك |

**الفحوص**

- ✅ الدخول HTTP 200 (كلمة المرور مقبولة)
- ✅ كوكيز صدر فعلًا: 1790583027100%3ApYhAZrJz…
- ✅ GET /api/admin/session HTTP 200
- ❌ authenticated=false (المتوقع true — DEFECT: القيمة على السلك تحتوي %3A)
- ❌ GET /api/orders بجلسة صالحة HTTP 401 (المتوقع 200)
- ❌ POST /api/products بجلسة صالحة HTTP 401 (المتوقع 200)

**ACTUAL (دليل خام)**

```json
{
  "login_http": 200,
  "cookie_value_on_the_wire": "1790583027100%3ApYhAZrJzcRoMG5q7qfCT23coARR5nGdM.i9x6Y6xcZMVtB8OKo9ofci8-XsP4QeP2gaz1GRsW3NQ",
  "wire_contains_percent3A": true,
  "session_http": 200,
  "session_authenticated": false,
  "list_orders_http": 401,
  "list_orders_code": "AUTH_REQUIRED",
  "admin_write_http": 401,
  "admin_write_code": "AUTH_REQUIRED",
  "root_cause": "response.cookies.set() يرمّز ':' إلى '%3A'؛ verifyAdminSession تحسب HMAC فوق النص المُرمَّز وتفشل كذلك في Number(payload.split(':')[0])",
  "repro": "whatif/repro-auth-cookie.mjs → verify(خام)=true ، verify(على السلك)=false",
  "defect": true
}
```


---

## الاكتشافات

### D-1 · جلسة الإدارة لا تُقبل أبدًا كما تُرسل على السلك — ❌ FAIL

**أثر:** لوحة التحكم `/admin` ميتة بالكامل. الدخول ينجح، ثم كل مسار إداري يُرجع `401`.

**الدليل من الـ Runtime:**

| خطوة | نتيجة |
|---|---|
| `POST /api/admin/login` بكلمة مرور صحيحة | `200` + `Set-Cookie` |
| قيمة الكوكيز على السلك | `1790583027100%3ApYhAZrJzcRoMG5q7qfCT23coARR5nGdM.i9x6Y6xcZMVtB8OKo9ofci8-XsP4QeP2gaz1GRsW3NQ` |
| `GET /api/admin/session` بنفس الكوكيز | `authenticated=false` |
| `GET /api/orders` بنفس الكوكيز | `401` `AUTH_REQUIRED` |
| `POST /api/products` بنفس الكوكيز | `401` `AUTH_REQUIRED` |

**السبب الجذري:** `createAdminSession()` تُنتج حمولة على شكل `<ts>:<nonce>` بنقطتين خام. `response.cookies.set()` ترمّز القيمة، فتصير النقطتان `%3A` على السلك. و`verifyAdminSession()` تقرأ القيمة كما وصلت فتحسب HMAC فوق النص المُرمَّز — بينما التوقيع حُسب فوق الخام — فلا يتطابق. ولو تطابق، فإن `Number(payload.split(":",1)[0])` يُعيد `NaN` لأن الفاصل لم يعد `:`، فيسقط فحص العمر أيضًا.

**إعادة الإنتاج:** `node --import tsx whatif/repro-auth-cookie.mjs` →
`verifyAdminSession(خام)=true` و`verifyAdminSession(على السلك)=false`.

**لماذا لم تلتقطه الاختبارات؟** `tests/auth.test.ts` يغطي `adminConfigIssues`/`isAdminConfigured` فقط. لا يوجد أي اختبار يمرّر الجلسة عبر ترميز الكوكيز الفعلي — وهي الخطوة الوحيدة التي تكسر العقد. 133 اختبارًا أخضر مع لوحة تحكم ميتة.

**الإصلاح المقترح (لم يُنفَّذ — الحالة مجمّدة حسب الخطة):** وحّد الترميز في طرف واحد. إما `encodeURIComponent` صريح عند الإنشاء مع `decodeURIComponent` عند التحقق، أو تجنّب `:` في الحمولة (مثلاً `<ts>.<nonce>.<sig>`). الأهم: أضف اختبار round-trip يمر عبر `response.cookies.set()` فعلًا لا عبر نص خام.

### D-2 · لا يوجد idempotency key — الضغط المزدوج يُنشئ طلبين

`createOrderContract` لا يحمل أي مفتاح تفرد. في WF-010 أنتجت ضغطتان متطابقتان طلبين منفصلين (`ORD-83026425-ef3bab2d` و`ORD-83026443-44b687d6`) وخصمًا قدره 2 من المخزون. **لا يوجد فساد بيانات** — المخزون لم يتجاوز حدّه ولا سجلات يتيمة — لكن العميل قد يطلب مرتين دون قصد. القرار الحالي «كل ضغطة طلب مستقل» قرار مشروع، لكنه غير معلن ولا محمي.

### D-3 · ملاحظة CSP

`Content-Security-Policy` تعمل في وضع `Report-Only` (`CSP_ENFORCE !== "true"`). هي تراقب ولا تفرض. هذا مقصود في الكود، لكنه يعني أن أي انتهاك CSP حاليًا لا يُحجب فعليًا.

### D-4 · الرد الاحتياطي: سؤال عن المنتجات يُخطفه جواب عن الدفع — ❌ FAIL

**السيناريو:** WF-013 — «هات أرخص منظف أرضيات متاح».

**ما حدث فعلًا:** الرد كان `الدفع عن طريق فودافون كاش على رقم 01095032221، أو الدفع عند الاستلام داخل القاهرة والجيزة.` — أي جواب السؤال الشائع عن طرق الدفع، وليس ترشيح منتج واحد. لم يُذكر أي سعر (`prices_mentioned=[]`).

**السبب الجذري:** `localAnswer` تفحص الأسئلة الشائعة **قبل** المنتجات وتكتفي بمطابقة واحدة (`bestFaq.s >= 1`). وكلمة «متاح» الواردة في سؤال العميل هي substring داخل «المتاحة» في سؤال «ما هي طرق الدفع المتاحة؟»، فيكفي هذا التقاطع الجزئي لخطف السؤال كله.

**لماذا يهم:** المطابقة substring بلا حدود كلمة تعني أن أي استعلام يحتوي مقطعًا من سؤال شائع يتحوّل عن موضوعه. هذا ليس خطأ في البيانات بل في سياسة المطابقة.

### D-5 · الرد الاحتياطي: لا حسم للمقاس، وإسقاط صامت للأصناف المتساوية — ❌ FAIL

**السيناريوهان:** WF-012 («هات الكبير») وWF-014 («عايز منظف حمامات»).

**WF-012 — لا حسم للمقاس:** مع تثبيت precondition أن العبوة الصغيرة (1 لتر) هي الأولى في ترتيب الكتالوج، جاء الرد ليذكر **المقاسين معًا** (`mentions_5l=true`، `mentions_1l=true`). صفة «الكبير» لم تُترجم إلى أي تفضيل؛ المحرك يطابق أسماء ولا يفهم صفات.

**WF-014 — إسقاط صامت:** أُدرج صنفان متطابقان إلا في الرائحة (ليمون 72 ج، لافندر 74 ج)، وكلاهما طابق كلمتَي السؤال («منظف»، «حمامات») كما يوثّق `fixture_keyword_eligibility`. مع ذلك لم يظهر أيٌّ منهما؛ الرد أخرج:

- كلوركس مبيض ومطهر 4 لتر — 95 جنيه
- منظف حمامات ومزيل جير 1 لتر — 75 جنيه
- جل تسليك مواسير 1 لتر — 130 جنيه

**السبب الجذري:** `localAnswer` ترتّب بالدرجة ثم تقطع عند أول 3 (`.slice(0, 3)`). عند تساوي الدرجات يحسم ترتيب الكتالوج (`featured DESC, rowid ASC`)، والأصناف المُدرجة لاحقًا تُستبعد بصمت. لا طلب توضيح ولا إشارة إلى وجود بدائل.

**الأثر التجاري:** منتج جديد مضاف من لوحة التحكم قد لا يظهر في المحادثة إطلاقًا رغم مطابقته التامة للطلب، فقط لأنه أُدرج بعد ثلاثة أصناف أقدم بنفس الدرجة.

**نطاق هاتين النتيجتين:** كلاهما في `localAnswer` — مسار الرد الاحتياطي بلا مفاتيح API، وهو مسار يُعلنه README ميزةً («رد احتياطي ذكي بدون مفتاح»). بوجود مفاتيح Gemini/Groq يختلف السلوك، وهو ما لم يُقَس هنا لأن البيئة تحجب الاتصال الخارجي (انظر الملاحظة المنهجية 6).

---

## ملاحظات منهجية

1. **كل فعل قيد القياس مرّ عبر HTTP على Runtime حقيقي** — لا Mocks ولا استدعاء مباشر للدوال.
2. **ضبط الـ precondition تم كتابةً مباشرة في قاعدة البيانات** بدل `POST /api/products`، لأن D-1 يجعل أي كتابة إدارية تُرجع 401. هذا fixture للاختبار لا مسار قيد القياس، ومغطّى مستقلًا في WF-017/WF-020.
3. **كل سيناريو أخذ `x-forwarded-for` مستقلًا** لأن `bucketKey()` يشتق مفتاح تحديد المعدل منه، والحد `8/10min` على `/api/orders` كان سيعطي `429` ويخفي القرارات الحقيقية.
4. **ثلاث نسخ Runtime من نفس الكود، كل واحدة لظرف:**
   - `:3000` — الحالة الأساسية، قاعدة بيانات مربوطة.
   - `:3001` (`~/whatif-nodb`) — `TURSO_DATABASE_URL` فارغ، لـ WF-016.
   - `:3002` (`~/whatif-aifail`) — مفاتيح Gemini/Groq موجودة، لـ WF-015.
   المجلدات منفصلة لأن نسختَي dev في مجلد واحد تتصارعان على `.next`، ولأن Turbopack يرفض `node_modules` الرمزي («points out of the filesystem root») فنُسخت بالوصلات الصلبة.
5. **لم يُعدَّل أي كود تطبيق.** التغييرات الوحيدة: `next.config.mjs` (قراءة `ALLOWED_DEV_ORIGINS` من البيئة، ومعطّل افتراضيًا) ومجلد `whatif/` الجديد.
6. **حدود البيئة — ما لم يُقَس:** الاتصال الخارجي محجوب على مستوى TLS (`generativelanguage.googleapis.com` و`api.groq.com` يُرجعان `000` مع `SSL_ERROR_SYSCALL`). لذلك:
   - WF-015 قاس **انقطاع المزود** لا **رفض المفتاح**. كلاهما يُنتج نفس قرار التراجع في `chat/route.ts`، لكن «مفتاح منتهي/غير صالح» تحديدًا لم يُختبر.
   - مسار Gemini/Groq الحقيقي لم يُقَس إطلاقًا، ونتائج D-4/D-5 تخص `localAnswer` وحده.
7. **حالات FAIL الثلاث في الرد الاحتياطي (D-4/D-5) ليست أعطال Runtime** بل قصور قرار في محرك بلا مفاتيح. صُنّفت FAIL لأن المتوقع كان قرارًا صحيحًا، لا لأن الطلب سقط.

## إعادة التشغيل

```bash
# الخادم الرئيسي (مع DB)
npx next dev -H 0.0.0.0 -p 3000

# نسخة DB-down لـ WF-016
cd ~/whatif-nodb && npx next dev -H 0.0.0.0 -p 3001

# المصفوفة
node whatif/run-whatif.mjs && node whatif/make-report.mjs

# إعادة إنتاج D-1
node --import tsx whatif/repro-auth-cookie.mjs
```
