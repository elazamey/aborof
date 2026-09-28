#!/usr/bin/env node
/**
 * Smoke test على بيئة الإنتاج — تطبيق قابل للتكرار لصفوف DEPLOYMENT.md.
 *
 * الافتراضي: فحوص **للقراءة فقط** (الصفوف 1، 2، 3، 5، 6 + رؤوس الأمان).
 * الفحوص الكتابية (4، 10، 11، 13، 14) تحتاج أعلامًا صريحة، لأنها:
 *   - تستهلك حد المعدل (الصف 4: 8 محاولات / 10 دقائق)،
 *   - أو تُنشئ طلبًا حقيقيًا في قاعدة الإنتاج (الصفان 10 و11).
 *
 * أمثلة:
 *   node scripts/smoke-production.mjs --base https://aborof.vercel.app
 *   node scripts/smoke-production.mjs --admin-probe            # الصف 4 (كلمة خاطئة عمدًا)
 *   node scripts/smoke-production.mjs --chat-probe             # الصف 12 (لا يكتب في القاعدة)
 *   node scripts/smoke-production.mjs --allow-mutations --orders-body ./order.json   # الصفان 10 و11
 *   node scripts/smoke-production.mjs --track <orderId> --last4 1234                 # الصفان 13 و14
 *   node scripts/smoke-production.mjs --require-csp-enforce                          # بعد ضبط CSP_ENFORCE=true
 *   node scripts/smoke-production.mjs --allow-seed-fallback                          # تنازل عن قرينة ربط Turso
 *
 * قراءتان دقيقتان مقصودتان حتى لا يعطي التشغيل الافتراضي حكمًا كاذبًا:
 *   - **CSP**: تُنشر في وضع المراقبة (`Content-Security-Policy-Report-Only`) حتى يُفعَّل
 *     `CSP_ENFORCE=true`، فيُقبل الوضعان في صف الرؤوس، ويُفرض الحجب فقط مع `--require-csp-enforce`.
 *   - **ربط Turso**: مسار قاعدة البيانات في `getProducts()` يمرّر `old_price` في كل صف دائمًا
 *     (ولو `null`)، بينما مسار البذرة المحلية يعيد كائنات `SEED_PRODUCTS` كما هي. الشكل حينها
 *     قرينة (لا إثبات) على أن `TURSO_DATABASE_URL` غير مربوط في بيئة النشر — وعندها تفشل كتابة
 *     أي طلب حقيقي بـ 503 «قاعدة البيانات غير مربوطة».
 *
 * لا تُطبع أي أسرار ولا أي بيانات عميل كاملة (يُفحص الجواب بحثًا عن PII ويُحجب).
 * كود الخروج: 0 = كل الفحوص المطلوبة خضراء، 1 = فشل حاجب، 2 = استخدام خاطئ.
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const USAGE = `الاستخدام: node scripts/smoke-production.mjs [--base https://aborof.vercel.app]
  [--admin-probe] [--chat-probe] [--allow-mutations --orders-body <file.json>] [--track <orderId> --last4 <4 digits>]
  [--require-csp-enforce] [--allow-seed-fallback] [--json]`;

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const flag = (name) => args.includes(name);

// لا تنفيذ على مستوى الوحدة: يُستورد هذا الملف في الاختبارات لفحص isSafeBaseUrl،
// لذا كل التحقق من الوسائط والتنفيذ داخل main() فقط.
const BASE = (arg("--base", "https://aborof.vercel.app") || "").replace(/\/$/, "");
const asJson = flag("--json");
const ONE_UNIFIED_MESSAGE = "تعذر العثور على الطلب";
const TIMEOUT_MS = 30_000;

/**
 * حاجز SSRF مطابق لمنطق `probe-production.yml`: https فقط، وبلا نطاقات داخلية.
 * مُصدَّر للاختبار في tests/deploy-tools.test.ts.
 */
