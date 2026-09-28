# What-If Test Matrix — متجر أبو رفيدة العزامي

> **مختبر قرار، لا اختبار «هل وقع الموقع».** كل سيناريو يُقاس عبر السلسلة:
> `INPUT → INTENT → DATA → POLICY → AUTHORIZATION → EXECUTION → EVIDENCE → OUTCOME`

| بند | قيمة |
|---|---|
| تاريخ التشغيل | `2026-09-28T07:55:46.572Z` |
| معرّف التشغيل | `run4` |
| الـ Runtime قيد القياس | `http://127.0.0.1:3000` (Next.js على `0.0.0.0:3000`) |
| نسخة DB-down | `http://127.0.0.1:3001` (نفس الكود، `TURSO_DATABASE_URL` فارغ) |
| قاعدة البيانات | `file:local.db` عبر `@libsql/client` — نفس مسار كود Turso |
| حالة خط الأساس | orders=`11` · order_items=`11` · orphans=`0` · negative_stock=`0` |
| الحالة النهائية | orders=`16` · order_items=`16` · orphans=`0` · negative_stock=`0` |

## الملخّص

| الحالة | العدد |
|---|---|
| ✅ PASS | 10 |
| ❌ FAIL | 1 |
| **الإجمالي** | **11** |

**ثوابت سلامة لم تُكسر في أي سيناريو:** `orphan_order_items = 0` و`negative_stock_rows = 0`.

---

## المصفوفة


### WF-001 — المنتج موجود والمخزون يكفي — «عايز 20 عبوة من منظف الأرضيات باللافندر»

