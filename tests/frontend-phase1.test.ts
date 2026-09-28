import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildContentSecurityPolicy } from "../src/lib/security/headers";
import { absoluteUrl, siteUrl } from "../src/lib/site";

/**
 * حراسة المرحلة الأولى من تطوير الواجهة:
 *  - حدود الخطأ/التحميل/404 موجودة وبالشروط الصحيحة (client حيث يلزم فقط).
 *  - ميتاداتا المنتج تُبنى من مصدر البيانات الحقيقي ولا تعتمد على وحدات وهمية.
 *  - sitemap/robots/manifest تُولّد محتوى صحيحًا ومتسقًا مع النطاق.
 *  - ثوابت CSP محميّة (لا خطوط خارجية، لا سكربتات طرف ثالث، منع تأطير).
 */

const KEYS = ["SITE_URL", "NEXT_PUBLIC_SITE_URL", "VERCEL_PROJECT_PRODUCTION_URL"] as const;
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

const appFile = (name: string) => path.join("src", "app", name);
const read = (file: string) => fs.readFileSync(file, "utf8");

describe("الواجهة — حدود الخطأ والتحميل و404", () => {
  test("الملفات الإلزامية موجودة", () => {
    for (const file of ["error.tsx", "not-found.tsx", "global-error.tsx"]) {
      assert.ok(fs.existsSync(appFile(file)), `${file} مفقود`);
    }
    assert.ok(fs.existsSync(appFile(path.join("(home)", "loading.tsx"))), "loading.tsx مفقود");
  });

  // درس إنتاجي: حدّ تحميل في جذر `src/app/` يبثّ الردّ بحالة 200 قبل حسم وجود
  // المنتج، فيصبح كل رابط منتج قديم/محذوف «404 ناعمًا» (200 + محتوى 404) — وهو
  // خطأ SEO حقيقي. لذلك حُصر حدّ التحميل في مجموعة `(home)`.
  test("لا حدّ تحميل يلفّ /product/[id] (منع 404 الناعم)", () => {
    assert.ok(!fs.existsSync(appFile("loading.tsx")), "loading.tsx في الجذر يُعيد 404 الناعم");
    assert.ok(!fs.existsSync(appFile(path.join("product", "loading.tsx"))));
    assert.ok(!fs.existsSync(appFile(path.join("product", "[id]", "loading.tsx"))));
  });

  test("error.tsx مكوّن عميل ويستقبل reset ولا يطبع الخطأ الخام", () => {
    const src = read(appFile("error.tsx"));
    assert.match(src, /^["']use client["']/m);
    assert.match(src, /reset/);
    assert.doesNotMatch(src, /console\.error\(\s*["'][^"']*["']\s*,\s*error\s*\)/);
    assert.match(src, /digest/);
  });

  test("global-error.tsx يصدّر html وbody بنفسه (شرط Next.js)", () => {
    const src = read(appFile("global-error.tsx"));
    assert.match(src, /<html/);
    assert.match(src, /<body/);
    assert.match(src, /dir="rtl"/);
  });

  test("loading.tsx مكوّن خادمي (لا use client) وnot-found يعرض مخرجين", () => {
    assert.doesNotMatch(read(appFile(path.join("(home)", "loading.tsx"))), /^["']use client["']/m);
    const notFound = read(appFile("not-found.tsx"));
    assert.match(notFound, /#products/);
    assert.match(notFound, /wa\.me/);
  });
});

describe("الواجهة — ميتاداتا المنتج", () => {
  const src = read(path.join("src", "app", "product", "[id]", "page.tsx"));

  test("generateMetadata موجود وتقرأ من مصدر البيانات الحقيقي", () => {
    assert.match(src, /export\s+async\s+function\s+generateMetadata/);
    assert.match(src, /from\s+["']@\/lib\/db["']/);
    assert.match(src, /getProduct\(/);
  });

  test("لا استيراد لوحدات غير موجودة (درس مراجعة الاقتراح الخارجي)", () => {
    for (const fake of ["@/lib/products", "getProductById", "getAllProducts"]) {
      assert.ok(!src.includes(fake), `استُخدم الرمز غير الموجود: ${fake}`);
    }
  });

  test("الميتاداتا تحمل السعر وcanonical وopenGraph بلغة عربية", () => {
    assert.match(src, /canonical:\s*`\/product\/\$\{product\.id\}`/);
    assert.match(src, /locale:\s*"ar_EG"/);
    assert.match(src, /جنيه/);
  });

  test("المنتج غير الموجود: notFound() بدل صفحة 200 صامتة", () => {
    assert.match(src, /notFound\(\)/);
  });

  // تعارض وسوم robots: `index: true` في الـlayout كان يضيف `index, follow` بجانب
  // `noindex` الذي يضعه Next في صفحات 404 — إشارتان متضاربتان لنفس الزاحف.
  test("الـlayout لا يعلن robots صراحةً (منع تعارض index/noindex)", () => {
    // تجريد التعليقات أولًا: تعليق يشرح «robots: {…}» ليس إعلانًا.
    const layout = fs
      .readFileSync(appFile("layout.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
      .join("\n");
    assert.doesNotMatch(layout, /robots:\s*\{/);
  });

  // خطأ إنتاجي حقيقي كان حيًّا على https://aborof.vercel.app/product/p1 (404 لكل
  // منتج): Next 16 يجعل params وعدًا، والقراءة المتزامنة تُرجع id غير معرّف.
  test("params تُقرأ بـawait كوعد (شكل Next 16)", () => {
    assert.match(src, /type\s+Props\s*=\s*\{\s*params:\s*Promise</);
    assert.ok((src.match(/await\s+params/g) ?? []).length >= 2,
      "يجب await params في الصفحة وفي generateMetadata");
    assert.doesNotMatch(src, /params\.id/);
  });

  test("notFound يُرفع مبكرًا من generateMetadata (رمز حالة 404 صحيح)", () => {
    const metadataBlock = src.slice(0, src.indexOf("export default"));
    assert.match(metadataBlock, /notFound\(\)/);
  });
});

describe("الواجهة — sitemap وrobots وmanifest", () => {
  test("sitemap يُبنى من المنتجات بروابط مطلقة", async () => {
    const { default: sitemap } = await import("../src/app/sitemap");
    const entries = await sitemap();
    assert.ok(entries.length >= 13, `عدد الروابط ${entries.length} أقل من المتوقع (رئيسية + 12 منتجًا)`);
    const urls = entries.map((e) => e.url);
    assert.ok(urls[0].endsWith("/") || urls.includes(absoluteUrl("/")));
    for (const url of urls) assert.match(url, /^https:\/\//, `رابط غير مطلق: ${url}`);
    assert.ok(!urls.some((u) => u.includes("/admin")), "الواجهة الإدارية يجب ألا تُفهرس");
  });

  test("robots يحجب الإدارة والـAPI والسلة ويرشد للخريطة", async () => {
    const { default: robots } = await import("../src/app/robots");
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    const disallow = rules.flatMap((rule) => (rule.disallow ? [rule.disallow].flat() : []));
    for (const blocked of ["/admin", "/api/", "/cart"]) {
      assert.ok(disallow.includes(blocked), `${blocked} غير محجوب`);
    }
    const sitemapUrl = Array.isArray(result.sitemap) ? result.sitemap[0] : result.sitemap;
    assert.ok(String(sitemapUrl).startsWith("https://"));
  });

  test("manifest يحمل هوية المتجر وبلا أيقونات مفقودة", async () => {
    const { default: manifest } = await import("../src/app/manifest");
    const result = manifest();
    assert.equal(result.dir, "rtl");
    assert.equal(result.lang, "ar-EG");
    assert.equal(result.theme_color, "#0f7a4d");
    assert.ok(result.name?.includes("روفيده"));
    for (const icon of result.icons ?? []) {
      const file = path.join("src", "app", String(icon.src).replace(/^\//, ""));
      assert.ok(fs.existsSync(file), `أيقونة مفقودة: ${icon.src}`);
    }
  });

  test("أيقونة المتجر SVG صالحة وبسيطة", () => {
    const svg = read(path.join("src", "app", "icon.svg"));
    assert.match(svg, /<svg[^>]+viewBox/);
    assert.match(svg, /#0f7a4d/);
    assert.ok(!svg.includes("<script"), "لا سكربتات داخل الأيقونة");
  });

  test("مصدر النطاق: افتراضي آمن، والبيئة تتقدم عليه", () => {
    assert.equal(siteUrl(), "https://aborof.vercel.app");
    process.env.SITE_URL = "https://shop.example.com/";
    assert.equal(siteUrl(), "https://shop.example.com", "الشرطة الأخيرة تُزال");
    assert.equal(absoluteUrl("/product/p1"), "https://shop.example.com/product/p1");
    assert.equal(absoluteUrl("/"), "https://shop.example.com");
  });
});

describe("الواجهة — ثوابت CSP محميّة", () => {
  const policy = buildContentSecurityPolicy();
  const directive = (name: string) =>
    policy
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(name + " "))
      ?.slice(name.length)
      .trim()
      .split(/\s+/) ?? [];

  test("لا مصادر خارجية للخطوط — Compatible مع font-src 'self' data:", () => {
    const fontSrc = directive("font-src");
    assert.deepEqual(fontSrc, ["'self'", "data:"]);
  });

  test("لا سكربتات طرف ثالث، ومنع التأطير والكائنات", () => {
    for (const source of directive("script-src")) {
      assert.ok(!/^https?:/.test(source), `مصدر سكربت خارجي: ${source}`);
    }
    assert.deepEqual(directive("frame-ancestors"), ["'none'"]);
    assert.deepEqual(directive("object-src"), ["'none'"]);
    assert.deepEqual(directive("base-uri"), ["'self'"]);
    assert.ok(directive("connect-src").includes("'self'"));
  });

  test("خط النظام العربي معرّف في CSS بلا أي طلب خارجي", () => {
    const css = read(path.join("src", "app", "globals.css"));
    assert.match(css, /--font-ar:/);
    assert.match(css, /font-family:\s*var\(--font-ar\)/);
    assert.ok(!/@import\s+url\(|fonts\.googleapis/.test(css), "CSS يستورد خطوطًا خارجية — مخالف للسياسة");
  });
});

describe("الواجهة — بوابة الملفات الإلزامية", () => {
  test("السكربت ينجح على الشجرة الحالية", () => {
    const out = execFileSync("node", ["scripts/check-front-mandatory.mjs", "--json"], { encoding: "utf8" });
    const report = JSON.parse(out) as { ok: boolean; findings: { id: string; ok: boolean }[] };
    assert.equal(report.ok, true, JSON.stringify(report.findings.filter((f) => !f.ok)));
    assert.ok(report.findings.length >= 15, `عدد الفحوص ${report.findings.length} أقل من المتوقع`);
  });

  test("البوابة مركّبة في مساري CI (الجودة والنشر)", () => {
    for (const workflow of [".github/workflows/quality.yml", ".github/workflows/deploy.yml"]) {
      assert.match(read(workflow), /npm run front:check/, `${workflow} لا يشغّل بوابة الواجهة`);
    }
  });
});