export function isSafeBaseUrl(base) {
  if (!/^https:\/\//i.test(base)) return false;
  let host;
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  const blocked = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|metadata)/;
  return !blocked.test(host) && !host.endsWith(".local") && !host.endsWith(".internal");
}

/**
 * الرؤوس الأمنية الصارمة التي يجب أن تكون حاضرة دائمًا. رأس CSP مستثنى عمدًا
 * لأنه يُنشر في وضعين (حجب/مراقبة) وفق `CSP_ENFORCE` — انظر `classifySecurityHeaders`.
 * مُصدَّرة للاختبار في tests/deploy-tools.test.ts.
 */
export const BASELINE_SECURITY_HEADERS = [
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
];

/** وصف مقروء لوضع CSP كما يظهر في النشر الحيّ. */
export const CSP_MODE_LABEL = {
  enforce: "الحجب (CSP_ENFORCE=true)",
  "report-only": "المراقبة Report-Only (الافتراضي الموثّق)",
  absent: "غائب تمامًا",
};

/**
 * يفصل بين «الرأس غائب» و«الرأس موجود في وضع المراقبة»: طلب الرأس الحاجب حرفيًا
 * كان يُنتج ❌ كاذبة على نشر سليم يعمل بالوضع الافتراضي (Report-Only)، وهو ما
 * ظهر فعليًا في فحص الإنتاج بتاريخ 2026-09-28.
 * مُصدَّرة للاختبار في tests/deploy-tools.test.ts.
 */
export function classifySecurityHeaders(headers) {
  const missing = BASELINE_SECURITY_HEADERS.filter((h) => !headers.get(h));
  const enforcing = headers.get("content-security-policy");
  const reportOnly = headers.get("content-security-policy-report-only");
  const cspMode = enforcing ? "enforce" : reportOnly ? "report-only" : "absent";
  if (cspMode === "absent") missing.push("content-security-policy");
  return { ok: missing.length === 0, missing, cspMode };
}

/**
 * قرينة (لا إثبات) على أن الكتالوج يُخدم من البذرة المحلية لا من Turso:
 * مسار قاعدة البيانات في `getProducts()` يبني كل صف عبر كائن يحمل مفتاح
 * `old_price` **دائمًا** (قيمة `null` عند الغياب)، بينما مسار البذرة يعيد
 * كائنات `SEED_PRODUCTS` كما هي، فبعضها بلا المفتاح أصلًا. ثبات هذا العقد
 * محميّ باختبار يشغّل `getProducts()` على قاعدة فعلية (tests/deploy-tools.test.ts).
 * مُصدَّرة للاختبار في tests/deploy-tools.test.ts.
 */
export function looksLikeSeedFallback(products) {
  if (!Array.isArray(products) || products.length === 0) return false;
  return products.some(
    (p) => p && typeof p === "object" && !Object.prototype.hasOwnProperty.call(p, "old_price")
  );
}

/**
 * منطق الصفوف 15–17 (الواجهة المنشورة) كدالة **نقية** مُصدَّرة:
 * الحالات الثلاث المهمة — عودة صفحات المنتجات 404 («params غير مُنتظر»)، تحوّل
 * المنتج غير الموجود إلى «404 ناعم» (200)، وتعارض وسمَي robots في صفحات 404 —
 * لا يمكن إنتاجها في اختبار بلا خادم، ولا يمكن تشغيل السكربت محليًا (isSafeBaseUrl).
 * لذلك تُبنى الحالات في tests/deploy-tools.test.ts من أجسام مصنوعة.
 * @param {{sampleId: string, sampleName: string, productPage: any, missing: any, missingRoute: any, robotsTxt: any, sitemapXml: any, webmanifest: any, iconSvg: any}} input
 */
