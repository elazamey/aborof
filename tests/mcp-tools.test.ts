import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { McpToolRegistry } from "../src/lib/ai/mcp/registry";
import { STORE_TOOLS } from "../src/lib/ai/mcp/tools/store";
import { snapshot } from "../src/lib/observability/metrics";
import type { McpTool } from "../src/lib/ai/mcp/types";

/**
 * حراسة طبقة MCP المحكومة (المرحلة الثانية):
 *  1) fail-closed: غياب العلم ⇒ صفر أدوات مرئية وصفر تنفيذ.
 *  2) السماح بالاسم + رفض الأدوات الكاتبة افتراضيًا.
 *  3) تحقق وسائط صارم ومهلة مفروضة وسقف استدعاءات واقتصاص مخرجات.
 *  4) كل مخرج ألفاظه آمنة: لا رسائل داخلية ولا أسرار.
 */

const KEYS = [
  "ENABLE_MCP_TOOLS",
  "MCP_ALLOW_WRITE_TOOLS",
  "MCP_ALLOWED_TOOLS",
  "MCP_MAX_CALLS_PER_REQUEST",
  "MCP_TOOL_TIMEOUT_MS",
  "MCP_MAX_RESULT_CHARS",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
] as const;

function resetEnv() {
  for (const key of KEYS) delete process.env[key];
}

function freshRegistry(tools: readonly McpTool[] = STORE_TOOLS): McpToolRegistry {
  const registry = new McpToolRegistry();
  registry.registerAll(tools);
  return registry;
}

const slowTool: McpTool = {
  definition: {
    name: "slow_tool",
    description: "أداة بطيئة للاختبار",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  policy: { readOnly: true, timeoutMs: 4_000, maxResultChars: 4_000 },
  validate: () => ({ ok: true, value: {} }),
  run: (_value, ctx) =>
    new Promise<string>((resolve) => {
      // لا تحل أبدًا قبل الإلغاء — تثبت أن الطبقة تفرض المهلة بنفسها.
      ctx.signal.addEventListener("abort", () => resolve("متأخر"), { once: true });
    }),
};

beforeEach(resetEnv);
afterEach(resetEnv);

describe("MCP layer is fail-closed", () => {
  test("flag absent → no tools listed and no execution", async () => {
    const registry = freshRegistry();
    assert.equal(registry.isEnabled(), false);
    assert.deepEqual(registry.listTools(), []);

    const result = await registry.callTool("search_products", { query: "منظف" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /غير مفعّلة/);
    // التدقيق يعمل حتى في حالة الرفض.
    assert.ok((snapshot().mcp.by_status.disabled ?? 0) >= 1);
  });

  test("flag must be exactly 'true'", async () => {
    process.env.ENABLE_MCP_TOOLS = "1";
    assert.deepEqual(freshRegistry().listTools(), []);
    process.env.ENABLE_MCP_TOOLS = "TRUE";
    assert.deepEqual(freshRegistry().listTools(), []);
    process.env.ENABLE_MCP_TOOLS = "true";
    assert.equal(freshRegistry().listTools().length, STORE_TOOLS.length);
  });
});

describe("MCP tools/list shape", () => {
  test("exposes read-only tools with JSON schema and no secrets", () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    const tools = freshRegistry().listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["lookup_faq", "search_products", "shipping_estimate", "store_info"]);

    for (const tool of tools) {
      assert.match(tool.name, /^[a-z][a-z0-9_]{2,40}$/);
      assert.ok(tool.description.length > 10);
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
  });

  test("allowlist narrows visibility and execution", async () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.MCP_ALLOWED_TOOLS = "store_info";
    const registry = freshRegistry();
    assert.deepEqual(
      registry.listTools().map((t) => t.name),
      ["store_info"]
    );

    const denied = await registry.callTool("search_products", { query: "منظف" });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /غير متاحة/);

    const allowed = await registry.callTool("store_info", {});
    assert.equal(allowed.isError, undefined);
    assert.match(allowed.content[0].text, /روفيده/);
  });

  test("unknown allowlist names add nothing", () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.MCP_ALLOWED_TOOLS = "delete_everything, search_products";
    assert.deepEqual(
      freshRegistry().listTools().map((t) => t.name),
      ["search_products"]
    );
  });

  test("write-capable tools are refused unless explicitly allowed", () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    const writeTool: McpTool = {
      definition: { name: "erase_orders", description: "أداة كاتبة", inputSchema: { type: "object" } },
      policy: { readOnly: false, timeoutMs: 4_000, maxResultChars: 4_000 },
      validate: () => ({ ok: true, value: {} }),
      run: async () => "حُذف",
    };

    const closed = freshRegistry([...STORE_TOOLS, writeTool]);
    assert.ok(!closed.listTools().some((t) => t.name === "erase_orders"));

    process.env.MCP_ALLOW_WRITE_TOOLS = "true";
    const open = freshRegistry([...STORE_TOOLS, writeTool]);
    assert.ok(open.listTools().some((t) => t.name === "erase_orders"));
  });
});

