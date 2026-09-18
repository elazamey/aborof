import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { McpToolRegistry } from "../src/lib/ai/mcp/registry";
import { ALL_MCP_TOOLS } from "../src/lib/ai/mcp";
import { invalidateKnowledgeBase } from "../src/lib/ai/memory";
import { SmartAgentEngine } from "../src/lib/ai/agent-engine";
import { LocalFallbackProvider } from "../src/lib/ai/providers/local-fallback";
import type { AgentMessage, AgentOptions, AIAgentProvider } from "../src/lib/ai/types";
import type {
  OpenAIToolDefinition,
  ToolCapableProvider,
  ToolModelReply,
} from "../src/lib/ai/tools/types";

/**
 * حراسة أداة ذاكرة المتجر داخل طبقة MCP المحكومة:
 *  1) **بوابة مزدوجة:** لا تكفي طبقة الأدوات، بل يلزم `ENABLE_RAG` أيضًا.
 *  2) الأداة قراءة فقط، ووسائطها صارمة، وتعمل **بلا أي مفتاح خارجي**.
 *  3) نتائج المنتجات تصل كبطاقات واجهة (نفس عقد search_products) بلا كود إضافي.
 *  4) صفر كسر: بلا الراية يبقى عدد الأدوات المرئية كما كان قبل إضافة الذاكرة.
 */

const KEYS = [
  "ENABLE_MCP_TOOLS",
  "ENABLE_RAG",
  "RAG_ENGINE",
  "RAG_TOP_K",
  "RAG_MIN_SCORE",
  "MCP_ALLOWED_TOOLS",
  "MCP_MAX_CALLS_PER_REQUEST",
  "ENABLE_AI_AGENT",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
] as const;

function resetEnv() {
  for (const key of KEYS) delete process.env[key];
}

function freshRegistry(): McpToolRegistry {
  const registry = new McpToolRegistry();
  registry.registerAll(ALL_MCP_TOOLS);
  return registry;
}

const messages: AgentMessage[] = [{ role: "user", content: "عايز حاجة للتعقيم" }];

beforeEach(() => {
  resetEnv();
  invalidateKnowledgeBase();
});
afterEach(resetEnv);

describe("search_knowledge visibility gates", () => {
  test("invisible when the layer is off, and when only the layer is on", async () => {
    assert.ok(!freshRegistry().listTools().some((t) => t.name === "search_knowledge"));

    process.env.ENABLE_MCP_TOOLS = "true";
    const withoutRag = freshRegistry();
    assert.ok(!withoutRag.listTools().some((t) => t.name === "search_knowledge"));
    assert.equal(withoutRag.listTools().length, 4, "الأدوات الأربع الأصلية فقط");

    const denied = await withoutRag.callTool("search_knowledge", { query: "تعقيم" });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /غير متاحة/);
  });

  test("visible only when both flags are on, and it is read-only", () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.ENABLE_RAG = "true";
    const registry = freshRegistry();

    const names = registry.listTools().map((t) => t.name);
    assert.ok(names.includes("search_knowledge"));
    assert.equal(names.length, 5);

    const descriptor = registry.describeTools().find((t) => t.name === "search_knowledge");
    assert.ok(descriptor);
    assert.equal(descriptor!.read_only, true);
    assert.equal(descriptor!.input_schema.additionalProperties, false);
  });

  test("RAG flag alone changes nothing in the tool layer", () => {
    process.env.ENABLE_RAG = "true";
    assert.deepEqual(freshRegistry().listTools(), []);
    assert.equal(freshRegistry().policy().enabled, false);
  });
});