export function frontPageFindings({
  sampleId,
  sampleName,
  productPage,
  missing,
  missingRoute,
  robotsTxt,
  sitemapXml,
  webmanifest,
  iconSvg,
}) {
  const findings = [];

  const pageTitle = /<title[^>]*>([^<]*)<\/title>/i.exec(productPage?.text ?? "")?.[1]?.trim() ?? "";
  const hasCanonical = /rel="canonical"/.test(productPage?.text ?? "");
  const titleOk = sampleName ? pageTitle.includes(sampleName) : pageTitle.length > 0;
  findings.push({
    id: "15",
    label: `GET /product/${sampleId} (صفحة منتج حقيقية)`,
    ok: productPage?.status === 200 && titleOk && hasCanonical,
    expected: "200 + <title> يحمل اسم المنتج + rel=canonical",
    actual:
      productPage?.status === 404
        ? "404 — عطل «params غير مُنتظر» عاد إلى البناء المنشور (راجع npm run front:check)"
        : `${productPage?.status} — العنوان: «${pageTitle.slice(0, 60)}»${hasCanonical ? " + canonical" : " — بلا canonical"}`,
  });

  const missingNoindex = /<meta name="robots" content="noindex"/.test(missing?.text ?? "");
  const conflictingRobots = /content="index,\s*follow"/.test(missing?.text ?? "");
  findings.push({
    id: "16",
    label: "GET /product/<معرف غير موجود> (منع 404 الناعم)",
    ok: missing?.status === 404 && missingNoindex && !conflictingRobots,
    expected: '404 + <meta name="robots" content="noindex"> وحده',
    actual:
      `${missing?.status}${missing?.status === 200 ? " — «404 ناعم»: يسبّبه حدّ تحميل في جذر src/app/" : ""}` +
      `${missingNoindex ? " + noindex" : " — بلا noindex"}` +
      `${conflictingRobots ? " + وسم robots متعارض (index, follow)" : ""}`,
  });

  findings.push({
    id: "16b",
    label: "GET /<مسار غير موجود>",
    ok: missingRoute?.status === 404,
    expected: "404",
    actual: `${missingRoute?.status}`,
  });

  const sitemapLocs = (sitemapXml?.text?.match(/<loc>/g) ?? []).length;
  const robotsBlocksAdmin = /Disallow:\s*\/admin/.test(robotsTxt?.text ?? "");
  const sitemapHidesAdmin = !/\/admin/.test(sitemapXml?.text ?? "");
  const allOk = [robotsTxt, sitemapXml, webmanifest, iconSvg].every((r) => r?.status === 200);
  findings.push({
    id: "17",
    label: "GET /robots.txt · /sitemap.xml · /manifest.webmanifest · /icon.svg",
    ok: allOk && sitemapLocs >= 2 && robotsBlocksAdmin && sitemapHidesAdmin,
    expected: "200 للجميع + خريطة بروابط + حجب /admin",
    actual:
      `robots ${robotsTxt?.status}${robotsBlocksAdmin ? " (يحجب /admin)" : " — لا يحجب /admin"} · ` +
      `sitemap ${sitemapXml?.status} (${sitemapLocs} رابطًا${sitemapHidesAdmin ? "" : " — يكشف /admin"}) · ` +
      `manifest ${webmanifest?.status} · icon ${iconSvg?.status}`,
  });

  return findings;
}

const results = [];
function record(id, label, ok, expected, actual) {
  results.push({ id, label, ok, expected, actual });
}

async function request(method, pathname, body) {
  const init = { method, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const started = Date.now();
  const response = await fetch(`${BASE}${pathname}`, init);
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, ms: Date.now() - started };
}

function forbidPii(payload) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  const leaks = [];
  if (/"(phone|customer_phone|address|governorate|transferRef)"/i.test(raw)) leaks.push("حقل PII ظاهر في الجواب");
  if (/\b\d{11,}\b/.test(raw)) leaks.push("تسلسل يشبه هاتفًا كاملًا");
  return leaks;
}

