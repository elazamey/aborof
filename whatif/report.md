# What-If Test Matrix — متجر أبو رفيدة العزامي

> **مختبر قرار، لا اختبار «هل وقع الموقع».** كل سيناريو يُقاس عبر السلسلة:
> `INPUT → INTENT → DATA → POLICY → AUTHORIZATION → EXECUTION → EVIDENCE → OUTCOME`

| بند | قيمة |
|---|---|
| تاريخ التشغيل | `2026-09-28T08:20:29.270Z` |
| معرّف التشغيل | `run10` |
| الـ Runtime قيد القياس | `http://127.0.0.1:3000` (Next.js على `0.0.0.0:3000`) |
| نسخة DB-down | `http://127.0.0.1:3001` (نفس الكود، `TURSO_DATABASE_URL` فارغ) |
| قاعدة البيانات | `file:local.db` عبر `@libsql/client` — نفس مسار كود Turso |
| حالة خط الأساس | orders=`57` · order_items=`57` · orphans=`0` · negative_stock=`0` |
| الحالة النهائية | orders=`70` · order_items=`70` · orphans=`0` · negative_stock=`0` |

## الملخّص

| الحالة | العدد |
|---|---|
| ✅ PASS | 26 |
| ❌ FAIL | 5 |
| **الإجمالي** | **31** |

**ثوابت سلامة لم تُكسر في أي سيناريو:** `orphan_order_items = 0` و`negative_stock_rows = 0`.

---

## المصفوفة


### WF-001 — المنتج موجود والمخزون يكفي — «عايز 20 عبوة من منظف الأرضيات باللافندر»