**✅ PASS** · 8/8 فحوص · 61ms

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
  "request_id": "req_cf8c5e72-1bda-4bbe-95ee-017a4e1eb412",
  "body": {
    "ok": true,
    "id": "ORD-82145886-f5ba439f",
    "subtotal": 3600,
    "shipping": 0,
    "total": 3600
  },
  "stock_before": 50,
  "stock_after": 30,
  "db": {
    "orders": 12,
    "order_items": 12,
    "orphan_order_items": 0,
    "negative_stock_rows": 0,
    "last_order": {
      "id": "ORD-82145886-f5ba439f",
      "total": 3600,
      "shipping_fee": 0,
      "items": "[{\"id\":\"p1\",\"name\":\"منظف أرضيات برائحة اللافندر 5 لتر\",\"price\":180,\"qty\":20}]"
    }
  }
}
```


### WF-002 — منتج غير موجود — بحث + محاولة شراء

**✅ PASS** · 7/7 فحوص · 47ms

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
- ✅ عدد الطلبات 12 → 12 (بلا تغيير)
- ✅ أصناف يتيمة = 0

**ACTUAL (دليل خام)**

```json
{
  "chat_http": 200,
  "chat_source": "local",
  "chat_reply": "أهلاً بيك 👋 دي المنتجات المناسبة لطلبك:\n• منظف أرضيات برائحة اللافندر 5 لتر — 180 جنيه\n• كلوركس مبيض ومطهر 4 لتر — 95 جنيه\n• سائل غسيل أطباق ليمون 2 لتر — 70 ج",
  "http": 409,
  "code": "CONFLICT",
  "request_id": "req_f010a45b-cf1f-4e88-bc5c-28049d42eea0",
  "body": {
    "error": "أحد المنتجات لم يعد متاحًا",
    "code": "CONFLICT",
    "request_id": "req_f010a45b-cf1f-4e88-bc5c-28049d42eea0"
  },
  "orders_before": 12,
  "orders_after": 12
}
```


### WF-003 — الكمية أكبر من المخزون — طلب 20 والمتاح 7

**✅ PASS** · 6/6 فحوص · 54ms

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
- ✅ عدد الطلبات 12 → 12 (لم يُنشأ طلب)

**ACTUAL (دليل خام)**

```json
{
  "http": 409,
  "code": "CONFLICT",
  "message": "الكمية المطلوبة من منظف أرضيات برائحة اللافندر 5 لتر غير متاحة",
  "request_id": "req_4f9d3e8f-52c5-4354-b51a-c7ff9e84af6d",
  "stock_before": 7,
  "stock_after": 7,
  "orders_before": 12,
  "orders_after": 12
}
```


### WF-004 — المخزون صفر — AVAILABILITY = FALSE

**✅ PASS** · 6/6 فحوص · 49ms

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
- ✅ عدد الطلبات 12 → 12
- ✅ صفوف بمخزون سالب = 0

**ACTUAL (دليل خام)**

```json
{
  "http": 409,
  "code": "CONFLICT",
  "message": "الكمية المطلوبة من منظف أرضيات برائحة اللافندر 5 لتر غير متاحة",
  "request_id": "req_d2da546e-3e78-4a8f-931b-a09b33c1b67b",
  "stock_before": 0,
  "stock_after": 0,
  "orders_after": 12
}
```


### WF-005 — حمولة غير صحيحة — مفتاح غير معروف + سلة فارغة

**✅ PASS** · 8/8 فحوص · 31ms

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
- ✅ request_id=req_5c8d216a-ef94-4bc2-bec4-e7045e32ec09
- ✅ orders HTTP 422 (المتوقع 422)
- ✅ orders code=VALIDATION_FAILED
- ✅ رسالة عربية مفهومة: items: السلة فارغة
- ✅ عدد الطلبات 12 → 12 (بلا تغيير)

**ACTUAL (دليل خام)**

```json
{
  "chat_http": 422,
  "chat_code": "VALIDATION_FAILED",
  "chat_error": "Unrecognized key(s) in object: 'message'",
  "chat_request_id": "req_5c8d216a-ef94-4bc2-bec4-e7045e32ec09",
  "order_http": 422,
  "order_code": "VALIDATION_FAILED",
  "order_error": "items: السلة فارغة",
  "order_request_id": "req_b7fb62db-6fe9-49f9-8a9c-50bc3fc415c6",
  "orders_before": 12,
  "orders_after": 12
}
```


### WF-010 — الضغط على «إرسال الطلب» مرتين — double submit

**✅ PASS** · 5/5 فحوص · 97ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/orders مرتين بنفس الحمولة ونفس هوية العميل |
| PRECONDITION | p1: stock=10 |
| EXPECTED_DECISION | لكل طلب قرار مستقل — لا مفتاح idempotency في العقد |
| EXPECTED_SIDE_EFFECT | طلبان منفصلان، المخزون 10→8، بلا تجاوز للمخزون |
| EVIDENCE_REQUIRED | رقما طلبين مختلفين + المخزون بعد + عدم وجود سجلات يتيمة |

**الفحوص**

- ✅ HTTP 200 / 200
- ✅ رقما الطلبين مختلفان: ORD-82146125-28d0d268 , ORD-82146148-b55df240
- ✅ المخزون 10 → 8 (خصم 2 — طلب واحد لكل ضغطة)
- ✅ صفوف بمخزون سالب = 0
- ✅ أصناف يتيمة = 0

**ACTUAL (دليل خام)**

```json
{
  "http_1": 200,
  "http_2": 200,
  "id_1": "ORD-82146125-28d0d268",
  "id_2": "ORD-82146148-b55df240",
  "request_id_1": "req_76ae8609-667e-43e5-a1e3-d4dcbd1c836d",
  "request_id_2": "req_cdd83bcc-bf59-4e45-8a1b-08183ad66428",
  "stock_before": 10,
  "stock_after": 8,
  "db": {
    "orders": 14,
    "order_items": 14,
    "orphan_order_items": 0,
    "negative_stock_rows": 0,
    "last_order": {
      "id": "ORD-82146148-b55df240",
      "total": 230,
      "shipping_fee": 50,
      "items": "[{\"id\":\"p1\",\"name\":\"منظف أرضيات برائحة اللافندر 5 لتر\",\"price\":180,\"qty\":1}]"
    }
  },
  "finding": "لا يوجد idempotency key في createOrderContract — التكرار يُنشئ طلبين"
}
```


### WF-011 — السعر تغيّر بين العرض وتأكيد الطلب + محاولة تزوير السعر

**✅ PASS** · 9/9 فحوص · 94ms

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
  "request_id": "req_f2c95d1b-5793-4ea1-92e5-d05195f43857"
}
```


### WF-016 — قاعدة البيانات غير متاحة أثناء إنشاء الطلب

