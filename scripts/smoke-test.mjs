#!/usr/bin/env node
/**
 * PRODUCTION SMOKE TEST — LEVEL 3 (Runtime) + LEVEL 4 (Business)
 * ===============================================================
 * يبني خادم الإنتاج الفعلي (`next start`) على قاعدة بيانات جديدة نظيفة
 * ثم يختبر النظام مثل مستخدم حقيقي، ويفشل (exit 1) عند أول خلل.
 *
 * التشغيل:  npm run build && npm run test:smoke
 * (النص يبدأ `next start` بنفسه ولا يحتاج خادماً قائماً)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const PORT = process.env.SMOKE_PORT || "3210";
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(path.join(tmpdir(), "aborof-smoke-"));
const dbPath = path.join(dir, "smoke.db");

const env = {
  ...process.env,
  NODE_ENV: "production",
  TURSO_DATABASE_URL: `file:${dbPath}`,
  ADMIN_PASSWORD: "smoke-admin-password-123",
  ADMIN_SESSION_SECRET: "smoke-session-secret-0123456789abcdef",
  PORT: undefined, // نمرر المنفذ عبر -p
};

let failures = 0;
const checks = [];

function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function get(pathname, opts = {}) {
  const res = await fetch(`${BASE}${pathname}`, opts);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ليس JSON */
  }
  return { res, text, json };
}

function post(pathname, body, opts = {}) {
  return get(pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: JSON.stringify(body),
  });
}