describe("search_knowledge execution (no external keys)", () => {
  test("answers a synonym query and returns product cards", async () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.ENABLE_RAG = "true";
    const registry = freshRegistry();

    const result = await registry.callTool("search_knowledge", { query: "حاجة للتعقيم", top_k: 3 });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /ذاكرة المتجر/);

    const structured = result.structuredContent as { kind?: string; products?: { id: string; name: string }[] };
    assert.equal(structured.kind, "products", "منتجات الذاكرة يجب أن تصل كبطاقات");
    assert.ok(structured.products!.length > 0);
    assert.ok(structured.products!.every((card) => typeof card.id === "string" && card.id.length > 0));
  });

  test("store policy questions return store/faq hits without cards", async () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.ENABLE_RAG = "true";
    const result = await freshRegistry().callTool("search_knowledge", { query: "الشحن كام؟" });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as { kind?: string; hits?: number };
    assert.equal(structured.kind, "knowledge");
    assert.ok((structured.hits ?? 0) > 0);
  });

  test("strict validation rejects malformed arguments", async () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.ENABLE_RAG = "true";
    const registry = freshRegistry();

    for (const bad of [{}, { query: "ا" }, { query: "منظف", top_k: 9 }, { query: "منظف", extra: 1 }]) {
      const result = await registry.callTool("search_knowledge", bad);
      assert.equal(result.isError, true, `يجب رفض: ${JSON.stringify(bad)}`);
    }
  });

  test("no match yields a clear instruction, not an error", async () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.ENABLE_RAG = "true";
    const result = await freshRegistry().callTool("search_knowledge", { query: "طقس بكين" });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /لا توجد معلومة مطابقة/);
  });
});

describe("agent integration and zero break", () => {
  function scriptedProvider(): ToolCapableProvider & { callCount: number } {
    let call = 0;
    return {
      name: "scripted",
      supportsTools: true,
      callCount: 0,
      isAvailable: () => true,
      generateResponse: async () => "نص عادي",
      callWithTools: async (): Promise<ToolModelReply> => {
        call += 1;
        if (call === 1) {
          const args = JSON.stringify({ query: "حاجة للتعقيم" });
          return {
            text: "",
            toolCalls: [{ id: "call_k", name: "search_knowledge", argumentsJson: args }],
            assistantMessage: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_k", type: "function", function: { name: "search_knowledge", arguments: args } },
              ],
            },
          };
        }
        return { text: "دي أنسب حاجة للتعقيم 👇", toolCalls: [], assistantMessage: { role: "assistant", content: "دي أنسب حاجة للتعقيم 👇" } };
      },
    } as ToolCapableProvider & { callCount: number };
  }

  test("memory results become product cards in the agent reply", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.ENABLE_RAG = "true";

    const engine = new SmartAgentEngine([scriptedProvider()]);
    const result = await engine.processRequestDetailed(messages, { enableTools: true });

    assert.equal(result.reply, "دي أنسب حاجة للتعقيم 👇");
    assert.equal(result.toolCalls, 1);
    assert.ok(result.products && result.products.length > 0);
  });

  test("with RAG off the same scenario is denied silently — no cards, no crash", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    process.env.ENABLE_MCP_TOOLS = "true";

    const scripted = scriptedProvider();
    const plain: AIAgentProvider = {
      name: "second",
      isAvailable: () => true,
      generateResponse: async () => "رد المزود الثاني",
    };
    const engine = new SmartAgentEngine([scripted, plain]);
    const result = await engine.processRequestDetailed(messages, { enableTools: true });

    // الذاكرة مغلقة ⇒ الأداة غير متاحة: الدورة تُكمل بنص الموديل نفسه بلا
    // تنفيذ وبلا بطاقات، ولا يسقط الطلب إلى مزود آخر ولا يرمي استثناءً.
    assert.equal(result.provider, "scripted");
    assert.equal(result.reply, "دي أنسب حاجة للتعقيم 👇");
    assert.equal(result.products, undefined);
  });

  test("plain providers are untouched by the memory layer", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    process.env.ENABLE_RAG = "true";
    const engine = new SmartAgentEngine([new LocalFallbackProvider()]);
    const options: AgentOptions = { enableTools: true };
    const result = await engine.processRequestDetailed(messages, options);
    assert.equal(result.provider, "local");
    assert.equal(result.products, undefined);
  });
});