// ---------------------------------------------------------------- قراءة فقط
async function readOnlyChecks() {
  // الصف 1
  const home = await request("GET", "/");
  record("1", "GET /", home.status === 200, "200", `${home.status} (${home.ms}ms)`);

  // رؤوس الأمان على الصفحة الرئيسية — CSP تُقبل في وضعيها، والوضع الفعلي يُعرض في صفه الخاص.
  const sec = classifySecurityHeaders(home.headers);
  record(
    "headers",
    "رؤوس الأمان الأساسية",
    sec.ok,
    `${BASELINE_SECURITY_HEADERS.join(", ")} + CSP (أي وضع)`,
    sec.ok
      ? `كلها موجودة — CSP في وضع ${CSP_MODE_LABEL[sec.cspMode]}`
      : `ناقصة: ${sec.missing.join(", ")}`
  );

  // صف مستقل لوضع CSP: المراقبة هي الافتراضي الموثّق (DEPLOYMENT.md)، والحجب
  // يُطلب صراحةً بـ --require-csp-enforce بعد ضبط CSP_ENFORCE=true على Vercel.
  const requireCspEnforce = flag("--require-csp-enforce");
  const cspEnforced = sec.cspMode === "enforce";
  record(
    "csp-mode",
    "وضع CSP (CSP_ENFORCE)",
    cspEnforced || (sec.cspMode === "report-only" && !requireCspEnforce),
    requireCspEnforce ? "content-security-policy (حجب فعلي)" : "أي وضع — والحجب يُفرض بـ --require-csp-enforce",
    `الوضع الحالي: ${CSP_MODE_LABEL[sec.cspMode]}${requireCspEnforce && !cspEnforced ? " — مطلوب الحجب فتحقّق من CSP_ENFORCE على Vercel ثم أعد النشر" : ""}`
  );


  // الصف 2
  const admin = await request("GET", "/admin");
  record("2", "GET /admin", admin.status === 200, "200", `${admin.status}`);

  // الصف 3
  const session = await request("GET", "/api/admin/session");
  let sessionOk = session.status === 200;
  try {
    sessionOk = sessionOk && JSON.parse(session.text)?.authenticated === false;
  } catch {
    sessionOk = false;
  }
  record("3", "GET /api/admin/session", sessionOk, '200 {"authenticated":false}', `${session.status} ${session.text.slice(0, 80)}`);

  // الصف 5
  const cart = await request("GET", "/cart");
  record("5", "GET /cart", cart.status === 200, "200", `${cart.status}`);

  // الصف 6 — 404 = الطبقة مغلقة (الافتراضي)، 401 = مفتوحة وتتطلب جلسة.
  const mcp = await request("GET", "/api/admin/mcp/tools");
  record(
    "6",
    "GET /api/admin/mcp/tools",
    mcp.status === 404 || mcp.status === 401,
    "404 (ENABLE_MCP_TOOLS مغلق) أو 401 (مفتوح مع طلب جلسة)",
    `${mcp.status} — ${mcp.status === 404 ? "الطبقة مغلقة" : mcp.status === 401 ? "الطبقة مفتوحة فعليًا" : "استجابة غير متوقعة"}`
  );

  // إضافي: كتالوج المنتجات (وهو نفسه حامل قرينة ربط Turso أدناه)
  const products = await request("GET", "/api/products");
  let productOk = products.status === 200;
  let productCount = "?";
  let productList = [];
  try {
    const parsed = JSON.parse(products.text);
    const list = Array.isArray(parsed) ? parsed : parsed?.products;
    if (Array.isArray(list)) {
      productCount = String(list.length);
      productList = list;
    } else {
      productOk = false;
    }
  } catch {
    productOk = false;
  }
  record("extra-products", "GET /api/products", productOk, "200 + قائمة منتجات", `${products.status} — ${productCount} منتجًا`);

  // قرينة ربط قاعدة البيانات — لا تُثبت الاتصال (إثباته الصفوف 7–9)، لكنها ترصد
  // الحالة الأخطر: نشر يخدم البذرة المحلية، فتظهر المنتجات ويتعذّر حفظ أي طلب
  // حقيقي (503 «قاعدة البيانات غير مربوطة»). التنازل الصريح: --allow-seed-fallback.
  const seedFallback = looksLikeSeedFallback(productList);
  const allowSeedFallback = flag("--allow-seed-fallback");
  record(
    "db-binding",
    "قرينة ربط قاعدة البيانات (شكل /api/products)",
    productOk && (!seedFallback || allowSeedFallback),
    "كل صف يحمل مفتاح old_price (مسار Turso) — أو --allow-seed-fallback للتنازل",
    seedFallback
      ? `الكتالوج من البذرة المحلية (صف بلا مفتاح old_price) ⇒ على الأرجح TURSO_DATABASE_URL غير مضبوط في بيئة Vercel الإنتاجية؛ تحقّق من الصفوف 7–9 قبل الصفين 10 و11${allowSeedFallback ? " [مُتنازَل عنه بـ --allow-seed-fallback]" : ""}`
      : productOk
        ? "كل الصفوف عبر مسار قاعدة البيانات (الاتصال نفسه يُثبته الصفان 7–9)"
        : "تعذّرت القراءة — لا حكم"
  );

  // ------------------------------- الواجهة المنشورة (الصفوف 15–17)
  // عطل إنتاجي حقيقي: كل صفحات المنتجات كانت 404 لأن Next 16 يجعل `params` وعدًا
  // والكود قرأه متزامنًا. المنطق مُفصول في دالة نقية مُصدَّرة كي يغطّيها الاختبار
  // ببيانات مصنوعة (لا يمكن تشغيل هذا السكربت محليًا بحماية `isSafeBaseUrl`).
  const sampleId = productList[0]?.id ?? "p1";
  const sampleName = productList[0]?.name ?? "";
  const stamp = Date.now().toString(36);
  const [productPage, missing, missingRoute, robotsTxt, sitemapXml, webmanifest, iconSvg] =
    await Promise.all([
      request("GET", `/product/${sampleId}`),
      request("GET", `/product/probe-missing-${stamp}`),
      request("GET", `/probe-missing-${stamp}`),
      request("GET", "/robots.txt"),
      request("GET", "/sitemap.xml"),
      request("GET", "/manifest.webmanifest"),
      request("GET", "/icon.svg"),
    ]);
  for (const finding of frontPageFindings({ sampleId, sampleName, productPage, missing, missingRoute, robotsTxt, sitemapXml, webmanifest, iconSvg })) {
    record(finding.id, finding.label, finding.ok, finding.expected, finding.actual);
  }

  // إضافي: وجود مسار التتبع في البناء المنشور (GET غير مدعوم ⇒ 405).
  // لا يكشف حالة العلم: الحالة تُقرأ فقط بـ POST (الصفان 13 و14).
  const trackGet = await request("GET", "/api/orders/track");
  record(
    "extra-track-route",
    "GET /api/orders/track (وجود المسار في البناء المنشور)",
    trackGet.status === 405,
    "405 = المسار منشور (حالة العلم لا تُقرأ بـ GET)",
    `${trackGet.status}${trackGet.status === 404 ? " — المسار غير موجود في البناء المنشور" : ""}`
  );
}

