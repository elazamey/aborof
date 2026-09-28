#!/usr/bin/env node
/**
 * مختبر What-If — يشغّل سيناريوهات على الـ Runtime الحقيقي (خادم Next فعلي)،
 * لا على Mocks. كل سيناريو يضبط precondition عبر واجهة الإدارة الحقيقية،
 * ينفّذ الفعل عبر HTTP، ثم يجمع الدليل من الاستجابة + من قاعدة البيانات.
 *
 * التشغيل:
 *   node whatif/run-whatif.mjs                # على http://127.0.0.1:3000
 *   BASE=http://127.0.0.1:3000 ADMIN_PASSWORD=... node whatif/run-whatif.mjs
 *
 * المخرجات: whatif/evidence.json (دليل خام) + جدول ملخّص على stdout.
 */

import { createClient } from "@libsql/client";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const NODB_BASE = process.env.NODB_BASE ?? "http://127.0.0.1:3001";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "dev-local-pass-12345";
const DB_URL = process.env.WHATIF_DB_URL ?? `file:${join(ROOT, "local.db")}`;

/** بادئة فريدة لكل تشغيل حتى لا تتصادم buckets تحديد المعدل بين تشغيلات متتالية. */
const RUN = process.env.WHATIF_RUN ?? `r${Date.now().toString(36)}`;

// ---------------------------------------------------------------- أدوات HTTP

async function req(base, method, path, { body, headers = {}, xff } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  // كل سيناريو يأخذ هوية عميل مستقلة (bucket مستقل لتحديد المعدل).
  if (xff) h["x-forwarded-for"] = xff;
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const requestId = res.headers.get("x-request-id");
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, requestId };
}

async function login(base = BASE) {
  const r = await req(base, "POST", "/api/admin/login", {
    body: { password: ADMIN_PASSWORD },
  });
  if (r.status !== 200) throw new Error(`admin login failed: ${r.status} ${r.text}`);
  const setCookie = r.text; // not enough; refetch with raw headers below
  return setCookie;
}

