import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

/**
 * حراسة عقد /api/chat: شكل الاستجابة القديم `{ reply, source }` يبقى كما هو
 * تمامًا عند إغلاق أعلام الميزات، ولا يُضاف حقل `products` إلا إذا أنتجته
 * أداة محكومة فعلًا. أي إضافة هنا يجب ألا تكسر عميلًا قديمًا.
 */

const KEYS = [
  "ENABLE_AI_AGENT",
  "MCP_ALLOWED_TOOLS",
  "MCP_MAX_CALLS_PER_REQUEST",
  "ENABLE_MCP_TOOLS",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "NVIDIA_NIM_API_KEY",
  "NVIDIA_API_KEY",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
] as const;

function resetEnv() {
  for (const key of KEYS) delete process.env[key];
}

function chatRequest(): Request {
  return new Request("http://x/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "عايز منظف أرضيات" }] }),
  });
}

beforeEach(resetEnv);
afterEach(resetEnv);

describe("chat route response contract", () => {
  test("default configuration answers with the local reply and no new fields", async () => {
    const { POST } = await import("../src/app/api/chat/route");
    const res = await POST(chatRequest());

    assert.equal(res.status, 200);
    const payload = (await res.json()) as { reply: string; source: string; products?: unknown };
    assert.ok(payload.reply.trim().length > 0);
    assert.equal(payload.source, "local");
    assert.equal(payload.products, undefined);
    assert.deepEqual(Object.keys(payload).sort(), ["reply", "source"]);
  });

  test("chat still works with the agent flag on but MCP off (no cards path)", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    const { POST } = await import("../src/app/api/chat/route");
    const res = await POST(chatRequest());

    assert.equal(res.status, 200);
    const payload = (await res.json()) as { reply: string; products?: unknown };
    assert.ok(payload.reply.trim().length > 0);
    assert.equal(payload.products, undefined);
  });

  test("with the governed tool path on, the answer carries sanitized product cards", async () => {
    // تكامل كامل: مزود Groq مُستبدل برد سيناريو (طلب أداة ثم نص نهائي)،
    // والأداة الحقيقية تعمل على كتالوج المتجر، والاستجابة تحمل البطاقات.
    process.env.ENABLE_AI_AGENT = "true";
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.MCP_ALLOWED_TOOLS = "search_products";
    process.env.GROQ_API_KEY = "g".repeat(24);

    const realFetch = global.fetch;
    let call = 0;
    global.fetch = (async () => {
      call += 1;
      const payload =
        call === 1
          ? {
              choices: [
                {
                  message: {
                    content: "",
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: {
                          name: "search_products",
                          arguments: JSON.stringify({ query: "منظف أرضيات", max_results: 2 }),
                        },
                      },
                    ],
                  },
                },
              ],
            }
          : { choices: [{ message: { content: "دي أحسن حاجة عندنا 👇" } }] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const { POST } = await import("../src/app/api/chat/route");
      const res = await POST(chatRequest());
      assert.equal(res.status, 200);

      const payload = (await res.json()) as {
        reply: string;
        source: string;
        products?: { id: string; name: string; price: number }[];
      };
      assert.equal(payload.reply, "دي أحسن حاجة عندنا 👇");
      assert.equal(payload.source, "groq");
      assert.ok(payload.products && payload.products.length > 0);
      for (const card of payload.products!) {
        assert.equal(typeof card.id, "string");
        assert.equal(typeof card.price, "number");
        assert.ok(card.name.length > 0);
      }
    } finally {
      global.fetch = realFetch;
    }
  });

  test("invalid payloads still fail through the central error layer", async () => {
    const { POST } = await import("../src/app/api/chat/route");
    const res = await POST(
      new Request("http://x/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: "not-an-array" }),
      })
    );

    assert.equal(res.status, 422);
    const payload = (await res.json()) as { code: string; request_id: string };
    assert.equal(payload.code, "VALIDATION_FAILED");
    assert.ok(payload.request_id);
  });
});