// ------------------------------------------------- الصف 4 (كلمة خاطئة عمدًا)
async function adminProbe() {
  const login = await request("POST", "/api/admin/login", { password: "probe-not-a-real-password" });
  const expected = login.status === 401;
  let detail = `${login.status}`;
  if (login.status === 401) detail = "401 — لوحة الإدارة مهيأة وترفض أي كلمة خاطئة";
  else if (login.status === 503) detail = `503 — متغير ناقص على Vercel: ${login.text.slice(0, 200)}`;
  else if (login.status === 429) detail = "429 — استُهلك حد المعدل (8/10 دقائق)، انتظر ثم أعد مرة واحدة";
  record("4", "POST /api/admin/login بكلمة خاطئة", expected, "401", detail);
}

// ------------------------------------------- الصف 12 (الدردشة — بلا كتابة في القاعدة)
async function chatProbe() {
  const probe = await request("POST", "/api/chat", {
    messages: [{ role: "user", content: "منظف أرضيات" }],
  });
  let parsed = null;
  try {
    parsed = JSON.parse(probe.text);
  } catch {
    parsed = null;
  }
  const reply = typeof parsed?.reply === "string" ? parsed.reply.trim() : "";
  const cards = Array.isArray(parsed?.products) ? parsed.products.length : 0;
  record(
    "12",
    "POST /api/chat بسؤال «منظف أرضيات»",
    probe.status === 200 && reply.length > 0,
    '200 + {reply: "…"} (و`products` إن كان ENABLE_AI_AGENT/ENABLE_MCP_TOOLS مفعّلًا)',
    `${probe.status} — رد بطول ${reply.length} حرفًا${cards ? ` + ${cards} بطاقة منتج` : " (بلا بطاقات — متوقع إن كانت الأعلام مغلقة)"}` +
      (probe.status === 429 ? " — استُهلك حد المعدل (30/10 دقائق)" : "")
  );
  return { status: probe.status, cards };
}

