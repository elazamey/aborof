import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SmartAgentEngine } from "../src/lib/ai/agent-engine";
import { LocalFallbackProvider } from "../src/lib/ai/providers/local-fallback";
import { snapshot } from "../src/lib/observability/metrics";
import type { AgentMessage, AgentOptions, AIAgentProvider } from "../src/lib/ai/types";
import type {
  OpenAIChatMessage,
  OpenAIToolDefinition,
  ToolCapableProvider,
  ToolModelReply,
} from "../src/lib/ai/tools/types";

/**
 * حراسة دورة الأدوات المقيدة في المحرك (المرحلة الثانية):
 *  1) صفر كسر: بدون العلم أو بدون طلب صريح يبقى المسار النصي القديم حرفيًا.
 *  2) التنفيذ لا يمر إلا عبر سجل MCP (السماح + التحقق + السقف + المهلة).
 *  3) رفض الأداة يصل للموديل كنتيجة، لا كاستثناء.
 *  4) أي فشل في الدورة يسلّم للمزود التالي بصمت بلا 500.
 */

const KEYS = [
  "ENABLE_AI_AGENT",
  "ENABLE_MCP_TOOLS",
  "MCP_ALLOWED_TOOLS",
  "MCP_MAX_CALLS_PER_REQUEST",
  "MCP_TOOL_TIMEOUT_MS",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
] as const;

const messages: AgentMessage[] = [
  { role: "system", content: "أنتِ سيليا." },
  { role: "user", content: "بيانات المتجر إيه؟" },
];

function resetEnv() {
  for (const key of KEYS) delete process.env[key];
}

function toolCall(id: string, name: string, args = "{}") {
  return { id, name, argumentsJson: args };
}

/** مزود مزيّف يتبع سيناريو ثابتًا ويعيد رسالة مساعد صالحة لإعادة الإرسال. */
class ScriptedProvider implements ToolCapableProvider {
  readonly name = "scripted";
  readonly supportsTools = true as const;
  callCount = 0;
  plainUsed = false;
  readonly transcripts: OpenAIChatMessage[][] = [];
  private index = 0;

  constructor(private readonly script: ToolModelReply[]) {}

  isAvailable(): boolean {
    return true;
  }

  async generateResponse(): Promise<string> {
    this.plainUsed = true;
    return "نص عادي بدون أدوات";
  }

  async callWithTools(
    transcript: OpenAIChatMessage[],
    _tools: OpenAIToolDefinition[],
    _options?: AgentOptions
  ): Promise<ToolModelReply> {
    this.callCount += 1;
    this.transcripts.push(transcript.map((m) => ({ ...m })));
    const reply = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    return reply;
  }
}

function replyWithTools(calls: { id: string; name: string; argumentsJson: string }[]): ToolModelReply {
  return {
    text: "",
    toolCalls: calls,
    assistantMessage: {
      role: "assistant",
      content: null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.argumentsJson },
      })),
    },
  };
}

function finalReply(text: string): ToolModelReply {
  return { text, toolCalls: [], assistantMessage: { role: "assistant", content: text } };
}

beforeEach(resetEnv);
afterEach(resetEnv);

describe("zero breakage: plain path stays untouched", () => {
  test("MCP disabled → provider text path is used even when tools are requested", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    const provider = new ScriptedProvider([finalReply("لن تُستدعى")]);
    const engine = new SmartAgentEngine([provider]);

    const result = await engine.processRequestDetailed(messages, { enableTools: true });

    assert.equal(provider.plainUsed, true);
    assert.equal(provider.callCount, 0);
    assert.equal(result.provider, "scripted");
    assert.equal(result.reply, "نص عادي بدون أدوات");
    assert.equal(result.toolCalls, undefined);
  });

  test("MCP enabled but caller did not request tools → plain path", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    process.env.ENABLE_MCP_TOOLS = "true";
    const provider = new ScriptedProvider([finalReply("لن تُستدعى")]);
    const engine = new SmartAgentEngine([provider]);

    const result = await engine.processRequestDetailed(messages);

    assert.equal(provider.plainUsed, true);
    assert.equal(provider.callCount, 0);
    assert.equal(result.reply, "نص عادي بدون أدوات");
  });
});

