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
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/**
 * حفظ كوكيز جلسة الإدارة بين التشغيلات.
 *
 * خارج المستودع عمدًا — انظر التعليق في `adminCookie`.
 */
const COOKIE_CACHE = join(tmpdir(), "aborof-whatif-admin-cookie");

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const NODB_BASE = process.env.NODB_BASE ?? "http://127.0.0.1:3001";
const AIFAIL_BASE = process.env.AIFAIL_BASE ?? "http://127.0.0.1:3002";
/** نفس نسخة :3002 لكن بعلم تتبُّع الطلبات مفعّل — تُستخدم لمسار التتبّع. */
const TRACK_BASE = process.env.TRACK_BASE ?? AIFAIL_BASE;
/** نسخة إنتاجية (`npm run build && next start`) لمقارنة التسريب dev مقابل prod. */
const PROD_BASE = process.env.PROD_BASE ?? "http://127.0.0.1:3003";
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
  // حد المعدل على الدخول 3 محاولات / 10 دقائق، وإعادة تشغيل المختبر كانت
  // تستهلكه كاملة فتفشل الجولة كلها بـ 429 قبل أن تبدأ. لذلك تُحفظ الجلسة
  // بين التشغيلات وتُختبر صلاحيتها قبل الاعتماد عليها.
  //
  // موضع الحفظ مقصود: مجلد مؤقت *خارج* المستودع. كوكيز جلسة الإدارة سرّ،
  // ولا يجوز أن يقترب من Git ولو سهوًا عبر `git add -A`.
  try {
    const cached = readFileSync(COOKIE_CACHE, "utf8").trim();
    if (cached) {
      const probe = await fetch(base + "/api/admin/session", { headers: { cookie: cached } });
      const j = await probe.json().catch(() => ({}));
      if (probe.ok && j?.authenticated) return cached;
    }
  } catch {
    /* لا جلسة محفوظة أو انتهت — ندخل من جديد */
  }

  const res = await fetch(base + "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`admin login failed: ${res.status} ${await res.text()}`);
  const raw = res.headers.getSetCookie?.() ?? [];
  const pairs = raw.map((c) => c.split(";")[0]);
  if (!pairs.length) throw new Error("admin login returned no cookies");
  const cookie = pairs.join("; ");
  try {
    writeFileSync(COOKIE_CACHE, cookie, { mode: 0o600 });
  } catch {
    /* الفشل في التخزين المؤقت ليس قاتلًا — الجولة الحالية تعمل */
  }
  return cookie;
}

let COOKIE = "";
const auth = () => ({ cookie: COOKIE });

// ------------------------------------------------------- قراءة/ضبط الحالة

async function products() {
  const r = await req(BASE, "GET", "/api/products");
  return new Map((r.json?.products ?? []).map((p) => [String(p.id), p]));
}

/**
 * ضبط الـ precondition عبر واجهة الإدارة الحقيقية.
 *
 * تاريخ: كانت هذه الدوال تكتب مباشرة في قاعدة البيانات لأن D-1 جعل كل كتابة
 * إدارية تُرجع 401. بعد إصلاح D-1 (فاصل حمولة الجلسة) صارت الجلسة تُقبل،
 * فأصبحت الحالات تُضبط عبر `POST /api/products` بجلسة إدارة فعلية — أي أن
 * الـ precondition نفسه يمر الآن عبر عقد Zod والتفويض وسجل التدقيق ومزامنة
 * FTS5، بدل تجاوزها.
 *
 * كل فعل قيد القياس ما زال يمر عبر HTTP على الـ Runtime الحقيقي.
 */
