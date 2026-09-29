import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SmartAgentEngine } from "../src/lib/ai/agent-engine";
import {
  DEFAULT_AI_GATEWAY_BASE_URL,
  DEFAULT_AI_GATEWAY_MODEL,
  AiGatewayProvider,
  resolveAiGatewayBaseUrl,
} from "../src/lib/ai/providers/ai-gateway";
import { GeminiRestProvider } from "../src/lib/ai/providers/gemini-rest";
import { GroqProvider } from "../src/lib/ai/providers/groq";
import { LocalFallbackProvider } from "../src/lib/ai/providers/local-fallback";
import { NvidiaNimProvider } from "../src/lib/ai/providers/nvidia-nim";
import { DEFAULT_PROVIDER_ORDER } from "../src/lib/ai/chain-order";
import type { AgentMessage } from "../src/lib/ai/types";
import type { OpenAIToolDefinition } from "../src/lib/ai/tools/types";

/**
 * حراسة مزود AI Gateway (Vercel):
 *  1) اختياري تمامًا: غياب المفتاح ⇒ غير متاح ويُتخطى، فلا يتغير سلوك السلسلة.
 *  2) https فقط للرابط، فلا يمر مفتاح على قناة غير مشفّرة.
 *  3) نفس عقد OpenAI في الطلب، مع دعم الأدوات عند تفعيلها.
 *  4) أي خطأ يُحجب منه المفتاح قبل مغادرة الوحدة.
 *  5) الترتيب الافتراضي: Gemini ← Groq ← NIM ← AI Gateway ← محلي.
 */

const KEYS = [
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_BASE_URL",
  "AI_GATEWAY_MODEL",
  "NVIDIA_NIM_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "ENABLE_AI_AGENT",
  "ENABLE_MCP_TOOLS",
  "AI_PROVIDER_ORDER",
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

describe("AI Gateway default chain position", () => {
  test("sits between nvidia-nim and local in the default order", () => {
    assert.deepEqual([...DEFAULT_PROVIDER_ORDER], [
      "gemini",
      "groq",
      "nvidia-nim",
      "ai-gateway",
      "local",
    ]);
  });
});

describe("AI Gateway base URL policy", () => {
  test("defaults to the hosted gateway endpoint", () => {
    assert.equal(resolveAiGatewayBaseUrl(""), DEFAULT_AI_GATEWAY_BASE_URL);
    assert.equal(resolveAiGatewayBaseUrl(undefined), DEFAULT_AI_GATEWAY_BASE_URL);
    assert.equal(resolveAiGatewayBaseUrl("   "), DEFAULT_AI_GATEWAY_BASE_URL);
    assert.equal(DEFAULT_AI_GATEWAY_BASE_URL, "https://ai-gateway.vercel.sh/v1");
  });

  test("accepts https and trims trailing slashes", () => {
    assert.equal(
      resolveAiGatewayBaseUrl("https://gateway.internal:8443/v1/"),
      "https://gateway.internal:8443/v1"
    );
  });

  test("rejects any non-https scheme (fail-closed)", () => {
    assert.equal(resolveAiGatewayBaseUrl("http://gateway.internal/v1"), null);
    assert.equal(resolveAiGatewayBaseUrl("ftp://gateway.internal/v1"), null);
    assert.equal(resolveAiGatewayBaseUrl("gateway.internal/v1"), null);
  });

  test("provider is unavailable without a key, or with an insecure url", () => {
    assert.equal(new AiGatewayProvider().isAvailable(), false);

    process.env.AI_GATEWAY_API_KEY = "vck_" + "A".repeat(30);
    assert.equal(new AiGatewayProvider().isAvailable(), true);

    process.env.AI_GATEWAY_BASE_URL = "http://insecure.example/v1";
    assert.equal(new AiGatewayProvider().isAvailable(), false);
  });
});

describe("AI Gateway request contract", () => {
  test("sends an OpenAI-compatible payload and returns the text", async () => {
    process.env.AI_GATEWAY_API_KEY = "vck_" + "C".repeat(30);
    const captured: { url?: string; init?: RequestInit } = {};
    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      captured.url = String(url);
      captured.init = init ?? {};
      return jsonResponse({ choices: [{ message: { content: "  أهلاً بيك في روفيده  " } }] });
    }) as unknown as typeof fetch;

    const reply = await new AiGatewayProvider().generateResponse(messages, { maxTokens: 500 });

    assert.equal(reply, "أهلاً بيك في روفيده");
    assert.equal(captured.url, `${DEFAULT_AI_GATEWAY_BASE_URL}/chat/completions`);
    const headers = captured.init?.headers as Record<string, string>;
    assert.match(headers.Authorization, /^Bearer vck_/);
    const body = JSON.parse(String(captured.init?.body));
    assert.equal(body.model, DEFAULT_AI_GATEWAY_MODEL);
    assert.equal(body.max_tokens, 500);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.tools, undefined);
  });

  test("honours AI_GATEWAY_MODEL and parses tool calls when tools are requested", async () => {
    process.env.AI_GATEWAY_API_KEY = "vck_" + "D".repeat(30);
    process.env.AI_GATEWAY_MODEL = "anthropic/claude-haiku-4-5";
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

    assert.equal(body.model, "anthropic/claude-haiku-4-5");
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
    process.env.AI_GATEWAY_API_KEY = "vck_" + "E".repeat(30);
    global.fetch = (async () =>
      jsonResponse({ choices: [{ message: { content: "   " } }] })) as unknown as typeof fetch;

    await assert.rejects(() => new AiGatewayProvider().generateResponse(messages), /empty response/);
  });

  test("redacts vck keys from upstream error messages", async () => {
    const fakeKey = "vck_" + "F".repeat(30);
    process.env.AI_GATEWAY_API_KEY = fakeKey;
    global.fetch = (async () =>
      jsonResponse({ error: { message: `Invalid key ${fakeKey}` } }, 401)) as unknown as typeof fetch;

    await assert.rejects(
      () => new AiGatewayProvider().generateResponse(messages),
      (error: Error) => {
        assert.ok(!error.message.includes(fakeKey), "المفتاح يجب ألا يظهر في رسالة الخطأ");
        assert.ok(error.message.includes("[REDACTED_AI_GATEWAY_KEY]"));
        return true;
      }
    );
  });
});

