import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SmartAgentEngine } from "../src/lib/ai/agent-engine";
import {
  DEFAULT_GATEWAY_BASE_URL,
  DEFAULT_GATEWAY_MODEL,
  AiGatewayProvider,
  resolveGatewayBaseUrl,
  resolveGatewayModel,
} from "../src/lib/ai/providers/ai-gateway";
import { GeminiRestProvider } from "../src/lib/ai/providers/gemini-rest";
import { GroqProvider } from "../src/lib/ai/providers/groq";
import { LocalFallbackProvider } from "../src/lib/ai/providers/local-fallback";
import { resolveProviderOrder } from "../src/lib/ai/chain-order";
import type { AgentMessage } from "../src/lib/ai/types";
import type { OpenAIToolDefinition } from "../src/lib/ai/tools/types";

/**
 * حراسة مزود Vercel AI Gateway:
 *  1) اختياري تمامًا: غياب المفتاح ⇒ غير متاح ويُتخطى، فلا يتغير سلوك السلسلة.
 *  2) https فقط للرابط (نفس سياسة NIM)، فلا يمر مفتاح على قناة غير مشفّرة.
 *  3) اسم الموديل يجب أن يحمل شكل creator/model — بدونه يُلغي المزود لا أن يفشل
 *     الطلب برسالة غامضة من البوابة.
 *  4) نفس عقد OpenAI في الطلب، مع دعم الأدوات عند تفعيلها.
 *  5) أي خطأ يُحجب منه المفتاح قبل مغادرة الوحدة.
 */

// تُبنى القيم في وقت التشغيل: الماسح الثابت يرفض شكل مفتاح حقيقي داخل الملف.
const fakeKey = (suffix: string) => "vck" + "_" + suffix;

const KEYS = [
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_BASE_URL",
  "AI_GATEWAY_MODEL",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "ENABLE_AI_AGENT",
  "ENABLE_MCP_TOOLS",
] as const;

const messages: AgentMessage[] = [
  { role: "system", content: "أنتِ سيليا." },
  { role: "user", content: "عايز منظف أرضيات" },
];

const realFetch = global.fetch;

