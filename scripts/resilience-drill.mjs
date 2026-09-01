#!/usr/bin/env node
/**
 * L5 RESILIENCE DRILLS — برنامج اختبار تحمّل الفشل (Failure Injection)
 * =====================================================================
 * يعمل على خادم الإنتاج الحقيقي (`next start`) وقاعدة بيانات حقيقية،
 * ويحقن أعطالاً فعلية، ويسجّل دليلاً قابلاً لإعادة التشغيل في evidence/.
 *
 *   DRILL-01  فشل DB عابر → فشل آمن (5xx) → استعادة تلقائية بدون إعادة تشغيل
 *   DRILL-02  طلبات متزامنة (نفس المفتاح + مفاتيح مختلفة) → idempotency + مخزون
 *   DRILL-03  قتل الخادم وسط طلب (restart during request) → اتساق + تعافٍ
 *   DRILL-04  جلسات: منتهية / مزوّرة / غير صالحة → 401 آمن
 *   DRILL-05  نقص متغير بيئة حرج → STARTUP FAIL برسالة واضحة
 *   DRILL-06  فشل مزوّد الذكاء الاصطناعي (Gemini/Groq) → رد محلي
 *
 * التشغيل:  npm run build && npm run test:drill
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto, { createHmac } from "node:crypto";

if (!existsSync(path.resolve(".next/BUILD_ID"))) {
  console.error("❌ .next/BUILD_ID غير موجود — شغّل `npm run build` أولاً");
  process.exit(1);
}

const dir = mkdtempSync(path.join(tmpdir(), "aborof-drill-"));
const dbPath = path.join(dir, "drill.db");
const ADMIN_PASSWORD = "drill-admin-password-123";
const ADMIN_SECRET = "drill-session-secret-0123456789abcdef";
const BASE_ENV = {
  ...process.env,
  NODE_ENV: "production",
  TURSO_DATABASE_URL: `file:${dbPath}`,
  ADMIN_PASSWORD,
  ADMIN_SESSION_SECRET: ADMIN_SECRET,
  GEMINI_API_KEY: "",
  GROQ_API_KEY: "",
};

const checks = [];
let failures = 0;
const startedAt = new Date();

function check(name, ok, detail = "") {
  checks.push({ name, ok, detail: String(detail) });
  if (!ok) failures += 1;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function get(base, p, opts = {}) {
  return fetch(`${base}${p}`, opts).then(async (r) => {
    const body = await r.text();
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* ليس JSON */
    }
    return { res: r, json: parsed, text: body };
  });
}
function post(base, p, body, opts = {}) {
  return get(base, p, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: JSON.stringify(body),
    ...opts,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port, envExtra = {}) {
  const env = { ...BASE_ENV, ...envExtra };
  const child = spawn(
    process.execPath,
    [path.resolve("node_modules/next/dist/bin/next"), "start", "-p", String(port)],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
    if (process.env.SMOKE_VERBOSE) process.stderr.write(d);
  });
  return { child, stderr: () => stderr };
}

async function waitHealthy(base, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return true;
    } catch {
      /* لم يبدأ بعد */
    }
    await sleep(250);
  }
  return false;
}

async function stopServer(srv, signal = "SIGTERM") {
  if (!srv || srv.child.exitCode !== null) return;
  srv.child.kill(signal);
  await new Promise((resolve) => {
    if (srv.child.exitCode !== null) return resolve();
    srv.child.once("exit", resolve);
    setTimeout(resolve, 5000);
  });
}

async function adminCookie(base) {
  const r = await post(base, "/api/admin/login", { password: ADMIN_PASSWORD });
  const setCookie = r.res.headers.get("set-cookie") || "";
  return setCookie.split(";")[0];
}

