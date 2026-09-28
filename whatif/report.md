# What-If Test Matrix — متجر أبو رفيدة العزامي

> **مختبر قرار، لا اختبار «هل وقع الموقع».** كل سيناريو يُقاس عبر السلسلة:
> `INPUT → INTENT → DATA → POLICY → AUTHORIZATION → EXECUTION → EVIDENCE → OUTCOME`

| بند | قيمة |
|---|---|
| تاريخ التشغيل | `2026-09-28T09:15:08.295Z` |
| معرّف التشغيل | `run23` |
| الـ Runtime قيد القياس | `http://127.0.0.1:3000` (Next.js على `0.0.0.0:3000`) |
| نسخة DB-down | `http://127.0.0.1:3001` (نفس الكود، `TURSO_DATABASE_URL` فارغ) |
| قاعدة البيانات | `file:local.db` عبر `@libsql/client` — نفس مسار كود Turso |
| حالة خط الأساس | orders=`191` · order_items=`191` · orphans=`0` · negative_stock=`0` |
| الحالة النهائية | orders=`204` · order_items=`204` · orphans=`0` · negative_stock=`0` |

## الملخّص

| الحالة | العدد |
|---|---|
| ✅ PASS | 32 |
| **الإجمالي** | **32** |

**ثوابت سلامة لم تُكسر في أي سيناريو:** `orphan_order_items = 0` و`negative_stock_rows = 0`.

---

## المصفوفة


### WF-001 — المنتج موجود والمخزون يكفي — «عايز 20 عبوة من منظف الأرضيات باللافندر»

**✅ PASS** · 8/8 فحوص · 79ms

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
  "request_id": "req_c9aad6e7-0fbe-49e0-9f57-5344abacf7c5",
  "body": {
    "ok": true,
    "id": "ORD-86905251-fa904cea",
    "subtotal": 3600,
    "shipping": 0,
    "total": 3600
  },
  "stock_before": 50,
  "stock_after": 30,
  "db": {
    "orders": 192,
    "order_items": 192,
    "orphan_order_items": 0,
    "negative_stock_rows": 0,
    "last_order": {
      "id": "ORD-86905251-fa904cea",
      "total": 3600,
      "shipping_fee": 0,
      "items": "[{\"id\":\"p1\",\"name\":\"منظف أرضيات برائحة اللافندر 5 لتر\",\"price\":180,\"qty\":20}]"
    }
  }
}
```


### WF-002 — منتج غير موجود — بحث + محاولة شراء

**✅ PASS** · 7/7 فحوص · 35ms

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
- ✅ عدد الطلبات 192 → 192 (بلا تغيير)
- ✅ أصناف يتيمة = 0

**ACTUAL (دليل خام)**

```json
{
  "chat_http": 200,
  "chat_source": "local",
  "chat_reply": "أهلاً بيك 👋 دي المنتجات المناسبة لطلبك:\n• منظف زجاج ومرايا 1 لتر — 55 جنيه\n• سائل غسيل أطباق ليمون 2 لتر — 70 جنيه\n• منظف حمامات ومزيل جير 1 لتر — 75 جنيه\n• مز",
  "http": 409,
  "code": "CONFLICT",
  "request_id": "req_6738c087-9b05-43cb-8488-9b44e8cdd7ed",
  "body": {
    "error": "أحد المنتجات لم يعد متاحًا",
    "code": "CONFLICT",
    "request_id": "req_6738c087-9b05-43cb-8488-9b44e8cdd7ed"
  },
  "orders_before": 192,
  "orders_after": 192
}
```


### WF-003 — الكمية أكبر من المخزون — طلب 20 والمتاح 7

**✅ PASS** · 6/6 فحوص · 170ms

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
- ✅ عدد الطلبات 192 → 192 (لم يُنشأ طلب)

**ACTUAL (دليل خام)**

```json
{
  "http": 409,
  "code": "CONFLICT",
  "message": "الكمية المطلوبة من منظف أرضيات برائحة اللافندر 5 لتر غير متاحة",
  "request_id": "req_4cecb134-a831-4ad9-9a3d-29f3530e22d4",
  "stock_before": 7,
  "stock_after": 7,
  "orders_before": 192,
  "orders_after": 192
}
```


### WF-004 — المخزون صفر — AVAILABILITY = FALSE

**✅ PASS** · 6/6 فحوص · 66ms

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
- ✅ عدد الطلبات 192 → 192
- ✅ صفوف بمخزون سالب = 0

**ACTUAL (دليل خام)**

```json
{
  "http": 409,
  "code": "CONFLICT",
  "message": "الكمية المطلوبة من منظف أرضيات برائحة اللافندر 5 لتر غير متاحة",
  "request_id": "req_59ef4b16-4f99-4a4a-b9ea-d3512c9ebb7e",
  "stock_before": 0,
  "stock_after": 0,
  "orders_after": 192
}
```


### WF-005 — حمولة غير صحيحة — مفتاح غير معروف + سلة فارغة

**✅ PASS** · 8/8 فحوص · 32ms

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
- ✅ request_id=req_1d7e33c8-7fb5-4762-8624-a0a33bce2446
- ✅ orders HTTP 422 (المتوقع 422)
- ✅ orders code=VALIDATION_FAILED
- ✅ رسالة عربية مفهومة: items: السلة فارغة
- ✅ عدد الطلبات 192 → 192 (بلا تغيير)

**ACTUAL (دليل خام)**

```json
{
  "chat_http": 422,
  "chat_code": "VALIDATION_FAILED",
  "chat_error": "Unrecognized key(s) in object: 'message'",
  "chat_request_id": "req_1d7e33c8-7fb5-4762-8624-a0a33bce2446",
  "order_http": 422,
  "order_code": "VALIDATION_FAILED",
  "order_error": "items: السلة فارغة",
  "order_request_id": "req_98d472b8-4cf2-48f7-9360-682eb1d24f80",
  "orders_before": 192,
  "orders_after": 192
}
```


### WF-010 — الضغط على «إرسال الطلب» مرتين — double submit

**✅ PASS** · 5/5 فحوص · 82ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/orders مرتين بنفس الحمولة ونفس هوية العميل |
| PRECONDITION | p1: stock=10 |
| EXPECTED_DECISION | لكل طلب قرار مستقل — لا مفتاح idempotency في العقد |
| EXPECTED_SIDE_EFFECT | طلبان منفصلان، المخزون 10→8، بلا تجاوز للمخزون |
| EVIDENCE_REQUIRED | رقما طلبين مختلفين + المخزون بعد + عدم وجود سجلات يتيمة |

**الفحوص**

- ✅ HTTP 200 / 200
- ✅ رقما الطلبين مختلفان: ORD-86905623-53976efc , ORD-86905639-614bdc29
- ✅ المخزون 10 → 8 (خصم 2 — طلب واحد لكل ضغطة)
- ✅ صفوف بمخزون سالب = 0
- ✅ أصناف يتيمة = 0

**ACTUAL (دليل خام)**

```json
{
  "http_1": 200,
  "http_2": 200,
  "id_1": "ORD-86905623-53976efc",
  "id_2": "ORD-86905639-614bdc29",
  "request_id_1": "req_97aa2dd8-42e4-48b0-857f-48ba846f2af4",
  "request_id_2": "req_9c9bee00-8cc3-4290-90cd-a12e929345bb",
  "stock_before": 10,
  "stock_after": 8,
  "db": {
    "orders": 194,
    "order_items": 194,
    "orphan_order_items": 0,
    "negative_stock_rows": 0,
    "last_order": {
      "id": "ORD-86905639-614bdc29",
      "total": 230,
      "shipping_fee": 50,
      "items": "[{\"id\":\"p1\",\"name\":\"منظف أرضيات برائحة اللافندر 5 لتر\",\"price\":180,\"qty\":1}]"
    }
  },
  "finding": "لا يوجد idempotency key في createOrderContract — التكرار يُنشئ طلبين"
}
```


### WF-011 — السعر تغيّر بين العرض وتأكيد الطلب + محاولة تزوير السعر

**✅ PASS** · 9/9 فحوص · 115ms

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
  "request_id": "req_25a81953-3f6a-40b5-b157-c65615b0b3fc"
}
```


### WF-016 — قاعدة البيانات غير متاحة أثناء إنشاء الطلب

**✅ PASS** · 7/7 فحوص · 23ms

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
- ✅ request_id=req_aa2458db-6152-490e-9437-e72696035f0d للربط بالسجلات
- ✅ قراءة المنتجات HTTP 200 (تدهور آمن)
- ✅ طلبات DB الحقيقية 195 → 195 (لم يُكتب شيء)

**ACTUAL (دليل خام)**

```json
{
  "http": 503,
  "code": "SERVICE_UNAVAILABLE",
  "message": "قاعدة البيانات غير مربوطة",
  "request_id": "req_aa2458db-6152-490e-9437-e72696035f0d",
  "read_http": 200,
  "read_products": 12,
  "real_db_orders_before": 195,
  "real_db_orders_after": 195
}
```


