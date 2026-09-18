import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SmartAgentEngine } from "../src/lib/ai/agent-engine";
import {
  DEFAULT_NIM_BASE_URL,
  DEFAULT_NIM_MODEL,
  NvidiaNimProvider,
  resolveNimBaseUrl,
} from "../src/lib/ai/providers/nvidia-nim";
import { GeminiRestProvider } from "../src/lib/ai/providers/gemini-rest";
import { GroqProvider } from "../src/lib/ai/providers/groq";
import { LocalFallbackProvider } from "../src/lib/ai/providers/local-fallback";
import type { AgentMessage } from "../src/lib/ai/types";
import type { OpenAIToolDefinition } from "../src/lib/ai/tools/types";

/**
 * حراسة مزود NVIDIA NIM (المرحلة الثانية):
 *  1) اختياري تمامًا: غياب المفتاح ⇒ غير متاح ويُتخطى، فلا يتغير سلوك السلسلة.
 *  2) https فقط للرابط، فلا يمر مفتاح على قناة غير مشفّرة.
 *  3) نفس عقد OpenAI في الطلب، مع دعم الأدوات عند تفعيلها.
 *  4) أي خطأ يُحجب منه المفتاح قبل مغادرة الوحدة.
 */

const KEYS = [
  "NVIDIA_NIM_API_KEY",
  "NVIDIA_API_KEY",
  "NVIDIA_NIM_BASE_URL",
  "NVIDIA_NIM_MODEL",
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

describe("NVIDIA NIM base URL policy", () => {
  test("defaults to the hosted NIM endpoint", () => {
    assert.equal(resolveNimBaseUrl(""), DEFAULT_NIM_BASE_URL);
    assert.equal(resolveNimBaseUrl(undefined), DEFAULT_NIM_BASE_URL);
    assert.equal(resolveNimBaseUrl("   "), DEFAULT_NIM_BASE_URL);
  });

  test("accepts https and trims trailing slashes", () => {
    assert.equal(resolveNimBaseUrl("https://nim.internal:8000/v1/"), "https://nim.internal:8000/v1");
  });

  test("rejects any non-https scheme (fail-closed)", () => {
    assert.equal(resolveNimBaseUrl("http://nim.internal/v1"), null);
    assert.equal(resolveNimBaseUrl("ftp://nim.internal/v1"), null);
    assert.equal(resolveNimBaseUrl("nim.internal/v1"), null);
  });

  test("provider is unavailable without a key, or with an insecure url", () => {
    assert.equal(new NvidiaNimProvider().isAvailable(), false);

    process.env.NVIDIA_NIM_API_KEY = "nvapi-" + "A".repeat(30);
    assert.equal(new NvidiaNimProvider().isAvailable(), true);

    process.env.NVIDIA_NIM_BASE_URL = "http://insecure.example/v1";
    assert.equal(new NvidiaNimProvider().isAvailable(), false);
  });

  test("accepts the short NVIDIA_API_KEY alias", () => {
    process.env.NVIDIA_API_KEY = "nvapi-" + "B".repeat(30);
    assert.equal(new NvidiaNimProvider().isAvailable(), true);
  });
});

describe("NVIDIA NIM request contract", () => {
  test("sends an OpenAI-compatible payload and returns the text", async () => {
    process.env.NVIDIA_NIM_API_KEY = "nvapi-" + "C".repeat(30);
    // حاوية خصائص ثابتة: لا يعتمد التحليل النوعي على تعيين داخل إغلاق.
    const captured: { url?: string; init?: RequestInit } = {};
    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      captured.url = String(url);
      captured.init = init ?? {};
      return jsonResponse({ choices: [{ message: { content: "  أهلاً بيك في روفيده  " } }] });
    }) as unknown as typeof fetch;

    const reply = await new NvidiaNimProvider().generateResponse(messages, { maxTokens: 500 });

    assert.equal(reply, "أهلاً بيك في روفيده");
    assert.equal(captured.url, `${DEFAULT_NIM_BASE_URL}/chat/completions`);
    const headers = captured.init?.headers as Record<string, string>;
    assert.match(headers.Authorization, /^Bearer nvapi-/);
    const body = JSON.parse(String(captured.init?.body));
    assert.equal(body.model, DEFAULT_NIM_MODEL);
    assert.equal(body.max_tokens, 500);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.tools, undefined);
  });

  test("honours NVIDIA_NIM_MODEL and parses tool calls when tools are requested", async () => {
    process.env.NVIDIA_NIM_API_KEY = "nvapi-" + "D".repeat(30);
    process.env.NVIDIA_NIM_MODEL = "meta/llama-3.1-70b-instruct";
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
    const reply = await new NvidiaNimProvider().callWithTools(
      [{ role: "user", content: "بيانات المتجر" }],
      tools
    );

    assert.equal(body.model, "meta/llama-3.1-70b-instruct");
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
    process.env.NVIDIA_NIM_API_KEY = "nvapi-" + "E".repeat(30);
    global.fetch = (async () =>
      jsonResponse({ choices: [{ message: { content: "   " } }] })) as unknown as typeof fetch;

    await assert.rejects(
      () => new NvidiaNimProvider().generateResponse(messages),
      /empty response/
    );
  });

  test("redacts nvapi keys from upstream error messages", async () => {
    const fakeKey = "nvapi-" + "F".repeat(30);
    process.env.NVIDIA_NIM_API_KEY = fakeKey;
    global.fetch = (async () =>
      jsonResponse({ error: { message: `Invalid key ${fakeKey}` } }, 401)) as unknown as typeof fetch;

    await assert.rejects(
      () => new NvidiaNimProvider().generateResponse(messages),
      (error: Error) => {
        assert.ok(!error.message.includes(fakeKey), "المفتاح يجب ألا يظهر في رسالة الخطأ");
        assert.ok(error.message.includes("[REDACTED_NVIDIA_KEY]"));
        return true;
      }
    );
  });
});

describe("NVIDIA NIM inside the silent chain", () => {
  test("serves the answer when earlier providers have no keys", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    process.env.NVIDIA_NIM_API_KEY = "nvapi-" + "G".repeat(30);
    global.fetch = (async () =>
      jsonResponse({ choices: [{ message: { content: "من غرفة NVIDIA" } }] })) as unknown as typeof fetch;

    const engine = new SmartAgentEngine([
      new GeminiRestProvider(),
      new GroqProvider(),
      new NvidiaNimProvider(),
      new LocalFallbackProvider(),
    ]);
    const result = await engine.processRequestDetailed(messages);

    assert.equal(result.provider, "nvidia-nim");
    assert.equal(result.reply, "من غرفة NVIDIA");
  });

  test("stays out of the way when unconfigured (zero breakage)", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    const engine = new SmartAgentEngine();
    const result = await engine.processRequestDetailed(messages);

    assert.equal(result.provider, "local");
    assert.ok(result.reply.trim().length > 0);
  });
});
