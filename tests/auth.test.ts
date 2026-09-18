import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { adminConfigIssues, isAdminConfigured } from "../src/lib/auth";

/**
 * اختبارات تشخيص تهيئة الإدارة:
 *  - الدالة تسمّي المتغير الناقص/غير الصالح بدقة بدل رسالة عامة.
 *  - لا تُكشف أي قيمة، فقط أسماء المتغيرات وشروطها.
 *  - رسالة 503 عبر المسار الفعلي تحمل التشخيص الدقيق.
 */

const KEYS = ["ADMIN_PASSWORD", "ADMIN_SESSION_SECRET"] as const;

function resetEnv() {
  for (const k of KEYS) delete process.env[k];
}

beforeEach(resetEnv);
afterEach(resetEnv);

describe("admin configuration diagnostics", () => {
  test("names every missing variable when nothing is configured", () => {
    const issues = adminConfigIssues();
    assert.equal(issues.length, 2);
    assert.ok(issues.some((m) => m.includes("ADMIN_PASSWORD")));
    assert.ok(issues.some((m) => m.includes("ADMIN_SESSION_SECRET")));
    assert.equal(isAdminConfigured(), false);
  });

  test("flags a too-short session secret by variable name", () => {
    process.env.ADMIN_PASSWORD = "correct-horse-battery";
    process.env.ADMIN_SESSION_SECRET = "short-secret";
    const issues = adminConfigIssues();
    assert.equal(issues.length, 1);
    assert.match(issues[0], /ADMIN_SESSION_SECRET/);
    assert.equal(isAdminConfigured(), false);
  });

  test("reports only the password when the secret alone is valid", () => {
    process.env.ADMIN_SESSION_SECRET = "s".repeat(32);
    const issues = adminConfigIssues();
    assert.equal(issues.length, 1);
    assert.match(issues[0], /ADMIN_PASSWORD/);
    assert.equal(isAdminConfigured(), false);
  });

  test("configured when both variables are valid", () => {
    process.env.ADMIN_PASSWORD = "correct-horse-battery";
    process.env.ADMIN_SESSION_SECRET = "s".repeat(32);
    assert.deepEqual(adminConfigIssues(), []);
    assert.equal(isAdminConfigured(), true);
  });

  test("login route returns 503 naming the missing variables, leaking nothing", async () => {
    resetEnv();
    const { POST } = await import("../src/app/api/admin/login/route");
    const req = new Request("http://x/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "content-length": "36" },
      body: JSON.stringify({ password: "probe-not-a-real-password" }),
    });
    const res = await POST(req);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error?: string; code?: string; request_id?: string };
    assert.equal(body.code, "SERVICE_UNAVAILABLE");
    assert.match(body.error ?? "", /ADMIN_PASSWORD/);
    assert.match(body.error ?? "", /ADMIN_SESSION_SECRET/);
    // لا تسريب لمدخلات المستخدم أو لأي قيمة سرية.
    assert.ok(!(body.error ?? "").includes("probe-not-a-real-password"));
    assert.ok(body.request_id);
  });
});
