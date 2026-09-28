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
const AIFAIL_BASE = process.env.AIFAIL_BASE ?? "http://127.0.0.1:3002";
/** نفس نسخة :3002 لكن بعلم تتبُّع الطلبات مفعّل — تُستخدم لمسار التتبّع. */
const TRACK_BASE = process.env.TRACK_BASE ?? AIFAIL_BASE;
const TRACK_DB_URL = process.env.WHATIF_TRACK_DB_URL ?? `file:${join(ROOT, "..", "whatif-aifail", "local-aifail.db")}`;
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
 * بجلسة إدارة. لكن WF-020 أثبت أن جلسة الإدارة لا تُقبل أبدًا كما تُرسل على
 * السلك (defect في ترميز الكوكيز)، فكل كتابة إدارية تُرجع 401.
 *
 * لذلك تُضبط الحالات هنا كتابةً مباشرة في قاعدة البيانات — وهي *fixture*
 * للاختبار وليست مسارًا قيد القياس. كل فعل قيد القياس (إنشاء الطلب،
 * التفويض، التحقق، التزامن) ما زال يمر عبر HTTP على الـ Runtime الحقيقي.
 * مسار الإدارة نفسه مغطّى ومستقل في WF-017 وWF-020.
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

/**
 * إدراج/حذف صف منتج كـ fixture.
 *
 *จำเป็น لسيناريوهات الجولة الثانية (أحجام، تشابه، «أرخص متاح») لأن الكتالوج
 * الحالي لا يملك إلا منظف أرضيات واحدًا، فلا تكون المقارنة ذات معنى. الكتابة
 * مباشرة في القاعدة للسبب نفسه الموثّق في `setProduct` (D-1).
 *
 * ملاحظة: لا تُزامن فهرس FTS5 — مقصود، لأن `localAnswer` يعتمد على
 * `getProducts()` وتسجيل الكلمات لا على الفهرس.
 */
async function upsertFixture(p) {
  const c = createClient({ url: DB_URL });
  try {
    await c.execute({
      sql: `INSERT INTO products (id,name,description,price,old_price,category,image,stock,featured)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,
            price=excluded.price,old_price=excluded.old_price,category=excluded.category,
            image=excluded.image,stock=excluded.stock,featured=excluded.featured`,
      args: [
        p.id, p.name, p.description ?? "", p.price, p.old_price ?? null,
        p.category ?? "", p.image ?? "🧴", p.stock ?? 0, p.featured ? 1 : 0,
      ],
    });
  } finally {
    c.close();
  }
}

async function deleteFixture(id) {
  const c = createClient({ url: DB_URL });
  try {
    await c.execute({ sql: "DELETE FROM products WHERE id=?", args: [id] });
  } finally {
    c.close();
  }
}

/**
 * تصفير `featured` لكل المنتجات وإرجاع الحالة السابقة.
 *
 * ضروري لأن ترتيب الكتالوج `featured DESC, rowid ASC`، ومحرك الرد الاحتياطي
 * يقطع عند أول 3 نتائج. بدون عزل الترتيب لا يمكن ضمان أن الصنف الصغير هو
 * المرشح الأول، فيصبح الاختبار غير حاسم (وهذا ما كشفه تشغيل سابق).
 */
async function clearAllFeatured() {
  const prev = [...(await products()).values()].map((p) => ({
    id: String(p.id),
    featured: Boolean(p.featured),
  }));
  const c = createClient({ url: DB_URL });
  try {
    await c.execute("UPDATE products SET featured=0");
  } finally {
    c.close();
  }
  return prev;
}

async function restoreFeatured(prev) {
  const c = createClient({ url: DB_URL });
  try {
    for (const p of prev) {
      await c.execute({ sql: "UPDATE products SET featured=? WHERE id=?", args: [p.featured ? 1 : 0, p.id] });
    }
  } finally {
    c.close();
  }
}

async function setFeatured(id, featured) {
  const c = createClient({ url: DB_URL });
  try {
    await c.execute({ sql: "UPDATE products SET featured=? WHERE id=?", args: [featured ? 1 : 0, id] });
  } finally {
    c.close();
  }
}

async function chat(message, xff) {
  const r = await req(BASE, "POST", "/api/chat", {
    body: { messages: [{ role: "user", content: message }] },
    xff,
  });
  return { ...r, reply: r.json?.reply ?? "", source: r.json?.source ?? null };
}