describe("AI Gateway inside the silent chain", () => {
  test("serves the answer when earlier providers have no keys", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    process.env.AI_GATEWAY_API_KEY = "vck_" + "G".repeat(30);
    global.fetch = (async () =>
      jsonResponse({ choices: [{ message: { content: "من بوابة Vercel" } }] })) as unknown as typeof fetch;

    const engine = new SmartAgentEngine([
      new GeminiRestProvider(),
      new GroqProvider(),
      new NvidiaNimProvider(),
      new AiGatewayProvider(),
      new LocalFallbackProvider(),
    ]);
    const result = await engine.processRequestDetailed(messages);

    assert.equal(result.provider, "ai-gateway");
    assert.equal(result.reply, "من بوابة Vercel");
  });

  test("default engine reaches the gateway between NIM and local", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    process.env.AI_GATEWAY_API_KEY = "vck_" + "H".repeat(30);
    global.fetch = (async () =>
      jsonResponse({ choices: [{ message: { content: "من البوابة عبر الترتيب الافتراضي" } }] })) as unknown as typeof fetch;

    // المحرك الافتراضي يبني ترتيبه من البيئة — بلا AI_PROVIDER_ORDER يجب أن
    // يصل للبوابة بعد تخطي المزودين الأسبق (بلا مفاتيح) وقبل المحلي.
    const engine = new SmartAgentEngine();
    const result = await engine.processRequestDetailed(messages);

    assert.equal(result.provider, "ai-gateway");
    assert.equal(result.reply, "من البوابة عبر الترتيب الافتراضي");
  });

  test("stays out of the way when unconfigured (zero breakage)", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    const engine = new SmartAgentEngine();
    const result = await engine.processRequestDetailed(messages);

    assert.equal(result.provider, "local");
    assert.ok(result.reply.trim().length > 0);
  });

  test("legacy AI_PROVIDER_ORDER without ai-gateway is honoured verbatim", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    process.env.AI_GATEWAY_API_KEY = "vck_" + "I".repeat(30);
    process.env.AI_PROVIDER_ORDER = "gemini,groq,nvidia-nim";
    let calls = 0;
    global.fetch = (async () => {
      calls += 1;
      return jsonResponse({ choices: [{ message: { content: "يجب ألا يُستدعى" } }] });
    }) as unknown as typeof fetch;

    const engine = new SmartAgentEngine();
    const result = await engine.processRequestDetailed(messages);

    // البوابة خارج السلسلة المطلوبة صراحةً: لا استدعاء شبكة، والرد محلي.
    assert.equal(calls, 0);
    assert.equal(result.provider, "local");
  });
});