// ------------------------------------- الصفان 10 و11 (إنشاء طلب حقيقي — بموافقة)
async function orderProbe() {
  const file = arg("--orders-body");
  if (!file) {
    console.error("❌ --orders-body مطلوب مع --allow-mutations (ملف JSON بجسم الطلب)");
    process.exit(2);
  }
  const body = JSON.parse(fs.readFileSync(file, "utf8"));

  const first = await request("POST", "/api/orders", body);
  let firstJson = null;
  try {
    firstJson = JSON.parse(first.text);
  } catch {
    firstJson = null;
  }
  record("10", "POST /api/orders (طلب تجريبي)", first.status === 200 && Boolean(firstJson?.id), "200 {ok:true,id}", `${first.status} — id=${firstJson?.id ?? "غير مطلوب"}`);

  const second = await request("POST", "/api/orders", body);
  let secondJson = null;
  try {
    secondJson = JSON.parse(second.text);
  } catch {
    secondJson = null;
  }
  const distinctIds = Boolean(firstJson?.id && secondJson?.id && firstJson.id !== secondJson.id);
  record("11", "POST /api/orders مرة ثانية", second.status === 200 && Boolean(secondJson?.id) && distinctIds, "200 بلا خطأ تكرار معرف", `${second.status} — id=${secondJson?.id ?? "غير مطلوب"}${distinctIds ? "" : " (تحقق: تكرار معرف أو فقدان أصناف)"}`);

  return { first: firstJson, second: secondJson };
}

// ------------------------------------------- الصفان 13 و14 (تتبع بمعرّفين صحيحين)
async function trackProbe(orderId, last4) {
  const correct = await request("POST", "/api/orders/track", { id: orderId, phoneLast4: last4 });
  let correctJson = null;
  try {
    correctJson = JSON.parse(correct.text);
  } catch {
    correctJson = null;
  }
  const leaks = forbidPii(correctJson);
  record(
    "13",
    "POST /api/orders/track بمعرّفين صحيحين",
    correct.status === 200 && correctJson?.ok === true && leaks.length === 0,
    '200 {ok:true,status:"جديد",items:[…]} بلا هاتف/عنوان',
    `${correct.status} — status=${correctJson?.status ?? "—"}${leaks.length ? ` — تسريب: ${leaks.join(", ")}` : ""}`
  );

  const wrongLast4 = String((Number(last4) + 1) % 10000).padStart(4, "0");
  const wrong = await request("POST", "/api/orders/track", { id: orderId, phoneLast4: wrongLast4 });
  let wrongJson = null;
  try {
    wrongJson = JSON.parse(wrong.text);
  } catch {
    wrongJson = null;
  }
  const message = String(wrongJson?.error ?? wrongJson?.message ?? wrong.text ?? "");
  const sameMessage = message.includes(ONE_UNIFIED_MESSAGE);
  record(
    "14",
    "POST /api/orders/track برقم خاطئ",
    wrong.status === 404 && sameMessage,
    `404 «${ONE_UNIFIED_MESSAGE}» بنفس الرسالة حرفيًا`,
    `${wrong.status} — الرسالة ${sameMessage ? "موحّدة" : `مختلفة: ${message.slice(0, 80)}`}`
  );

  // الحالة عند غياب العلم: 404 بنفس الرسالة — لا يكشف الفرق بين الحالتين.
  if (wrong.status !== 404 && correct.status === 404) {
    record("flag", "حالة ENABLE_ORDER_TRACKING", false, "200 للطلب الصحيح", `العلم مغلق: الصف 13 أعاد ${correct.status} بنفس رسالة الصف 14 (سلوك مقصود قبل فتح العلم)`);
  }
}

