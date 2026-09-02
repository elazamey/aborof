import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSecurityHeaders, buildContentSecurityPolicy } from "../src/lib/security/headers";
import { verifyAdminSession, createAdminSession } from "../src/lib/auth";

describe("security headers", () => {
  test("all required hardening headers present", () => {
    const h = buildSecurityHeaders(true);
    assert.ok(h["Content-Security-Policy-Report-Only"], "CSP starts in report-only");
    assert.match(h["Strict-Transport-Security"], /max-age=\d+/);
    assert.equal(h["X-Content-Type-Options"], "nosniff");
    assert.equal(h["X-Frame-Options"], "DENY");
    assert.equal(h["Referrer-Policy"], "strict-origin-when-cross-origin");
  });

  test("enforce mode switches CSP header name", () => {
    const reportOnly = buildSecurityHeaders(true);
    const enforced = buildSecurityHeaders(false);
    assert.ok(reportOnly["Content-Security-Policy-Report-Only"]);
    assert.ok(!reportOnly["Content-Security-Policy"]);
    assert.ok(enforced["Content-Security-Policy"]);
    assert.ok(!enforced["Content-Security-Policy-Report-Only"]);
  });

  test("CSP denies framing and restricts origins", () => {
    const csp = buildContentSecurityPolicy();
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /default-src 'self'/);
  });
});

describe("admin auth guard (isolation / authorization)", () => {
  // سر توقيع الجلسات مطلوب لتوليد/التحقق من التوكنات في الاختبارات.
  process.env.ADMIN_SESSION_SECRET = "test-session-secret-at-least-32-characters-long";

  test("rejects missing, malformed, and tampered session tokens", () => {
    assert.equal(verifyAdminSession(undefined), false);
    assert.equal(verifyAdminSession("not-a-token"), false);
    const valid = createAdminSession();
    const tampered = valid.slice(0, -3) + (valid.slice(-3) === "aaa" ? "bbb" : "aaa");
    assert.equal(verifyAdminSession(tampered), false);
  });

  test("accepts a freshly issued, correctly signed token", () => {
    assert.equal(verifyAdminSession(createAdminSession()), true);
  });
});
