import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

describe("Celia Agent — علم ميزة منفصل وحارس نطاقات", () => {
  const originalEnv: Record<string, string | undefined> = {};

  function saveEnv(keys: string[]) {
    for (const k of keys) originalEnv[k] = process.env[k];
  }
  function restoreEnv(keys: string[]) {
    for (const k of keys) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  }

  const KEYS = ["ENABLE_CELIA_AGENT", "CELIA_ALLOWED_SCOPES", "ENABLE_AGENT_FLEET", "ENABLE_AI_AGENT"];

  beforeEach(() => saveEnv(KEYS));
  afterEach(() => restoreEnv(KEYS));

  test("isCeliaAgentEnabled — fail-closed (افتراضي false)", async () => {
    delete process.env.ENABLE_CELIA_AGENT;
    const { isCeliaAgentEnabled } = await import("../src/lib/celia/config");
    assert.equal(isCeliaAgentEnabled(), false);
    process.env.ENABLE_CELIA_AGENT = "false";
    assert.equal(isCeliaAgentEnabled(), false);
    process.env.ENABLE_CELIA_AGENT = "true";
    assert.equal(isCeliaAgentEnabled(), true);
    process.env.ENABLE_CELIA_AGENT = "True";
    assert.equal(isCeliaAgentEnabled(), false, "حساس لحالة الأحرف — True لا تُقبل");
    process.env.ENABLE_CELIA_AGENT = "1";
    assert.equal(isCeliaAgentEnabled(), false);
  });

  test("isCeliaAgentEnabled منفصل عن ENABLE_AGENT_FLEET و ENABLE_AI_AGENT", async () => {
    const { isCeliaAgentEnabled } = await import("../src/lib/celia/config");
    const { isAgentFleetEnabled, isAgentFleetActive } = await import("../src/lib/ai/agents");
    process.env.ENABLE_CELIA_AGENT = "true";
    process.env.ENABLE_AGENT_FLEET = "false";
    process.env.ENABLE_AI_AGENT = "false";
    assert.equal(isCeliaAgentEnabled(), true);
    assert.equal(isAgentFleetEnabled(), false);
    assert.equal(isAgentFleetActive(), false);
    // Celia مفعّل والأسطول معطّل — لا تأثير متبادل
    process.env.ENABLE_CELIA_AGENT = "false";
    process.env.ENABLE_AGENT_FLEET = "true";
    process.env.ENABLE_AI_AGENT = "true";
    assert.equal(isCeliaAgentEnabled(), false);
    assert.equal(isAgentFleetEnabled(), true);
  });

  test("celiaAllowedScopes — تحليل القائمة البيضاء", async () => {
    const { celiaAllowedScopes } = await import("../src/lib/celia/config");
    delete process.env.CELIA_ALLOWED_SCOPES;
    assert.equal(celiaAllowedScopes().size, 0, "غيابها = لا نطاق");
    process.env.CELIA_ALLOWED_SCOPES = "";
    assert.equal(celiaAllowedScopes().size, 0);
    process.env.CELIA_ALLOWED_SCOPES = "products:read, orders:read , faq:read";
    const s = celiaAllowedScopes();
    assert.ok(s.has("products:read"));
    assert.ok(s.has("orders:read"));
    assert.ok(s.has("faq:read"));
    assert.equal(s.size, 3);
    process.env.CELIA_ALLOWED_SCOPES = "*";
    const all = celiaAllowedScopes();
    // * تُحوَّل إلى كل النطاقات المعروفة
    assert.ok(all.size > 0);
    assert.ok(all.has("products:read"));
  });

  test("isScopeAllowed — يدعم prefix:* و *", async () => {
    const { isScopeAllowed } = await import("../src/lib/celia/config");
    assert.equal(isScopeAllowed("orders:read", new Set(["orders:read"])), true);
    assert.equal(isScopeAllowed("orders:write", new Set(["orders:read"])), false);
    assert.equal(isScopeAllowed("orders:write", new Set(["orders:*"])), true);
    assert.equal(isScopeAllowed("orders:read", new Set(["orders:*"])), true);
    assert.equal(isScopeAllowed("products:read", new Set(["orders:*"])), false);
    assert.equal(isScopeAllowed("any:thing", new Set(["*"])), true);
    assert.equal(isScopeAllowed("any:thing", new Set([])), false);
  });

  test("ScopeGuard — can / assert — fail-closed", async () => {
    const { createCeliaScopeGuard } = await import("../src/lib/celia/scope-guard");
    // مغلق → can دائمًا false
    process.env.ENABLE_CELIA_AGENT = "false";
    process.env.CELIA_ALLOWED_SCOPES = "products:read";
    let guard = createCeliaScopeGuard();
    assert.equal(guard.can("products:read"), false);
    assert.throws(() => guard.assert("products:read"), /Celia غير مفعّل/);

    // مفعّل بلا نطاقات → can false + رسالة لا نطاقات
    process.env.ENABLE_CELIA_AGENT = "true";
    delete process.env.CELIA_ALLOWED_SCOPES;
    guard = createCeliaScopeGuard();
    assert.equal(guard.can("products:read"), false);
    assert.throws(() => guard.assert("products:read"), /لا نطاقات مسموحة/);

    // مفعّل مع نطاق → can true للنطاق المسموح فقط
    process.env.CELIA_ALLOWED_SCOPES = "products:read,orders:read";
    guard = createCeliaScopeGuard();
    assert.equal(guard.can("products:read"), true);
    assert.equal(guard.can("orders:read"), true);
    assert.equal(guard.can("orders:write"), false);
    assert.doesNotThrow(() => guard.assert("products:read"));
    assert.throws(() => guard.assert("orders:write"), /النطاق غير مسموح/);

    // prefix:*
    process.env.CELIA_ALLOWED_SCOPES = "orders:*";
    guard = createCeliaScopeGuard();
    assert.equal(guard.can("orders:read"), true);
    assert.equal(guard.can("orders:write"), true);
    assert.equal(guard.can("products:read"), false);

    // * للتجارب المحلية
    process.env.CELIA_ALLOWED_SCOPES = "*";
    guard = createCeliaScopeGuard();
    assert.equal(guard.can("products:read"), true);
    assert.equal(guard.can("orders:write"), true);
  });

  test("ScopeGuard.assertAll — يرمي إن فُقد نطاق واحد", async () => {
    const { createCeliaScopeGuard } = await import("../src/lib/celia/scope-guard");
    process.env.ENABLE_CELIA_AGENT = "true";
    process.env.CELIA_ALLOWED_SCOPES = "products:read,faq:read";
    const guard = createCeliaScopeGuard();
    assert.doesNotThrow(() => guard.assertAll(["products:read", "faq:read"]));
    assert.throws(() => guard.assertAll(["products:read", "orders:write"]), /النطاق غير مسموح/);
  });

  test("requireCeliaScope — 404 موحّد إن كان العلم مغلقًا (لا يكشف وجود النقطة)", async () => {
    const { requireCeliaScope } = await import("../src/lib/celia/scope-guard");
    process.env.ENABLE_CELIA_AGENT = "false";
    process.env.CELIA_ALLOWED_SCOPES = "products:read";
    const req = new Request("http://localhost/api/celia/test");
    assert.throws(() => requireCeliaScope(req, "products:read"), (e: unknown) => {
      const err = e as { code?: string; status?: number };
      return err.code === "NOT_FOUND" || err.status === 404;
    });
    // مفعّل لكن النطاق مرفوض → 403
    process.env.ENABLE_CELIA_AGENT = "true";
    process.env.CELIA_ALLOWED_SCOPES = "faq:read";
    assert.throws(() => requireCeliaScope(req, "orders:write"), (e: unknown) => {
      const err = e as { code?: string; status?: number };
      return err.code === "FORBIDDEN" || err.status === 403;
    });
    // مفعّل والنطاق مسموح → لا يرمي
    process.env.CELIA_ALLOWED_SCOPES = "products:read";
    assert.doesNotThrow(() => requireCeliaScope(req, "products:read"));
  });

  test("CELIA_ALLOWED_SCOPES لا تُطبع و ScopeGuard لا يكشف القائمة في رسالة العميل", async () => {
    const { createCeliaScopeGuard } = await import("../src/lib/celia/scope-guard");
    process.env.ENABLE_CELIA_AGENT = "true";
    process.env.CELIA_ALLOWED_SCOPES = "products:read";
    const guard = createCeliaScopeGuard();
    try {
      guard.assert("orders:write");
      assert.fail("يجب أن يرمي");
    } catch (e) {
      const msg = String((e as Error).message);
      // الرسالة تذكر النطاق المطلوب فقط، لا تذكر قائمة المسموح
      assert.match(msg, /orders:write/);
      assert.ok(!msg.includes("products:read"), "لا يكشف النطاقات المسموحة");
    }
  });
});