**✅ PASS** · 8/8 فحوص · 75ms

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
  "request_id": "req_580b0a54-7568-4b9d-b58f-0269bff07c0f",
  "body": {
    "ok": true,
    "id": "ORD-83627015-81fa026c",
    "subtotal": 3600,
    "shipping": 0,
    "total": 3600
  },
  "stock_before": 50,
  "stock_after": 30,
  "db": {
    "orders": 58,
    "order_items": 58,
    "orphan_order_items": 0,
    "negative_stock_rows": 0,
    "last_order": {
      "id": "ORD-83627015-81fa026c",
      "total": 3600,
      "shipping_fee": 0,
      "items": "[{\"id\":\"p1\",\"name\":\"منظف أرضيات برائحة اللافندر 5 لتر\",\"price\":180,\"qty\":20}]"
    }
  }
}
```


### WF-002 — منتج غير موجود — بحث + محاولة شراء

**✅ PASS** · 7/7 فحوص · 38ms

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
- ✅ عدد الطلبات 58 → 58 (بلا تغيير)
- ✅ أصناف يتيمة = 0

**ACTUAL (دليل خام)**

```json
{
  "chat_http": 200,
  "chat_source": "local",
  "chat_reply": "أهلاً بيك 👋 دي المنتجات المناسبة لطلبك:\n• منظف أرضيات برائحة اللافندر 5 لتر — 180 جنيه\n• كلوركس مبيض ومطهر 4 لتر — 95 جنيه\n• سائل غسيل أطباق ليمون 2 لتر — 70 ج",
  "http": 409,
  "code": "CONFLICT",
  "request_id": "req_280b4e97-077c-45ec-801f-52f29c9119f5",
  "body": {
    "error": "أحد المنتجات لم يعد متاحًا",
    "code": "CONFLICT",
    "request_id": "req_280b4e97-077c-45ec-801f-52f29c9119f5"
  },
  "orders_before": 58,
  "orders_after": 58
}
```


### WF-003 — الكمية أكبر من المخزون — طلب 20 والمتاح 7

**✅ PASS** · 6/6 فحوص · 47ms

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
- ✅ عدد الطلبات 58 → 58 (لم يُنشأ طلب)

**ACTUAL (دليل خام)**

```json
{
  "http": 409,
  "code": "CONFLICT",
  "message": "الكمية المطلوبة من منظف أرضيات برائحة اللافندر 5 لتر غير متاحة",
  "request_id": "req_db27870b-5bb9-472b-aca1-a871c048b603",
  "stock_before": 7,
  "stock_after": 7,
  "orders_before": 58,
  "orders_after": 58
}
```


### WF-004 — المخزون صفر — AVAILABILITY = FALSE

**✅ PASS** · 6/6 فحوص · 42ms

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
- ✅ عدد الطلبات 58 → 58
- ✅ صفوف بمخزون سالب = 0

**ACTUAL (دليل خام)**

```json
{
  "http": 409,
  "code": "CONFLICT",
  "message": "الكمية المطلوبة من منظف أرضيات برائحة اللافندر 5 لتر غير متاحة",
  "request_id": "req_97f911c3-94a8-48ec-be35-496d53ef948b",
  "stock_before": 0,
  "stock_after": 0,
  "orders_after": 58
}
```


### WF-005 — حمولة غير صحيحة — مفتاح غير معروف + سلة فارغة

**✅ PASS** · 8/8 فحوص · 29ms

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
- ✅ request_id=req_ee85e24c-8224-48cb-ad09-2c51b168af12
- ✅ orders HTTP 422 (المتوقع 422)
- ✅ orders code=VALIDATION_FAILED
- ✅ رسالة عربية مفهومة: items: السلة فارغة
- ✅ عدد الطلبات 58 → 58 (بلا تغيير)

**ACTUAL (دليل خام)**

```json
{
  "chat_http": 422,
  "chat_code": "VALIDATION_FAILED",
  "chat_error": "Unrecognized key(s) in object: 'message'",
  "chat_request_id": "req_ee85e24c-8224-48cb-ad09-2c51b168af12",
  "order_http": 422,
  "order_code": "VALIDATION_FAILED",
  "order_error": "items: السلة فارغة",
  "order_request_id": "req_097f2d3e-334a-460e-8932-8a24d080c955",
  "orders_before": 58,
  "orders_after": 58
}
```


### WF-010 — الضغط على «إرسال الطلب» مرتين — double submit

**✅ PASS** · 5/5 فحوص · 141ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/orders مرتين بنفس الحمولة ونفس هوية العميل |
| PRECONDITION | p1: stock=10 |
| EXPECTED_DECISION | لكل طلب قرار مستقل — لا مفتاح idempotency في العقد |
| EXPECTED_SIDE_EFFECT | طلبان منفصلان، المخزون 10→8، بلا تجاوز للمخزون |
| EVIDENCE_REQUIRED | رقما طلبين مختلفين + المخزون بعد + عدم وجود سجلات يتيمة |

**الفحوص**

- ✅ HTTP 200 / 200
- ✅ رقما الطلبين مختلفان: ORD-83627233-95233884 , ORD-83627285-ad266519
- ✅ المخزون 10 → 8 (خصم 2 — طلب واحد لكل ضغطة)
- ✅ صفوف بمخزون سالب = 0
- ✅ أصناف يتيمة = 0

**ACTUAL (دليل خام)**

```json
{
  "http_1": 200,
  "http_2": 200,
  "id_1": "ORD-83627233-95233884",
  "id_2": "ORD-83627285-ad266519",
  "request_id_1": "req_49121b61-2cb0-4b99-bc75-61f9142e481c",
  "request_id_2": "req_73060dde-8a66-4a6a-9a9f-af5bf10bb8a2",
  "stock_before": 10,
  "stock_after": 8,
  "db": {
    "orders": 60,
    "order_items": 60,
    "orphan_order_items": 0,
    "negative_stock_rows": 0,
    "last_order": {
      "id": "ORD-83627285-ad266519",
      "total": 230,
      "shipping_fee": 50,
      "items": "[{\"id\":\"p1\",\"name\":\"منظف أرضيات برائحة اللافندر 5 لتر\",\"price\":180,\"qty\":1}]"
    }
  },
  "finding": "لا يوجد idempotency key في createOrderContract — التكرار يُنشئ طلبين"
}
```


### WF-011 — السعر تغيّر بين العرض وتأكيد الطلب + محاولة تزوير السعر

**✅ PASS** · 9/9 فحوص · 58ms

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
  "request_id": "req_20da2a2d-f7b3-4006-bf17-5f087b26beba"
}
```