async function setProduct(id, patch) {
  const p = (await products()).get(id);
  if (!p) throw new Error(`setProduct: ${id} not in catalog`);
  const next = {
    id,
    name: p.name,
    description: p.description ?? "",
    price: patch.price ?? Number(p.price),
    old_price: "old_price" in patch ? patch.old_price : (p.old_price == null ? null : Number(p.old_price)),
    category: p.category ?? "",
    image: p.image ?? "🧴",
    stock: patch.stock ?? Number(p.stock),
    featured: "featured" in patch ? Boolean(patch.featured) : Boolean(p.featured),
  };
  const r = await req(BASE, "POST", "/api/products", {
    body: { product: next },
    headers: auth(),
    xff: `${RUN}-fixture`,
  });
  if (r.status !== 200) throw new Error(`setProduct ${id} failed: ${r.status} ${r.text}`);
  return next;
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
  const r = await req(BASE, "POST", "/api/products", {
    body: {
      product: {
        id: p.id,
        name: p.name,
        description: p.description ?? "",
        price: p.price,
        old_price: p.old_price ?? null,
        category: p.category ?? "",
        image: p.image ?? "🧴",
        stock: p.stock ?? 0,
        featured: Boolean(p.featured),
      },
    },
    headers: auth(),
    xff: `${RUN}-fixture`,
  });
  if (r.status !== 200) throw new Error(`upsertFixture ${p.id} failed: ${r.status} ${r.text}`);
}

async function deleteFixture(id) {
  const r = await req(BASE, "DELETE", `/api/products?id=${encodeURIComponent(id)}`, {
    headers: auth(),
    xff: `${RUN}-fixture`,
  });
  if (r.status !== 200) throw new Error(`deleteFixture ${id} failed: ${r.status} ${r.text}`);
}

/**
 * تصفير `featured` لكل المنتجات وإرجاع الحالة السابقة.
 *
 * ضروري لأن ترتيب الكتالوج `featured DESC, rowid ASC`، ومحرك الرد الاحتياطي
 * يقطع عند أول 3 نتائج. بدون عزل الترتيب لا يمكن ضمان أن الصنف الصغير هو
 * المرشح الأول، فيصبح الاختبار غير حاسم (وهذا ما كشفه تشغيل سابق).
 */
async function clearAllFeatured() {
  const list = [...(await products()).values()];
  const prev = list.map((p) => ({ id: String(p.id), featured: Boolean(p.featured) }));
  for (const p of list) if (p.featured) await setProduct(String(p.id), { featured: false });
  return prev;
}

async function restoreFeatured(prev) {
  for (const p of prev) if (p.featured) await setProduct(p.id, { featured: true });
}