// ============================================================
async function run() {
  console.log(`\n🧨 L5 RESILIENCE DRILLS — ${startedAt.toISOString()}`);
  console.log(`   DB: ${dbPath}\n`);

  // ---------- DRILL-01: transient DB failure → safe fail → auto recovery ----------
  console.log("── DRILL-01: فشل DB عابر (FAULT_INJECTION=fail:4) ثم استعادة تلقائية ──");
  const s1 = startServer(3311, { FAULT_INJECTION: "fail:4" });
  try {
    check("D01: الخادم بدأ رغم فشل DB القادم", await waitHealthy("http://127.0.0.1:3311"));
    // التسلسل: 4 عمليات DB ستفشل (ready, ready, products, POST) ثم تتعافى تلقائياً
    let r = await get("http://127.0.0.1:3311", "/api/ready");
    check(
      "D01: /api/ready أثناء الفشل → 503 not_ready",
      r.res.status === 503 && r.json?.status === "not_ready",
      `${r.res.status} ${JSON.stringify(r.json)}`
    );
    r = await get("http://127.0.0.1:3311", "/api/ready");
    check("D01: /api/ready ما زال 503", r.res.status === 503, String(r.res.status));
    r = await get("http://127.0.0.1:3311", "/api/products");
    check(
      "D01: /api/products يتحلل بأمان (seed) بدل انهيار 500",
      r.res.status === 200 && r.json?.products?.length === 12,
      String(r.res.status)
    );
    r = await post("http://127.0.0.1:3311", "/api/orders", {
      customer: "فشل-عابر",
      phone: "01011111111",
      governorate: "القاهرة",
      address: "عنوان اختبار",
      items: [{ id: "p2", qty: 1 }],
      idempotencyKey: "D01-FAIL",
    });
    check("D01: الطلب أثناء الفشل يفشل بأمان (5xx وليس نجاحاً جزئياً)", r.res.status >= 500, String(r.res.status));
    r = await get("http://127.0.0.1:3311", "/api/ready");
    check(
      "D01: /api/ready بعد استنفاد الأعطال → 200 ready (تعافٍ تلقائي بدون إعادة تشغيل)",
      r.res.status === 200 && r.json?.status === "ready",
      `${r.res.status} ${JSON.stringify(r.json)}`
    );
    r = await post("http://127.0.0.1:3311", "/api/orders", {
      customer: "بعد-التعافي",
      phone: "01022222222",
      governorate: "القاهرة",
      address: "عنوان اختبار",
      items: [{ id: "p2", qty: 1 }],
      idempotencyKey: "D01-RECOVER",
    });
    check(
      "D01: الطلب التالي ينجح بعد التعافي",
      r.res.status === 200 && Boolean(r.json?.id),
      `${r.res.status} ${r.json?.id || r.json?.error}`
    );
    r = await get("http://127.0.0.1:3311", "/api/products");
    const p2after = r.json?.products?.find((p) => p.id === "p2");
    check("D01: خصم واحد فقط بعد التعافي (p2: 60 → 59)", p2after?.stock === 59, String(p2after?.stock));
  } finally {
    await stopServer(s1);
  }

  // ---------- DRILL-02: concurrent duplicate submission ----------
  console.log("\n── DRILL-02: طلبات متزامنة — نفس المفتاح + مفاتيح مختلفة ──");
  const s2 = startServer(3312);
  try {
    await waitHealthy("http://127.0.0.1:3312");
    const keyC = crypto.randomUUID();
    const sameBody = {
      customer: "منافس-مكرر",
      phone: "01033333333",
      governorate: "الجيزة",
      address: "عنوان متزامن",
      items: [{ id: "p1", qty: 1 }],
      idempotencyKey: keyC,
    };
    // 12 عميلاً مختلفاً (عناوين IP مختلفة) — واقعي، ولا يصطدم بحد rate-limit للعميل الواحد
    const parallel = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        post("http://127.0.0.1:3312", "/api/orders", sameBody, {
          headers: { "x-forwarded-for": `10.0.1.${i + 1}` },
        })
      )
    );
    const ids = new Set(parallel.map((r) => r.json?.id).filter(Boolean));
    const dupCount = parallel.filter((r) => r.json?.duplicate === true).length;
    check(
      "D02: كل 12 استجابة 200",
      parallel.every((r) => r.res.status === 200),
      parallel.map((r) => r.res.status).join(",")
    );
    check("D02: كل الاستجابات لنفس رقم الطلب", ids.size === 1, [...ids][0] || "بدون id");
    check(`D02: حدث تصادم حقيقي (${dupCount} استجابة duplicate=true)`, dupCount >= 1, `${dupCount}/12`);

    const distinct = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        post(
          "http://127.0.0.1:3312",
          "/api/orders",
          {
            customer: `مزامنة-${i}`,
            phone: `0104${String(i).padStart(7, "0")}`,
            governorate: "القاهرة",
            address: "عنوان",
            items: [{ id: "p3", qty: 1 }],
            idempotencyKey: crypto.randomUUID(),
          },
          {
            headers: { "x-forwarded-for": `10.0.2.${i + 1}` },
          }
        )
      )
    );
    check(
      "D02: 6 طلبات بمفاتيح مختلفة → 6 أرقام مختلفة",
      distinct.every((r) => r.res.status === 200) && new Set(distinct.map((r) => r.json?.id)).size === 6,
      String(new Set(distinct.map((r) => r.json?.id)).size)
    );

    let r = await get("http://127.0.0.1:3312", "/api/products");
    const stocks = r.json?.products || [];
    check(
      "D02: المخزون خُصم مرة واحدة فقط (p1: 40 → 39)",
      stocks.find((p) => p.id === "p1")?.stock === 39,
      String(stocks.find((p) => p.id === "p1")?.stock)
    );
    check(
      "D02: p3: 80 → 74 (6 طلبات)",
      stocks.find((p) => p.id === "p3")?.stock === 74,
      String(stocks.find((p) => p.id === "p3")?.stock)
    );
    check(
      "D02: لا يوجد مخزون سالب إطلاقاً",
      stocks.every((p) => Number(p.stock) >= 0)
    );

    const cookie = await adminCookie("http://127.0.0.1:3312");
    r = await get("http://127.0.0.1:3312", "/api/orders", { headers: { cookie } });
    const orders = r.json?.orders || [];
    check(
      "D02: طلب واحد فقط للمفتاح المتكرر (بدل 12)",
      orders.filter((o) => o.customer === "منافس-مكرر").length === 1,
      String(orders.filter((o) => o.customer === "منافس-مكرر").length)
    );
  } finally {
    await stopServer(s2);
  }

  // ---------- DRILL-03: restart during in-flight request ----------
  console.log("\n── DRILL-03: قتل الخادم وسط طلب قيد التنفيذ ثم التحقق من الاتساق ──");
  const keyD = crypto.randomUUID();
  const s3 = startServer(3313, { FAULT_INJECTION: "delay:300" });
  try {
    await waitHealthy("http://127.0.0.1:3313");
    const inFlight = post("http://127.0.0.1:3313", "/api/orders", {
      customer: "وسط-إعادة-تشغيل",
      phone: "01055555555",
      governorate: "القاهرة",
      address: "عنوان",
      items: [{ id: "p1", qty: 2 }],
      idempotencyKey: keyD,
    }).catch(() => null);
    // مع delay:300ms لكل عملية DB، الطلب يستغرق ~3.5s؛ نقتل عند 2.9s داخل نافذة المعاملة
    await sleep(2900);
    const killStart = Date.now();
    s3.child.kill("SIGKILL");
    await Promise.race([new Promise((resolve) => s3.child.once("exit", resolve)), sleep(5000)]);
    console.log(`   ⚡ قُتل الخادم (SIGKILL) في ${Date.now() - killStart}ms بينما الطلب قيد التنفيذ`);
    await inFlight; // نهمل فشل/نجاح الاستجابة — المهم حالة قاعدة البيانات
  } finally {
    await stopServer(s3);
  }

  const s4 = startServer(3314);
  try {
    check("D03: الخادم يعود للعمل بعد القتل", await waitHealthy("http://127.0.0.1:3314"));
    let r = await get("http://127.0.0.1:3314", "/api/products");
    const p1AfterKill = r.json?.products?.find((p) => p.id === "p1")?.stock;
    const cookie = await adminCookie("http://127.0.0.1:3314");
    r = await get("http://127.0.0.1:3314", "/api/orders", { headers: { cookie } });
    const killedOrders = (r.json?.orders || []).filter((o) => o.customer === "وسط-إعادة-تشغيل");
    // اتساق: إما اكتمل الطلب (مخزون -2 + طلب موجود) أو لم يحدث شيء إطلاقاً — لا حالة وسطى
    const committed = killedOrders.length === 1;
    check(
      "D03: اتساق — لا حالة وسطى (طلب مكتمل ⟺ خصم كامل)",
      committed ? p1AfterKill === 37 : p1AfterKill === 39,
      `p1=${p1AfterKill}, orders=${killedOrders.length}`
    );

    // إعادة محاولة نفس المفتاح بعد إعادة التشغيل → نتيجة حتمية واحدة مهما كانت نقطة القتل
    r = await post("http://127.0.0.1:3314", "/api/orders", {
      customer: "وسط-إعادة-تشغيل",
      phone: "01055555555",
      governorate: "القاهرة",
      address: "عنوان",
      items: [{ id: "p1", qty: 2 }],
      idempotencyKey: keyD,
    });
    check("D03: إعادة المحاولة بنفس المفتاح تنجح (200)", r.res.status === 200, String(r.res.status));
    r = await get("http://127.0.0.1:3314", "/api/products");
    const p1Final = r.json?.products?.find((p) => p.id === "p1")?.stock;
    r = await get("http://127.0.0.1:3314", "/api/orders", { headers: { cookie } });
    const ordersD = (r.json?.orders || []).filter((o) => o.customer === "وسط-إعادة-تشغيل");
    // حتمية: مهما كانت نقطة القتل، النهاية = طلب واحد + خصم واحد (p1: 39-2=37)
    check(
      "D03: الحتمية عبر إعادة التشغيل — طلب واحد فقط وخصم واحد (p1 = 37)",
      ordersD.length === 1 && p1Final === 37,
      `p1=${p1Final}, orders=${ordersD.length}`
    );

    r = await post("http://127.0.0.1:3314", "/api/orders", {
      customer: "بعد-إعادة-التشغيل",
      phone: "01066666666",
      governorate: "القاهرة",
      address: "عنوان",
      items: [{ id: "p4", qty: 1 }],
      idempotencyKey: crypto.randomUUID(),
    });
    check("D03: طلب جديد ينجح بعد إعادة التشغيل (تعافٍ كامل)", r.res.status === 200, String(r.res.status));

    // ---------- DRILL-04: expired / invalid / tampered sessions ----------
    console.log("\n── DRILL-04: جلسات منتهية ومزوّرة وغير صالحة ──");
    const sign = (payload) => createHmac("sha256", ADMIN_SECRET).update(payload).digest("base64url");
    const mkToken = (ts) => {
      const payload = Buffer.from(`${ts}:drill`).toString("base64url");
      return `${payload}.${sign(payload)}`;
    };
    const expired = mkToken(Date.now() - 9 * 60 * 60 * 1000);
    r = await get("http://127.0.0.1:3314", "/api/orders", { headers: { cookie: `aborof_admin_session=${expired}` } });
    check("D04: جلسة منتهية → 401", r.res.status === 401, String(r.res.status));
    const valid = mkToken(Date.now());
    r = await get("http://127.0.0.1:3314", "/api/orders", { headers: { cookie: `aborof_admin_session=${valid}` } });
    check("D04: جلسة صالحة → 200", r.res.status === 200, String(r.res.status));
    const tampered = `${valid.slice(0, -3)}AAA`;
    r = await get("http://127.0.0.1:3314", "/api/orders", { headers: { cookie: `aborof_admin_session=${tampered}` } });
    check("D04: توقيع مزوّر → 401", r.res.status === 401, String(r.res.status));
    r = await get("http://127.0.0.1:3314", "/api/orders", { headers: { cookie: "aborof_admin_session=not-a-token" } });
    check("D04: كوكي غير صالح → 401", r.res.status === 401, String(r.res.status));
  } finally {
    await stopServer(s4);
  }

  // ---------- DRILL-05: missing critical env → startup fail ----------
  console.log("\n── DRILL-05: نقص متغير بيئة حرج (بدون TURSO_DATABASE_URL) ──");
  const s5 = startServer(3315, { TURSO_DATABASE_URL: "" });
  try {
    const exited = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 20_000);
      s5.child.once("exit", (code) => {
        clearTimeout(t);
        resolve(true);
      });
    });
    check("D05: الخادم يرفض الإقلاع (يفشل مبكراً بدل تشغيل مكسور)", exited === true, `exited=${exited}`);
    check(
      "D05: رسالة واضحة: Environment contract violated",
      s5.stderr().includes("Environment contract violated"),
      s5.stderr().slice(0, 120).replace(/\n/g, " ")
    );
  } finally {
    await stopServer(s5);
  }

  // ---------- DRILL-06: AI provider failure → local fallback ----------
  console.log("\n── DRILL-06: فشل مزوّدي الذكاء الاصطناعي (مفاتيح غير صالحة) ──");
  const s6 = startServer(3316, { GEMINI_API_KEY: "invalid-key-for-drill", GROQ_API_KEY: "invalid-key-for-drill" });
  try {
    await waitHealthy("http://127.0.0.1:3316");
    const r = await post("http://127.0.0.1:3316", "/api/chat", {
      messages: [{ role: "user", content: "كم سعر الشحن؟" }],
    });
    check("D06: الشات يرد 200 رغم فشل المزوّدين", r.res.status === 200, String(r.res.status));
    check(
      "D06: الرد احتياطي محلي صحيح (المصدر local)",
      r.json?.source === "local" && Boolean(r.json?.reply),
      `source=${r.json?.source}`
    );
    check("D06: الرد يطابق بيانات المتجر", String(r.json?.reply).includes("50 جنيه"));
  } finally {
    await stopServer(s6);
  }

  // ---------- الخلاصة والأدلة ----------
  console.log(`\n${"─".repeat(64)}`);
  console.log(
    `النتيجة: ${failures === 0 ? "✅ L5 RESILIENCE PASS — النظام يتحمل الفشل ويتعافى" : `❌ L5 RESILIENCE FAIL — ${failures} فحص فاشل`}`
  );
  console.log("─".repeat(64));

  writeEvidence();
  rmSync(dir, { recursive: true, force: true });
  return failures === 0 ? 0 : 1;
}

