import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SmartAgentEngine } from "../src/lib/ai/agent-engine";
import { GeminiRestProvider } from "../src/lib/ai/providers/gemini-rest";
import { GroqProvider } from "../src/lib/ai/providers/groq";
import { LocalFallbackProvider } from "../src/lib/ai/providers/local-fallback";
import type { AgentMessage, AIAgentProvider } from "../src/lib/ai/types";

/**
 * حراسة التوافقية العكسية لمحرك الوكيل الذكي (المرحلة الأولى):
 *  1) تعطيل الميزة: غياب العلم أو `false` يعيد الرد المحلي فورًا.
 *  2) الفشل الصامت: فشل مزود ينتقل تلقائيًا للتالي دون استثناءات.
 *  3) حفظ الأسرار: أنماط المفاتيح لا تظهر في رسائل الأخطاء أبدًا.
 */

const KEYS = [
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "GEMINI_MODEL",
  "GROQ_MODEL",
  "ENABLE_AI_AGENT",
] as const;

function resetEnv() {
  for (const k of KEYS) delete process.env[k];
}

const messages: AgentMessage[] = [
  { role: "system", content: "أنتِ سيليا، مساعدة متجر روفيده." },
  { role: "user", content: "عايز منظف أرضيات" },
];

beforeEach(resetEnv);
afterEach(resetEnv);

describe("feature flag off → immediate local reply", () => {
  test("absent flag returns local reply", async () => {
    const engine = new SmartAgentEngine();
    const result = await engine.processRequestDetailed(messages);
    assert.equal(result.provider, "local");
    assert.ok(result.reply.trim().length > 0);
  });

  test("flag explicitly false returns local reply", async () => {
    process.env.ENABLE_AI_AGENT = "false";
    const engine = new SmartAgentEngine();
    const result = await engine.processRequestDetailed(messages);
    assert.equal(result.provider, "local");
  });

  test("processRequest returns the reply string", async () => {
    const engine = new SmartAgentEngine();
    const reply = await engine.processRequest(messages);
    assert.ok(reply.trim().length > 0);
  });
});

describe("silent fallback engine", () => {
  function failing(name: string): AIAgentProvider {
    return {
      name,
      isAvailable: () => true,
      generateResponse: async () => {
        throw new Error(`${name} is down`);
      },
    };
  }

  test("failing provider hands over to the next without throwing", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    const okGroq: AIAgentProvider = {
      name: "groq",
      isAvailable: () => true,
      generateResponse: async () => "أهلاً بيك في روفيده",
    };
    const engine = new SmartAgentEngine([failing("gemini"), okGroq]);
    const result = await engine.processRequestDetailed(messages);
    assert.deepEqual(result, { reply: "أهلاً بيك في روفيده", provider: "groq" });
  });

  test("empty replies are skipped like failures", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    const empty: AIAgentProvider = {
      name: "gemini",
      isAvailable: () => true,
      generateResponse: async () => "   ",
    };
    const ok: AIAgentProvider = {
      name: "groq",
      isAvailable: () => true,
      generateResponse: async () => "رد فعلي",
    };
    const engine = new SmartAgentEngine([empty, ok]);
    const result = await engine.processRequestDetailed(messages);
    assert.equal(result.provider, "groq");
  });

  test("unavailable providers are skipped entirely", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    const unavailable: AIAgentProvider = {
      name: "gemini",
      isAvailable: () => false,
      generateResponse: async () => "لا يجب الوصول لهذا",
    };
    const ok: AIAgentProvider = {
      name: "groq",
      isAvailable: () => true,
      generateResponse: async () => "من غروك",
    };
    const engine = new SmartAgentEngine([unavailable, ok]);
    const result = await engine.processRequestDetailed(messages);
    assert.equal(result.provider, "groq");
  });

  test("all providers failing still yields the local answer — never an exception", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    const engine = new SmartAgentEngine([
      failing("gemini"),
      failing("groq"),
      new LocalFallbackProvider(),
    ]);
    const result = await engine.processRequestDetailed(messages);
    assert.equal(result.provider, "local");
    assert.ok(result.reply.trim().length > 0);
  });

  test("provider availability reflects configured keys", () => {
    assert.equal(new GeminiRestProvider().isAvailable(), false);
    assert.equal(new GroqProvider().isAvailable(), false);
    process.env.GEMINI_API_KEY = "k".repeat(24);
    process.env.GROQ_API_KEY = "g".repeat(24);
    assert.equal(new GeminiRestProvider().isAvailable(), true);
    assert.equal(new GroqProvider().isAvailable(), true);
    assert.equal(new LocalFallbackProvider().isAvailable(), true);
  });
});

describe("no secret leakage in provider errors", () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  test("gemini key pattern is redacted from error messages", async () => {
    // المفتاح الاصطناعي يُبنى وقت التشغيل حتى لا يلتقطه الفحص الثابت للأسرار.
    const fakeKey = "AIzaSy" + "D".repeat(30);
    process.env.GEMINI_API_KEY = fakeKey;
    global.fetch = (async () =>
      new Response(`{"error":{"message":"API key ${fakeKey} is invalid"}}`, {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const provider = new GeminiRestProvider();
    await assert.rejects(
      () => provider.generateResponse(messages),
      (err: Error) => {
        assert.ok(!err.message.includes(fakeKey), "المفتاح يجب ألا يظهر في رسالة الخطأ");
        assert.ok(err.message.includes("[REDACTED_GEMINI_KEY]"), "يجب وضع علامة الحجب");
        return true;
      }
    );
  });

  test("bearer/groq key pattern is redacted from error messages", async () => {
    // المفتاح الاصطناعي يُبنى وقت التشغيل حتى لا يلتقطه الفحص الثابت للأسرار.
    const fakeKey = "gsk_" + "F".repeat(30);
    process.env.GROQ_API_KEY = fakeKey;
    global.fetch = (async () =>
      new Response(`{"error":{"message":"Invalid Bearer ${fakeKey}"}}`, {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const provider = new GroqProvider();
    await assert.rejects(
      () => provider.generateResponse(messages),
      (err: Error) => {
        assert.ok(!err.message.includes(fakeKey), "مفتاح Groq يجب ألا يظهر في رسالة الخطأ");
        return true;
      }
    );
  });
});