### WF-016 — قاعدة البيانات غير متاحة أثناء إنشاء الطلب

**✅ PASS** · 7/7 فحوص · 29ms

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
- ✅ request_id=req_e27fb8ab-b284-471e-b7e5-c0603a912001 للربط بالسجلات
- ✅ قراءة المنتجات HTTP 200 (تدهور آمن)
- ✅ طلبات DB الحقيقية 61 → 61 (لم يُكتب شيء)

**ACTUAL (دليل خام)**

```json
{
  "http": 503,
  "code": "SERVICE_UNAVAILABLE",
  "message": "قاعدة البيانات غير مربوطة",
  "request_id": "req_e27fb8ab-b284-471e-b7e5-c0603a912001",
  "read_http": 200,
  "read_products": 12,
  "real_db_orders_before": 61,
  "real_db_orders_after": 61
}
```


### WF-017 — مستخدم عادي يحاول تنفيذ إجراء إداري

**✅ PASS** · 8/8 فحوص · 65ms

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
- ✅ عدد الطلبات 61 → 61

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
  "orders_before": 61,
  "orders_after": 61
}
```


### WF-018 — تنفيذ جزئي — صنفان يفشل ثانيهما، ثم تسابق على نفس المخزون

**✅ PASS** · 11/11 فحوص · 90ms

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
- ✅ أ) عدد الطلبات 61 → 61 (لا طلب)
- ✅ أ) أصناف يتيمة = 0
- ✅ ب) نتائج التزامن [200, 409] (المتوقع 200 و409 — رابح واحد)
- ✅ ب) عدد الطلبات الناجحة = 1
- ✅ ب) المخزون 5 → 1 (المتوقع 1 لا سالب)
- ✅ ب) طلبات DB 61 → 62 (+1 فقط)
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
    61,
    61
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
    61,
    62
  ],
  "b_request_ids": [
    "req_bc90144c-5e2b-4a84-b726-6d87c2d2882a",
    "req_15183c95-4472-4493-9dc3-24662a21e9f9"
  ],
  "db": {
    "orders": 62,
    "order_items": 62,
    "orphan_order_items": 0,
    "negative_stock_rows": 0,
    "last_order": {
      "id": "ORD-83627566-c46a55f6",
      "total": 1000,
      "shipping_fee": 0,
      "items": "[{\"id\":\"p1\",\"name\":\"منظف أرضيات برائحة اللافندر 5 لتر\",\"price\":250,\"qty\":4}]"
    }
  }
}
```


### WF-012 — أحجام متعددة والعميل قال «هات الكبير»

**❌ FAIL** · 3/4 فحوص · 72ms

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

**❌ FAIL** · 2/5 فحوص · 32ms

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

**❌ FAIL** · 1/3 فحوص · 48ms

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