function writeEvidence() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const mdPath = path.resolve(`evidence/l5-resilience/l5-resilience-${ts}.md`);
  const jsonPath = path.resolve(`evidence/l5-resilience/l5-resilience-${ts}.json`);
  const lines = [
    "# L5 Resilience Drill — Evidence",
    "",
    `- **التاريخ:** ${new Date().toISOString()}`,
    `- **المرجع:** ${"worktree@" + new Date().toISOString().slice(0, 16)}`,
    `- **الأمر لإعادة التشغيل:** \`npm run build && npm run test:drill\``,
    "- **البيئة:** خادم `next start` (إنتاج) + قاعدة ملف SQLite نظيفة + حقن فشل عبر `FAULT_INJECTION` (بذرة اختبار فقط، بلا أثر في الإنتاج)",
    "",
    "## النتائج",
    "",
    "| الفحص | النتيجة | التفاصيل |",
    "|---|---|---|",
    ...checks.map((c) => `| ${c.name} | ${c.ok ? "✅ PASS" : "❌ FAIL"} | ${c.detail.replace(/\|/g, "\\|")} |`),
    "",
    `## الحكم النهائي: ${failures === 0 ? "✅ L5 RESILIENCE PASS" : `❌ L5 RESILIENCE FAIL (${failures})`}`,
    "",
  ];
  mkdirSync(path.resolve("evidence"), { recursive: true });
  writeFileSync(mdPath, lines.join("\n"));
  writeFileSync(jsonPath, JSON.stringify({ ts: new Date().toISOString(), failures, checks }, null, 2));
  console.log(`📄 الدليل: ${mdPath}`);
  console.log(`📄 الدليل (JSON): ${jsonPath}`);
}

run().then((code) => process.exit(code));