async function stockOf(id) {
  const p = (await products()).get(id);
  return p ? Number(p.stock) : null;
}

/**
 * قراءة صفوف الطلبات.
 *
 * المسار الطبيعي `GET /api/orders` محمي بجلسة الإدارة، وWF-020 أثبت أن الجلسة
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

// ---------------------------------------------------------------- WF-012
await scenario(
  {
    id: "WF-012",
    title: "أحجام متعددة والعميل قال «هات الكبير»",
    input: "chat: «هات الكبير من منظف الأرضيات باللافندر»",
    precondition: "صنفان بنفس الاسم يختلفان في الحجم: 1 لتر (60 ج) و5 لتر (180 ج)",
    expected_decision: "INTENT: resolve «الكبير» → المتغير 5 لتر، لا الأصغر",
    expected_side_effect: "الرد يسمّي العبوة 5 لتر تحديدًا",
    evidence_required: "نص الرد + هل ذكر 5 لتر + هل تجنّب الادعاء الخاطئ",
  },
  async (rec) => {
    // الاختبار الحاسم: نجعل العبوة *الصغيرة* هي المميزة (featured=1) فتتصدر
    // ترتيب المحرك نفسه. لو كان يحسم «الكبير» فعلًا لأعاد 5 لتر رغم ذلك،
    // ولو كان يطابق كلمات فقط لأعاد 1 لتر. بهذا لا يمكن للنجاح أن يكون صدفة.
    const prevFeatured = await clearAllFeatured();
    await upsertFixture({
      id: "wf12s",
      name: "منظف أرضيات برائحة اللافندر 1 لتر",
      description: "عبوة صغيرة للاستخدام الخفيف",
      price: 60,
      category: "منظفات أرضيات",
      stock: 20,
      featured: true,
    });
    await setProduct("p1", { stock: 20, price: 180, old_price: 220 });

    const catalog = (await products()).get("wf12s");
    const smallIsFirst = [...(await products()).values()].findIndex((p) => p.id === "wf12s") === 0;

    const r = await chat("هات الكبير من منظف الأرضيات باللافندر", `${RUN}-wf012`);
    const mentions5 = /5\s*لتر/.test(r.reply);
    const mentions1 = /1\s*لتر/.test(r.reply);
    const firstLine = r.reply.split("\n").find((l) => l.includes("•")) ?? "";

    await deleteFixture("wf12s");
    await restoreFeatured(prevFeatured);
    rec.actual = {
      http: r.status,
      source: r.source,
      reply: r.reply,
      first_recommendation: firstLine.trim(),
      precondition_small_is_featured: Boolean(catalog?.featured),
      precondition_small_ranks_first_in_catalog: smallIsFirst,
      mentions_5l: mentions5,
      mentions_1l: mentions1,
      resolved_size: mentions5 && !mentions1 ? "5 لتر" : mentions5 && mentions1 ? "كلاهما (بلا حسم)" : mentions1 ? "1 لتر (حسم عكسي)" : "لم يحسم",
    };
    return {
      checks: [
        check(r.status === 200, `chat HTTP ${r.status}`),
        check(smallIsFirst, `precondition مؤكّد: العبوة الصغيرة هي الأولى في ترتيب الكتالوج`),
        check(mentions5, `الرد ذكر العبوة الكبيرة (5 لتر): ${mentions5}`),
        check(
          mentions5 && !mentions1,
          `حسم «الكبير» لصالح 5 لتر رغم تصدر الصغيرة (ذكر 5 لتر=${mentions5}، ذكر 1 لتر=${mentions1})`
        ),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-013
await scenario(
  {
    id: "WF-013",
    title: "«هات أرخص منظف أرضيات متاح» — ترتيب بالسعر + فلتر توافر",
    input: "chat: «هات أرخص منظف أرضيات متاح»",
    precondition: "أ) اقتصادي 30 ج مخزون 0 (الأرخص لكن نافد) ب) مركز 45 ج مخزون 10 ج) فاخر 180 ج مخزون 10",
    expected_decision: "DATA+POLICY: استبعاد النافد ثم أدنى سعر → (ب) 45 ج",
    expected_side_effect: "الرد يرشّح 45 ج، ولا يرشّح 30 ج النافد",
    evidence_required: "نص الرد + الأسعار المذكورة + هل ذُكر النافد",
  },
  async (rec) => {
    await upsertFixture({ id: "wf13c", name: "منظف أرضيات اقتصادي 1 لتر", description: "أرخص خيار", price: 30, category: "منظفات أرضيات", stock: 0 });
    await upsertFixture({ id: "wf13a", name: "منظف أرضيات مركز 1 لتر", description: "تركيز عالٍ", price: 45, category: "منظفات أرضيات", stock: 10 });
    await setProduct("p1", { stock: 10, price: 180, old_price: 220 });

    const r = await chat("هات أرخص منظف أرضيات متاح", `${RUN}-wf013`);
    const prices = [...r.reply.matchAll(/(\d+(?:\.\d+)?)\s*جنيه/g)].map((m) => Number(m[1]));
    const recommends45 = prices.includes(45);
    const recommendsStockout30 = /اقتصادي/.test(r.reply) || prices.includes(30);
    const cheapestMentioned = prices.length ? Math.min(...prices) : null;
    // الآلية: `localAnswer` تفحص الأسئلة الشائعة *قبل* المنتجات، وكلمة «متاح»
    // substring داخل «المتاحة» في سؤال طرق الدفع، فيخطف السؤالَ جوابٌ عن الدفع.
    const faqHijack = /فودافون كاش|الدفع عند الاستلام/.test(r.reply) && prices.length === 0;

    await deleteFixture("wf13c");
    await deleteFixture("wf13a");
    rec.actual = {
      http: r.status,
      source: r.source,
      reply: r.reply,
      prices_mentioned: prices,
      cheapest_mentioned: cheapestMentioned,
      recommends_expected_45: recommends45,
      recommends_out_of_stock_30: recommendsStockout30,
      faq_hijack: faqHijack,
      mechanism: faqHijack
        ? "localAnswer يفحص FAQ أولًا؛ «متاح» ⊂ «المتاحة» في سؤال طرق الدفع، فأجاب عن الدفع بدل المنتجات"
        : null,
      expected: "أرخص *متاح* = 45 ج (منظف أرضيات مركز 1 لتر)، واستبعاد 30 ج لأن مخزونه 0",
    };
    return {
      checks: [
        check(r.status === 200, `chat HTTP ${r.status}`),
        check(!faqHijack, `لم يخطف سؤالُ المنتجات جوابٌ عن الدفع (FAQ hijack = ${faqHijack})`),
        check(recommends45, `رشّح الأرخص المتاح (45 ج): ${recommends45}`),
        check(!recommendsStockout30, `لم يرشّح النافد (30 ج): ${!recommendsStockout30}`),
        check(cheapestMentioned === 45, `أدنى سعر مذكور = ${cheapestMentioned} (المتوقع 45)`),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-014
await scenario(
  {
    id: "WF-014",
    title: "منتجان متشابهان جدًا — هل يحسم أم يوضّح؟",
    input: "chat: «عايز منظف حمامات»",
    precondition: "صنفان يتطابق اسمهما إلا في الرائحة: ليمون 72 ج ولافندر 74 ج",
    expected_decision: "AMBIGUITY: عرض الاثنين أو طلب توضيح — لا حسم صامت",
    expected_side_effect: "لا يُقدَّم صنف واحد على أنه المطلوب الوحيد",
    evidence_required: "نص الرد + هل ذُكر الصنفان + هل طُلب توضيح",
  },
  async (rec) => {
    await upsertFixture({ id: "wf14a", name: "منظف حمامات برائحة الليمون 1 لتر", description: "رائحة ليمون", price: 72, category: "منظفات حمامات", stock: 15 });
    await upsertFixture({ id: "wf14b", name: "منظف حمامات برائحة اللافندر 1 لتر", description: "رائحة لافندر", price: 74, category: "منظفات حمامات", stock: 15 });

    const r = await chat("عايز منظف حمامات", `${RUN}-wf014`);
    const lemon = /ليمون/.test(r.reply);
    const lavender = /لافندر/.test(r.reply);
    const asksClarify = /أي|أيه|تحب|تفضّل|اختار|حدد/.test(r.reply);
    const listed = r.reply.split("\n").filter((l) => l.includes("•")).map((l) => l.replace("•", "").trim());

    // دليل وصفي (لا يحل محل خرج التطبيق): الصنفان يطابقان كلمات السؤال فعلًا،
    // فسبب غيابهما الترتيب لا المطابقة. المطابقة تُقاس بعدّ كلمات السؤال فقط.
    const qWords = ["عايز", "منظف", "حمامات"];
    const eligibility = {};
    for (const id of ["wf14a", "wf14b"]) {
      const p = (await products()).get(id);
      const hay = `${p?.name ?? ""} ${p?.category ?? ""} ${p?.description ?? ""}`;
      eligibility[id] = { name: p?.name ?? null, matched_words: qWords.filter((w) => hay.includes(w)) };
    }

    await deleteFixture("wf14a");
    await deleteFixture("wf14b");
    rec.actual = {
      http: r.status,
      source: r.source,
      reply: r.reply,
      listed_recommendations: listed,
      mentions_lemon: lemon,
      mentions_lavender: lavender,
      asks_clarification: asksClarify,
      fixture_keyword_eligibility: eligibility,
      behavior: lemon && lavender ? "عرض الخيارين" : asksClarify ? "طلب توضيح" : "حسم صامت واستبعاد الصنفين المتشابهين",
      mechanism:
        "localAnswer يرتب بالدرجة ثم يقطع عند 3؛ عند التعادل يفوز الأسبق في ترتيب الكتالوج (featured ثم rowid)، والصنفان المُدرجان أخيرًا فيُستبعدان رغم مطابقتهما",
    };
    return {
      checks: [
        check(r.status === 200, `chat HTTP ${r.status}`),
        check(lemon || lavender, `ذكر أحد الصنفين المتشابهين (ليمون=${lemon}، لافندر=${lavender})`),
        check(
          (lemon && lavender) || asksClarify,
          `لم يحسم صامتًا: عرض الاثنين=${lemon && lavender} أو طلب توضيح=${asksClarify}`
        ),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-015
await scenario(
  {
    id: "WF-015",
    title: "خدمة الذكاء الاصطناعي توقفت — فشل المزودين",
    input: "POST /api/chat على نسخة بمفاتيح موجودة لكن المزودين غير متاحين (:3002)",
    precondition: "GEMINI_API_KEY و GROQ_API_KEY معيَّنان؛ الاتصال بهما يفشل",
    expected_decision: "CHAIN FALLBACK: gemini ← groq ← local، بلا 5xx",
    expected_side_effect: "رد مفيد من القاعدة، ولا تسريب مفتاح أو stack",
    evidence_required: "200 + source=local + غياب المفاتيح و stack عن جسم الرد",
  },
  async (rec) => {
    const r = await req(AIFAIL_BASE, "POST", "/api/chat", {
      body: { messages: [{ role: "user", content: "سعر منظف الأرضيات كام؟" }] },
      xff: `${RUN}-wf015`,
    });
    const body = r.text;
    rec.actual = {
      http: r.status,
      code: r.json?.code ?? null,
      source: r.json?.source,
      reply: (r.json?.reply ?? "").slice(0, 200),
      request_id: r.requestId,
      leaked_api_key: /AIza[0-9A-Za-z_-]{10,}|gsk_[0-9A-Za-z]{10,}/.test(body),
      leaked_stack: /at\s+Object\.|node_modules|\.ts:\d+:\d+/.test(body),
      provider_failure_mode:
        "fetch failed — انقطاع اتصال على مستوى TLS في بيئة الاختبار، لا رفض مفتاح؛ كلا المسارين يُنتجان نفس قرار التراجع",
    };
    return {
      checks: [
        check(r.status === 200, `HTTP ${r.status} (لا 5xx رغم فشل المزودين)`),
        check(r.json?.source === "local", `source=${r.json?.source} (المتوقع local)`),
        check((r.json?.reply ?? "").length > 20, "رد مفيد رغم توقف الخدمة"),
        check(!/AIza[0-9A-Za-z_-]{10,}|gsk_[0-9A-Za-z]{10,}/.test(body), "لا مفتاح API في جسم الرد"),
        check(!/at\s+Object\.|node_modules|\.ts:\d+:\d+/.test(body), "لا stack trace للعميل"),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-019
await scenario(
  {
    id: "WF-019",
    title: "أمر غامض — «محتاج حاجة»",
    input: "chat: «محتاج حاجة»",
    precondition: "لا شيء",
    expected_decision: "INTENT غامض → استيضاح أو عرض عام، لا اختراع منتج أو سعر",
    expected_side_effect: "لا رقم طلب، لا التزام، لا سعر مختلَق",
    evidence_required: "نص الرد + ثبات عدد الطلبات",
  },
  async (rec) => {
    const before = (await dbFacts()).orders;
    const r = await chat("محتاج حاجة", `${RUN}-wf019`);
    const after = (await dbFacts()).orders;
    const fabricatesOrder = /ORD-/.test(r.reply);
    rec.actual = {
      http: r.status,
      source: r.source,
      reply: r.reply,
      fabricates_order_id: fabricatesOrder,
      orders_before: before,
      orders_after: after,
    };
    return {
      checks: [
        check(r.status === 200, `chat HTTP ${r.status}`),
        check(!fabricatesOrder, `لم يختلق رقم طلب: ${!fabricatesOrder}`),
        check(after === before, `عدد الطلبات ${before} → ${after} (لا تنفيذ من محادثة)`),
        check(r.reply.length > 20, "رد مفيد يستوضح أو يعرض خيارات"),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-020
await scenario(
  {
    id: "WF-020",
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
      xff: `${RUN}-wf020a`,
    });
    const list = await req(BASE, "GET", "/api/orders", {
      headers: { cookie: jar },
      xff: `${RUN}-wf020b`,
    });
    const write = await req(BASE, "POST", "/api/products", {
      body: { product: { id: "p1", name: "منظف أرضيات برائحة اللافندر 5 لتر", price: 180, stock: 5 } },
      headers: { cookie: jar },
      xff: `${RUN}-wf020c`,
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

// ---------------------------------------------------------------- WF-021
await scenario(
  {
    id: "WF-021",
    title: "تتبّع الطلب بعاملين صحيحين — العلم مفعّل",
    input: "POST /api/orders/track {id, phoneLast4} على نسخة ENABLE_ORDER_TRACKING=true",
    precondition: "طلب قائم بهاتف 01012345678؛ آخر 4 = 5678",
    expected_decision: "AUTHORIZATION بعاملين → كشف الحالة",
    expected_side_effect: "200 + حالة + أصناف مختصرة، بلا هاتف كامل ولا عنوان ولا أسعار",
    evidence_required: "200 + محتوى الرد + غياب الهاتف/العنوان/السعر",
  },
  async (rec) => {
    const created = await req(TRACK_BASE, "POST", "/api/orders", {
      body: order([{ id: "p3", qty: 1 }], { phone: "01012345678", governorate: "الجيزة" }),
      xff: `${RUN}-wf021create`,
    });
    const id = created.json?.id;
    const r = await req(TRACK_BASE, "POST", "/api/orders/track", {
      body: { id, phoneLast4: "5678" },
      xff: `${RUN}-wf021`,
    });
    const body = r.text;
    rec.actual = {
      order_id: id,
      http: r.status,
      body: r.json,
      request_id: r.requestId,
      leaks_full_phone: /01012345678/.test(body),
      leaks_address: /شارع النيل/.test(body),
      leaks_price: /price|جنيه|\btotal\b/.test(body),
    };
    return {
      checks: [
        check(created.status === 200 && id, `أنشئ طلب للتتبّع: ${id}`),
        check(r.status === 200, `HTTP ${r.status} (المتوقع 200)`),
        check(r.json?.ok === true, `ok=${r.json?.ok}`),
        check(r.json?.status === "جديد", `الحالة المُعادة = ${r.json?.status}`),
        check(Array.isArray(r.json?.items) && r.json.items.length === 1, `أصناف مختصرة = ${JSON.stringify(r.json?.items)}`),
        check(!/01012345678/.test(body), "لا هاتف كامل في الرد"),
        check(!/شارع النيل/.test(body), "لا عنوان في الرد"),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-022
await scenario(
  {
    id: "WF-022",
    title: "تتبّع بآخر 4 أرقام خاطئة — منع تعداد الطلبات",
    input: "POST /api/orders/track بنفس رقم الطلب مع phoneLast4=0000",
    precondition: "نفس طلب WF-021",
    expected_decision: "عدم تطابق → 404 برسالة موحّدة لا تكشف وجود الطلب",
    expected_side_effect: "تسجيل محاولة فاشلة في سجل التدقيق، بلا تسريب",
    evidence_required: "404 + تطابق الرسالة حرفيًا مع حالة «الرقم غير الموجود أصلًا» + صف تدقيق",
  },
  async (rec) => {
    const created = await req(TRACK_BASE, "POST", "/api/orders", {
      body: order([{ id: "p3", qty: 1 }], { phone: "01012345678", governorate: "الجيزة" }),
      xff: `${RUN}-wf022create`,
    });
    const id = created.json?.id;

    const c = createClient({ url: TRACK_DB_URL });
    let auditBefore = 0;
    try {
      const a = await c.execute({
        sql: "SELECT COUNT(*) AS n FROM admin_audit_log WHERE action='track_failed'",
      });
      auditBefore = Number(a.rows[0].n);
    } finally {
      c.close();
    }

    const wrongLast4 = await req(TRACK_BASE, "POST", "/api/orders/track", {
      body: { id, phoneLast4: "0000" },
      xff: `${RUN}-wf022a`,
    });
    const ghostId = await req(TRACK_BASE, "POST", "/api/orders/track", {
      body: { id: "ORD-00000000-deadbeef", phoneLast4: "5678" },
      xff: `${RUN}-wf022b`,
    });

    let auditAfter = 0;
    try {
      const cc = createClient({ url: TRACK_DB_URL });
      try {
        const a = await cc.execute({
          sql: "SELECT COUNT(*) AS n FROM admin_audit_log WHERE action='track_failed'",
        });
        auditAfter = Number(a.rows[0].n);
      } finally {
        cc.close();
      }
    } catch {
      auditAfter = auditBefore;
    }

    rec.actual = {
      order_id: id,
      wrong_last4_http: wrongLast4.status,
      wrong_last4_error: wrongLast4.json?.error,
      wrong_last4_code: wrongLast4.json?.code,
      ghost_id_http: ghostId.status,
      ghost_id_error: ghostId.json?.error,
      messages_identical: wrongLast4.json?.error === ghostId.json?.error,
      audit_track_failed: [auditBefore, auditAfter],
    };
    return {
      checks: [
        check(wrongLast4.status === 404, `آخر 4 خاطئة → HTTP ${wrongLast4.status} (المتوقع 404)`),
        check(wrongLast4.json?.code === "NOT_FOUND", `code=${wrongLast4.json?.code}`),
        check(ghostId.status === 404, `رقم طلب غير موجود أصلًا → HTTP ${ghostId.status}`),
        check(
          wrongLast4.json?.error === ghostId.json?.error,
          `الرسالتان متطابقتان حرفيًا («${wrongLast4.json?.error}») — لا تمييز يكشف وجود الطلب`
        ),
        check(auditAfter > auditBefore, `سُجّلت محاولة فاشلة في التدقيق: ${auditBefore} → ${auditAfter}`),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-023
await scenario(
  {
    id: "WF-023",
    title: "علم التتبّع مغلق — النقطة لا تكشف وجودها",
    input: "POST /api/orders/track على النسخة الأساسية (ENABLE_ORDER_TRACKING غير مفعّل)",
    precondition: "العلم مغلق افتراضيًا على :3000",
    expected_decision: "404 موحّد قبل أي فحص لبيانات",
    expected_side_effect: "لا كشف لوجود الميزة، ولا فرق بين طلب موجود وغير موجود",
    evidence_required: "404 + تطابق الرسالة مع النسخة المفعّلة الفاشلة",
  },
  async (rec) => {
    const r = await req(BASE, "POST", "/api/orders/track", {
      body: { id: "ORD-83180654-1a1806de", phoneLast4: "5678" },
      xff: `${RUN}-wf023`,
    });
    rec.actual = {
      http: r.status,
      code: r.json?.code,
      error: r.json?.error,
      request_id: r.requestId,
      identical_to_enabled_failure: r.json?.error === "تعذر العثور على الطلب",
    };
    return {
      checks: [
        check(r.status === 404, `HTTP ${r.status} (المتوقع 404 لا 403/404 مميزة)`),
        check(r.json?.code === "NOT_FOUND", `code=${r.json?.code} (لا FEATURE_DISABLED كاشف)`),
        check(
          r.json?.error === "تعذر العثور على الطلب",
          `الرسالة مطابقة لحالة الفشل العادية: «${r.json?.error}»`
        ),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-024
await scenario(
  {
    id: "WF-024",
    title: "تجاوز حد المعدل على إنشاء الطلبات — 429 بعد 8 محاولات",
    input: "9 طلبات POST /api/orders متتالية من نفس هوية العميل",
    precondition: "الحد 8 / 10 دقائق لكل (مسار، عميل)",
    expected_decision: "الثامن يمر، التاسع 429 RATE_LIMITED مع retry_after_seconds",
    expected_side_effect: "لا طلب تاسع، والمخزون لا يُخصم مرة إضافية",
    evidence_required: "تسلسل الحالات + 429 + retry_after_seconds + ثبات المخزون",
  },
  async (rec) => {
    await setProduct("p3", { stock: 100 });
    const stockBefore = await stockOf("p3");
    const xff = `${RUN}-wf024`;
    const statuses = [];
    let last = null;
    for (let i = 0; i < 9; i++) {
      const r = await req(BASE, "POST", "/api/orders", {
        body: order([{ id: "p3", qty: 1 }], { governorate: "القاهرة" }),
        xff,
      });
      statuses.push(r.status);
      last = r;
    }
    const stockAfter = await stockOf("p3");
    const accepted = statuses.filter((s) => s === 200).length;
    rec.actual = {
      statuses,
      accepted_count: accepted,
      ninth_http: statuses[8],
      ninth_code: last.json?.code,
      retry_after_seconds: last.json?.retry_after_seconds,
      stock_before: stockBefore,
      stock_after: stockAfter,
      stock_delta: stockBefore - stockAfter,
    };
    return {
      checks: [
        check(accepted === 8, `عدد المقبول = ${accepted} (المتوقع 8 = الحد)`),
        check(statuses[8] === 429, `التاسع → HTTP ${statuses[8]} (المتوقع 429)`),
        check(last.json?.code === "RATE_LIMITED", `code=${last.json?.code}`),
        check(
          Number(last.json?.retry_after_seconds) > 0,
          `retry_after_seconds=${last.json?.retry_after_seconds} (يوجّه العميل لإعادة المحاولة)`
        ),
        check(stockBefore - stockAfter === 8, `المخزون خُصم 8 فقط: ${stockBefore} → ${stockAfter}`),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-025
await scenario(
  {
    id: "WF-025",
    title: "نقطتان محجوبتان بعلم ميزة — التشخيص وأدوات MCP",
    input: "GET /api/admin/diagnostics و GET /api/admin/mcp/tools",
    precondition: "DIAGNOSTICS_ENABLED=false و ENABLE_MCP_TOOLS غير مفعّل",
    expected_decision: "404 موحّد لا يكشف وجود النقطتين، حتى بجلسة/مفتاح",
    expected_side_effect: "لا مقاييس ولا مانيفست أدوات",
    evidence_required: "404 على المسارين + تطابق الرسالة + عدم تسريب أسماء أدوات",
  },
  async (rec) => {
    const diag = await req(BASE, "GET", "/api/admin/diagnostics", { xff: `${RUN}-wf025a` });
    const diagWithKey = await req(BASE, "GET", "/api/admin/diagnostics?key=anything", {
      xff: `${RUN}-wf025b`,
    });
    const mcp = await req(BASE, "GET", "/api/admin/mcp/tools", { xff: `${RUN}-wf025c` });
    rec.actual = {
      diagnostics_http: diag.status,
      diagnostics_code: diag.json?.code,
      diagnostics_error: diag.json?.error,
      diagnostics_with_key_http: diagWithKey.status,
      mcp_http: mcp.status,
      mcp_code: mcp.json?.code,
      mcp_error: mcp.json?.error,
      messages_identical: diag.json?.error === mcp.json?.error,
      leaks_tool_names: /search_products|lookup_faq|shipping_estimate|store_info/.test(
        diag.text + mcp.text
      ),
    };
    return {
      checks: [
        check(diag.status === 404, `التشخيص → HTTP ${diag.status} (المتوقع 404 لا 401/403)`),
        check(diagWithKey.status === 404, `التشخيص بمفتاح مُخمَّن → HTTP ${diagWithKey.status}`),
        check(mcp.status === 404, `أدوات MCP → HTTP ${mcp.status}`),
        check(
          diag.json?.error === mcp.json?.error,
          `رسالتان موحّدتان («${diag.json?.error}») — لا تمييز بين نقطتين`
        ),
        check(
          !/search_products|lookup_faq|shipping_estimate|store_info/.test(diag.text + mcp.text),
          "لا أسماء أدوات مسرّبة"
        ),
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