### WF-017 — مستخدم عادي يحاول تنفيذ إجراء إداري

**✅ PASS** · 8/8 فحوص · 63ms

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
- ✅ عدد الطلبات 195 → 195

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
  "orders_before": 195,
  "orders_after": 195
}
```


### WF-018 — تنفيذ جزئي — صنفان يفشل ثانيهما، ثم تسابق على نفس المخزون

**✅ PASS** · 11/11 فحوص · 248ms

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
- ✅ أ) عدد الطلبات 195 → 195 (لا طلب)
- ✅ أ) أصناف يتيمة = 0
- ✅ ب) نتائج التزامن [200, 409] (المتوقع 200 و409 — رابح واحد)
- ✅ ب) عدد الطلبات الناجحة = 1
- ✅ ب) المخزون 5 → 1 (المتوقع 1 لا سالب)
- ✅ ب) طلبات DB 195 → 196 (+1 فقط)
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
    195,
    195
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
    195,
    196
  ],
  "b_request_ids": [
    "req_14d906a4-f3bb-49f7-a9f9-d5b874fc02d2",
    "req_a0d5d216-f41e-4b04-a32d-08d458bbadbf"
  ],
  "db": {
    "orders": 196,
    "order_items": 196,
    "orphan_order_items": 0,
    "negative_stock_rows": 0,
    "last_order": {
      "id": "ORD-86906082-8b5a932f",
      "total": 1000,
      "shipping_fee": 0,
      "items": "[{\"id\":\"p1\",\"name\":\"منظف أرضيات برائحة اللافندر 5 لتر\",\"price\":250,\"qty\":4}]"
    }
  }
}
```


### WF-012 — أحجام متعددة والعميل قال «هات الكبير»

**✅ PASS** · 4/4 فحوص · 267ms

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
- ✅ حسم «الكبير» لصالح 5 لتر رغم تصدر الصغيرة (ذكر 5 لتر=true، ذكر 1 لتر=false)

**ACTUAL (دليل خام)**

```json
{
  "http": 200,
  "source": "local",
  "reply": "أهلاً بيك 👋 دي المنتجات المناسبة لطلبك:\n• منظف أرضيات برائحة اللافندر 5 لتر — 180 جنيه\n\nتقدر تضيفهم للسلة وتكمل الطلب، والدفع فودافون كاش على 01095032221 أو عند الاستلام.",
  "first_recommendation": "• منظف أرضيات برائحة اللافندر 5 لتر — 180 جنيه",
  "precondition_small_is_featured": true,
  "precondition_small_ranks_first_in_catalog": true,
  "mentions_5l": true,
  "mentions_1l": false,
  "resolved_size": "5 لتر"
}
```


### WF-013 — «هات أرخص منظف أرضيات متاح» — ترتيب بالسعر + فلتر توافر

**✅ PASS** · 5/5 فحوص · 151ms

| الحقل | القيمة |
|---|---|
| INPUT | chat: «هات أرخص منظف أرضيات متاح» |
| PRECONDITION | أ) اقتصادي 30 ج مخزون 0 (الأرخص لكن نافد) ب) مركز 45 ج مخزون 10 ج) فاخر 180 ج مخزون 10 |
| EXPECTED_DECISION | DATA+POLICY: استبعاد النافد ثم أدنى سعر → (ب) 45 ج |
| EXPECTED_SIDE_EFFECT | الرد يرشّح 45 ج، ولا يرشّح 30 ج النافد |
| EVIDENCE_REQUIRED | نص الرد + الأسعار المذكورة + هل ذُكر النافد |

**الفحوص**

- ✅ chat HTTP 200
- ✅ لم يخطف سؤالُ المنتجات جوابٌ عن الدفع (FAQ hijack = false)
- ✅ رشّح الأرخص المتاح (45 ج): true
- ✅ لم يرشّح النافد (30 ج): true
- ✅ أدنى سعر مذكور = 45 (المتوقع 45)

**ACTUAL (دليل خام)**

```json
{
  "http": 200,
  "source": "local",
  "reply": "أهلاً بيك 👋 دي المنتجات المناسبة لطلبك:\n• منظف أرضيات مركز 1 لتر — 45 جنيه\n• منظف أرضيات برائحة اللافندر 5 لتر — 180 جنيه\n• منظف زجاج ومرايا 1 لتر — 55 جنيه\n• سائل غسيل أطباق ليمون 2 لتر — 70 جنيه\n• منظف حمامات ومزيل جير 1 لتر — 75 جنيه\n\nوفيه كمان 3 صنف تاني مطابق — قولّي تحب أنهي نوع بالظبط وأضيّقلك الاختيار.\n\nتقدر تضيفهم للسلة وتكمل الطلب، والدفع فودافون كاش على 01095032221 أو عند الاستلام.",
  "prices_mentioned": [
    45,
    180,
    55,
    70,
    75
  ],
  "cheapest_mentioned": 45,
  "recommends_expected_45": true,
  "recommends_out_of_stock_30": false,
  "faq_hijack": false,
  "mechanism": null,
  "expected": "أرخص *متاح* = 45 ج (منظف أرضيات مركز 1 لتر)، واستبعاد 30 ج لأن مخزونه 0"
}
```


### WF-014 — منتجان متشابهان جدًا — هل يحسم أم يوضّح؟

**✅ PASS** · 3/3 فحوص · 111ms

| الحقل | القيمة |
|---|---|
| INPUT | chat: «عايز منظف حمامات» |
| PRECONDITION | صنفان يتطابق اسمهما إلا في الرائحة: ليمون 72 ج ولافندر 74 ج |
| EXPECTED_DECISION | AMBIGUITY: عرض الاثنين أو طلب توضيح — لا حسم صامت |
| EXPECTED_SIDE_EFFECT | لا يُقدَّم صنف واحد على أنه المطلوب الوحيد |
| EVIDENCE_REQUIRED | نص الرد + هل ذُكر الصنفان + هل طُلب توضيح |

**الفحوص**

- ✅ chat HTTP 200
- ✅ ذكر أحد الصنفين المتشابهين (ليمون=true، لافندر=true)
- ✅ لم يحسم صامتًا: عرض الاثنين=true أو طلب توضيح=true

**ACTUAL (دليل خام)**

```json
{
  "http": 200,
  "source": "local",
  "reply": "أهلاً بيك 👋 دي المنتجات المناسبة لطلبك:\n• منظف حمامات برائحة الليمون 1 لتر — 72 جنيه\n• منظف حمامات برائحة اللافندر 1 لتر — 74 جنيه\n• منظف حمامات ومزيل جير 1 لتر — 75 جنيه\n• جل تسليك مواسير 1 لتر — 130 جنيه\n• منظف زجاج ومرايا 1 لتر — 55 جنيه\n\nوفيه كمان 3 صنف تاني مطابق — قولّي تحب أنهي نوع بالظبط وأضيّقلك الاختيار.\n\nتقدر تضيفهم للسلة وتكمل الطلب، والدفع فودافون كاش على 01095032221 أو عند الاستلام.",
  "listed_recommendations": [
    "منظف حمامات برائحة الليمون 1 لتر — 72 جنيه",
    "منظف حمامات برائحة اللافندر 1 لتر — 74 جنيه",
    "منظف حمامات ومزيل جير 1 لتر — 75 جنيه",
    "جل تسليك مواسير 1 لتر — 130 جنيه",
    "منظف زجاج ومرايا 1 لتر — 55 جنيه"
  ],
  "mentions_lemon": true,
  "mentions_lavender": true,
  "asks_clarification": true,
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
  "behavior": "عرض الخيارين",
  "mechanism": "localAnswer يرتب بالدرجة ثم يقطع عند 3؛ عند التعادل يفوز الأسبق في ترتيب الكتالوج (featured ثم rowid)، والصنفان المُدرجان أخيرًا فيُستبعدان رغم مطابقتهما"
}
```


### WF-015 — خدمة الذكاء الاصطناعي توقفت — فشل المزودين