function resetEnv() {
  for (const key of KEYS) delete process.env[key];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(resetEnv);
afterEach(() => {
  resetEnv();
  global.fetch = realFetch;
});

describe("AI Gateway base URL policy", () => {
  test("defaults to the hosted gateway endpoint", () => {
    assert.equal(resolveGatewayBaseUrl(""), DEFAULT_GATEWAY_BASE_URL);
    assert.equal(resolveGatewayBaseUrl(undefined), DEFAULT_GATEWAY_BASE_URL);
    assert.equal(resolveGatewayBaseUrl("   "), DEFAULT_GATEWAY_BASE_URL);
  });

  test("accepts https and trims trailing slashes", () => {
    assert.equal(
      resolveGatewayBaseUrl("https://gateway.internal:3000/v1/"),
      "https://gateway.internal:3000/v1"
    );
  });

  test("rejects any non-https scheme (fail-closed)", () => {
    assert.equal(resolveGatewayBaseUrl("http://gateway.internal/v1"), null);
    assert.equal(resolveGatewayBaseUrl("ftp://gateway.internal/v1"), null);
    assert.equal(resolveGatewayBaseUrl("gateway.internal/v1"), null);
  });
});

describe("AI Gateway model policy", () => {
  test("defaults to the documented gateway model", () => {
    assert.equal(resolveGatewayModel(""), DEFAULT_GATEWAY_MODEL);
    assert.equal(resolveGatewayModel(undefined), DEFAULT_GATEWAY_MODEL);
    assert.equal(resolveGatewayModel("   "), DEFAULT_GATEWAY_MODEL);
  });

  test("accepts creator/model and trims whitespace", () => {
    assert.equal(resolveGatewayModel("  openai/gpt-5.5  "), "openai/gpt-5.5");
    assert.equal(resolveGatewayModel("anthropic/claude-sonnet-4.5"), "anthropic/claude-sonnet-4.5");
  });

  test("rejects a bare model name with no creator (fail-closed)", () => {
    // البوابة ترفض gpt-5.5 المجرد برسالة لا تذكر السبب، فالمزود يُلغى محليًا.
    assert.equal(resolveGatewayModel("gpt-5.5"), null);
    assert.equal(resolveGatewayModel("openai"), null);
  });
});

describe("AI Gateway availability", () => {
  test("unavailable without a key, or with an insecure url, or with a bad model", () => {
    assert.equal(new AiGatewayProvider().isAvailable(), false);

    process.env.AI_GATEWAY_API_KEY = fakeKey("A".repeat(40));
    assert.equal(new AiGatewayProvider().isAvailable(), true);

    process.env.AI_GATEWAY_BASE_URL = "http://insecure.example/v1";
    assert.equal(new AiGatewayProvider().isAvailable(), false);

    process.env.AI_GATEWAY_BASE_URL = "https://gateway.example/v1";
    process.env.AI_GATEWAY_MODEL = "gpt-5.5";
    assert.equal(new AiGatewayProvider().isAvailable(), false);
  });

  test("explicit constructor overrides win over the environment", () => {
    process.env.AI_GATEWAY_API_KEY = fakeKey("B".repeat(40));
    const provider = new AiGatewayProvider({
      apiKey: fakeKey("C".repeat(40)),
      baseUrl: "https://override.example/v1",
      model: "openai/gpt-5.5-mini",
    });
    assert.equal(provider.isAvailable(), true);
  });
});

describe("AI Gateway request contract", () => {
  test("sends an OpenAI-compatible payload and returns the text", async () => {
    process.env.AI_GATEWAY_API_KEY = fakeKey("D".repeat(40));
    const captured: { url?: string; init?: RequestInit } = {};
    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      captured.url = String(url);
      captured.init = init ?? {};
      return jsonResponse({ choices: [{ message: { content: "  أهلاً بيك في روفيده  " } }] });
    }) as unknown as typeof fetch;

    const reply = await new AiGatewayProvider().generateResponse(messages, { maxTokens: 500 });

    assert.equal(reply, "أهلاً بيك في روفيده");
    assert.equal(captured.url, `${DEFAULT_GATEWAY_BASE_URL}/chat/completions`);
    const headers = captured.init?.headers as Record<string, string>;
    assert.match(headers.Authorization, /^Bearer vck_/);
    const body = JSON.parse(String(captured.init?.body));
    assert.equal(body.model, DEFAULT_GATEWAY_MODEL);
    assert.equal(body.max_tokens, 500);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.tools, undefined);
  });

  test("honours AI_GATEWAY_MODEL and parses tool calls when tools are requested", async () => {
    process.env.AI_GATEWAY_API_KEY = fakeKey("E".repeat(40));
    process.env.AI_GATEWAY_MODEL = "openai/gpt-5.5-mini";
    let body: any = null;
    global.fetch = (async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "store_info", arguments: '{"x":1}' },
                },
              ],
            },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const tools: OpenAIToolDefinition[] = [
      {
        type: "function",
        function: { name: "store_info", description: "بيانات المتجر", parameters: { type: "object" } },
      },
    ];
    const reply = await new AiGatewayProvider().callWithTools(
      [{ role: "user", content: "بيانات المتجر" }],
      tools
    );

    assert.equal(body.model, "openai/gpt-5.5-mini");
    assert.equal(body.tool_choice, "auto");
    assert.equal(body.tools[0].function.name, "store_info");
    assert.equal(reply.toolCalls.length, 1);
    assert.deepEqual(reply.toolCalls[0], {
      id: "call_1",
      name: "store_info",
      argumentsJson: '{"x":1}',
    });
    assert.equal(reply.assistantMessage.tool_calls?.[0].id, "call_1");
  });

  test("empty completions are treated as failures", async () => {
    process.env.AI_GATEWAY_API_KEY = fakeKey("F".repeat(40));
    global.fetch = (async () =>
      jsonResponse({ choices: [{ message: { content: "   " } }] })) as unknown as typeof fetch;

    await assert.rejects(
      () => new AiGatewayProvider().generateResponse(messages),
      /empty response/
    );
  });

  test("redacts vck keys from upstream error messages", async () => {
    const key = fakeKey("G".repeat(40));
    process.env.AI_GATEWAY_API_KEY = key;
    global.fetch = (async () =>
      jsonResponse({ error: { message: `Invalid key ${key}` } }, 401)) as unknown as typeof fetch;

    await assert.rejects(
      () => new AiGatewayProvider().generateResponse(messages),
      (error: Error) => {
        assert.ok(!error.message.includes(key), "المفتاح يجب ألا يظهر في رسالة الخطأ");
        assert.ok(error.message.includes("[REDACTED"));
        return true;
      }
    );
  });

  test("refuses to call the network when misconfigured (no key, bad url, bad model)", async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return jsonResponse({ choices: [{ message: { content: "لا يجب" } }] });
    }) as unknown as typeof fetch;

    await assert.rejects(() => new AiGatewayProvider().generateResponse(messages), /المفتاح/);

    process.env.AI_GATEWAY_API_KEY = fakeKey("H".repeat(40));
    process.env.AI_GATEWAY_BASE_URL = "http://insecure.example/v1";
    await assert.rejects(
      () => new AiGatewayProvider().generateResponse(messages),
      /https/
    );
    assert.equal(called, false, "لا نداء شبكة عندما التهيئة فاسدة");
  });
});

describe("AI Gateway inside the silent chain", () => {
  test("serves the answer when earlier providers have no keys", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    process.env.AI_GATEWAY_API_KEY = fakeKey("I".repeat(40));
    global.fetch = (async () =>
      jsonResponse({ choices: [{ message: { content: "من بوابة Vercel" } }] })) as unknown as typeof fetch;

    // ‏Gemini وGroq بلا مفاتيح ⇒ isAvailable() = false فتُتخطّى صامتًا،
    // فتصل السلسلة إلى البوابة قبل الرد المحلي.
    const engine = new SmartAgentEngine([
      new GeminiRestProvider(),
      new GroqProvider(),
      new AiGatewayProvider(),
      new LocalFallbackProvider(),
    ]);
    const result = await engine.processRequestDetailed(messages);

    assert.equal(result.provider, "ai-gateway");
    assert.equal(result.reply, "من بوابة Vercel");
  });

  test("stays out of the way when unconfigured (zero breakage)", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    const engine = new SmartAgentEngine();
    const result = await engine.processRequestDetailed(messages);

    assert.equal(result.provider, "local");
    assert.ok(result.reply.trim().length > 0);
  });

  test("the default chain places it last, just before the local reply", () => {
    // صفر كسر: أي تكوين قائم تعمل فيه Gemini/Groq/NIM لا يصل إلى البوابة أبدًا.
    assert.deepEqual(resolveProviderOrder(undefined), [
      "gemini",
      "groq",
      "nvidia-nim",
      "ai-gateway",
      "local",
    ]);
  });

  test("can be promoted to the head via AI_PROVIDER_ORDER", () => {
    assert.deepEqual(resolveProviderOrder("ai-gateway"), ["ai-gateway", "local"]);
  });
});