async function main() {
  if (!isSafeBaseUrl(BASE)) {
    console.error(`❌ base URL غير مسموح (يجب https:// ونطاق عام): ${BASE}`);
    process.exit(2);
  }

  await readOnlyChecks();
  if (flag("--admin-probe")) await adminProbe();

  // الصف 12: قراءة فقط من ناحية القاعدة (لا ينشئ طلبًا)، لكنه POST على نقطة محكومة
  // بحد معدل — لذلك خلف علم --chat-probe مثل بقية الفحوص التي تُرسل جسمًا.
  if (flag("--chat-probe")) await chatProbe();

  let created = null;
  if (flag("--allow-mutations") && arg("--orders-body")) created = await orderProbe();

  const trackId = arg("--track") ?? created?.first?.id;
  const last4 = arg("--last4");
  if (trackId && last4) await trackProbe(trackId, last4);
  else if (trackId && flag("--track")) {
    console.error("❌ --last4 مطلوب مع --track");
    process.exit(2);
  }

  const failed = results.filter((r) => !r.ok);

  if (asJson) {
    console.log(JSON.stringify({ base: BASE, ok: failed.length === 0, results }, null, 2));
  } else {
    console.log(`# Smoke test — ${BASE}\n`);
    console.log("| الصف | الفحص | النتيجة | المتوقع | الفعلي |");
    console.log("|---|---|---|---|---|");
    for (const r of results) {
      console.log(`| ${r.id} | ${r.label} | ${r.ok ? "✅" : "❌"} | ${r.expected} | ${String(r.actual).replace(/\|/g, "\\|")} |`);
    }
    console.log(
      failed.length === 0
        ? `\n✅ كل الفحوص المنفَّذة خضراء (${results.length}).`
        : `\n❌ فشل ${failed.length} فحصًا: ${failed.map((f) => f.id).join(", ")}`
    );
    if (!flag("--admin-probe")) console.log("\nملاحظة: الصف 4 يحتاج تشغيل `--admin-probe` (محاولة واحدة احترامًا لحد المعدل).");
    if (!flag("--chat-probe")) console.log("ملاحظة: الصف 12 يحتاج تشغيل `--chat-probe` (POST على /api/chat).");
    if (!flag("--allow-mutations")) console.log("ملاحظة: الصفان 10 و11 يحتاجان `--allow-mutations --orders-body <file>` لأن أول إنشاء طلب حقيقي.");
    if (!flag("--require-csp-enforce")) console.log("ملاحظة: وضع CSP يُقبل في الحالتين افتراضيًا؛ بعد ضبط `CSP_ENFORCE=true` على Vercel أضف `--require-csp-enforce` ليفشل الفحص إن بقيت المراقبة.");
    if (!flag("--allow-seed-fallback")) console.log("ملاحظة: صف `db-binding` قرينة على مصدر الكتالوج؛ إثبات اتصال Turso نفسه بالصفوف 7–9 عبر `npm run verify:turso` أو `service-health.yml`.");
  }

  process.exit(failed.length === 0 ? 0 : 1);
}

// التنفيذ فقط عند تشغيل الملف مباشرة (لا عند استيراده في الاختبارات).
const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  if (flag("--help") || flag("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  main().catch((error) => {
    console.error(`❌ توقف الفحص: ${String(error?.message ?? error)}`);
    process.exit(1);
  });
}