**✅ PASS** · 5/5 فحوص · 59ms

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
  "request_id": "req_77286543-1473-41be-9cf8-a48419e6581d",
  "leaked_api_key": false,
  "leaked_stack": false,
  "provider_failure_mode": "fetch failed — انقطاع اتصال على مستوى TLS في بيئة الاختبار، لا رفض مفتاح؛ كلا المسارين يُنتجان نفس قرار التراجع"
}
```


### WF-019 — أمر غامض — «محتاج حاجة»

**✅ PASS** · 4/4 فحوص · 31ms

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
- ✅ عدد الطلبات 62 → 62 (لا تنفيذ من محادثة)
- ✅ رد مفيد يستوضح أو يعرض خيارات

**ACTUAL (دليل خام)**

```json
{
  "http": 200,
  "source": "local",
  "reply": "أهلاً بحضرتك في روفيده 🧼\nأنا سيليا، تحت أمرك. عندنا منظفات أرضيات ومطابخ وحمامات ومعطرات وأدوات نظافة.\nقولّي محتاج إيه بالظبط وأرشحلك الأنسب، أو كلمنا واتساب على 01095032221.",
  "fabricates_order_id": false,
  "orders_before": 62,
  "orders_after": 62
}
```


### WF-020 — جلسة إدارة صالحة تُرفض — defect ترميز الكوكيز (اكتشاف المختبر)

**❌ FAIL** · 3/6 فحوص · 43ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/admin/login (كلمة مرور صحيحة) ← GET /api/admin/session و GET /api/orders بنفس الكوكيز |
| PRECONDITION | ADMIN_PASSWORD و ADMIN_SESSION_SECRET صحيحان |
| EXPECTED_DECISION | login 200 + جلسة مقبولة على كل المسارات الإدارية |
| EXPECTED_SIDE_EFFECT | authenticated:true وقراءة الطلبات 200 |
| EVIDENCE_REQUIRED | 200 على الدخول + authenticated + حالة المسارات الإدارية + قيمة الكوكيز على السلك |

**الفحوص**

- ✅ الدخول HTTP 200 (كلمة المرور مقبولة)
- ✅ كوكيز صدر فعلًا: 1790583627844%3A_0U2eu_C…
- ✅ GET /api/admin/session HTTP 200
- ❌ authenticated=false (المتوقع true — DEFECT: القيمة على السلك تحتوي %3A)
- ❌ GET /api/orders بجلسة صالحة HTTP 401 (المتوقع 200)
- ❌ POST /api/products بجلسة صالحة HTTP 401 (المتوقع 200)

**ACTUAL (دليل خام)**

```json
{
  "login_http": 200,
  "cookie_value_on_the_wire": "1790583627844%3A_0U2eu_C0Ouyb0qc1Od-W6jpONMPfmoP.7EAMDGlwhwG4kJUEaeuLH871cW-ubwtwQ_ri_JBCwKQ",
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


### WF-021 — تتبّع الطلب بعاملين صحيحين — العلم مفعّل

**✅ PASS** · 7/7 فحوص · 34ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/orders/track {id, phoneLast4} على نسخة ENABLE_ORDER_TRACKING=true |
| PRECONDITION | طلب قائم بهاتف 01012345678؛ آخر 4 = 5678 |
| EXPECTED_DECISION | AUTHORIZATION بعاملين → كشف الحالة |
| EXPECTED_SIDE_EFFECT | 200 + حالة + أصناف مختصرة، بلا هاتف كامل ولا عنوان ولا أسعار |
| EVIDENCE_REQUIRED | 200 + محتوى الرد + غياب الهاتف/العنوان/السعر |

**الفحوص**

- ✅ أنشئ طلب للتتبّع: ORD-83627889-ef284495
- ✅ HTTP 200 (المتوقع 200)
- ✅ ok=true
- ✅ الحالة المُعادة = جديد
- ✅ أصناف مختصرة = [{"name":"سائل غسيل أطباق ليمون 2 لتر","qty":1}]
- ✅ لا هاتف كامل في الرد
- ✅ لا عنوان في الرد

**ACTUAL (دليل خام)**

```json
{
  "order_id": "ORD-83627889-ef284495",
  "http": 200,
  "body": {
    "ok": true,
    "id": "ORD-83627889-ef284495",
    "status": "جديد",
    "items": [
      {
        "name": "سائل غسيل أطباق ليمون 2 لتر",
        "qty": 1
      }
    ],
    "created_at": "2026-09-28 08:20:27"
  },
  "request_id": "req_755ae16d-a429-4b5e-9994-2360c5930ea8",
  "leaks_full_phone": false,
  "leaks_address": false,
  "leaks_price": false
}
```


### WF-022 — تتبّع بآخر 4 أرقام خاطئة — منع تعداد الطلبات

**✅ PASS** · 5/5 فحوص · 48ms

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
- ✅ سُجّلت محاولة فاشلة في التدقيق: 5 → 7

**ACTUAL (دليل خام)**

```json
{
  "order_id": "ORD-83627922-31579573",
  "wrong_last4_http": 404,
  "wrong_last4_error": "تعذر العثور على الطلب",
  "wrong_last4_code": "NOT_FOUND",
  "ghost_id_http": 404,
  "ghost_id_error": "تعذر العثور على الطلب",
  "messages_identical": true,
  "audit_track_failed": [
    5,
    7
  ]
}
```


### WF-023 — علم التتبّع مغلق — النقطة لا تكشف وجودها

**✅ PASS** · 3/3 فحوص · 13ms

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
  "request_id": "req_23816ca3-fe62-4b94-bdb3-50bc74d30c9f",
  "identical_to_enabled_failure": true
}
```


### WF-024 — تجاوز حد المعدل على إنشاء الطلبات — 429 بعد 8 محاولات

**✅ PASS** · 5/5 فحوص · 177ms

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

**❌ FAIL** · 4/5 فحوص · 24ms

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
- ❌ رسالتان موحّدتان («التشخيص معطل في بيئة الإنتاج») — لا تمييز بين نقطتين
- ✅ لا أسماء أدوات مسرّبة

**ACTUAL (دليل خام)**

```json
{
  "diagnostics_http": 404,
  "diagnostics_code": "DIAGNOSTICS_DISABLED",
  "diagnostics_error": "التشخيص معطل في بيئة الإنتاج",
  "diagnostics_with_key_http": 404,
  "mcp_http": 404,
  "mcp_code": "NOT_FOUND",
  "mcp_error": "هذه النقطة غير متاحة",
  "messages_identical": false,
  "leaks_tool_names": false
}
```


### WF-006 — جسم أكبر من الحد المسموح

**✅ PASS** · 4/4 فحوص · 13ms

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
- ✅ request_id=req_ec93c8e5-a153-4d17-a4d5-2e4673ffd90d
- ✅ عدد الطلبات 70 → 70 (بلا تغيير)

**ACTUAL (دليل خام)**

```json
{
  "http": 413,
  "code": "PAYLOAD_TOO_LARGE",
  "error": "حجم الطلب كبير جدًا",
  "request_id": "req_ec93c8e5-a153-4d17-a4d5-2e4673ffd90d",
  "orders_before": 70,
  "orders_after": 70
}
```


### WF-007 — جسم ليس JSON صالحًا

**✅ PASS** · 4/4 فحوص · 19ms

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
  "request_id": "req_191f234d-2b00-4654-9746-7ea4cd6344a6",
  "leaks_parser_internals": false,
  "body_excerpt": "{\"error\":\"جسم الطلب ليس JSON صالحًا\",\"code\":\"VALIDATION_FAILED\",\"request_id\":\"req_191f234d-2b00-4654-9746-7ea4cd6344a6\"}"
}
```