describe("bounded tool loop", () => {
  test("executes an allowed tool, feeds the result back, and returns the final text", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.MCP_ALLOWED_TOOLS = "store_info";

    const provider = new ScriptedProvider([
      replyWithTools([toolCall("call_1", "store_info")]),
      finalReply("البيانات جاهزة ✅"),
    ]);
    const engine = new SmartAgentEngine([provider]);

    const result = await engine.processRequestDetailed(messages, { enableTools: true });

    assert.equal(result.reply, "البيانات جاهزة ✅");
    assert.equal(result.provider, "scripted");
    assert.equal(result.toolCalls, 1);
    assert.equal(provider.callCount, 2);

    const toolMessages = provider.transcripts[1].filter((m) => m.role === "tool");
    assert.equal(toolMessages.length, 1);
    assert.equal(toolMessages[0].tool_call_id, "call_1");
    assert.match(String(toolMessages[0].content), /روفيده/);
  });

  test("a denied tool is returned as a result, never executed and never thrown", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.MCP_ALLOWED_TOOLS = "store_info";

    const provider = new ScriptedProvider([
      replyWithTools([toolCall("call_9", "delete_everything")]),
      finalReply("معلش، مش هقدر أعمل ده."),
    ]);
    const engine = new SmartAgentEngine([provider]);

    const result = await engine.processRequestDetailed(messages, { enableTools: true });

    assert.equal(result.reply, "معلش، مش هقدر أعمل ده.");
    const toolMessage = provider.transcripts[1].find((m) => m.role === "tool");
    assert.ok(toolMessage);
    assert.match(String(toolMessage!.content), /\(لم تُنفَّذ الأداة\)/);
    assert.match(String(toolMessage!.content), /غير متاحة/);
    assert.ok((snapshot().mcp.by_status.denied ?? 0) >= 1);
  });

  test("invalid tool arguments are rejected before execution", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.MCP_ALLOWED_TOOLS = "shipping_estimate";

    const provider = new ScriptedProvider([
      replyWithTools([toolCall("call_2", "shipping_estimate", '{"governorate":""}')]),
      finalReply("محتاج اسم المحافظة."),
    ]);
    const engine = new SmartAgentEngine([provider]);

    const result = await engine.processRequestDetailed(messages, { enableTools: true });
    assert.equal(result.reply, "محتاج اسم المحافظة.");
    assert.ok((snapshot().mcp.by_status.invalid ?? 0) >= 1);
  });

  test("the central budget caps tool executions per request", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.MCP_MAX_CALLS_PER_REQUEST = "1";

    const provider = new ScriptedProvider([
      replyWithTools([toolCall("call_a", "store_info")]),
      finalReply("تمام"),
    ]);
    const engine = new SmartAgentEngine([provider]);

    const result = await engine.processRequestDetailed(messages, { enableTools: true });

    assert.equal(result.reply, "تمام");
    assert.equal(result.toolCalls, 1);
    // دور أول بأدوات + دور أخير بلا أدوات (الحد المركزي) — لا دورات لا نهائية.
    assert.equal(provider.callCount, 2);
  });

  test("zero budget disables tool execution entirely", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.MCP_MAX_CALLS_PER_REQUEST = "0";

    const stubborn = new ScriptedProvider([replyWithTools([toolCall("call_z", "store_info")])]);
    const engine = new SmartAgentEngine([stubborn, new LocalFallbackProvider()]);

    const result = await engine.processRequestDetailed(messages, { enableTools: true });

    assert.equal(stubborn.callCount, 1);
    assert.equal(result.provider, "local");
    assert.ok(result.reply.trim().length > 0);
  });

  test("a failing tool loop hands over to the next provider silently", async () => {
    process.env.ENABLE_AI_AGENT = "true";
    process.env.ENABLE_MCP_TOOLS = "true";

    const broken: ToolCapableProvider = {
      name: "broken-tools",
      supportsTools: true,
      isAvailable: () => true,
      generateResponse: async () => "لا يجب الوصول لهذا",
      callWithTools: async () => {
        throw new Error("tool loop exploded");
      },
    };
    const plain: AIAgentProvider = {
      name: "second",
      isAvailable: () => true,
      generateResponse: async () => "رد المزود الثاني",
    };

    const engine = new SmartAgentEngine([broken, plain]);
    const result = await engine.processRequestDetailed(messages, { enableTools: true });

    assert.equal(result.provider, "second");
    assert.equal(result.reply, "رد المزود الثاني");
    assert.ok(snapshot().ai_provider_failures_last_hour >= 1);
  });
});