async function setFeatured(id, featured) {
  return setProduct(id, { featured });
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
 * قراءة صفوف الطلبات عبر `GET /api/orders` بجلسة الإدارة.
 *
 * كانت تقرأ مباشرة من القاعدة لأن D-1 كان يرفض كل جلسة إدارة. بعد إصلاحه
 * صار الدليل نفسه يُجمع عبر المسار المحمي الحقيقي، فأي انحدار في التفويض
 * يُسقط جمع الدليل فورًا بدل أن يمرّ بصمت.
 */
async function orders() {
  const r = await req(BASE, "GET", "/api/orders", { headers: auth(), xff: `${RUN}-evidence` });
  if (r.status !== 200) throw new Error(`orders() failed: ${r.status} ${r.text}`);
  return r.json?.orders ?? [];
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
    title: "جلسة إدارة صالحة تُقبل على كل المسارات الإدارية (انحدار D-1)",
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

// ---------------------------------------------------------------- WF-006
await scenario(
  {
    id: "WF-006",
    title: "جسم أكبر من الحد المسموح",
    input: "POST /api/orders بحقل note حجمه ~40KB (الحد 32_000 بايت)",
    precondition: "MAX_BODY_BYTES = 32_000 على /api/orders",
    expected_decision: "PAYLOAD_TOO_LARGE قبل أي تحليل أو تحقق",
    expected_side_effect: "413، لا طلب، لا كتابة",
    evidence_required: "413 + code + request_id + ثبات عدد الطلبات",
  },
  async (rec) => {
    const before = (await dbFacts()).orders;
    const r = await req(BASE, "POST", "/api/orders", {
      body: order([{ id: "p3", qty: 1 }], { note: "ا".repeat(40_000) }),
      xff: `${RUN}-wf006`,
    });
    const after = (await dbFacts()).orders;
    rec.actual = {
      http: r.status,
      code: r.json?.code,
      error: r.json?.error,
      request_id: r.requestId,
      orders_before: before,
      orders_after: after,
    };
    return {
      checks: [
        check(r.status === 413, `HTTP ${r.status} (المتوقع 413)`),
        check(r.json?.code === "PAYLOAD_TOO_LARGE", `code=${r.json?.code}`),
        check(typeof r.requestId === "string" && r.requestId.length > 0, `request_id=${r.requestId}`),
        check(after === before, `عدد الطلبات ${before} → ${after} (بلا تغيير)`),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-007
await scenario(
  {
    id: "WF-007",
    title: "جسم ليس JSON صالحًا",
    input: "POST /api/orders بنص مشوَّه: '{\"customer\": ' ",
    precondition: "لا شيء",
    expected_decision: "VALIDATION_FAILED — لا يُسرَّب خطأ المحلّل الداخلي",
    expected_side_effect: "422 برسالة عربية آمنة، لا stack ولا SyntaxError",
    evidence_required: "422 + code + غياب SyntaxError/stack عن الرد",
  },
  async (rec) => {
    const res = await fetch(BASE + "/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `${RUN}-wf007` },
      body: '{"customer": ',
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    rec.actual = {
      http: res.status,
      code: json?.code,
      error: json?.error,
      request_id: res.headers.get("x-request-id"),
      leaks_parser_internals: /SyntaxError|Unexpected end of JSON|at Object\./.test(text),
      body_excerpt: text.slice(0, 200),
    };
    return {
      checks: [
        check(res.status === 422, `HTTP ${res.status} (المتوقع 422)`),
        check(json?.code === "VALIDATION_FAILED", `code=${json?.code}`),
        check(/JSON/.test(json?.error ?? ""), `رسالة عربية آمنة: «${json?.error}»`),
        check(
          !/SyntaxError|Unexpected end of JSON|at Object\./.test(text),
          "لا خطأ محلّل داخلي ولا stack في الرد"
        ),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-008
await scenario(
  {
    id: "WF-008",
    title: "تجاوز حدود أطوال الحقول",
    input: "customer بطول 121، address بطول 501، note بطول 501 (الحدود 120/500/500)",
    precondition: "عقود trimmed(min,max) في contracts.ts",
    expected_decision: "422 لكل حقل متجاوز، برسالة تسمّي الحد",
    expected_side_effect: "لا طلب",
    evidence_required: "422 + رسائل تسمّي الحقول + ثبات عدد الطلبات",
  },
  async (rec) => {
    const before = (await dbFacts()).orders;
    const cases = [
      ["customer", order([{ id: "p3", qty: 1 }], { customer: "ا".repeat(121) })],
      ["address", order([{ id: "p3", qty: 1 }], { address: "ا".repeat(501) })],
      ["note", order([{ id: "p3", qty: 1 }], { note: "ا".repeat(501) })],
      ["customer_short", order([{ id: "p3", qty: 1 }], { customer: "ا" })],
    ];
    const out = {};
    for (const [name, body] of cases) {
      const r = await req(BASE, "POST", "/api/orders", { body, xff: `${RUN}-wf008-${name}` });
      out[name] = { http: r.status, code: r.json?.code, error: r.json?.error };
    }
    const after = (await dbFacts()).orders;
    rec.actual = { cases: out, orders_before: before, orders_after: after };
    return {
      checks: [
        ...Object.entries(out).map(([name, v]) =>
          check(v.http === 422, `${name} → HTTP ${v.http} (المتوقع 422) — «${v.error}»`)
        ),
        check(/120/.test(out.customer.error ?? ""), `رسالة customer تسمّي الحد 120: «${out.customer.error}»`),
        check(/500/.test(out.address.error ?? ""), `رسالة address تسمّي الحد 500: «${out.address.error}»`),
        check(after === before, `عدد الطلبات ${before} → ${after} (بلا تغيير)`),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-009
await scenario(
  {
    id: "WF-009",
    title: "هاتف غير صالح ومحافظة خارج القائمة",
    input: "phone='abcdef 12345' ثم governorate='أطلنطس'",
    precondition: "regex /^[0-9+\\s()-]{8,30}$/ وقائمة GOVERNORATES",
    expected_decision: "422 في الحالتين — لا يُنشأ طلب بعنوان غير قابل للتوصيل",
    expected_side_effect: "لا طلب، لا خصم مخزون",
    evidence_required: "422 + رسائل محددة + ثبات المخزون وعدد الطلبات",
  },
  async (rec) => {
    await setProduct("p3", { stock: 50 });
    const stockBefore = await stockOf("p3");
    const before = (await dbFacts()).orders;

    const badPhone = await req(BASE, "POST", "/api/orders", {
      body: order([{ id: "p3", qty: 1 }], { phone: "abcdef 12345" }),
      xff: `${RUN}-wf009a`,
    });
    const badGov = await req(BASE, "POST", "/api/orders", {
      body: order([{ id: "p3", qty: 1 }], { governorate: "أطلنطس" }),
      xff: `${RUN}-wf009b`,
    });
    const stockAfter = await stockOf("p3");
    const after = (await dbFacts()).orders;
    rec.actual = {
      bad_phone: { http: badPhone.status, code: badPhone.json?.code, error: badPhone.json?.error },
      bad_governorate: { http: badGov.status, code: badGov.json?.code, error: badGov.json?.error },
      stock_before: stockBefore,
      stock_after: stockAfter,
      orders_before: before,
      orders_after: after,
    };
    return {
      checks: [
        check(badPhone.status === 422, `هاتف غير صالح → HTTP ${badPhone.status} (المتوقع 422)`),
        check(/هاتف/.test(badPhone.json?.error ?? ""), `رسالة تسمّي الهاتف: «${badPhone.json?.error}»`),
        check(badGov.status === 422, `محافظة خارج القائمة → HTTP ${badGov.status}`),
        check(/المحافظة/.test(badGov.json?.error ?? ""), `رسالة تسمّي المحافظة: «${badGov.json?.error}»`),
        check(stockAfter === stockBefore, `المخزون ${stockBefore} → ${stockAfter} (لم يُخصم)`),
        check(after === before, `عدد الطلبات ${before} → ${after}`),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-026
await scenario(
  {
    id: "WF-026",
    title: "رؤوس الأمان مطبّقة على كل الاستجابات",
    input: "GET / و /api/products و /api/orders (401) و POST /api/chat",
    precondition: "middleware + buildSecurityHeaders",
    expected_decision: "رؤوس موحّدة على النجاح والخطأ معًا",
    expected_side_effect: "لا استجابة عارية من الرؤوس",
    evidence_required: " presence الرؤوس الثمانية على المسارات الأربعة",
  },
  async (rec) => {
    const targets = [
      ["GET", "/", undefined],
      ["GET", "/api/products", undefined],
      ["GET", "/api/orders", undefined],
      ["POST", "/api/chat", { messages: [{ role: "user", content: "أهلاً" }] }],
    ];
    const required = [
      "strict-transport-security",
      "x-content-type-options",
      "x-frame-options",
      "referrer-policy",
      "permissions-policy",
      "cross-origin-opener-policy",
      "x-dns-prefetch-control",
    ];
    const out = {};
    for (const [method, path, body] of targets) {
      const res = await fetch(BASE + path, {
        method,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          "x-forwarded-for": `${RUN}-wf026${path}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const h = {};
      for (const k of required) h[k] = res.headers.get(k);
      h["csp"] = res.headers.get("content-security-policy-report-only") ?? res.headers.get("content-security-policy");
      out[`${method} ${path}`] = { status: res.status, missing: required.filter((k) => !h[k]), csp_present: Boolean(h.csp) };
    }
    rec.actual = out;
    return {
      checks: Object.entries(out).map(
        ([label, v]) =>
          check(
            v.missing.length === 0 && v.csp_present,
            `${label} (${v.status}) — ناقص: ${v.missing.length ? v.missing.join(",") : "لا شيء"}، CSP: ${v.csp_present}`
          )
      ),
    };
  }
);

// ---------------------------------------------------------------- WF-027
await scenario(
  {
    id: "WF-027",
    title: "حد المعدل على الدردشة — 30 محاولة / 10 دقائق",
    input: "31 طلب POST /api/chat من نفس هوية العميل",
    precondition: "rateLimit(req,'chat',30,10min)",
    expected_decision: "الثلاثون يمر، الحادي والثلاثون 429",
    expected_side_effect: "لا رد بعد تجاوز الحد، مع retry_after_seconds",
    evidence_required: "عدد 200 = 30 ثم 429 + retry_after_seconds",
  },
  async (rec) => {
    const xff = `${RUN}-wf027`;
    let ok = 0;
    let last = null;
    for (let i = 0; i < 31; i++) {
      const r = await req(BASE, "POST", "/api/chat", {
        body: { messages: [{ role: "user", content: "السعر كام؟" }] },
        xff,
      });
      if (r.status === 200) ok++;
      last = r;
    }
    rec.actual = {
      accepted: ok,
      last_http: last.status,
      last_code: last.json?.code,
      retry_after_seconds: last.json?.retry_after_seconds,
      request_id: last.requestId,
    };
    return {
      checks: [
        check(ok === 30, `عدد المقبول = ${ok} (المتوقع 30)`),
        check(last.status === 429, `الحادي والثلاثون → HTTP ${last.status} (المتوقع 429)`),
        check(last.json?.code === "RATE_LIMITED", `code=${last.json?.code}`),
        check(Number(last.json?.retry_after_seconds) > 0, `retry_after_seconds=${last.json?.retry_after_seconds}`),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-028
await scenario(
  {
    id: "WF-028",
    title: "قيمة غير مسموحة في حقل مُعدَّد وحد الأصناف",
    input: "payment='bitcoin' ثم items من 51 صنفًا (الحد 50)",
    precondition: "z.enum(['cod','vodafone_cash']) و items.max(50)",
    expected_decision: "422 في الحالتين",
    expected_side_effect: "لا طلب",
    evidence_required: "422 + رسائل محددة + ثبات عدد الطلبات",
  },
  async (rec) => {
    const before = (await dbFacts()).orders;
    const badPayment = await req(BASE, "POST", "/api/orders", {
      body: order([{ id: "p3", qty: 1 }], { payment: "bitcoin" }),
      xff: `${RUN}-wf028a`,
    });
    const tooMany = await req(BASE, "POST", "/api/orders", {
      body: order(Array.from({ length: 51 }, (_, i) => ({ id: "p3", qty: 1, _i: i })).map(({ _i, ...x }) => x)),
      xff: `${RUN}-wf028b`,
    });
    const after = (await dbFacts()).orders;
    rec.actual = {
      bad_payment: { http: badPayment.status, code: badPayment.json?.code, error: badPayment.json?.error },
      too_many_items: { http: tooMany.status, code: tooMany.json?.code, error: tooMany.json?.error },
      orders_before: before,
      orders_after: after,
    };
    return {
      checks: [
        check(badPayment.status === 422, `payment غير مسموح → HTTP ${badPayment.status} (المتوقع 422)`),
        check(badPayment.json?.code === "VALIDATION_FAILED", `code=${badPayment.json?.code}`),
        check(tooMany.status === 422, `51 صنفًا → HTTP ${tooMany.status} (المتوقع 422)`),
        check(/50/.test(tooMany.json?.error ?? ""), `الرسالة تسمّي الحد 50: «${tooMany.json?.error}»`),
        check(after === before, `عدد الطلبات ${before} → ${after}`),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-029
await scenario(
  {
    id: "WF-029",
    title: "X-Request-Id على النجاح والخطأ معًا",
    input: "200 على /api/products و422 على /api/chat و401 على /api/orders و409 على طلب مرفوض",
    precondition: "apiHandler يضبط X-Request-Id ويظهر request_id في جسم الخطأ",
    expected_decision: "معرّف قابل للربط بالسجلات في كل استجابة",
    expected_side_effect: "لا استجابة بلا معرّف",
    evidence_required: "رأس + جسم متطابقان في كل حالة",
  },
  async (rec) => {
    const probes = [];
    const a = await fetch(BASE + "/api/products", { headers: { "x-forwarded-for": `${RUN}-wf029a` } });
    probes.push({ case: "200 /api/products", header: a.headers.get("x-request-id"), bodyId: null });

    const b = await req(BASE, "POST", "/api/chat", { body: { nope: 1 }, xff: `${RUN}-wf029b` });
    probes.push({ case: `422 chat`, header: b.requestId, bodyId: b.json?.request_id });

    const c = await req(BASE, "GET", "/api/orders", { xff: `${RUN}-wf029c` });
    probes.push({ case: `401 orders`, header: c.requestId, bodyId: c.json?.request_id });

    await setProduct("p3", { stock: 0 });
    const d = await req(BASE, "POST", "/api/orders", {
      body: order([{ id: "p3", qty: 5 }]),
      xff: `${RUN}-wf029d`,
    });
    probes.push({ case: `409 conflict`, header: d.requestId, bodyId: d.json?.request_id });
    await setProduct("p3", { stock: 80 });

    rec.actual = { probes };
    return {
      checks: [
        ...probes.map((p) =>
          check(
            Boolean(p.header) && (p.bodyId == null || p.bodyId === p.header),
            `${p.case} — header=${p.header}${p.bodyId ? ` body=${p.bodyId}` : ""}`
          )
        ),
        check(
          probes.every((p) => p.header && p.header.startsWith("req_")),
          "كل المعرّفات بالصيغة req_ القابلة للبحث في السجلات"
        ),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-030
await scenario(
  {
    id: "WF-030",
    title: "مسار غير موجود — 404 بلا تسريب",
    input: "GET /api/does-not-exist و GET /api/orders/../admin/diagnostics",
    precondition: "لا شيء",
    expected_decision: "404 موحّد، لا stack ولا كشف بنية",
    expected_side_effect: "لا كتابة",
    evidence_required: "404 + غياب stack/مسارات داخلية عن الرد",
  },
  async (rec) => {
    const a = await fetch(BASE + "/api/does-not-exist", { headers: { "x-forwarded-for": `${RUN}-wf030a` } });
    const at = await a.text();
    const b = await fetch(BASE + "/api/orders/../admin/diagnostics", {
      headers: { "x-forwarded-for": `${RUN}-wf030b` },
      redirect: "manual",
    });
    const bt = await b.text();
    // تسريب حقيقي = مسار نظام مطلق أو إطار stack.
    // أما `node_modules` داخل اسم chunk فهو أثر وضع التطوير (next-devtools /
    // hmr-client) وليس تسريبًا؛ قيس على بناء الإنتاج في WF-031 بدل خلطه هنا.
    const REAL_LEAK = /at\s+[\w$.]+\s*\(|\/home\/user\/|\.ts:\d+:\d+/;
    const DEV_ARTIFACT = /next-devtools|hmr-client|node_modules_next_dist/;
    rec.actual = {
      missing_route_http: a.status,
      missing_route_excerpt: at.slice(0, 160),
      traversal_http: b.status,
      traversal_excerpt: bt.slice(0, 160),
      real_leak: REAL_LEAK.test(at + bt),
      dev_only_artifact_present: DEV_ARTIFACT.test(at + bt),
    };
    return {
      checks: [
        check(a.status === 404, `مسار غير موجود → HTTP ${a.status} (المتوقع 404)`),
        check(!REAL_LEAK.test(at + bt), "لا stack حقيقي ولا مسار نظام مطلق في أيٍّ من الردّين"),
        check(b.status === 404 || b.status === 308 || b.status === 401, `محاولة اجتياز المسار → HTTP ${b.status} (لا وصول)`),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-031
await scenario(
  {
    id: "WF-031",
    title: "بناء الإنتاج لا يسرّب ما يسرّبه وضع التطوير",
    input: "GET /api/does-not-exist على :3000 (dev) مقابل :3003 (next start)",
    precondition: "نفس الكود؛ :3003 يعمل من npm run build",
    expected_decision: "آثار أدوات التطوير تظهر في dev وتختفي في الإنتاج",
    expected_side_effect: "لا stack ولا مسار نظام في الحالتين",
    evidence_required: "قائمة التطابقات لكل بيئة + حجم الردّين",
  },
  async (rec) => {
    const pats = {
      "at Object.": /at\s+[\w$.]+\s*\(/,
      node_modules: /node_modules/,
      ".ts:L:C": /\.ts:\d+:\d+/,
      "/home/user": /\/home\/user\//,
      "next-devtools": /next-devtools/,
      "hmr-client": /hmr-client/,
    };
    const out = {};
    for (const [label, base] of [["dev", BASE], ["prod", PROD_BASE]]) {
      const r = await fetch(base + "/api/does-not-exist", {
        headers: { "x-forwarded-for": `${RUN}-wf031-${label}` },
      });
      const t = await r.text();
      out[label] = {
        http: r.status,
        bytes: t.length,
        matches: Object.entries(pats).filter(([, p]) => p.test(t)).map(([n]) => n),
      };
    }
    const realLeak = (v) => v.matches.some((m) => ["at Object.", ".ts:L:C", "/home/user"].includes(m));
    rec.actual = {
      environments: out,
      dev_only_artifacts: out.dev.matches.filter((m) => !out.prod.matches.includes(m)),
      real_leak_dev: realLeak(out.dev),
      real_leak_prod: realLeak(out.prod),
    };
    return {
      checks: [
        check(out.dev.http === 404 && out.prod.http === 404, `404 في البيئتين (dev=${out.dev.http}, prod=${out.prod.http})`),
        check(!realLeak(out.dev), `لا تسريب حقيقي في dev: ${JSON.stringify(out.dev.matches)}`),
        check(!realLeak(out.prod), `لا تسريب حقيقي في prod: ${JSON.stringify(out.prod.matches)}`),
        check(
          out.dev.matches.length > out.prod.matches.length,
          `آثار التطوير مقصورة على dev (dev=${out.dev.matches.length}، prod=${out.prod.matches.length})`
        ),
      ],
    };
  }
);

// ---------------------------------------------------------------- WF-032
await scenario(
    {
      id: "WF-032",
      title: "تكافؤ dev/prod على محرّك الرد الاحتياطي — حارس البناء القديم",
      input: "نفس استعلام الدردشة على :3000 (dev) و:3003 (next start)",
      precondition: "نفس الكود؛ :3003 يُبنى من npm run build قبل التشغيل",
      expected_decision: "قرار واحد في البيئتين — لا يختلف المحرك بالوضع",
      expected_side_effect: "لا كتابة؛ قراءة فقط",
      evidence_required: "أول ترشيح في كل بيئة + هل خُطف السؤال بـFAQ في أيٍّ منهما",
    },
    /**
     * لماذا هذا السيناريو موجود:
     *
     * WF-012/013/014 تُقاس كلها على `:3000` (dev). ولو نُسي `npm run build`
     * بعد إصلاح، لبقي بناء الإنتاج على السلوك القديم وظلّ المختبر أخضر —
     * وقد حدث هذا فعلًا: بعد إصلاح D-4/D-5 أعاد `:3003` القديم جواب الدفع
     * الخاطئ نفسه بينما `:3000` يُرشّح المنتجات.
     *
     * لذلك يُقاس القرار في البيئتين ويُشترط تطابقه. أي بناء قديم يُسقط هذا
     * الفحص فورًا بدل أن يختبئ خلف مصفوفة خضراء.
     */
    async (rec) => {
      const query = "هات أرخص منظف أرضيات متاح";
      const ask = async (base, label) => {
        const r = await fetch(base + "/api/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": `${RUN}-wf032-${label}`,
          },
          body: JSON.stringify({ messages: [{ role: "user", content: query }] }),
        });
        const j = await r.json().catch(() => ({}));
        const reply = String(j?.reply ?? "");
        return {
          http: r.status,
          source: j?.source ?? null,
          first_recommendation: reply.split("\n").find((l) => l.includes("•"))?.replace("•", "").trim() ?? null,
          // خطف FAQ هو العيب نفسه: جواب عن الدفع وبلا أي سعر.
          faq_hijack: /فودافون كاش|الدفع عند الاستلام/.test(reply) && !/\d+\s*جنيه/.test(reply),
        };
      };

      const [dev, prod] = [await ask(BASE, "dev"), await ask(PROD_BASE, "prod")];
      rec.actual = { query, dev, prod, identical_first_recommendation: dev.first_recommendation === prod.first_recommendation };
      return {
        checks: [
          check(dev.http === 200 && prod.http === 200, `200 في البيئتين (dev=${dev.http}, prod=${prod.http})`),
          check(!dev.faq_hijack, `dev لم يُخطف بـFAQ: ${!dev.faq_hijack}`),
          check(!prod.faq_hijack, `prod لم يُخطف بـFAQ: ${!prod.faq_hijack} — بناء قديم لو سقط هذا`),
          check(
            dev.first_recommendation === prod.first_recommendation,
            `أول ترشيح متطابق (dev=«${dev.first_recommendation}»، prod=«${prod.first_recommendation}»)`
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