### WF-008 — تجاوز حدود أطوال الحقول

**✅ PASS** · 7/7 فحوص · 55ms

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
- ✅ عدد الطلبات 70 → 70 (بلا تغيير)

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
  "orders_before": 70,
  "orders_after": 70
}
```


### WF-009 — هاتف غير صالح ومحافظة خارج القائمة

**✅ PASS** · 6/6 فحوص · 54ms

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
- ✅ عدد الطلبات 70 → 70

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
  "orders_before": 70,
  "orders_after": 70
}
```


### WF-026 — رؤوس الأمان مطبّقة على كل الاستجابات

**✅ PASS** · 4/4 فحوص · 131ms

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

**✅ PASS** · 4/4 فحوص · 587ms

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
  "request_id": "req_fc99331b-adeb-463c-8eb1-4443859d2253"
}
```


### WF-028 — قيمة غير مسموحة في حقل مُعدَّد وحد الأصناف

**✅ PASS** · 5/5 فحوص · 30ms

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
- ✅ عدد الطلبات 70 → 70

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
  "orders_before": 70,
  "orders_after": 70
}
```


### WF-029 — X-Request-Id على النجاح والخطأ معًا

**✅ PASS** · 5/5 فحوص · 64ms

| الحقل | القيمة |
|---|---|
| INPUT | 200 على /api/products و422 على /api/chat و401 على /api/orders و409 على طلب مرفوض |
| PRECONDITION | apiHandler يضبط X-Request-Id ويظهر request_id في جسم الخطأ |
| EXPECTED_DECISION | معرّف قابل للربط بالسجلات في كل استجابة |
| EXPECTED_SIDE_EFFECT | لا استجابة بلا معرّف |
| EVIDENCE_REQUIRED | رأس + جسم متطابقان في كل حالة |