async function waitForServer(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      /* الخادم لم يبدأ بعد */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function run() {
  console.log(`\n🧪 Production smoke test (next start, port ${PORT}, fresh DB)`);
  console.log(`   DB: ${dbPath}\n`);

  const server = spawn(process.execPath, [path.resolve("node_modules/next/dist/bin/next"), "start", "-p", PORT], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => process.env.SMOKE_VERBOSE && process.stdout.write(d));
  server.stderr.on("data", (d) => process.env.SMOKE_VERBOSE && process.stderr.write(d));

  try {
    if (!(await waitForServer())) {
      check("خادم الإنتاج بدأ واستجاب لـ /api/health", false, "timeout");
      return 1;
    }
    check("خادم الإنتاج بدأ واستجاب لـ /api/health", true);

    // ---------- LEVEL 3: Runtime ----------
    let r = await get("/");
    check("GET / → 200", r.res.status === 200, String(r.res.status));
    check("الصفحة الرئيسية تعرض اسم المتجر", r.text.includes("روفيده"));

    r = await get("/product/p1");
    check("GET /product/p1 → 200 (regression: كانت 404)", r.res.status === 200, String(r.res.status));
    check("صفحة المنتج تعرض اسم المنتج", r.text.includes("منظف أرضيات"));

    r = await get("/product/nonexistent");
    check("GET /product/nonexistent → 404", r.res.status === 404, String(r.res.status));

    r = await get("/api/health");
    check("GET /api/health → 200 + status ok", r.res.status === 200 && r.json?.status === "ok");

    r = await get("/api/ready");
    check(
      "GET /api/ready → 200 + ready (DB متصلة)",
      r.res.status === 200 && r.json?.status === "ready" && r.json?.database === "ok",
      JSON.stringify(r.json)
    );

    r = await get("/");
    check("Security headers موجودة (CSP)", Boolean(r.res.headers.get("content-security-policy")));
    check("X-Content-Type-Options: nosniff", r.res.headers.get("x-content-type-options") === "nosniff");
    check("X-Request-Id يظهر في الاستجابة", Boolean(r.res.headers.get("x-request-id")));

    r = await get("/api/products");
    const products = r.json?.products || [];
    check("GET /api/products → 12 منتجات من بذرة نظيفة", products.length === 12, String(products.length));
    const p1 = products.find((p) => p.id === "p1");
    check("p1 stock أولي = 40", p1?.stock === 40, String(p1?.stock));

    // ---------- LEVEL 4: Business ----------
    // شات سيليا (رد محلي بدون مفاتيح)
    r = await post("/api/chat", { messages: [{ role: "user", content: "كم سعر الشحن؟" }] });
    check(
      "شات سيليا يرد على سؤال بشحن",
      r.json?.source === "local" && r.json?.reply?.includes("50 جنيه"),
      JSON.stringify(r.json?.reply?.slice(0, 60))
    );

    // إنشاء طلب مع مفتاح idempotency
    const key1 = crypto.randomUUID();
    const orderBody = {
      customer: "محمد أحمد",
      phone: "01012345678",
      governorate: "القاهرة",
      address: "المنيل، شارع النيل، عمارة 5",
      items: [
        { id: "p1", qty: 2 },
        { id: "p2", qty: 1 },
      ],
      payment: "vodafone_cash",
      idempotencyKey: key1,
    };
    r = await post("/api/orders", orderBody);
    check("إنشاء طلب → 200 + رقم طلب", r.res.status === 200 && Boolean(r.json?.id), r.json?.id || r.json?.error);
    const orderId = r.json?.id;
    check("الإجمالي محسوب من الخادم (360+95+50=505)", r.json?.total === 505, String(r.json?.total));

    // إعادة نفس الطلب (نفس المفتاح) → نفس رقم الطلب + duplicate:true
    const dup = await post("/api/orders", orderBody);
    check(
      "طلب مكرر بنفس idempotencyKey → نفس رقم الطلب",
      dup.json?.id === orderId && dup.json?.duplicate === true,
      `${dup.json?.id} / duplicate=${dup.json?.duplicate}`
    );
    check("الطلب المكرر لا يخصم المخزون مرتين", true, "يُتحقق أدناه من المخزون");

    r = await get("/api/products");
    const after = r.json?.products.find((p) => p.id === "p1");
    check("المخزون خُصم مرة واحدة فقط (40 - 2 = 38)", after?.stock === 38, String(after?.stock));

    // طلب ثانٍ (بدون مفتاح) ثم إلغاؤه → استرجاع المخزون
    const key2 = crypto.randomUUID();
    const order2 = await post("/api/orders", { ...orderBody, items: [{ id: "p1", qty: 5 }], idempotencyKey: key2 });
    check("طلب ثانٍ → 200", order2.res.status === 200 && Boolean(order2.json?.id), order2.json?.id);
    const order2Id = order2.json?.id;

    // ---------- Failure/Invalid cases ----------
    // (p1 stock الآن 33 بعد الطلبين: 40-2-5؛ و50 ≤ حد القطعة 100 لكنها > المخزون)
    r = await post("/api/orders", {
      ...orderBody,
      items: [{ id: "p1", qty: 50 }],
      idempotencyKey: crypto.randomUUID(),
    });
    check("كمية أكبر من المخزون → 409", r.res.status === 409, String(r.res.status));

    r = await post("/api/orders", { ...orderBody, governorate: "محافظة وهمية", idempotencyKey: crypto.randomUUID() });
    check("محافظة غير صالحة → 422", r.res.status === 422, String(r.res.status));

    r = await post("/api/orders", { ...orderBody, items: [{ id: "p9", qty: 0 }], idempotencyKey: crypto.randomUUID() });
    check("كمية صفر → 422", r.res.status === 422, String(r.res.status));

    r = await get("/api/orders", {
      headers: { "Content-Type": "application/json" },
      method: "POST",
      body: "{bad json",
    });
    check("جسم مشوّه (bad JSON) → 400", r.res.status === 400, String(r.res.status));

    r = await get("/api/orders", { headers: { cookie: "aborof_admin_session=garbage.token" } });
    check("كوكي إدارة غير صالح → 401", r.res.status === 401, String(r.res.status));

    // ---------- Admin ----------
    r = await post("/api/admin/login", { password: "wrong-password" });
    check("كلمة مرور خاطئة → 401", r.res.status === 401, String(r.res.status));

    const loginRes = await fetch(`${BASE}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
    });
    const setCookie = loginRes.headers.get("set-cookie") || "";
    const cookie = setCookie.split(";")[0];
    check("تسجيل دخول الإدارة → 200 + كوكي", loginRes.status === 200 && Boolean(cookie), loginRes.status);

    r = await get("/api/admin/session", { headers: { cookie } });
    check("الجلسة معتمدة (regression: كانت false دائماً)", r.json?.authenticated === true, JSON.stringify(r.json));

    r = await get("/api/orders", { headers: { cookie } });
    check("قائمة الطلبات للإدارة → 200", r.res.status === 200 && Array.isArray(r.json?.orders), String(r.res.status));
    check("الطلبان ظاهران (2)", r.json?.orders?.length === 2, String(r.json?.orders?.length));

    r = await get(`/api/orders`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ id: orderId, status: "مؤكد" }),
    });
    check("تغيير حالة الطلب إلى «مؤكد» → 200", r.res.status === 200, String(r.res.status));

    r = await get("/api/orders", { headers: { cookie } });
    const confirmed = r.json?.orders?.find((o) => o.id === orderId);
    check("الحالة أصبحت «مؤكد»", confirmed?.status === "مؤكد", confirmed?.status);

    r = await get(`/api/orders`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ id: order2Id, status: "ملغى" }),
    });
    check("إلغاء الطلب الثاني → 200", r.res.status === 200, String(r.res.status));

    r = await get("/api/products");
    const afterCancel = r.json?.products.find((p) => p.id === "p1");
    // 40 (بداية) − 2 (الطلب الأول) − 5 (الطلب الثاني) + 5 (استرجاع الإلغاء) = 38
    check("إلغاء الطلب أعاد المخزون (33 + 5 = 38)", afterCancel?.stock === 38, String(afterCancel?.stock));

    r = await get(`/api/orders`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ id: "ORD-غير-موجود", status: "مؤكد" }),
    });
    check("تغيير حالة طلب غير موجود → 404", r.res.status === 404, String(r.res.status));

    r = await get("/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        product: {
          id: "smoke1",
          name: "منتج سميك",
          description: "د",
          price: 10,
          old_price: "",
          category: "منظفات أرضيات",
          image: "🧪",
          stock: 3,
        },
      }),
    });
    check("إنشاء منتج من الإدارة → 200", r.res.status === 200 && r.json?.ok === true, String(r.res.status));

    r = await get("/");
    check("الصفحة الرئيسية ما زالت تعمل في نهاية الرحلة", r.res.status === 200);
  } catch (error) {
    check("التنفيذ بدون استثناءات غير متوقعة", false, String(error));
  } finally {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(
    `النتيجة: ${failures === 0 ? "✅ SMOKE PASS — الإصدار جاهز للتوزيع" : `❌ SMOKE FAIL — ${failures} فحص فاشل`}`
  );
  console.log("─".repeat(60));
  return failures === 0 ? 0 : 1;
}

run().then((code) => process.exit(code));