**✅ PASS** · 7/7 فحوص · 37ms

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
- ✅ request_id=req_a5c4e5ae-ebda-404d-83b5-0516091599c1 للربط بالسجلات
- ✅ قراءة المنتجات HTTP 200 (تدهور آمن)
- ✅ طلبات DB الحقيقية 15 → 15 (لم يُكتب شيء)

**ACTUAL (دليل خام)**

```json
{
  "http": 503,
  "code": "SERVICE_UNAVAILABLE",
  "message": "قاعدة البيانات غير مربوطة",
  "request_id": "req_a5c4e5ae-ebda-404d-83b5-0516091599c1",
  "read_http": 200,
  "read_products": 12,
  "real_db_orders_before": 15,
  "real_db_orders_after": 15
}
```


### WF-017 — مستخدم عادي يحاول تنفيذ إجراء إداري

**✅ PASS** · 8/8 فحوص · 76ms

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
- ✅ عدد الطلبات 15 → 15

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
  "orders_before": 15,
  "orders_after": 15
}
```


### WF-018 — تنفيذ جزئي — صنفان يفشل ثانيهما، ثم تسابق على نفس المخزون

**✅ PASS** · 11/11 فحوص · 116ms

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
- ✅ أ) عدد الطلبات 15 → 15 (لا طلب)
- ✅ أ) أصناف يتيمة = 0
- ✅ ب) نتائج التزامن [200, 409] (المتوقع 200 و409 — رابح واحد)
- ✅ ب) عدد الطلبات الناجحة = 1
- ✅ ب) المخزون 5 → 1 (المتوقع 1 لا سالب)
- ✅ ب) طلبات DB 15 → 16 (+1 فقط)
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
    15,
    15
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
    15,
    16
  ],
  "b_request_ids": [
    "req_ef51bcf1-b9f9-480b-9b2f-2c89209077ae",
    "req_1c655196-f9d8-49a7-a011-de0adacd9096"
  ],
  "db": {
    "orders": 16,
    "order_items": 16,
    "orphan_order_items": 0,
    "negative_stock_rows": 0,
    "last_order": {
      "id": "ORD-82146479-1e121d32",
      "total": 1000,
      "shipping_fee": 0,
      "items": "[{\"id\":\"p1\",\"name\":\"منظف أرضيات برائحة اللافندر 5 لتر\",\"price\":250,\"qty\":4}]"
    }
  }
}
```


### WF-019 — جلسة إدارة صالحة تُرفض — defect ترميز الكوكيز (اكتشاف المختبر)

**❌ FAIL** · 3/6 فحوص · 56ms

| الحقل | القيمة |
|---|---|
| INPUT | POST /api/admin/login (كلمة مرور صحيحة) ← GET /api/admin/session و GET /api/orders بنفس الكوكيز |
| PRECONDITION | ADMIN_PASSWORD و ADMIN_SESSION_SECRET صحيحان |
| EXPECTED_DECISION | login 200 + جلسة مقبولة على كل المسارات الإدارية |
| EXPECTED_SIDE_EFFECT | authenticated:true وقراءة الطلبات 200 |
| EVIDENCE_REQUIRED | 200 على الدخول + authenticated + حالة المسارات الإدارية + قيمة الكوكيز على السلك |

**الفحوص**

- ✅ الدخول HTTP 200 (كلمة المرور مقبولة)
- ✅ كوكيز صدر فعلًا: 1790582146533%3AVUiIdqTj…
- ✅ GET /api/admin/session HTTP 200
- ❌ authenticated=false (المتوقع true — DEFECT: القيمة على السلك تحتوي %3A)
- ❌ GET /api/orders بجلسة صالحة HTTP 401 (المتوقع 200)
- ❌ POST /api/products بجلسة صالحة HTTP 401 (المتوقع 200)

**ACTUAL (دليل خام)**