**الفحوص**

- ✅ 200 /api/products — header=req_2f53029d-f996-44c7-9f6b-966b37d9b0ab
- ✅ 422 chat — header=req_9b1ef99d-c920-4199-b8e1-b1d3512f5582 body=req_9b1ef99d-c920-4199-b8e1-b1d3512f5582
- ✅ 401 orders — header=req_995d19f9-cb1f-4cdb-abea-04cd7c2586a5 body=req_995d19f9-cb1f-4cdb-abea-04cd7c2586a5
- ✅ 409 conflict — header=req_c8002014-00e8-4d9a-80f7-abcae6ca761c body=req_c8002014-00e8-4d9a-80f7-abcae6ca761c
- ✅ كل المعرّفات بالصيغة req_ القابلة للبحث في السجلات

**ACTUAL (دليل خام)**

```json
{
  "probes": [
    {
      "case": "200 /api/products",
      "header": "req_2f53029d-f996-44c7-9f6b-966b37d9b0ab",
      "bodyId": null
    },
    {
      "case": "422 chat",
      "header": "req_9b1ef99d-c920-4199-b8e1-b1d3512f5582",
      "bodyId": "req_9b1ef99d-c920-4199-b8e1-b1d3512f5582"
    },
    {
      "case": "401 orders",
      "header": "req_995d19f9-cb1f-4cdb-abea-04cd7c2586a5",
      "bodyId": "req_995d19f9-cb1f-4cdb-abea-04cd7c2586a5"
    },
    {
      "case": "409 conflict",
      "header": "req_c8002014-00e8-4d9a-80f7-abcae6ca761c",
      "bodyId": "req_c8002014-00e8-4d9a-80f7-abcae6ca761c"
    }
  ]
}
```


### WF-030 — مسار غير موجود — 404 بلا تسريب

