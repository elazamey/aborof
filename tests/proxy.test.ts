import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { config, proxy } from "../src/proxy";

/**
 * رؤوس الأمان تأتي من `src/proxy.ts` (اصطلاح Next.js 16). اصطلاح `middleware`
 * القديم أُوقف («The "middleware" file convention is deprecated. Please use
 * "proxy" instead») وظهر تحذيره في كل بناء على Vercel؛ هذه الاختبارات تمنع عودته
 * وتثبت أن الرؤوس نفسها ما زالت تُطبَّق كما كانت.
 */

const root = process.cwd();
const previousEnforce = process.env.CSP_ENFORCE;

afterEach(() => {
  if (previousEnforce === undefined) delete process.env.CSP_ENFORCE;
  else process.env.CSP_ENFORCE = previousEnforce;
});

describe("src/proxy.ts (Next.js 16 proxy convention)", () => {
  test("the deprecated middleware convention file is gone", () => {
    for (const candidate of ["src/middleware.ts", "src/middleware.js", "middleware.ts", "middleware.js"]) {
      assert.ok(!fs.existsSync(path.join(root, candidate)), `${candidate} يجب ألا يوجد — استخدم src/proxy.ts`);
    }
    assert.ok(fs.existsSync(path.join(root, "src/proxy.ts")));
  });

  test("exports a `proxy` function (not `middleware`) and a matcher config", async () => {
    const mod = await import("../src/proxy");
    assert.equal(typeof mod.proxy, "function");
    assert.ok(!("middleware" in mod), "لا تصدير باسم middleware");
    assert.ok(Array.isArray(config.matcher) && config.matcher.length === 1);
  });

  test("applies the hardening headers with CSP in report-only mode by default", () => {
    delete process.env.CSP_ENFORCE;
    const response = proxy(new NextRequest("https://example.com/"));
    assert.ok(response.headers.get("Content-Security-Policy-Report-Only"));
    assert.equal(response.headers.get("Content-Security-Policy"), null);
    assert.match(response.headers.get("Strict-Transport-Security") ?? "", /max-age=\d+/);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("X-Frame-Options"), "DENY");
    assert.equal(response.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
    assert.equal(response.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  });

  test("CSP_ENFORCE=true switches to the enforcing header; anything else stays report-only", () => {
    process.env.CSP_ENFORCE = "true";
    const enforced = proxy(new NextRequest("https://example.com/cart"));
    assert.ok(enforced.headers.get("Content-Security-Policy"));
    assert.equal(enforced.headers.get("Content-Security-Policy-Report-Only"), null);

    process.env.CSP_ENFORCE = "TRUE";
    const loose = proxy(new NextRequest("https://example.com/cart"));
    assert.equal(loose.headers.get("Content-Security-Policy"), null);
  });

  test("the matcher covers pages and APIs but skips Next internals and the favicon", () => {
    const pattern = new RegExp(`^${config.matcher[0]}$`);
    for (const covered of ["/", "/cart", "/product/p1", "/api/products", "/admin", "/robots.txt", "/sitemap.xml"]) {
      assert.ok(pattern.test(covered), `${covered} يجب أن يمرّ بالبروكسي`);
    }
    for (const skipped of ["/_next/static/chunks/app.js", "/_next/image", "/favicon.ico"]) {
      assert.ok(!pattern.test(skipped), `${skipped} يجب ألا يمرّ بالبروكسي`);
    }
  });
});