```json
{
  "login_http": 200,
  "cookie_value_on_the_wire": "1790582146533%3AVUiIdqTjyXgnuXuky7gbvWmOiiRvg3fv.wNo8LPTwCssty2HM92nAJVFk4pFXBrlQMvGHyl2oB6U",
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
| قيمة الكوكيز على السلك | `1790582146533%3AVUiIdqTjyXgnuXuky7gbvWmOiiRvg3fv.wNo8LPTwCssty2HM92nAJVFk4pFXBrlQMvGHyl2oB6U` |
| `GET /api/admin/session` بنفس الكوكيز | `authenticated=false` |
| `GET /api/orders` بنفس الكوكيز | `401` `AUTH_REQUIRED` |
| `POST /api/products` بنفس الكوكيز | `401` `AUTH_REQUIRED` |

**السبب الجذري:** `createAdminSession()` تُنتج حمولة على شكل `<ts>:<nonce>` بنقطتين خام. `response.cookies.set()` ترمّز القيمة، فتصير النقطتان `%3A` على السلك. و`verifyAdminSession()` تقرأ القيمة كما وصلت فتحسب HMAC فوق النص المُرمَّز — بينما التوقيع حُسب فوق الخام — فلا يتطابق. ولو تطابق، فإن `Number(payload.split(":",1)[0])` يُعيد `NaN` لأن الفاصل لم يعد `:`، فيسقط فحص العمر أيضًا.

**إعادة الإنتاج:** `node --import tsx whatif/repro-auth-cookie.mjs` →
`verifyAdminSession(خام)=true` و`verifyAdminSession(على السلك)=false`.

**لماذا لم تلتقطه الاختبارات؟** `tests/auth.test.ts` يغطي `adminConfigIssues`/`isAdminConfigured` فقط. لا يوجد أي اختبار يمرّر الجلسة عبر ترميز الكوكيز الفعلي — وهي الخطوة الوحيدة التي تكسر العقد. 133 اختبارًا أخضر مع لوحة تحكم ميتة.

**الإصلاح المقترح (لم يُنفَّذ — الحالة مجمّدة حسب الخطة):** وحّد الترميز في طرف واحد. إما `encodeURIComponent` صريح عند الإنشاء مع `decodeURIComponent` عند التحقق، أو تجنّب `:` في الحمولة (مثلاً `<ts>.<nonce>.<sig>`). الأهم: أضف اختبار round-trip يمر عبر `response.cookies.set()` فعلًا لا عبر نص خام.

### D-2 · لا يوجد idempotency key — الضغط المزدوج يُنشئ طلبين

`createOrderContract` لا يحمل أي مفتاح تفرد. في WF-010 أنتجت ضغطتان متطابقتان طلبين منفصلين (`ORD-82146125-28d0d268` و`ORD-82146148-b55df240`) وخصمًا قدره 2 من المخزون. **لا يوجد فساد بيانات** — المخزون لم يتجاوز حدّه ولا سجلات يتيمة — لكن العميل قد يطلب مرتين دون قصد. القرار الحالي «كل ضغطة طلب مستقل» قرار مشروع، لكنه غير معلن ولا محمي.

### D-3 · ملاحظة CSP

`Content-Security-Policy` تعمل في وضع `Report-Only` (`CSP_ENFORCE !== "true"`). هي تراقب ولا تفرض. هذا مقصود في الكود، لكنه يعني أن أي انتهاك CSP حاليًا لا يُحجب فعليًا.

---

## ملاحظات منهجية

1. **كل فعل قيد القياس مرّ عبر HTTP على Runtime حقيقي** — لا Mocks ولا استدعاء مباشر للدوال.
2. **ضبط الـ precondition تم كتابةً مباشرة في قاعدة البيانات** بدل `POST /api/products`، لأن D-1 يجعل أي كتابة إدارية تُرجع 401. هذا fixture للاختبار لا مسار قيد القياس، ومغطّى مستقلًا في WF-017/WF-019.
3. **كل سيناريو أخذ `x-forwarded-for` مستقلًا** لأن `bucketKey()` يشتق مفتاح تحديد المعدل منه، والحد `8/10min` على `/api/orders` كان سيعطي `429` ويخفي القرارات الحقيقية.
4. **نسخة DB-down تعمل من مجلد منفصل** (`~/whatif-nodb`) حتى لا تتصارع نسختا dev على `.next`.
5. **لم يُعدَّل أي كود تطبيق.** التغييرات الوحيدة: `next.config.mjs` (قراءة `ALLOWED_DEV_ORIGINS` من البيئة، ومعطّل افتراضيًا) ومجلد `whatif/` الجديد.

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