describe("MCP tools/call governance", () => {
  test("searches store products and returns a bounded, data-only answer", async () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    const result = await freshRegistry().callTool("search_products", {
      query: "منظف أرضيات",
      max_results: 2,
    });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /نتائج البحث/);
    assert.match(result.content[0].text, /جنيه/);
    assert.ok((snapshot().mcp.by_status.ok ?? 0) >= 1);
  });

  test("strict validation rejects empty, malformed and unknown-field arguments", async () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    const registry = freshRegistry();

    const empty = await registry.callTool("search_products", { query: "" });
    assert.equal(empty.isError, true);

    const notJson = await registry.callTool("search_products", "{ query: منظف }");
    assert.equal(notJson.isError, true);
    assert.match(notJson.content[0].text, /JSON/);

    const unknownField = await registry.callTool("search_products", {
      query: "منظف",
      tenant: "spoof",
    });
    assert.equal(unknownField.isError, true);

    assert.ok((snapshot().mcp.by_status.invalid ?? 0) >= 3);
  });

  test("shipping tool answers from the store rate table", async () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    const result = await freshRegistry().callTool("shipping_estimate", {
      governorate: "أسوان",
      subtotal: 200,
    });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /120 جنيه/);
  });

  test("enforces a central timeout even when the tool never settles", async () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.MCP_TOOL_TIMEOUT_MS = "300";
    const started = Date.now();
    const result = await freshRegistry([...STORE_TOOLS, slowTool]).callTool("slow_tool", {});
    const elapsed = Date.now() - started;

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /مهلة/);
    assert.ok(elapsed < 2_000, `should abort near the central timeout, took ${elapsed}ms`);
    assert.ok((snapshot().mcp.by_status.timeout ?? 0) >= 1);
  });

  test("enforces the per-request call budget", async () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.MCP_MAX_CALLS_PER_REQUEST = "1";
    const registry = freshRegistry();
    const budget = registry.newBudget();

    const first = await registry.callTool("store_info", {}, { budget });
    assert.equal(first.isError, undefined);

    const second = await registry.callTool("store_info", {}, { budget });
    assert.equal(second.isError, true);
    assert.match(second.content[0].text, /الحد الأقصى/);
    assert.ok((snapshot().mcp.by_status.budget_exceeded ?? 0) >= 1);
  });

  test("truncates oversized results at the central cap", async () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.MCP_MAX_RESULT_CHARS = "200";
    const result = await freshRegistry().callTool("search_products", {
      query: "منظف",
      max_results: 5,
    });
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.ok(text.length < 300, `expected truncation, got ${text.length} chars`);
    assert.match(text, /تم اقتصاص المخرجات/);
  });

  test("tool failures never throw and never leak internals", async () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    const fakeKey = "nvapi-" + "K".repeat(30);
    const exploding: McpTool = {
      definition: { name: "exploding_tool", description: "أداة تفشل", inputSchema: { type: "object" } },
      policy: { readOnly: true, timeoutMs: 4_000, maxResultChars: 4_000 },
      validate: () => ({ ok: true, value: {} }),
      run: async () => {
        throw new Error(`upstream said key=${fakeKey} stack=/srv/app/secret.ts`);
      },
    };

    const result = await freshRegistry([...STORE_TOOLS, exploding]).callTool("exploding_tool", {});
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.ok(!text.includes(fakeKey));
    assert.ok(!text.includes("/srv/app/secret.ts"));
    assert.match(text, /تعذر تنفيذ الأداة/);
  });

  test("policy defaults stay at the documented safe values", () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    const policy = freshRegistry().policy();
    assert.equal(policy.max_calls_per_request, 3);
    assert.equal(policy.tool_timeout_ms, 4_000);
    assert.equal(policy.max_result_chars, 4_000);
  });

  test("policy snapshot clamps hostile numeric env values", () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.MCP_MAX_CALLS_PER_REQUEST = "9999";
    process.env.MCP_TOOL_TIMEOUT_MS = "0";
    process.env.MCP_MAX_RESULT_CHARS = "not-a-number";
    const policy = freshRegistry().policy();
    assert.equal(policy.max_calls_per_request, 8);
    assert.equal(policy.tool_timeout_ms, 300);
    assert.equal(policy.max_result_chars, 4_000);
  });
});