/** دخول الإدارة مع التقاط كوكيز الجلسة فعليًا. */
async function adminCookie(base = BASE) {
  const res = await fetch(base + "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`admin login failed: ${res.status} ${await res.text()}`);
  const raw = res.headers.getSetCookie?.() ?? [];
  const pairs = raw.map((c) => c.split(";")[0]);
  if (!pairs.length) throw new Error("admin login returned no cookies");
  return pairs.join("; ");
}

let COOKIE = "";
const auth = () => ({ cookie: COOKIE });

// ------------------------------------------------------- قراءة/ضبط الحالة

async function products() {
  const r = await req(BASE, "GET", "/api/products");
  return new Map((r.json?.products ?? []).map((p) => [String(p.id), p]));
}

/**
 * ضبط الـ precondition.
 *
 * ملاحظة منهجية مهمة: المسار الطبيعي لضبط المخزون هو `POST /api/products`
 * بجلسة إدارة. لكن WF-019 أثبت أن جلسة الإدارة لا تُقبل أبدًا كما تُرسل على
 * السلك (defect في ترميز الكوكيز)، فكل كتابة إدارية تُرجع 401.
 *
 * لذلك تُضبط الحالات هنا كتابةً مباشرة في قاعدة البيانات — وهي *fixture*
 * للاختبار وليست مسارًا قيد القياس. كل فعل قيد القياس (إنشاء الطلب،
 * التفويض، التحقق، التزامن) ما زال يمر عبر HTTP على الـ Runtime الحقيقي.
 * مسار الإدارة نفسه مغطّى ومستقل في WF-017 وWF-019.
 */
async function setProduct(id, patch) {
  const c = createClient({ url: DB_URL });
  try {
    const cur = await c.execute({ sql: "SELECT * FROM products WHERE id=?", args: [id] });
    const p = cur.rows[0];
    if (!p) throw new Error(`setProduct: ${id} not in catalog`);
    const next = {
      price: patch.price ?? Number(p.price),
      old_price: "old_price" in patch ? patch.old_price : (p.old_price == null ? null : Number(p.old_price)),
      stock: patch.stock ?? Number(p.stock),
    };
    await c.execute({
      sql: "UPDATE products SET price=?, old_price=?, stock=? WHERE id=?",
      args: [next.price, next.old_price, next.stock, id],
    });
    return { id, ...next };
  } finally {
    c.close();
  }
}

async function stockOf(id) {
  const p = (await products()).get(id);
  return p ? Number(p.stock) : null;
}

/**
 * قراءة صفوف الطلبات.
 *
 * المسار الطبيعي `GET /api/orders` محمي بجلسة الإدارة، وWF-019 أثبت أن الجلسة
 * لا تُقبل كما تُرسل على السلك. لذا تُقرأ الصفوف هنا مباشرة من قاعدة البيانات
 * كجزء من جمع الدليل — القرار قيد القياس (التسعير وقت التنفيذ) ما زال صادرًا
 * عن الـ Runtime نفسه عبر استجابة `POST /api/orders`.
 */
async function orders() {
  const c = createClient({ url: DB_URL });
  try {
    const r = await c.execute(
      "SELECT id,customer,phone,address,governorate,items,total,shipping_fee,payment,transfer_ref,receipt_url,status,note,created_at FROM orders ORDER BY created_at DESC LIMIT 200"
    );
    return r.rows.map((x) => ({ ...x }));
  } finally {
    c.close();
  }
}

/** دليل مباشر من قاعدة البيانات: عدد الطلبات/الأصناف وفحص السجلات اليتيمة. */
async function dbFacts() {
  const c = createClient({ url: DB_URL });
  try {
    const o = await c.execute("SELECT COUNT(*) AS n FROM orders");
    const oi = await c.execute("SELECT COUNT(*) AS n FROM order_items");
    const orphan = await c.execute(
      "SELECT COUNT(*) AS n FROM order_items oi LEFT JOIN orders o ON o.id=oi.order_id WHERE o.id IS NULL"
    );
    const neg = await c.execute("SELECT COUNT(*) AS n FROM products WHERE stock < 0");
    const lastOrder = await c.execute(
      "SELECT id,total,shipping_fee,items FROM orders ORDER BY rowid DESC LIMIT 1"
    );
    return {
      orders: Number(o.rows[0].n),
      order_items: Number(oi.rows[0].n),
      orphan_order_items: Number(orphan.rows[0].n),
      negative_stock_rows: Number(neg.rows[0].n),
      last_order: lastOrder.rows[0] ? { ...lastOrder.rows[0] } : null,
    };
  } finally {
    c.close();
  }
}

// ------------------------------------------------------------ إطار السيناريو

const results = [];

function check(cond, detail) {
  return { ok: Boolean(cond), detail };
}

async function scenario(meta, fn) {
  const started = Date.now();
  const rec = { id: meta.id, ...meta, checks: [], actual: null, status: "NOT VERIFIED", ms: 0 };
  results.push(rec);
  try {
    const out = await fn(rec);
    // الجسم يسجّل `rec.actual` بنفسه؛ لا نطمسه إن لم يُعد الجسم بديلاً.
    if (out?.actual !== undefined) rec.actual = out.actual;
    if (out?.checks) rec.checks.push(...out.checks);
    const failed = rec.checks.filter((c) => !c.ok);
    rec.status = rec.checks.length === 0 ? "NOT VERIFIED" : failed.length === 0 ? "PASS" : "FAIL";
  } catch (e) {
    rec.status = "BLOCKED";
    rec.error = String(e?.message ?? e);
  }
  rec.ms = Date.now() - started;
  const icon = { PASS: "✅", FAIL: "❌", BLOCKED: "⛔", "NOT VERIFIED": "❔" }[rec.status];
  console.log(`${icon} ${rec.id} — ${rec.title} [${rec.status}] ${rec.ms}ms`);
  for (const c of rec.checks) console.log(`     ${c.ok ? "·" : "×"} ${c.detail}`);
  if (rec.error) console.log(`     ! ${rec.error}`);
  return rec;
}

const order = (items, over = {}) => ({
  customer: "عميل مختبر What-If",
  phone: "01095032221",
  address: "شارع التحرير 12، شقة 4",
  governorate: "القاهرة",
  payment: "cod",
  items,
  ...over,
});

// ================================================================ السيناريوهات

COOKIE = await adminCookie();
console.log(`\nRuntime: ${BASE} | DB-less: ${NODB_BASE} | run=${RUN}`);
console.log(`admin session acquired (${COOKIE.split(";").length} cookie)\n`);

const baseline = await dbFacts();
console.log(
  `baseline: orders=${baseline.orders} order_items=${baseline.order_items} orphans=${baseline.orphan_order_items} negative_stock=${baseline.negative_stock_rows}\n`
);

// ---------------------------------------------------------------- WF-001
await scenario(
  {
    id: "WF-001",
    title: "المنتج موجود والمخزون يكفي — «عايز 20 عبوة من منظف الأرضيات باللافندر»",
    input: "POST /api/orders {items:[{p1,20}]}",
    precondition: "p1: stock=50, price=180",
    expected_decision: "FIND → CHECK STOCK → ACCEPT",
    expected_side_effect: "طلب واحد، subtotal=3600، شحن=0 (فوق 1000)، المخزون 50→30",
    evidence_required: "200 + رقم طلب + المخزون بعد + صف الطلب في DB",
  },
  async (rec) => {
    await setProduct("p1", { stock: 50, price: 180, old_price: 220 });
    const before = await stockOf("p1");
    const r = await req(BASE, "POST", "/api/orders", {
      body: order([{ id: "p1", qty: 20 }]),
      xff: `${RUN}-wf001`,
    });
    const after = await stockOf("p1");
    const facts = await dbFacts();
    rec.actual = {
      http: r.status,
      request_id: r.requestId,
      body: r.json,
      stock_before: before,
      stock_after: after,
      db: facts,
    };
    return {
      checks: [
        check(r.status === 200, `HTTP ${r.status} (المتوقع 200)`),
        check(r.json?.ok === true, `ok=${r.json?.ok}`),
        check(r.json?.subtotal === 3600, `subtotal=${r.json?.subtotal} (المتوقع 3600 = 20×180)`),
        check(r.json?.shipping === 0, `shipping=${r.json?.shipping} (المتوقع 0 — فوق حد الشحن المجاني 1000)`),
        check(r.json?.total === 3600, `total=${r.json?.total} (المتوقع 3600)`),
        check(after === before - 20, `المخزون ${before} → ${after} (المتوقع ${before - 20})`),
        check(facts.negative_stock_rows === 0, `صفوف بمخزون سالب = ${facts.negative_stock_rows}`),
        check(facts.orphan_order_items === 0, `أصناف يتيمة = ${facts.orphan_order_items}`),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-002
await scenario(
  {
    id: "WF-002",
    title: "منتج غير موجود — بحث + محاولة شراء",
    input: "chat: «عندكم منظف زئبق للقمر؟» ثم POST /api/orders {items:[{p-ghost,1}]}",
    precondition: "لا يوجد منتج بهذا المعرف/الاسم",
    expected_decision: "SEARCH → NOT_FOUND → SAFE RESPONSE / 409 CONFLICT",
    expected_side_effect: "لا طلب، لا خصم مخزون، رد آمن بلا اختراع منتج",
    evidence_required: "رد الدردشة + 409 + ثبات المخزون وعدد الطلبات",
  },
  async (rec) => {
    const chat = await req(BASE, "POST", "/api/chat", {
      body: { messages: [{ role: "user", content: "عندكم منظف زئبق للقمر؟" }] },
      xff: `${RUN}-wf002chat`,
    });
    const before = await dbFacts();
    const r = await req(BASE, "POST", "/api/orders", {
      body: order([{ id: "p-ghost-not-in-catalog", qty: 1 }]),
      xff: `${RUN}-wf002`,
    });
    const after = await dbFacts();
    rec.actual = {
      chat_http: chat.status,
      chat_source: chat.json?.source,
      chat_reply: chat.json?.reply?.slice(0, 160),
      http: r.status,
      code: r.json?.code,
      request_id: r.requestId,
      body: r.json,
      orders_before: before.orders,
      orders_after: after.orders,
    };
    return {
      checks: [
        check(chat.status === 200, `chat HTTP ${chat.status}`),
        check(typeof chat.json?.reply === "string" && chat.json.reply.length > 0, "الدردشة ردّت نصًا آمنًا"),
        check(
          !/زئبق للقمر/.test(chat.json?.reply ?? "") || /غير متوفر|مش موجود|تحت أمرك/.test(chat.json?.reply ?? ""),
          "الرد لم يؤكّد توافر منتج غير موجود"
        ),
        check(r.status === 409, `HTTP ${r.status} (المتوقع 409)`),
        check(r.json?.code === "CONFLICT", `code=${r.json?.code} (المتوقع CONFLICT)`),
        check(after.orders === before.orders, `عدد الطلبات ${before.orders} → ${after.orders} (بلا تغيير)`),
        check(after.orphan_order_items === 0, `أصناف يتيمة = ${after.orphan_order_items}`),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-003
await scenario(
  {
    id: "WF-003",
    title: "الكمية أكبر من المخزون — طلب 20 والمتاح 7",
    input: "POST /api/orders {items:[{p1,20}]}",
    precondition: "p1: stock=7",
    expected_decision: "VALIDATE QUANTITY → BLOCK → EXPLAIN WHY",
    expected_side_effect: "لا طلب، المخزون يبقى 7، رسالة تسمّي المنتج",
    evidence_required: "409 + نص الرسالة + المخزون قبل/بعد + عدد الطلبات",
  },
  async (rec) => {
    await setProduct("p1", { stock: 7 });
    const before = await stockOf("p1");
    const ordersBefore = (await dbFacts()).orders;
    const r = await req(BASE, "POST", "/api/orders", {
      body: order([{ id: "p1", qty: 20 }]),
      xff: `${RUN}-wf003`,
    });
    const after = await stockOf("p1");
    const facts = await dbFacts();
    rec.actual = {
      http: r.status,
      code: r.json?.code,
      message: r.json?.error,
      request_id: r.requestId,
      stock_before: before,
      stock_after: after,
      orders_before: ordersBefore,
      orders_after: facts.orders,
    };
    return {
      checks: [
        check(r.status === 409, `HTTP ${r.status} (المتوقع 409)`),
        check(r.json?.code === "CONFLICT", `code=${r.json?.code}`),
        check(/الكمية المطلوبة/.test(r.json?.error ?? ""), `الرسالة تشرح السبب: «${r.json?.error}»`),
        check(/لافندر/.test(r.json?.error ?? ""), "الرسالة تسمّي المنتج المعني"),
        check(after === before, `المخزون ${before} → ${after} (لم يُخصم شيء)`),
        check(facts.orders === ordersBefore, `عدد الطلبات ${ordersBefore} → ${facts.orders} (لم يُنشأ طلب)`),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-004
await scenario(
  {
    id: "WF-004",
    title: "المخزون صفر — AVAILABILITY = FALSE",
    input: "POST /api/orders {items:[{p1,1}]}",
    precondition: "p1: stock=0",
    expected_decision: "CHECK STOCK → ORDER_BLOCKED",
    expected_side_effect: "لا طلب، المخزون يبقى 0",
    evidence_required: "409 + ثبات المخزون وعدد الطلبات",
  },
  async (rec) => {
    await setProduct("p1", { stock: 0 });
    const before = await stockOf("p1");
    const ordersBefore = (await dbFacts()).orders;
    const r = await req(BASE, "POST", "/api/orders", {
      body: order([{ id: "p1", qty: 1 }]),
      xff: `${RUN}-wf004`,
    });
    const after = await stockOf("p1");
    const facts = await dbFacts();
    rec.actual = {
      http: r.status,
      code: r.json?.code,
      message: r.json?.error,
      request_id: r.requestId,
      stock_before: before,
      stock_after: after,
      orders_after: facts.orders,
    };
    return {
      checks: [
        check(before === 0, `precondition: stock=${before}`),
        check(r.status === 409, `HTTP ${r.status} (المتوقع 409)`),
        check(r.json?.code === "CONFLICT", `code=${r.json?.code}`),
        check(after === 0, `المخزون بعد = ${after} (لم يصبح سالبًا)`),
        check(facts.orders === ordersBefore, `عدد الطلبات ${ordersBefore} → ${facts.orders}`),
        check(facts.negative_stock_rows === 0, `صفوف بمخزون سالب = ${facts.negative_stock_rows}`),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-005
await scenario(
  {
    id: "WF-005",
    title: "حمولة غير صحيحة — مفتاح غير معروف + سلة فارغة",
    input: "POST /api/chat {message:...} ثم POST /api/orders {items:[]}",
    precondition: "لا شيء",
    expected_decision: "ZOD STRICT → 422 VALIDATION_FAILED",
    expected_side_effect: "لا طلب، لا كتابة في DB، request_id للربط بالسجلات",
    evidence_required: "422 + code + request_id + ثبات عدد الطلبات",
  },
  async (rec) => {
    const before = (await dbFacts()).orders;
    const a = await req(BASE, "POST", "/api/chat", {
      body: { message: "سعر المنظف كام؟" },
      xff: `${RUN}-wf005a`,
    });
    const b = await req(BASE, "POST", "/api/orders", {
      body: order([]),
      xff: `${RUN}-wf005b`,
    });
    const after = (await dbFacts()).orders;
    rec.actual = {
      chat_http: a.status,
      chat_code: a.json?.code,
      chat_error: a.json?.error,
      chat_request_id: a.requestId,
      order_http: b.status,
      order_code: b.json?.code,
      order_error: b.json?.error,
      order_request_id: b.requestId,
      orders_before: before,
      orders_after: after,
    };
    return {
      checks: [
        check(a.status === 422, `chat HTTP ${a.status} (المتوقع 422)`),
        check(a.json?.code === "VALIDATION_FAILED", `chat code=${a.json?.code}`),
        check(/Unrecognized key/.test(a.json?.error ?? ""), `العقد strict رفض المفتاح: ${a.json?.error}`),
        check(typeof a.requestId === "string" && a.requestId.length > 0, `request_id=${a.requestId}`),
        check(b.status === 422, `orders HTTP ${b.status} (المتوقع 422)`),
        check(b.json?.code === "VALIDATION_FAILED", `orders code=${b.json?.code}`),
        check(/السلة فارغة/.test(b.json?.error ?? ""), `رسالة عربية مفهومة: ${b.json?.error}`),
        check(after === before, `عدد الطلبات ${before} → ${after} (بلا تغيير)`),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-010
await scenario(
  {
    id: "WF-010",
    title: "الضغط على «إرسال الطلب» مرتين — double submit",
    input: "POST /api/orders مرتين بنفس الحمولة ونفس هوية العميل",
    precondition: "p1: stock=10",
    expected_decision: "لكل طلب قرار مستقل — لا مفتاح idempotency في العقد",
    expected_side_effect: "طلبان منفصلان، المخزون 10→8، بلا تجاوز للمخزون",
    evidence_required: "رقما طلبين مختلفين + المخزون بعد + عدم وجود سجلات يتيمة",
  },
  async (rec) => {
    await setProduct("p1", { stock: 10 });
    const before = await stockOf("p1");
    const xff = `${RUN}-wf010`;
    const r1 = await req(BASE, "POST", "/api/orders", {
      body: order([{ id: "p1", qty: 1 }]),
      xff,
    });
    const r2 = await req(BASE, "POST", "/api/orders", {
      body: order([{ id: "p1", qty: 1 }]),
      xff,
    });
    const after = await stockOf("p1");
    const facts = await dbFacts();
    const ids = [r1.json?.id, r2.json?.id].filter(Boolean);
    rec.actual = {
      http_1: r1.status,
      http_2: r2.status,
      id_1: r1.json?.id,
      id_2: r2.json?.id,
      request_id_1: r1.requestId,
      request_id_2: r2.requestId,
      stock_before: before,
      stock_after: after,
      db: facts,
      finding: "لا يوجد idempotency key في createOrderContract — التكرار يُنشئ طلبين",
    };
    return {
      checks: [
        check(r1.status === 200 && r2.status === 200, `HTTP ${r1.status} / ${r2.status}`),
        check(ids.length === 2 && ids[0] !== ids[1], `رقما الطلبين مختلفان: ${ids.join(" , ")}`),
        check(after === before - 2, `المخزون ${before} → ${after} (خصم 2 — طلب واحد لكل ضغطة)`),
        check(facts.negative_stock_rows === 0, `صفوف بمخزون سالب = ${facts.negative_stock_rows}`),
        check(facts.orphan_order_items === 0, `أصناف يتيمة = ${facts.orphan_order_items}`),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-011
await scenario(
  {
    id: "WF-011",
    title: "السعر تغيّر بين العرض وتأكيد الطلب + محاولة تزوير السعر",
    input: "عرض 180 ← الإدارة ترفعه إلى 250 ← POST /api/orders {items:[{p1,1}]}",
    precondition: "p1: price=180 ثم price=250 (old_price=null)",
    expected_decision: "إعادة حساب السعر من مصدر موثوق؛ العقد لا يقبل سعرًا من العميل",
    expected_side_effect: "الطلب يُسعَّر بـ 250 لا 180؛ الحمولة المزوّرة تُرفض 422",
    evidence_required: "total=300 (250+50) + price داخل items + 422 للتزوير",
  },
  async (rec) => {
    await setProduct("p1", { stock: 50, price: 180, old_price: 220 });
    const viewed = Number((await products()).get("p1").price); // ما رآه العميل
    await setProduct("p1", { price: 250, old_price: null }); // تغيّر تحت النظام
    const r = await req(BASE, "POST", "/api/orders", {
      body: order([{ id: "p1", qty: 1 }]),
      xff: `${RUN}-wf011`,
    });
    const tampered = await req(BASE, "POST", "/api/orders", {
      body: order([{ id: "p1", qty: 1, price: 1 }]),
      xff: `${RUN}-wf011t`,
    });
    const stored = r.json?.id
      ? (await orders()).find((o) => o.id === r.json.id)
      : null;
    rec.actual = {
      price_viewed_by_customer: viewed,
      price_at_commit: 250,
      http: r.status,
      subtotal: r.json?.subtotal,
      shipping: r.json?.shipping,
      total: r.json?.total,
      stored_items: stored?.items,
      tamper_http: tampered.status,
      tamper_code: tampered.json?.code,
      tamper_error: tampered.json?.error,
      request_id: r.requestId,
    };
    return {
      checks: [
        check(viewed === 180, `precondition: السعر المعروض = ${viewed}`),
        check(r.status === 200, `HTTP ${r.status}`),
        check(r.json?.subtotal === 250, `subtotal=${r.json?.subtotal} (المتوقع 250 — سعر وقت التنفيذ لا وقت العرض)`),
        check(r.json?.shipping === 50, `shipping=${r.json?.shipping} (المتوقع 50 — تحت حد 1000)`),
        check(r.json?.total === 300, `total=${r.json?.total} (المتوقع 300)`),
        check(/"price":250/.test(String(stored?.items ?? "")), `السعر المخزّن في صف الطلب = 250`),
        check(tampered.status === 422, `تزوير السعر → HTTP ${tampered.status} (المتوقع 422)`),
        check(tampered.json?.code === "VALIDATION_FAILED", `code=${tampered.json?.code}`),
        check(/Unrecognized key/.test(tampered.json?.error ?? ""), `العقد strict رفض حقل price: ${tampered.json?.error}`),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-016
await scenario(
  {
    id: "WF-016",
    title: "قاعدة البيانات غير متاحة أثناء إنشاء الطلب",
    input: "POST /api/orders على نسخة Runtime بلا TURSO_DATABASE_URL (:3001)",
    precondition: "TURSO_DATABASE_URL فارغ — db() يُعيد null",
    expected_decision: "SERVICE_UNAVAILABLE — لا نجاح كاذب",
    expected_side_effect: "لا طلب، والقراءة تتدهور بأمان إلى منتجات البذر",
    evidence_required: "503 + code + request_id + 200 على القراءة + عدم ظهور طلب في DB الحقيقية",
  },
  async (rec) => {
    const before = await dbFacts();
    const r = await req(NODB_BASE, "POST", "/api/orders", {
      body: order([{ id: "p1", qty: 1 }]),
      xff: `${RUN}-wf016`,
    });
    const read = await req(NODB_BASE, "GET", "/api/products");
    const after = await dbFacts();
    rec.actual = {
      http: r.status,
      code: r.json?.code,
      message: r.json?.error,
      request_id: r.requestId,
      read_http: read.status,
      read_products: read.json?.products?.length,
      real_db_orders_before: before.orders,
      real_db_orders_after: after.orders,
    };
    return {
      checks: [
        check(r.status === 503, `HTTP ${r.status} (المتوقع 503)`),
        check(r.json?.code === "SERVICE_UNAVAILABLE", `code=${r.json?.code}`),
        check(r.json?.ok !== true, `لا يوجد ok:true في الاستجابة (لا نجاح كاذب)`),
        check(!/ORD-/.test(r.text), `لا رقم طلب في الاستجابة`),
        check(typeof r.requestId === "string", `request_id=${r.requestId} للربط بالسجلات`),
        check(read.status === 200, `قراءة المنتجات HTTP ${read.status} (تدهور آمن)`),
        check(after.orders === before.orders, `طلبات DB الحقيقية ${before.orders} → ${after.orders} (لم يُكتب شيء)`),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-017
await scenario(
  {
    id: "WF-017",
    title: "مستخدم عادي يحاول تنفيذ إجراء إداري",
    input: "POST /api/products و PATCH /api/orders و GET /api/orders — بلا كوكيز، وبكوكيز مزوّر",
    precondition: "لا جلسة إدارة صالحة",
    expected_decision: "AUTHORIZATION → 401 AUTH_REQUIRED",
    expected_side_effect: "لا كتابة، لا كشف بيانات الطلبات، لا تغيير مخزون",
    evidence_required: "401 على المسارات الأربعة + ثبات المخزون وعدد الطلبات",
  },
  async (rec) => {
    const before = await stockOf("p1");
    const ordersBefore = (await dbFacts()).orders;

    const noCookie = await req(BASE, "POST", "/api/products", {
      body: { product: { name: "اختراق", price: 1, stock: 999 } },
      xff: `${RUN}-wf017a`,
    });
    const patch = await req(BASE, "PATCH", "/api/orders", {
      body: { id: "ORD-00000000-00000000", status: "مكتمل" },
      xff: `${RUN}-wf017b`,
    });
    const list = await req(BASE, "GET", "/api/orders", { xff: `${RUN}-wf017c` });
    const forged = await req(BASE, "POST", "/api/products", {
      body: { product: { name: "اختراق", price: 1, stock: 999 } },
      headers: { cookie: "aborof_admin_session=1700000000000:Zm9yZ2Vk.forgedsignature" },
      xff: `${RUN}-wf017d`,
    });
    const del = await req(BASE, "DELETE", "/api/products?id=p1", { xff: `${RUN}-wf017e` });

    const after = await stockOf("p1");
    const facts = await dbFacts();
    rec.actual = {
      post_products: noCookie.status,
      patch_orders: patch.status,
      list_orders: list.status,
      list_code: list.json?.code,
      forged_cookie: forged.status,
      delete_product: del.status,
      stock_before: before,
      stock_after: after,
      orders_before: ordersBefore,
      orders_after: facts.orders,
    };
    return {
      checks: [
        check(noCookie.status === 401, `POST /api/products بلا كوكيز → ${noCookie.status}`),
        check(patch.status === 401, `PATCH /api/orders بلا كوكيز → ${patch.status}`),
        check(list.status === 401, `GET /api/orders بلا كوكيز → ${list.status}`),
        check(list.json?.code === "AUTH_REQUIRED", `code=${list.json?.code} (لا كشف لبيانات الطلبات)`),
        check(forged.status === 401, `كوكيز موقّع تزويرًا → ${forged.status} (HMAC مرفوض)`),
        check(del.status === 401, `DELETE /api/products بلا كوكيز → ${del.status}`),
        check(after === before, `المخزون ${before} → ${after} (لم يتغير)`),
        check(facts.orders === ordersBefore, `عدد الطلبات ${ordersBefore} → ${facts.orders}`),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-018
await scenario(
  {
    id: "WF-018",
    title: "تنفيذ جزئي — صنفان يفشل ثانيهما، ثم تسابق على نفس المخزون",
    input: "أ) items:[{p1,1},{p2,1}] والمخزون p2=0  ب) طلبان متزامنان qty=4 والمخزون 5",
    precondition: "أ) p1.stock=10, p2.stock=0   ب) p1.stock=5",
    expected_decision: "أ) الكل أو لا شيء — لا خصم جزئي  ب) طلب واحد فقط ينجح",
    expected_side_effect: "أ) p1 يبقى 10 ولا طلب  ب) المخزون 1 لا −3، وطلب واحد فقط",
    evidence_required: "409 + ثبات p1 + نتائج التزامن + أصناف يتيمة = 0",
  },
  async (rec) => {
    // (أ) فشل قبل المعاملة: لا كتابة جزئية إطلاقًا
    await setProduct("p1", { stock: 10 });
    await setProduct("p2", { stock: 0 });
    const p1Before = await stockOf("p1");
    const ordersBefore = (await dbFacts()).orders;
    const partial = await req(BASE, "POST", "/api/orders", {
      body: order([
        { id: "p1", qty: 1 },
        { id: "p2", qty: 1 },
      ]),
      xff: `${RUN}-wf018a`,
    });
    const p1After = await stockOf("p1");
    const factsA = await dbFacts();

    // (ب) فشل داخل المعاملة: التسابق على نفس الصف
    await setProduct("p1", { stock: 5 });
    const raceBefore = await stockOf("p1");
    const raceOrdersBefore = (await dbFacts()).orders;
    const xff = `${RUN}-wf018b`;
    const [c1, c2] = await Promise.all([
      req(BASE, "POST", "/api/orders", { body: order([{ id: "p1", qty: 4 }]), xff }),
      req(BASE, "POST", "/api/orders", { body: order([{ id: "p1", qty: 4 }]), xff }),
    ]);
    const raceAfter = await stockOf("p1");
    const factsB = await dbFacts();
    const statuses = [c1.status, c2.status].sort();
    const winners = [c1, c2].filter((c) => c.status === 200);

    rec.actual = {
      a_http: partial.status,
      a_code: partial.json?.code,
      a_message: partial.json?.error,
      a_p1_before: p1Before,
      a_p1_after: p1After,
      a_orders: [ordersBefore, factsA.orders],
      b_http: [c1.status, c2.status],
      b_codes: [c1.json?.code, c2.json?.code],
      b_stock_before: raceBefore,
      b_stock_after: raceAfter,
      b_orders_created: [raceOrdersBefore, factsB.orders],
      b_request_ids: [c1.requestId, c2.requestId],
      db: factsB,
    };
    return {
      checks: [
        check(partial.status === 409, `أ) HTTP ${partial.status} (المتوقع 409)`),
        check(partial.json?.code === "CONFLICT", `أ) code=${partial.json?.code}`),
        check(p1After === p1Before, `أ) p1: ${p1Before} → ${p1After} (لا خصم جزئي للصنف الناجح)`),
        check(factsA.orders === ordersBefore, `أ) عدد الطلبات ${ordersBefore} → ${factsA.orders} (لا طلب)`),
        check(factsA.orphan_order_items === 0, `أ) أصناف يتيمة = ${factsA.orphan_order_items}`),
        check(
          statuses[0] === 200 && statuses[1] === 409,
          `ب) نتائج التزامن [${c1.status}, ${c2.status}] (المتوقع 200 و409 — رابح واحد)`
        ),
        check(winners.length === 1, `ب) عدد الطلبات الناجحة = ${winners.length}`),
        check(raceAfter === raceBefore - 4, `ب) المخزون ${raceBefore} → ${raceAfter} (المتوقع ${raceBefore - 4} لا سالب)`),
        check(factsB.orders === raceOrdersBefore + 1, `ب) طلبات DB ${raceOrdersBefore} → ${factsB.orders} (+1 فقط)`),
        check(factsB.negative_stock_rows === 0, `ب) صفوف بمخزون سالب = ${factsB.negative_stock_rows}`),
        check(factsB.orphan_order_items === 0, `ب) أصناف يتيمة = ${factsB.orphan_order_items}`),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-019
await scenario(
  {
    id: "WF-019",
    title: "جلسة إدارة صالحة تُرفض — defect ترميز الكوكيز (اكتشاف المختبر)",
    input: "POST /api/admin/login (كلمة مرور صحيحة) ← GET /api/admin/session و GET /api/orders بنفس الكوكيز",
    precondition: "ADMIN_PASSWORD و ADMIN_SESSION_SECRET صحيحان",
    expected_decision: "login 200 + جلسة مقبولة على كل المسارات الإدارية",
    expected_side_effect: "authenticated:true وقراءة الطلبات 200",
    evidence_required: "200 على الدخول + authenticated + حالة المسارات الإدارية + قيمة الكوكيز على السلك",
  },
  async (rec) => {
    const loginRes = await fetch(BASE + "/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    const setCookie = (loginRes.headers.getSetCookie?.() ?? [])[0] ?? "";
    const wireValue = setCookie.split(";")[0].replace("aborof_admin_session=", "");
    const jar = setCookie.split(";")[0];

    const session = await req(BASE, "GET", "/api/admin/session", {
      headers: { cookie: jar },
      xff: `${RUN}-wf019a`,
    });
    const list = await req(BASE, "GET", "/api/orders", {
      headers: { cookie: jar },
      xff: `${RUN}-wf019b`,
    });
    const write = await req(BASE, "POST", "/api/products", {
      body: { product: { id: "p1", name: "منظف أرضيات برائحة اللافندر 5 لتر", price: 180, stock: 5 } },
      headers: { cookie: jar },
      xff: `${RUN}-wf019c`,
    });

    rec.actual = {
      login_http: loginRes.status,
      cookie_value_on_the_wire: wireValue,
      wire_contains_percent3A: wireValue.includes("%3A"),
      session_http: session.status,
      session_authenticated: session.json?.authenticated,
      list_orders_http: list.status,
      list_orders_code: list.json?.code,
      admin_write_http: write.status,
      admin_write_code: write.json?.code,
      root_cause:
        "response.cookies.set() يرمّز ':' إلى '%3A'؛ verifyAdminSession تحسب HMAC فوق النص المُرمَّز وتفشل كذلك في Number(payload.split(':')[0])",
      repro: "whatif/repro-auth-cookie.mjs → verify(خام)=true ، verify(على السلك)=false",
      defect: true,
    };
    return {
      checks: [
        check(loginRes.status === 200, `الدخول HTTP ${loginRes.status} (كلمة المرور مقبولة)`),
        check(wireValue.length > 0, `كوكيز صدر فعلًا: ${wireValue.slice(0, 24)}…`),
        check(session.status === 200, `GET /api/admin/session HTTP ${session.status}`),
        check(
          session.json?.authenticated === true,
          `authenticated=${session.json?.authenticated} (المتوقع true — DEFECT: القيمة على السلك تحتوي %3A)`
        ),
        check(list.status === 200, `GET /api/orders بجلسة صالحة HTTP ${list.status} (المتوقع 200)`),
        check(write.status === 200, `POST /api/products بجلسة صالحة HTTP ${write.status} (المتوقع 200)`),
      ],
    };
  }
);

// ------------------------------------------------------------------ الملخّص

const finalFacts = await dbFacts();
const summary = {
  run: RUN,
  base: BASE,
  nodb_base: NODB_BASE,
  generated_at: new Date().toISOString(),
  baseline,
  final_db: finalFacts,
  totals: results.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {}),
  scenarios: results,
};

writeFileSync(join(HERE, "evidence.json"), JSON.stringify(summary, null, 2));

console.log("\n" + "─".repeat(72));
console.log("ID       STATUS         CHECKS  TITLE");
for (const r of results) {
  const ok = r.checks.filter((c) => c.ok).length;
  console.log(
    `${r.id.padEnd(8)} ${r.status.padEnd(14)} ${String(ok).padStart(2)}/${String(r.checks.length).padEnd(3)} ${r.title}`
  );
}
console.log("─".repeat(72));
console.log(`totals: ${JSON.stringify(summary.totals)}`);
console.log(`final db: ${JSON.stringify(finalFacts)}`);
console.log(`evidence → ${join(HERE, "evidence.json")}`);
