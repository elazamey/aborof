import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_COOKIE, createAdminSession } from "../src/lib/auth";

/**
 * نقطة مانيفست أدوات MCP الإدارية:
 *  - معطلة افتراضيًا ⇒ 404 موحّد لا يكشف وجودها.
 *  - مفعّلة ⇒ جلسة إدارة إلزامية.
 *  - بجلسة صحيحة ⇒ أسماء الأدوات وسياسة الحدود فقط، وبلا أي تنفيذ.
 */

const KEYS = ["ENABLE_MCP_TOOLS", "ADMIN_SESSION_SECRET", "MCP_ALLOWED_TOOLS"] as const;
const SECRET = "s".repeat(40);

function resetEnv() {
  for (const key of KEYS) delete process.env[key];
}

async function body(res: Response) {
  return (await res.json()) as { code?: string; tools?: { name: string }[]; policy?: Record<string, unknown> };
}

function request(cookie?: string): Request {
  return new Request("http://x/api/admin/mcp/tools", {
    headers: cookie ? { cookie: `${ADMIN_COOKIE}=${cookie}` } : {},
  });
}

beforeEach(resetEnv);
afterEach(resetEnv);

describe("admin MCP manifest route", () => {
  test("disabled layer answers 404 without revealing itself", async () => {
    const { GET } = await import("../src/app/api/admin/mcp/tools/route");
    const res = await GET(request());
    assert.equal(res.status, 404);
    assert.equal((await body(res)).code, "NOT_FOUND");
  });

  test("enabled layer requires an admin session", async () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.ADMIN_SESSION_SECRET = SECRET;
    const { GET } = await import("../src/app/api/admin/mcp/tools/route");

    const anonymous = await GET(request());
    assert.equal(anonymous.status, 401);
    assert.equal((await body(anonymous)).code, "AUTH_REQUIRED");

    const forged = await GET(request("forged.token"));
    assert.equal(forged.status, 401);
  });

  test("with a valid session it lists governed tools and never executes one", async () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.ADMIN_SESSION_SECRET = SECRET;
    const { GET } = await import("../src/app/api/admin/mcp/tools/route");

    const res = await GET(request(createAdminSession()));
    assert.equal(res.status, 200);
    const payload = await body(res);

    assert.deepEqual(
      payload.tools?.map((t) => t.name).sort(),
      ["lookup_faq", "search_products", "shipping_estimate", "store_info"]
    );
    assert.equal(payload.policy?.enabled, true);
    assert.equal(payload.policy?.max_calls_per_request, 3);
    assert.ok(!JSON.stringify(payload).includes("nvapi-"));
  });

  test("allowlist is reflected in the manifest", async () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.ADMIN_SESSION_SECRET = SECRET;
    process.env.MCP_ALLOWED_TOOLS = "lookup_faq";
    const { GET } = await import("../src/app/api/admin/mcp/tools/route");

    const res = await GET(request(createAdminSession()));
    assert.equal(res.status, 200);
    assert.deepEqual((await body(res)).tools?.map((t) => t.name), ["lookup_faq"]);
  });
});