**✅ PASS** · 5/5 فحوص · 43ms

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
  "request_id": "req_6dfd2d39-d24b-4f48-a73b-1aff2e33b965",
  "leaked_api_key": false,
  "leaked_stack": false,
  "provider_failure_mode": "fetch failed — انقطاع اتصال على مستوى TLS في بيئة الاختبار، لا رفض مفتاح؛ كلا المسارين يُنتجان نفس قرار التراجع"
}
```


### WF-019 — أمر غامض — «محتاج حاجة»

**✅ PASS** · 4/4 فحوص · 19ms

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
- ✅ عدد الطلبات 196 → 196 (لا تنفيذ من محادثة)
- ✅ رد مفيد يستوضح أو يعرض خيارات

**ACTUAL (دليل خام)**

```json
{
  "http": 200,
  "source": "local",
  "reply": "أهلاً بحضرتك في روفيده 🧼\nأنا سيليا، تحت أمرك. عندنا منظفات أرضيات ومطابخ وحمامات ومعطرات وأدوات نظافة.\nقولّي محتاج إيه بالظبط وأرشحلك الأنسب، أو كلمنا واتساب على 01095032221.",
  "fabricates_order_id": false,
  "orders_before": 196,
  "orders_after": 196
}
```


### WF-020 — جلسة إدارة صالحة تُقبل على كل المسارات الإدارية (انحدار D-1)

**✅ PASS** · 6/6 فحوص · 51ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/admin/login (كلمة مرور صحيحة) ← GET /api/admin/session و GET /api/orders بنفس الكوكيز |
| PRECONDITION | ADMIN_PASSWORD و ADMIN_SESSION_SECRET صحيحان |
| EXPECTED_DECISION | login 200 + جلسة مقبولة على كل المسارات الإدارية |
| EXPECTED_SIDE_EFFECT | authenticated:true وقراءة الطلبات 200 |
| EVIDENCE_REQUIRED | 200 على الدخول + authenticated + حالة المسارات الإدارية + قيمة الكوكيز على السلك |

**الفحوص**

- ✅ الدخول HTTP 200 (كلمة المرور مقبولة)
- ✅ كوكيز صدر فعلًا: 1790586906714-vd9T7gT0nW…
- ✅ GET /api/admin/session HTTP 200
- ✅ authenticated=true (المتوقع true — DEFECT: القيمة على السلك تحتوي %3A)
- ✅ GET /api/orders بجلسة صالحة HTTP 200 (المتوقع 200)
- ✅ POST /api/products بجلسة صالحة HTTP 200 (المتوقع 200)

**ACTUAL (دليل خام)**

```json
{
  "login_http": 200,
  "cookie_value_on_the_wire": "1790586906714-vd9T7gT0nW-URZCZK9F1iPccEhb4rc0c.6aizPVENRaebbiTnNWHH0xnfTXE9gl3DwBwDUBh59AI",
  "wire_contains_percent3A": false,
  "session_http": 200,
  "session_authenticated": true,
  "list_orders_http": 200,
  "admin_write_http": 200,
  "root_cause": "response.cookies.set() يرمّز ':' إلى '%3A'؛ verifyAdminSession تحسب HMAC فوق النص المُرمَّز وتفشل كذلك في Number(payload.split(':')[0])",
  "repro": "whatif/repro-auth-cookie.mjs → verify(خام)=true ، verify(على السلك)=false",
  "defect": true
}
```


### WF-021 — تتبّع الطلب بعاملين صحيحين — العلم مفعّل

**✅ PASS** · 7/7 فحوص · 42ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/orders/track {id, phoneLast4} على نسخة ENABLE_ORDER_TRACKING=true |
| PRECONDITION | طلب قائم بهاتف 01012345678؛ آخر 4 = 5678 |
| EXPECTED_DECISION | AUTHORIZATION بعاملين → كشف الحالة |
| EXPECTED_SIDE_EFFECT | 200 + حالة + أصناف مختصرة، بلا هاتف كامل ولا عنوان ولا أسعار |
| EVIDENCE_REQUIRED | 200 + محتوى الرد + غياب الهاتف/العنوان/السعر |

**الفحوص**

- ✅ أنشئ طلب للتتبّع: ORD-86906769-7d88d028
- ✅ HTTP 200 (المتوقع 200)
- ✅ ok=true
- ✅ الحالة المُعادة = جديد
- ✅ أصناف مختصرة = [{"name":"سائل غسيل أطباق ليمون 2 لتر","qty":1}]
- ✅ لا هاتف كامل في الرد
- ✅ لا عنوان في الرد

**ACTUAL (دليل خام)**

```json
{
  "order_id": "ORD-86906769-7d88d028",
  "http": 200,
  "body": {
    "ok": true,
    "id": "ORD-86906769-7d88d028",
    "status": "جديد",
    "items": [
      {
        "name": "سائل غسيل أطباق ليمون 2 لتر",
        "qty": 1
      }
    ],
    "created_at": "2026-09-28 09:15:06"
  },
  "request_id": "req_e158168b-e98a-4c57-9b99-dff43e2e3008",
  "leaks_full_phone": false,
  "leaks_address": false,
  "leaks_price": false
}
```


### WF-022 — تتبّع بآخر 4 أرقام خاطئة — منع تعداد الطلبات

**✅ PASS** · 5/5 فحوص · 56ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/orders/track بنفس رقم الطلب مع phoneLast4=0000 |
| PRECONDITION | نفس طلب WF-021 |
| EXPECTED_DECISION | عدم تطابق → 404 برسالة موحّدة لا تكشف وجود الطلب |
| EXPECTED_SIDE_EFFECT | تسجيل محاولة فاشلة في سجل التدقيق، بلا تسريب |
| EVIDENCE_REQUIRED | 404 + تطابق الرسالة حرفيًا مع حالة «الرقم غير الموجود أصلًا» + صف تدقيق |

**الفحوص**

- ✅ آخر 4 خاطئة → HTTP 404 (المتوقع 404)
- ✅ code=NOT_FOUND
- ✅ رقم طلب غير موجود أصلًا → HTTP 404
- ✅ الرسالتان متطابقتان حرفيًا («تعذر العثور على الطلب») — لا تمييز يكشف وجود الطلب
- ✅ سُجّلت محاولة فاشلة في التدقيق: 27 → 29

**ACTUAL (دليل خام)**

```json
{
  "order_id": "ORD-86906810-64595413",
  "wrong_last4_http": 404,
  "wrong_last4_error": "تعذر العثور على الطلب",
  "wrong_last4_code": "NOT_FOUND",
  "ghost_id_http": 404,
  "ghost_id_error": "تعذر العثور على الطلب",
  "messages_identical": true,
  "audit_track_failed": [
    27,
    29
  ]
}
```


### WF-023 — علم التتبّع مغلق — النقطة لا تكشف وجودها

**✅ PASS** · 3/3 فحوص · 15ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/orders/track على النسخة الأساسية (ENABLE_ORDER_TRACKING غير مفعّل) |
| PRECONDITION | العلم مغلق افتراضيًا على :3000 |
| EXPECTED_DECISION | 404 موحّد قبل أي فحص لبيانات |
| EXPECTED_SIDE_EFFECT | لا كشف لوجود الميزة، ولا فرق بين طلب موجود وغير موجود |
| EVIDENCE_REQUIRED | 404 + تطابق الرسالة مع النسخة المفعّلة الفاشلة |

**الفحوص**

- ✅ HTTP 404 (المتوقع 404 لا 403/404 مميزة)
- ✅ code=NOT_FOUND (لا FEATURE_DISABLED كاشف)
- ✅ الرسالة مطابقة لحالة الفشل العادية: «تعذر العثور على الطلب»

**ACTUAL (دليل خام)**

```json
{
  "http": 404,
  "code": "NOT_FOUND",
  "error": "تعذر العثور على الطلب",
  "request_id": "req_7ab138fa-fc15-4432-b6a7-9125fe856cf2",
  "identical_to_enabled_failure": true
}
```


### WF-024 — تجاوز حد المعدل على إنشاء الطلبات — 429 بعد 8 محاولات

**✅ PASS** · 5/5 فحوص · 245ms

| الحقل | القيمة |
|---|---|
| INPUT | 9 طلبات POST /api/orders متتالية من نفس هوية العميل |
| PRECONDITION | الحد 8 / 10 دقائق لكل (مسار، عميل) |
| EXPECTED_DECISION | الثامن يمر، التاسع 429 RATE_LIMITED مع retry_after_seconds |
| EXPECTED_SIDE_EFFECT | لا طلب تاسع، والمخزون لا يُخصم مرة إضافية |
| EVIDENCE_REQUIRED | تسلسل الحالات + 429 + retry_after_seconds + ثبات المخزون |

**الفحوص**

- ✅ عدد المقبول = 8 (المتوقع 8 = الحد)
- ✅ التاسع → HTTP 429 (المتوقع 429)
- ✅ code=RATE_LIMITED
- ✅ retry_after_seconds=600 (يوجّه العميل لإعادة المحاولة)
- ✅ المخزون خُصم 8 فقط: 100 → 92

**ACTUAL (دليل خام)**

```json
{
  "statuses": [
    200,
    200,
    200,
    200,
    200,
    200,
    200,
    200,
    429
  ],
  "accepted_count": 8,
  "ninth_http": 429,
  "ninth_code": "RATE_LIMITED",
  "retry_after_seconds": 600,
  "stock_before": 100,
  "stock_after": 92,
  "stock_delta": 8
}
```


### WF-025 — نقطتان محجوبتان بعلم ميزة — التشخيص وأدوات MCP

**✅ PASS** · 5/5 فحوص · 37ms

| الحقل | القيمة |
|---|---|
| INPUT | GET /api/admin/diagnostics و GET /api/admin/mcp/tools |
| PRECONDITION | DIAGNOSTICS_ENABLED=false و ENABLE_MCP_TOOLS غير مفعّل |
| EXPECTED_DECISION | 404 موحّد لا يكشف وجود النقطتين، حتى بجلسة/مفتاح |
| EXPECTED_SIDE_EFFECT | لا مقاييس ولا مانيفست أدوات |
| EVIDENCE_REQUIRED | 404 على المسارين + تطابق الرسالة + عدم تسريب أسماء أدوات |

**الفحوص**

- ✅ التشخيص → HTTP 404 (المتوقع 404 لا 401/403)
- ✅ التشخيص بمفتاح مُخمَّن → HTTP 404
- ✅ أدوات MCP → HTTP 404
- ✅ رسالتان موحّدتان («هذه النقطة غير متاحة») — لا تمييز بين نقطتين
- ✅ لا أسماء أدوات مسرّبة

**ACTUAL (دليل خام)**

```json
{
  "diagnostics_http": 404,
  "diagnostics_code": "NOT_FOUND",
  "diagnostics_error": "هذه النقطة غير متاحة",
  "diagnostics_with_key_http": 404,
  "mcp_http": 404,
  "mcp_code": "NOT_FOUND",
  "mcp_error": "هذه النقطة غير متاحة",
  "messages_identical": true,
  "leaks_tool_names": false
}
```


### WF-006 — جسم أكبر من الحد المسموح

**✅ PASS** · 4/4 فحوص · 15ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/orders بحقل note حجمه ~40KB (الحد 32_000 بايت) |
| PRECONDITION | MAX_BODY_BYTES = 32_000 على /api/orders |
| EXPECTED_DECISION | PAYLOAD_TOO_LARGE قبل أي تحليل أو تحقق |
| EXPECTED_SIDE_EFFECT | 413، لا طلب، لا كتابة |
| EVIDENCE_REQUIRED | 413 + code + request_id + ثبات عدد الطلبات |

**الفحوص**

- ✅ HTTP 413 (المتوقع 413)
- ✅ code=PAYLOAD_TOO_LARGE
- ✅ request_id=req_e17142ab-1df5-4e15-8578-7e7d522f1c17
- ✅ عدد الطلبات 204 → 204 (بلا تغيير)

**ACTUAL (دليل خام)**

```json
{
  "http": 413,
  "code": "PAYLOAD_TOO_LARGE",
  "error": "حجم الطلب كبير جدًا",
  "request_id": "req_e17142ab-1df5-4e15-8578-7e7d522f1c17",
  "orders_before": 204,
  "orders_after": 204
}
```


### WF-007 — جسم ليس JSON صالحًا

**✅ PASS** · 4/4 فحوص · 15ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/orders بنص مشوَّه: '{"customer": '  |
| PRECONDITION | لا شيء |
| EXPECTED_DECISION | VALIDATION_FAILED — لا يُسرَّب خطأ المحلّل الداخلي |
| EXPECTED_SIDE_EFFECT | 422 برسالة عربية آمنة، لا stack ولا SyntaxError |
| EVIDENCE_REQUIRED | 422 + code + غياب SyntaxError/stack عن الرد |

**الفحوص**

- ✅ HTTP 422 (المتوقع 422)
- ✅ code=VALIDATION_FAILED
- ✅ رسالة عربية آمنة: «جسم الطلب ليس JSON صالحًا»
- ✅ لا خطأ محلّل داخلي ولا stack في الرد

**ACTUAL (دليل خام)**

```json
{
  "http": 422,
  "code": "VALIDATION_FAILED",
  "error": "جسم الطلب ليس JSON صالحًا",
  "request_id": "req_af1bfe8a-44e4-48c6-9304-bba285fbfac9",
  "leaks_parser_internals": false,
  "body_excerpt": "{\"error\":\"جسم الطلب ليس JSON صالحًا\",\"code\":\"VALIDATION_FAILED\",\"request_id\":\"req_af1bfe8a-44e4-48c6-9304-bba285fbfac9\"}"
}
```


### WF-008 — تجاوز حدود أطوال الحقول

**✅ PASS** · 7/7 فحوص · 72ms

| الحقل | القيمة |
|---|---|
| INPUT | customer بطول 121، address بطول 501، note بطول 501 (الحدود 120/500/500) |
| PRECONDITION | عقود trimmed(min,max) في contracts.ts |
| EXPECTED_DECISION | 422 لكل حقل متجاوز، برسالة تسمّي الحد |
| EXPECTED_SIDE_EFFECT | لا طلب |
| EVIDENCE_REQUIRED | 422 + رسائل تسمّي الحقول + ثبات عدد الطلبات |

**الفحوص**

- ✅ customer → HTTP 422 (المتوقع 422) — «customer: الطول الأقصى 120 حرفًا»
- ✅ address → HTTP 422 (المتوقع 422) — «address: الطول الأقصى 500 حرفًا»
- ✅ note → HTTP 422 (المتوقع 422) — «note: الطول الأقصى 500 حرفًا»
- ✅ customer_short → HTTP 422 (المتوقع 422) — «customer: الطول الأدنى 2 أحرف»
- ✅ رسالة customer تسمّي الحد 120: «customer: الطول الأقصى 120 حرفًا»
- ✅ رسالة address تسمّي الحد 500: «address: الطول الأقصى 500 حرفًا»
- ✅ عدد الطلبات 204 → 204 (بلا تغيير)

**ACTUAL (دليل خام)**

```json
{
  "cases": {
    "customer": {
      "http": 422,
      "code": "VALIDATION_FAILED",
      "error": "customer: الطول الأقصى 120 حرفًا"
    },
    "address": {
      "http": 422,
      "code": "VALIDATION_FAILED",
      "error": "address: الطول الأقصى 500 حرفًا"
    },
    "note": {
      "http": 422,
      "code": "VALIDATION_FAILED",
      "error": "note: الطول الأقصى 500 حرفًا"
    },
    "customer_short": {
      "http": 422,
      "code": "VALIDATION_FAILED",
      "error": "customer: الطول الأدنى 2 أحرف"
    }
  },
  "orders_before": 204,
  "orders_after": 204
}
```


### WF-009 — هاتف غير صالح ومحافظة خارج القائمة

**✅ PASS** · 6/6 فحوص · 79ms

| الحقل | القيمة |
|---|---|
| INPUT | phone='abcdef 12345' ثم governorate='أطلنطس' |
| PRECONDITION | regex /^[0-9+\s()-]{8,30}$/ وقائمة GOVERNORATES |
| EXPECTED_DECISION | 422 في الحالتين — لا يُنشأ طلب بعنوان غير قابل للتوصيل |
| EXPECTED_SIDE_EFFECT | لا طلب، لا خصم مخزون |
| EVIDENCE_REQUIRED | 422 + رسائل محددة + ثبات المخزون وعدد الطلبات |

**الفحوص**

- ✅ هاتف غير صالح → HTTP 422 (المتوقع 422)
- ✅ رسالة تسمّي الهاتف: «phone: رقم هاتف غير صالح»
- ✅ محافظة خارج القائمة → HTTP 422
- ✅ رسالة تسمّي المحافظة: «اختر المحافظة من القائمة»
- ✅ المخزون 50 → 50 (لم يُخصم)
- ✅ عدد الطلبات 204 → 204

**ACTUAL (دليل خام)**

```json
{
  "bad_phone": {
    "http": 422,
    "code": "VALIDATION_FAILED",
    "error": "phone: رقم هاتف غير صالح"
  },
  "bad_governorate": {
    "http": 422,
    "code": "VALIDATION_FAILED",
    "error": "اختر المحافظة من القائمة"
  },
  "stock_before": 50,
  "stock_after": 50,
  "orders_before": 204,
  "orders_after": 204
}
```


### WF-026 — رؤوس الأمان مطبّقة على كل الاستجابات

**✅ PASS** · 4/4 فحوص · 87ms

| الحقل | القيمة |
|---|---|
| INPUT | GET / و /api/products و /api/orders (401) و POST /api/chat |
| PRECONDITION | middleware + buildSecurityHeaders |
| EXPECTED_DECISION | رؤوس موحّدة على النجاح والخطأ معًا |
| EXPECTED_SIDE_EFFECT | لا استجابة عارية من الرؤوس |
| EVIDENCE_REQUIRED |  presence الرؤوس الثمانية على المسارات الأربعة |

**الفحوص**

- ✅ GET / (200) — ناقص: لا شيء، CSP: true
- ✅ GET /api/products (200) — ناقص: لا شيء، CSP: true
- ✅ GET /api/orders (401) — ناقص: لا شيء، CSP: true
- ✅ POST /api/chat (200) — ناقص: لا شيء، CSP: true

**ACTUAL (دليل خام)**

```json
{
  "GET /": {
    "status": 200,
    "missing": [],
    "csp_present": true
  },
  "GET /api/products": {
    "status": 200,
    "missing": [],
    "csp_present": true
  },
  "GET /api/orders": {
    "status": 401,
    "missing": [],
    "csp_present": true
  },
  "POST /api/chat": {
    "status": 200,
    "missing": [],
    "csp_present": true
  }
}
```


### WF-027 — حد المعدل على الدردشة — 30 محاولة / 10 دقائق

**✅ PASS** · 4/4 فحوص · 623ms

| الحقل | القيمة |
|---|---|
| INPUT | 31 طلب POST /api/chat من نفس هوية العميل |
| PRECONDITION | rateLimit(req,'chat',30,10min) |
| EXPECTED_DECISION | الثلاثون يمر، الحادي والثلاثون 429 |
| EXPECTED_SIDE_EFFECT | لا رد بعد تجاوز الحد، مع retry_after_seconds |
| EVIDENCE_REQUIRED | عدد 200 = 30 ثم 429 + retry_after_seconds |

**الفحوص**

- ✅ عدد المقبول = 30 (المتوقع 30)
- ✅ الحادي والثلاثون → HTTP 429 (المتوقع 429)
- ✅ code=RATE_LIMITED
- ✅ retry_after_seconds=600

**ACTUAL (دليل خام)**

```json
{
  "accepted": 30,
  "last_http": 429,
  "last_code": "RATE_LIMITED",
  "retry_after_seconds": 600,
  "request_id": "req_881691ff-b634-4cf8-8a8c-6501a372db62"
}
```


### WF-028 — قيمة غير مسموحة في حقل مُعدَّد وحد الأصناف

**✅ PASS** · 5/5 فحوص · 24ms

| الحقل | القيمة |
|---|---|
| INPUT | payment='bitcoin' ثم items من 51 صنفًا (الحد 50) |
| PRECONDITION | z.enum(['cod','vodafone_cash']) و items.max(50) |
| EXPECTED_DECISION | 422 في الحالتين |
| EXPECTED_SIDE_EFFECT | لا طلب |
| EVIDENCE_REQUIRED | 422 + رسائل محددة + ثبات عدد الطلبات |

**الفحوص**

- ✅ payment غير مسموح → HTTP 422 (المتوقع 422)
- ✅ code=VALIDATION_FAILED
- ✅ 51 صنفًا → HTTP 422 (المتوقع 422)
- ✅ الرسالة تسمّي الحد 50: «items: الحد الأقصى 50 صنفًا»
- ✅ عدد الطلبات 204 → 204

**ACTUAL (دليل خام)**

```json
{
  "bad_payment": {
    "http": 422,
    "code": "VALIDATION_FAILED",
    "error": "payment: Invalid enum value. Expected 'cod' | 'vodafone_cash', received 'bitcoin'"
  },
  "too_many_items": {
    "http": 422,
    "code": "VALIDATION_FAILED",
    "error": "items: الحد الأقصى 50 صنفًا"
  },
  "orders_before": 204,
  "orders_after": 204
}
```


### WF-029 — X-Request-Id على النجاح والخطأ معًا

**✅ PASS** · 5/5 فحوص · 94ms

| الحقل | القيمة |
|---|---|
| INPUT | 200 على /api/products و422 على /api/chat و401 على /api/orders و409 على طلب مرفوض |
| PRECONDITION | apiHandler يضبط X-Request-Id ويظهر request_id في جسم الخطأ |
| EXPECTED_DECISION | معرّف قابل للربط بالسجلات في كل استجابة |
| EXPECTED_SIDE_EFFECT | لا استجابة بلا معرّف |
| EVIDENCE_REQUIRED | رأس + جسم متطابقان في كل حالة |

**الفحوص**

- ✅ 200 /api/products — header=req_d2faebf6-26cc-4a07-931a-3f6bf4d45728
- ✅ 422 chat — header=req_96302375-8fbe-46e6-af30-28390c8ec014 body=req_96302375-8fbe-46e6-af30-28390c8ec014
- ✅ 401 orders — header=req_bf3d230b-47a9-453c-a7cd-d5c31e34e075 body=req_bf3d230b-47a9-453c-a7cd-d5c31e34e075
- ✅ 409 conflict — header=req_e691d797-55f6-4847-be96-1b5873b29970 body=req_e691d797-55f6-4847-be96-1b5873b29970
- ✅ كل المعرّفات بالصيغة req_ القابلة للبحث في السجلات

**ACTUAL (دليل خام)**

```json
{
  "probes": [
    {
      "case": "200 /api/products",
      "header": "req_d2faebf6-26cc-4a07-931a-3f6bf4d45728",
      "bodyId": null
    },
    {
      "case": "422 chat",
      "header": "req_96302375-8fbe-46e6-af30-28390c8ec014",
      "bodyId": "req_96302375-8fbe-46e6-af30-28390c8ec014"
    },
    {
      "case": "401 orders",
      "header": "req_bf3d230b-47a9-453c-a7cd-d5c31e34e075",
      "bodyId": "req_bf3d230b-47a9-453c-a7cd-d5c31e34e075"
    },
    {
      "case": "409 conflict",
      "header": "req_e691d797-55f6-4847-be96-1b5873b29970",
      "bodyId": "req_e691d797-55f6-4847-be96-1b5873b29970"
    }
  ]
}
```


### WF-030 — مسار غير موجود — 404 بلا تسريب

**✅ PASS** · 3/3 فحوص · 57ms

| الحقل | القيمة |
|---|---|
| INPUT | GET /api/does-not-exist و GET /api/orders/../admin/diagnostics |
| PRECONDITION | لا شيء |
| EXPECTED_DECISION | 404 موحّد، لا stack ولا كشف بنية |
| EXPECTED_SIDE_EFFECT | لا كتابة |
| EVIDENCE_REQUIRED | 404 + غياب stack/مسارات داخلية عن الرد |

**الفحوص**

- ✅ مسار غير موجود → HTTP 404 (المتوقع 404)
- ✅ لا stack حقيقي ولا مسار نظام مطلق في أيٍّ من الردّين
- ✅ محاولة اجتياز المسار → HTTP 404 (لا وصول)

**ACTUAL (دليل خام)**

```json
{
  "missing_route_http": 404,
  "missing_route_excerpt": "<!DOCTYPE html><html lang=\"ar\" dir=\"rtl\"><head><meta charSet=\"utf-8\"/><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/><link rel=\"stylesheet",
  "traversal_http": 404,
  "traversal_excerpt": "{\"error\":\"هذه النقطة غير متاحة\",\"code\":\"NOT_FOUND\",\"request_id\":\"req_b853492e-3d27-43b2-830d-5bf057c968f1\"}",
  "real_leak": false,
  "dev_only_artifact_present": true
}
```


### WF-031 — بناء الإنتاج لا يسرّب ما يسرّبه وضع التطوير

**✅ PASS** · 4/4 فحوص · 44ms

| الحقل | القيمة |
|---|---|
| INPUT | GET /api/does-not-exist على :3000 (dev) مقابل :3003 (next start) |
| PRECONDITION | نفس الكود؛ :3003 يعمل من npm run build |
| EXPECTED_DECISION | آثار أدوات التطوير تظهر في dev وتختفي في الإنتاج |
| EXPECTED_SIDE_EFFECT | لا stack ولا مسار نظام في الحالتين |
| EVIDENCE_REQUIRED | قائمة التطابقات لكل بيئة + حجم الردّين |

**الفحوص**

- ✅ 404 في البيئتين (dev=404, prod=404)
- ✅ لا تسريب حقيقي في dev: ["node_modules","next-devtools","hmr-client"]
- ✅ لا تسريب حقيقي في prod: []
- ✅ آثار التطوير مقصورة على dev (dev=3، prod=0)

**ACTUAL (دليل خام)**

```json
{
  "environments": {
    "dev": {
      "http": 404,
      "bytes": 16877,
      "matches": [
        "node_modules",
        "next-devtools",
        "hmr-client"
      ]
    },
    "prod": {
      "http": 404,
      "bytes": 12132,
      "matches": []
    }
  },
  "dev_only_artifacts": [
    "node_modules",
    "next-devtools",
    "hmr-client"
  ],
  "real_leak_dev": false,
  "real_leak_prod": false
}
```


### WF-032 — تكافؤ dev/prod على محرّك الرد الاحتياطي — حارس البناء القديم

**✅ PASS** · 4/4 فحوص · 31ms

| الحقل | القيمة |
|---|---|
| INPUT | نفس استعلام الدردشة على :3000 (dev) و:3003 (next start) |
| PRECONDITION | نفس الكود؛ :3003 يُبنى من npm run build قبل التشغيل |
| EXPECTED_DECISION | قرار واحد في البيئتين — لا يختلف المحرك بالوضع |
| EXPECTED_SIDE_EFFECT | لا كتابة؛ قراءة فقط |
| EVIDENCE_REQUIRED | أول ترشيح في كل بيئة + هل خُطف السؤال بـFAQ في أيٍّ منهما |

**الفحوص**

- ✅ 200 في البيئتين (dev=200, prod=200)
- ✅ dev لم يُخطف بـFAQ: true
- ✅ prod لم يُخطف بـFAQ: true — بناء قديم لو سقط هذا
- ✅ أول ترشيح متطابق (dev=«منظف أرضيات برائحة اللافندر 5 لتر — 180 جنيه»، prod=«منظف أرضيات برائحة اللافندر 5 لتر — 180 جنيه»)

**ACTUAL (دليل خام)**

```json
{
  "query": "هات أرخص منظف أرضيات متاح",
  "dev": {
    "http": 200,
    "source": "local",
    "first_recommendation": "منظف أرضيات برائحة اللافندر 5 لتر — 180 جنيه",
    "faq_hijack": false
  },
  "prod": {
    "http": 200,
    "source": "local",
    "first_recommendation": "منظف أرضيات برائحة اللافندر 5 لتر — 180 جنيه",
    "faq_hijack": false
  },
  "identical_first_recommendation": true
}
```


---

## الاكتشافات

### D-1 · جلسة الإدارة لا تُقبل أبدًا كما تُرسل على السلك — ✅ أُصلح

**أثر:** لوحة التحكم `/admin` ميتة بالكامل. الدخول ينجح، ثم كل مسار إداري يُرجع `401`.

**الدليل من الـ Runtime:**

| خطوة | نتيجة |
|---|---|
| `POST /api/admin/login` بكلمة مرور صحيحة | `200` + `Set-Cookie` |
| قيمة الكوكيز على السلك | `1790586906714-vd9T7gT0nW-URZCZK9F1iPccEhb4rc0c.6aizPVENRaebbiTnNWHH0xnfTXE9gl3DwBwDUBh59AI` |
| `GET /api/admin/session` بنفس الكوكيز | `authenticated=true` |
| `GET /api/orders` بنفس الكوكيز | `200` `undefined` |
| `POST /api/products` بنفس الكوكيز | `200` `undefined` |

**السبب الجذري:** `createAdminSession()` تُنتج حمولة على شكل `<ts>:<nonce>` بنقطتين خام. `response.cookies.set()` ترمّز القيمة، فتصير النقطتان `%3A` على السلك. و`verifyAdminSession()` تقرأ القيمة كما وصلت فتحسب HMAC فوق النص المُرمَّز — بينما التوقيع حُسب فوق الخام — فلا يتطابق. ولو تطابق، فإن `Number(payload.split(":",1)[0])` يُعيد `NaN` لأن الفاصل لم يعد `:`، فيسقط فحص العمر أيضًا.

**إعادة الإنتاج:** `node --import tsx whatif/repro-auth-cookie.mjs` →
`verifyAdminSession(خام)=true` و`verifyAdminSession(على السلك)=false`.

**لماذا لم تلتقطه الاختبارات؟** `tests/auth.test.ts` يغطي `adminConfigIssues`/`isAdminConfigured` فقط. لا يوجد أي اختبار يمرّر الجلسة عبر ترميز الكوكيز الفعلي — وهي الخطوة الوحيدة التي تكسر العقد. 133 اختبارًا أخضر مع لوحة تحكم ميتة.

### ✅ أُصلح

**السبب الجذري الدقيق:** `z.union` يجرّب أعضائه بالترتيب ويأخذ أول نجاح. الأبجدية الوحيدة التي تتغير تحت ترميز الكوكيز كانت `:` (النقطتان في `<ts>:<nonce>`)، فتصير `%3A` على السلك ويحسب `verifyAdminSession` الـHMAC فوق نص مختلف عن المُوقَّع.

**الإصلاح:** `src/lib/auth.ts` — استُبدل الفاصل `:` بـ `-` عبر ثابت `PAYLOAD_SEPARATOR` مُوثَّق، في الإنشاء والقراءة معًا. الرمز كله صار من محارف آمنة (`[0-9]+-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`) فثبت تحت الترميز.

**الدليل بعد الإصلاح (على الـ Runtime نفسه):**

| خطوة | قبل | بعد |
|---|---|---|
| `POST /api/admin/login` | 200 + كوكيز | 200 + كوكيز |
| `GET /api/admin/session` | `authenticated=false` | `{"authenticated":true}` |
| `GET /api/orders` | 401 `AUTH_REQUIRED` | 200 (أعاد 70 طلبًا) |
| WF-020 | ❌ FAIL 3/6 | ✅ PASS 6/6 |

**اختبار الانحدار:** أُضيفت 9 اختبارات في `tests/auth.test.ts` تحت `admin session round-trip`، أهمها يمرّ عبر `response.cookies.set()` فعلًا ثم يُغذّي الكوكيز المُصدَّر إلى `isAdminRequest` — لا نص خام. plus ثابتة `encodeURIComponent(token) === token`، وفحص انتهاء العمر عبر `mock.timers`.

**إثبات أن الاختبار يلتقط العيب:** أُعيد الفاصل إلى `:` مؤقتًا فسقطت **4** من الاختبارات الجديدة (`pass 138 / fail 4`)، ثم أُعيد الإصلاح فعادت `142/142`. اختبار انحدار لا يفشل عند إعادة العيب ليس اختبارًا.

### D-2 · لا يوجد idempotency key — الضغط المزدوج يُنشئ طلبين

`createOrderContract` لا يحمل أي مفتاح تفرد. في WF-010 أنتجت ضغطتان متطابقتان طلبين منفصلين (`ORD-86905623-53976efc` و`ORD-86905639-614bdc29`) وخصمًا قدره 2 من المخزون. **لا يوجد فساد بيانات** — المخزون لم يتجاوز حدّه ولا سجلات يتيمة — لكن العميل قد يطلب مرتين دون قصد. القرار الحالي «كل ضغطة طلب مستقل» قرار مشروع، لكنه غير معلن ولا محمي.

### D-3 · ملاحظة CSP

`Content-Security-Policy` تعمل في وضع `Report-Only` (`CSP_ENFORCE !== "true"`). هي تراقب ولا تفرض. هذا مقصود في الكود، لكنه يعني أن أي انتهاك CSP حاليًا لا يُحجب فعليًا.

### D-4 · الرد الاحتياطي: سؤال عن المنتجات يُخطفه جواب عن الدفع — ✅ أُصلح

**السيناريو:** WF-013 — «هات أرخص منظف أرضيات متاح».

**ما كان يحدث:** الرد كان جواب السؤال الشائع عن طرق الدفع — «الدفع عن طريق فودافون كاش على رقم 01095032221…» — وليس ترشيح منتج واحد، ولم يُذكر أي سعر (`prices_mentioned=[]`).

**السبب الجذري:** `localAnswer` كانت تفحص الأسئلة الشائعة **قبل** المنتجات وتكتفي بمطابقة واحدة (`bestFaq.s >= 1`). وكلمة «متاح» الواردة في سؤال العميل هي substring داخل «المتاحة» في سؤال «ما هي طرق الدفع المتاحة؟»، فيكفي هذا التقاطع الجزئي لخطف السؤال كله.

**الإصلاح:** أُخرج المحرك إلى `src/lib/ai/local-answer.ts` كدالة نقية (`composeLocalAnswer`)، وصارت الأسئلة الشائعة **تنافس المنتجات على الدرجة** بدل أن تسبقها بالترتيب: لا يُجاب عن FAQ إلا إذا تفوّقت درجتها على أفضل منتج فعلًا، والتعادل يُحسم للمنتج.

**الدليل بعد الإصلاح (WF-013 — `PASS` 5/5):** `faq_hijack=false`، وأدنى سعر مذكور `45` (المتوقع 45)، والنافد ذو الـ30 ج لم يُرشَّح.

**حدود صادقة للإصلاح:** المحرك ما زال مطابقة كلمات لا فهم قصد. فترشيح الأرخص صحيح، لكن الرد يُدرج تحته أصنافًا أقل صلة (زجاج، أطباق) لأن كلمتَي «منظف» و«أرضيات» تتقاطعان معها جزئيًا. الترتيب صحيح والحدود معروفة — الفهم الحقيقي للقصد هو دور طبقة الوكيل (Gemini/Celia)، لا هذا المسار الاحتياطي.

### D-5 · الرد الاحتياطي: لا حسم للمقاس، وإسقاط صامت للأصناف المتساوية — ✅ أُصلح

**السيناريوهان:** WF-012 («هات الكبير») وWF-014 («عايز منظف حمامات»).

**ما كان يحدث:**

- **WF-012 — لا حسم للمقاس:** مع تثبيت precondition أن العبوة الصغيرة (1 لتر) هي الأولى في ترتيب الكتالوج، كان الرد يذكر **المقاسين معًا** (`resolved_size="كلاهما (بلا حسم)"`). صفة «الكبير» لم تُترجم إلى أي تفضيل؛ المحرك كان يطابق أسماء ولا يفهم صفات.
- **WF-014 — إسقاط صامت:** صنفان متطابقان إلا في الرائحة (ليمون 72 ج، لافندر 74 ج)، وكلاهما طابق كلمتَي السؤال («منظف»، «حمامات») كما يوثّق `fixture_keyword_eligibility`. مع ذلك لم يظهر أيٌّ منهما، لأن الرد كان يقطع عند أول 3 وعند تساوي الدرجات يحسم ترتيب الكتالوج (`featured DESC, rowid ASC`). لا طلب توضيح ولا إشارة إلى وجود بدائل.

**الأثر التجاري وقتها:** منتج جديد مضاف من لوحة التحكم قد لا يظهر في المحادثة إطلاقًا رغم مطابقته التامة للطلب، فقط لأنه أُدرج بعد ثلاثة أصناف أقدم بنفس الدرجة.

**الإصلاح — ثلاث قواعد صريحة في `src/lib/ai/local-answer.ts`:**

1. **حسم المقاس:** `packSizeMl()` يستخرج حجم العبوة من الاسم ويوحّده بالملليلتر، و«الكبير»/«الصغير» يُرشّحان العبوة المطلوبة **وحدها**. والأهم ما يرفضه: الوحدات غير القابلة للمقارنة («5 كجم»، «عبوة 6 قطع») تُعيد `null` فيُستثنى الصنف بدل أن يُخمَّن حجمه — الامتناع عن الحسم خير من حسم خاطئ.
2. **التوافر شرط للترشيح:** ما مخزونه صفر خارج القائمة، ولو كان كل ما طابق السؤال نافدًا يُقال ذلك صراحةً («نفدت حاليًا من المخزون») بدل اقتراح صنف لا يمكن شراؤه.
3. **لا إسقاط صامت:** الترتيب صار صريحًا (الدرجة ← الأرخص ← الاسم) لا ترتيب الكتالوج، والحد رُفع إلى `5`، وما زاد يُعلن عدده («وفيه كمان N صنف تاني مطابق») بدل أن يختفي.

**الدليل بعد الإصلاح:**

| السيناريو | قبل | بعد |
|---|---|---|
| WF-012 «هات الكبير» | ❌ 3/4 · `mentions_1l=true` (المقاسان معًا) | ✅ 4/4 · `5 لتر فقط`، `5 لتر` |
| WF-014 صنفان متشابهان | ❌ 1/3 · حسم صامت | ✅ 3/3 · `عرض الخيارين` |
| WF-013 أرخص متاح | ❌ 2/5 · خطفه FAQ | ✅ 5/5 · أدنى سعر `45` |

**اختبار الانحدار:** `tests/local-answer.test.ts` (18 اختبارًا) على الدالة النقية مباشرةً — تحليل الأحجام ورفض الوحدات غير المتقارنة، ومنع خطف FAQ مع بقاء الأسئلة الشائعة الحقيقية تعمل، وحسم المقاسين في الاتجاهين، وبقاء المقاسين معروضين عند غياب صفة الحجم، واستبعاد النافد، وإعلان النفاد الكلي، وعرض المتشابهين معًا، والترتيب بالسعر لا بالكتالوج، وإعلان الفائض، وعدم اختلاق سعر لأمر غامض.

**إثبات أن الاختبارات تلتقط العيوب:** أُعيد كل عيب على حدة (`sed`/`python`) فسقطت — طفرة D-4 (أسبقية FAQ المطلقة) → 2، طفرة إلغاء حسم المقاس → 2، طفرة الإسقاط الصامت + ترتيب الكتالوج → 3. ثم أُعيد الإصلاح فعادت `168/168`.

**النطاق:** كلا العيبين كانا في مسار الرد الاحتياطي بلا مفاتيح API — وهو المسار الذي يخدم العميل فعلًا اليوم. بوجود مفاتيح Gemini/Groq يختلف السلوك، وهو ما لم يُقَس هنا لأن البيئة تحجب الاتصال الخارجي (انظر الملاحظة المنهجية 6).

### D-6 · نقطة التشخيص تكشف وجودها رغم وعد «404 موحّد» — ✅ أُصلح

**السيناريو:** WF-025.

**ما وعد به الكود:** تعليق `src/app/api/admin/diagnostics/route.ts` ينصّ على أنها عند التعطيل «تُعيد 404 موحّدًا حتى لا يُكشف وجودها».

**ما كان يحدث:** كانت النقطة تُرجع كود `DIAGNOSTICS_DISABLED` ورسالة «التشخيص معطل في بيئة الإنتاج»، بينما نقطة MCP المجاورة — بنفس المنطق الأمني المعلن — تُرجع `NOT_FOUND` عامًا. نقطتان محجوبتان بعلم ميزة تُرجعان رسالتين مختلفتين، والكود والرسالة يُثبتان للمهاجم أن المسار موجود وأنه محمي بعلم بيئة: نقيض المقصد المكتوب.

**ليست أثرًا لوضع التطوير:** قيس العيب على بناء الإنتاج (`npm run build && next start` على `:3003`) قبل الإصلاح فأعاد **نفس الكود والرسالة حرفيًا**، فالسلوك كان ثابتًا في البيئتين ولا يختفي بالنشر.

**الإصلاح:** `src/app/api/admin/diagnostics/route.ts` يستدعي الآن `Errors.notFound("هذه النقطة غير متاحة")` مطابقةً لنقطة MCP، وسبب التعطيل يُسجَّل في الخادم (`console.info`) لا في الاستجابة. وحُذف المصنع `Errors.diagnosticsDisabled` وكود `DIAGNOSTICS_DISABLED` من اتحاد `ErrorCode` نهائيًا، حتى لا يعيد أحد إدخال التسريب عن طريق الخطأ.

**الدليل بعد الإصلاح (WF-025 — `PASS`):**

| النقطة | HTTP | code | الرسالة |
|---|---|---|---|
| `/api/admin/diagnostics` | `404` | `NOT_FOUND` | `هذه النقطة غير متاحة` |
| `/api/admin/diagnostics` + مفتاح مُخمَّن | `404` | `NOT_FOUND` | `هذه النقطة غير متاحة` |
| `/api/admin/mcp/tools` | `404` | `NOT_FOUND` | `هذه النقطة غير متاحة` |

`messages_identical = true` — صار المستجيبان غير قابلين للتمييز، فلا oracle يُخبر المهاجم أيّ النقطتين موجودة.

**اختبار الانحدار:** `tests/diagnostics-route.test.ts` (5 اختبارات) يثبّت أن التعطيل يُعطي `404/NOT_FOUND`، وأن الرد لا يحتوي على «التشخيص» أو `DIAGNOSTICS` أو «بيئة الإنتاج»، وأن جسم 404 من النقطتين **متطابق حرفيًا** (عدا `request_id`)، وأن مفتاحًا مُخمَّنًا لا يُميّز النقطة — مع بقاء التفعيل الحقيقي يعمل (401 بلا اعتماد، 200 بالمفتاح أو بالجلسة). أُعيد العيب مؤقتًا فسقطت **3** اختبارات، ثم أُعيد الإصلاح فعادت `150/150`.

### D-7 · يستحيل على الإدارة مسح «السعر قبل الخصم» — ✅ أُصلح

**كيف ظهر:** لم يكن ضمن الخطة. ظهر عرضًا حين حُوّلت حالات المختبر من الكتابة المباشرة في القاعدة إلى واجهة الإدارة الحقيقية بعد إصلاح D-1، فسقطت 7 سيناريوهات بـ `422`.

**الدليل من الـ Runtime (قبل الإصلاح):**

| الحمول | النتيجة |
|---|---|
| `old_price: 150` (أكبر من السعر) | 200 |
| `old_price: null` | **422** «السعر قبل الخصم يجب ألا يقل عن السعر الحالي» |
| `old_price: ""` | **422** نفس الرسالة |
| حذف `old_price` | 200 |

**الأثر التجاري:**一旦 يضبط المدير سعرًا قبل الخصم لا يستطيع إلغاءه — الحقل يبقى عالقًا للأبد ما دام أقل من السعر الحالي. نموذج الويب يرسل الحقل الفارغ كـ `""` أو `null`، فالمسار مكسور من الواجهة نفسها لا من API وحده.

**السبب الجذري:** `z.union` يجرّب أعضاءه بالترتيب ويأخذ أول نجاح. كان الترتيب `[positiveMoney, z.literal(""), z.null()]`، و`positiveMoney` مبني على `z.coerce.number()`. وبما أن `Number(null) === 0` و`Number("") === 0` وكلاهما يجتاز `.min(0)`، كان الرقم يبتلع القيمتين ويحوّلهما إلى `0` **قبل** بلوغ الأعضاء الحرفية. فتصل `.transform` وهي ترى `0` لا قيمة فارغة، و`0 == null` يساوي `false`، فيمرّر `0` إلى `refine` الذي يرفضه لأن `0 < price`.

قيس ذلك مباشرة على zod:

```
الترتيب الحالي  : null → 0 (number)   "" → 0 (number)
الترتيب المصحّح: null → null         "" → null
```

**الإصلاح:** `src/lib/validation/contracts.ts` — أُعيد ترتيب الاتحاد إلى `[z.null(), z.literal(""), positiveMoney]` مع تعليق يشرح لماذا الترتيب عقد لا تفصيل.

**الدليل بعد الإصلاح (على الـ Runtime نفسه):** `old_price: null` → 200، `old_price: ""` → 200، والقيمة المخزّنة `{"price":100,"old_price":null}`.

**اختبار الانحدار:** 3 اختبارات في `tests/contracts.test.ts` تثبّت أن `null`/`""`/الحذف كلها تُقبل وتتحول إلى `null`، وأن التحويل لا يُنتج `0` أبدًا، مع بقاء إكراه النصوص الرقمية ورفض السالب. أُعيد الترتيب القديم مؤقتًا فسقط اختباران (`143/145`)، ثم أُعيد الإصلاح فعادت `145/145`.

---

## ملاحظات منهجية

1. **كل فعل قيد القياس مرّ عبر HTTP على Runtime حقيقي** — لا Mocks ولا استدعاء مباشر للدوال.
2. **ضبط الـ precondition يمرّ عبر واجهة الإدارة الحقيقية** (`POST /api/products` بجلسة إدارة فعلية). كان في الجولات الأولى كتابةً مباشرة في القاعدة لأن D-1 كان يرفض كل جلسة؛ بعد إصلاحه حُوّلت كل الـ fixtures إلى المسار الحقيقي، فصار الـ precondition نفسه يعبر عقد Zod والتفويض وسجل التدقيق ومزامنة FTS5. القراءة كذلك عبر `GET /api/orders` المحمي، فأي انحدار في التفويض يُسقط جمع الدليل فورًا بدل أن يمرّ بصمت. القراءة المباشرة من القاعدة بقيت في موضعين فقط لا مكافئ لهما عبر API: ثوابت السلامة (الأصناف اليتيمة، المخزون السالب) وسجل تدقيق محاولات التتبّع الفاشلة.
3. **كل سيناريو أخذ `x-forwarded-for` مستقلًا** لأن `bucketKey()` يشتق مفتاح تحديد المعدل منه، والحد `8/10min` على `/api/orders` كان سيعطي `429` ويخفي القرارات الحقيقية.
4. **أربع نسخ Runtime من نفس الكود، كل واحدة لظرف:**
   - `:3000` — الحالة الأساسية، `next dev`، قاعدة بيانات مربوطة.
   - `:3001` (`~/whatif-nodb`) — `TURSO_DATABASE_URL` فارغ، لـ WF-016.
   - `:3002` (`~/whatif-aifail`) — مفاتيح Gemini/Groq موجودة + `ENABLE_ORDER_TRACKING=true`، لـ WF-015 وWF-021/022.
   - `:3003` — **بناء إنتاجي** (`npm run build && next start`)، لـ WF-031 ومقاطعة D-6.
   المجلدات منفصلة لأن نسختَي dev في مجلد واحد تتصارعان على `.next`، ولأن Turbopack يرفض `node_modules` الرمزي («points out of the filesystem root») فنُسخت بالوصلات الصلبة.
5. **لم يُعدَّل أي كود تطبيق أثناء القياس — والتعديلات جاءت بعده وبقياس جديد.** التزم المختبر في جولاته الأولى بتجميد الحالة: التغيير الوحيد كان `next.config.mjs` (قراءة `ALLOWED_DEV_ORIGINS` من البيئة، ومعطّل افتراضيًا) ومجلد `whatif/` الجديد. بعد اكتمال المصفوفة أُصلحت خمسة عيوب (D-1، D-4، D-5، D-6، D-7)، وكل إصلاح أُعيد قياسه بتشغيل جديد للمختبر لا بالاعتماد على التشغيل السابق. فالتسلسل كان: قِس ← اكتشف ← أصلح ← أعِد القياس، ولم يُعلن أي إصلاح قبل دليله.
6. **حدود البيئة — ما لم يُقَس:** الاتصال الخارجي محجوب على مستوى TLS (`generativelanguage.googleapis.com` و`api.groq.com` يُرجعان `000` مع `SSL_ERROR_SYSCALL`). لذلك:
   - WF-015 قاس **انقطاع المزود** لا **رفض المفتاح**. كلاهما يُنتج نفس قرار التراجع في `chat/route.ts`، لكن «مفتاح منتهي/غير صالح» تحديدًا لم يُختبر.
   - مسار Gemini/Groq الحقيقي لم يُقَس إطلاقًا، ونتائج D-4/D-5 تخص `localAnswer` وحده.
7. **حالات FAIL في الرد الاحتياطي (D-4/D-5) لم تكن أعطال Runtime** بل قصور قرار في محرك بلا مفاتيح؛ صُنّفت FAIL لأن المتوقع كان قرارًا صحيحًا لا لأن الطلب سقط. وقد أُصلحت لاحقًا فصارت PASS — والتغيير في التصنيف جاء من إصلاح الكود، لا من تخفيف الفحص.
8. **فحصان من فحوص المختبر صُحّحا أثناء العمل، وكلاهما كان خطأً في المختبر لا في التطبيق:**
   - **WF-012** أعطى PASS زائفًا في تشغيل مبكر: الرد ذكر «5 لتر» لأن العبوة الكبيرة `featured` فتتصدر الترتيب، لا لأن «الكبير» حُسمت. أُعيد بناؤه ليثبّت العبوة **الصغيرة** في صدارة الكتالوج؛ صار حاسمًا ونتيجته FAIL.
   - **WF-030** أعطى FAIL زائفًا: نمط الكشف عن التسريب كان يطابق `node_modules` داخل أسماء chunks الخاصة بأدوات التطوير. قُسّم النمط إلى «تسريب حقيقي» (إطار stack أو مسار نظام مطلق) مقابل «أثر تطوير»، وأُضيف WF-031 ليقيس الفرق بين dev والإنتاج بدل الاكتفاء بالادعاء. النتيجة النهائية PASS.
   القاعدة المتّبعة: أي FAIL يُقرأ ردّه الفعلي قبل اعتماده، وأي PASS يُسأل «هل يمكن أن ينجح هذا صدفة؟».
9. **مصفوفة خضراء لا تعني أن الإنتاج سليم — وقد وقعنا في هذا فعلًا.** كل سيناريوهات الدردشة (WF-012/013/014) تُقاس على `:3000` (dev). وبعد إصلاح D-4/D-5 أعادت المصفوفة 31/31 PASS بينما بناء الإنتاج على `:3003` كان ما زال **قديمًا** ويُعيد جواب الدفع الخاطئ نفسه. الدليل: نفس الاستعلام أعاد على `:3000` ترشيح منتجات وعلى `:3003` «الدفع عن طريق فودافون كاش…».

   أُضيف **WF-032** حارسًا: يقيس قرار محرّك الرد على البيئتين ويشترط تطابقه، فأي بناء قديم يُسقطه فورًا. وأُثبت أن الحارس ليس أجوف — وُجّه `PROD_BASE` إلى `:3002` (نسخة المصدر غير المُصلَحة) فسقط WF-032 بفحصين (`prod لم يُخطف بـFAQ: false`)، ثم أُعيد إلى `:3003` السليم فعاد PASS.

   القاعدة: أي ادعاء «أُصلح» يُقاس على البناء الذي سيُشحن، لا على خادم التطوير وحده.
10. **كوكيز جلسة الإدارة لا يدخل المستودع.** إعادة تشغيل المختبر كانت تستهلك حد المعدل على الدخول (3 محاولات / 10 دقائق) فتفشل الجولة كلها بـ `429`. صارت الجلسة تُحفظ بين التشغيلات وتُختبر صلاحيتها قبل الاعتماد عليها — والحفظ في مجلد مؤقت **خارج** المستودع (`os.tmpdir()`) بصلاحيات `0600`، لأن كوكيز الإدارة سرّ ولا يجوز أن يقترب من `git add -A`. قيس الأثر: الجولة بعد انتهاء الجلسة 99 ثانية، والتي تليها 3.5 ثانية وبلا `429`.

## إعادة التشغيل

```bash
# 1) النسخة الأساسية — مع قاعدة بيانات
cd ~/aborof && npx next dev -H 0.0.0.0 -p 3000