**✅ PASS** · 3/3 فحوص · 67ms

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
  "traversal_excerpt": "{\"error\":\"التشخيص معطل في بيئة الإنتاج\",\"code\":\"DIAGNOSTICS_DISABLED\",\"request_id\":\"req_85f94469-71e8-4421-87c4-d3487f671d06\"}",
  "real_leak": false,
  "dev_only_artifact_present": true
}
```


### WF-031 — بناء الإنتاج لا يسرّب ما يسرّبه وضع التطوير

**✅ PASS** · 4/4 فحوص · 74ms

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


---

## الاكتشافات

### D-1 · جلسة الإدارة لا تُقبل أبدًا كما تُرسل على السلك — ❌ FAIL

**أثر:** لوحة التحكم `/admin` ميتة بالكامل. الدخول ينجح، ثم كل مسار إداري يُرجع `401`.

**الدليل من الـ Runtime:**

| خطوة | نتيجة |
|---|---|
| `POST /api/admin/login` بكلمة مرور صحيحة | `200` + `Set-Cookie` |
| قيمة الكوكيز على السلك | `1790583627844%3A_0U2eu_C0Ouyb0qc1Od-W6jpONMPfmoP.7EAMDGlwhwG4kJUEaeuLH871cW-ubwtwQ_ri_JBCwKQ` |
| `GET /api/admin/session` بنفس الكوكيز | `authenticated=false` |
| `GET /api/orders` بنفس الكوكيز | `401` `AUTH_REQUIRED` |
| `POST /api/products` بنفس الكوكيز | `401` `AUTH_REQUIRED` |

**السبب الجذري:** `createAdminSession()` تُنتج حمولة على شكل `<ts>:<nonce>` بنقطتين خام. `response.cookies.set()` ترمّز القيمة، فتصير النقطتان `%3A` على السلك. و`verifyAdminSession()` تقرأ القيمة كما وصلت فتحسب HMAC فوق النص المُرمَّز — بينما التوقيع حُسب فوق الخام — فلا يتطابق. ولو تطابق، فإن `Number(payload.split(":",1)[0])` يُعيد `NaN` لأن الفاصل لم يعد `:`، فيسقط فحص العمر أيضًا.

**إعادة الإنتاج:** `node --import tsx whatif/repro-auth-cookie.mjs` →
`verifyAdminSession(خام)=true` و`verifyAdminSession(على السلك)=false`.

**لماذا لم تلتقطه الاختبارات؟** `tests/auth.test.ts` يغطي `adminConfigIssues`/`isAdminConfigured` فقط. لا يوجد أي اختبار يمرّر الجلسة عبر ترميز الكوكيز الفعلي — وهي الخطوة الوحيدة التي تكسر العقد. 133 اختبارًا أخضر مع لوحة تحكم ميتة.

**الإصلاح المقترح (لم يُنفَّذ — الحالة مجمّدة حسب الخطة):** وحّد الترميز في طرف واحد. إما `encodeURIComponent` صريح عند الإنشاء مع `decodeURIComponent` عند التحقق، أو تجنّب `:` في الحمولة (مثلاً `<ts>.<nonce>.<sig>`). الأهم: أضف اختبار round-trip يمر عبر `response.cookies.set()` فعلًا لا عبر نص خام.

### D-2 · لا يوجد idempotency key — الضغط المزدوج يُنشئ طلبين

`createOrderContract` لا يحمل أي مفتاح تفرد. في WF-010 أنتجت ضغطتان متطابقتان طلبين منفصلين (`ORD-83627233-95233884` و`ORD-83627285-ad266519`) وخصمًا قدره 2 من المخزون. **لا يوجد فساد بيانات** — المخزون لم يتجاوز حدّه ولا سجلات يتيمة — لكن العميل قد يطلب مرتين دون قصد. القرار الحالي «كل ضغطة طلب مستقل» قرار مشروع، لكنه غير معلن ولا محمي.

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

### D-6 · نقطة التشخيص تكشف وجودها رغم وعد «404 موحّد» — ❌ FAIL

**السيناريو:** WF-025.

**ما وعد به الكود:** تعليق `src/app/api/admin/diagnostics/route.ts` ينصّ على أنها عند التعطيل «تُعيد 404 موحّدًا حتى لا يُكشف وجودها».

**ما حدث فعلًا:**

| النقطة | HTTP | code | الرسالة |
|---|---|---|---|
| `/api/admin/diagnostics` | `404` | `DIAGNOSTICS_DISABLED` | `التشخيص معطل في بيئة الإنتاج` |
| `/api/admin/mcp/tools` | `404` | `NOT_FOUND` | `هذه النقطة غير متاحة` |

نقطتان محجوبتان بعلم ميزة، بنفس المنطق الأمني المعلن، تُرجعان رسالتين مختلفتين.

**ما يُكشف:** كود `DIAGNOSTICS_DISABLED` ورسالة «التشخيص معطل» يؤكّدان للمهاجم أن المسار موجود وأنه محمي بعلم بيئة — وهذا نقيض المقصد. نقطة MCP تفعل الصواب (`NOT_FOUND` عام)، فالمخالفة في التشخيص وحده.

**ليست أثرًا لوضع التطوير:** أُعيد القياس على بناء الإنتاج (`npm run build && next start` على `:3003`) فأعادت النقطة **نفس الكود والرسالة حرفيًا**. فالسلوك ثابت في البيئتين ولا يختفي بالنشر.

**ملاحظة دقة إضافية (تخصّ dev فقط):** الرسالة تقول «معطل في بيئة الإنتاج». في الإنتاج هذه صياغة سليمة، أما في `NODE_ENV=development` فالتعطيل جاء من `DIAGNOSTICS_ENABLED=false` صراحةً لا من البيئة، فالرسالة تُسند السبب خطأً وتُربك من يُشخّص محليًا.

**الخطورة:** منخفضة — لا أسرار ولا مقاييس تخرج (`leaks_tool_names=false`)، والكشف يقتصر على وجود المسار وآلية حمايته. لكنها مخالفة صريحة لعقد أمني مكتوب في الكود، والعقود المكتوبة هي ما يُراجَع عند التدقيق.

**الإصلاح المقترح:** استخدام `Errors.notFound("هذه النقطة غير متاحة")` في نقطة التشخيص مطابقةً لنقطة MCP، وإبقاء سبب التعطيل في السجلات لا في الاستجابة.

---

## ملاحظات منهجية

1. **كل فعل قيد القياس مرّ عبر HTTP على Runtime حقيقي** — لا Mocks ولا استدعاء مباشر للدوال.
2. **ضبط الـ precondition تم كتابةً مباشرة في قاعدة البيانات** بدل `POST /api/products`، لأن D-1 يجعل أي كتابة إدارية تُرجع 401. هذا fixture للاختبار لا مسار قيد القياس، ومغطّى مستقلًا في WF-017/WF-020.
3. **كل سيناريو أخذ `x-forwarded-for` مستقلًا** لأن `bucketKey()` يشتق مفتاح تحديد المعدل منه، والحد `8/10min` على `/api/orders` كان سيعطي `429` ويخفي القرارات الحقيقية.
4. **أربع نسخ Runtime من نفس الكود، كل واحدة لظرف:**
   - `:3000` — الحالة الأساسية، `next dev`، قاعدة بيانات مربوطة.
   - `:3001` (`~/whatif-nodb`) — `TURSO_DATABASE_URL` فارغ، لـ WF-016.
   - `:3002` (`~/whatif-aifail`) — مفاتيح Gemini/Groq موجودة + `ENABLE_ORDER_TRACKING=true`، لـ WF-015 وWF-021/022.
   - `:3003` — **بناء إنتاجي** (`npm run build && next start`)، لـ WF-031 ومقاطعة D-6.
   المجلدات منفصلة لأن نسختَي dev في مجلد واحد تتصارعان على `.next`، ولأن Turbopack يرفض `node_modules` الرمزي («points out of the filesystem root») فنُسخت بالوصلات الصلبة.
5. **لم يُعدَّل أي كود تطبيق.** التغييرات الوحيدة: `next.config.mjs` (قراءة `ALLOWED_DEV_ORIGINS` من البيئة، ومعطّل افتراضيًا) ومجلد `whatif/` الجديد.
6. **حدود البيئة — ما لم يُقَس:** الاتصال الخارجي محجوب على مستوى TLS (`generativelanguage.googleapis.com` و`api.groq.com` يُرجعان `000` مع `SSL_ERROR_SYSCALL`). لذلك:
   - WF-015 قاس **انقطاع المزود** لا **رفض المفتاح**. كلاهما يُنتج نفس قرار التراجع في `chat/route.ts`، لكن «مفتاح منتهي/غير صالح» تحديدًا لم يُختبر.
   - مسار Gemini/Groq الحقيقي لم يُقَس إطلاقًا، ونتائج D-4/D-5 تخص `localAnswer` وحده.
7. **حالات FAIL في الرد الاحتياطي (D-4/D-5) ليست أعطال Runtime** بل قصور قرار في محرك بلا مفاتيح. صُنّفت FAIL لأن المتوقع كان قرارًا صحيحًا، لا لأن الطلب سقط.
8. **فحصان من فحوص المختبر صُحّحا أثناء العمل، وكلاهما كان خطأً في المختبر لا في التطبيق:**
   - **WF-012** أعطى PASS زائفًا في تشغيل مبكر: الرد ذكر «5 لتر» لأن العبوة الكبيرة `featured` فتتصدر الترتيب، لا لأن «الكبير» حُسمت. أُعيد بناؤه ليثبّت العبوة **الصغيرة** في صدارة الكتالوج؛ صار حاسمًا ونتيجته FAIL.
   - **WF-030** أعطى FAIL زائفًا: نمط الكشف عن التسريب كان يطابق `node_modules` داخل أسماء chunks الخاصة بأدوات التطوير. قُسّم النمط إلى «تسريب حقيقي» (إطار stack أو مسار نظام مطلق) مقابل «أثر تطوير»، وأُضيف WF-031 ليقيس الفرق بين dev والإنتاج بدل الاكتفاء بالادعاء. النتيجة النهائية PASS.
   القاعدة المتّبعة: أي FAIL يُقرأ ردّه الفعلي قبل اعتماده، وأي PASS يُسأل «هل يمكن أن ينجح هذا صدفة؟».

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