# 2) نسخة DB-down — لـ WF-016
cd ~/whatif-nodb && npx next dev -H 0.0.0.0 -p 3001

# 3) نسخة مفاتيح AI غير صالحة + تتبُّع مفعّل — لـ WF-015 وWF-021/022
cd ~/whatif-aifail && npx next dev -H 0.0.0.0 -p 3002

# 4) بناء إنتاجي — لـ WF-031 ومقاطعة D-6
cd ~/aborof && npm run build && npx next start -H 0.0.0.0 -p 3003

# المصفوفة كاملة (تتطلّب النسخ الأربع شغّالة)
cd ~/aborof && node whatif/run-whatif.mjs && node whatif/make-report.mjs

# إعادة إنتاج D-1 بمفردها
cd ~/aborof && node --import tsx whatif/repro-auth-cookie.mjs
```

الملفات:

| ملف | الدور |
|---|---|
| `whatif/run-whatif.mjs` | يشغّل السيناريوهات ويجمع الدليل |
| `whatif/evidence.json` | الدليل الخام (مولَّد) |
| `whatif/make-report.mjs` | يولّد التقرير من الدليل — لا أرقام يدوية |
| `whatif/report.md` | المصفوفة النهائية (مولَّد) |
| `whatif/repro-auth-cookie.mjs` | إعادة إنتاج D-1 على الوحدة الحقيقية |
