import { redactSecrets } from "@/lib/errors";
import { metrics } from "@/lib/observability/metrics";
import {
  MCP_POLICY_LIMITS,
  areWriteToolsAllowed,
  clampInt,
  isMcpToolsEnabled,
  mcpPolicySnapshot,
  resolveAllowedToolNames,
  type McpPolicySnapshot,
} from "./policy";
import type {
  McpCallBudget,
  McpCallContext,
  McpCallStatus,
  McpTool,
  McpToolDefinition,
  McpToolDescriptor,
  McpToolOutput,
  McpToolResult,
} from "./types";

/**
 * سجل أدوات MCP المحكوم — نقطة التنفيذ الوحيدة.
 *
 * كل استدعاء يمر بالبوابات التالية بالترتيب، وأي بوابة تفشل تُعاد كنتيجة
 * `isError` ولا تصل للموديل كرسالة خطأ داخلية ولا تُسقط الطلب:
 *   1) علم الميزة `ENABLE_MCP_TOOLS` (fail-closed).
 *   2) السماح بالاسم (allowlist) + وجود الأداة فعلًا.
 *   3) سقف الاستدعاءات لكل طلب.
 *   4) تحقق وسائط صارم (zod + strict) معلن في الأداة.
 *   5) مهلة تنفيذ مفروضة من الطبقة (AbortSignal + سقف زمني).
 *   6) اقتصاص المخرجات إلى الحد المركزي.
 *   7) تدقيق: مقاييس + سطر سجل لا يحتوي وسائط ولا مخرجات ولا أسرار.
 *
 * المخرجات تُعامَل كبيانات لا كتعليمات: تُقتصّ وتُعاد نصًا، ولا تُنفَّذ أبدًا.
 */

const MAX_ARGUMENTS_CHARS = 4_000;
const NAME_PATTERN = /^[a-z][a-z0-9_]{2,40}$/;

class RequestBudget implements McpCallBudget {
  readonly limit: number;
  private _used = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  get used(): number {
    return this._used;
  }

  remaining(): number {
    return Math.max(0, this.limit - this._used);
  }

  consume(): boolean {
    if (this._used >= this.limit) return false;
    this._used += 1;
    return true;
  }
}

function parseArguments(
  raw: unknown
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (typeof raw !== "string") {
    if (raw == null) return { ok: true, value: {} };
    if (typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, message: "وسائط الأداة يجب أن تكون كائنًا" };
    }
    return { ok: true, value: raw };
  }

  const text = raw.trim();
  if (text.length === 0) return { ok: true, value: {} };
  if (text.length > MAX_ARGUMENTS_CHARS) {
    return { ok: false, message: "حجم وسائط الأداة كبير جدًا" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, message: "وسائط الأداة يجب أن تكون كائن JSON" };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, message: "وسائط الأداة ليست JSON صالحًا" };
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[تم اقتصاص المخرجات]`;
}

export class McpToolRegistry {
  private readonly tools = new Map<string, McpTool>();

  /** تسجيل أداة واحدة. الأخطاء هنا برمجية وتُرفض fail-closed بلا استثناء. */
  register(tool: McpTool): void {
    const name = tool.definition?.name ?? "";
    if (!NAME_PATTERN.test(name)) {
      console.warn(`mcp: رُفض تسجيل أداة باسم غير صالح (${name.length} حرفًا).`);
      return;
    }
    if (this.tools.has(name)) {
      console.warn(`mcp: رُفض تسجيل مكرر للأداة ${name}.`);
      return;
    }
    if (tool.policy.readOnly !== true && !areWriteToolsAllowed()) {
      // أدوات الكتابة لا تُسجَّل إلا ببوابة صريحة مستقلة، حتى لو كانت الطبقة مفعّلة.
      console.warn(`mcp: رُفضت أداة غير للقراءة فقط ${name} (MCP_ALLOW_WRITE_TOOLS غير مفعّل).`);
      return;
    }
    this.tools.set(name, tool);
  }

  registerAll(tools: readonly McpTool[]): void {
    for (const tool of tools) this.register(tool);
  }

  isEnabled(): boolean {
    return isMcpToolsEnabled();
  }

  policy(): McpPolicySnapshot {
    return mcpPolicySnapshot(this.registeredNames());
  }

  private registeredNames(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** الأسماء المرئية الآن: الطبقة مفعّلة + القائمة المسموح بها. */
  private visibleNames(): string[] {
    if (!isMcpToolsEnabled()) return [];
    const allowed = new Set(resolveAllowedToolNames(this.registeredNames()));
    return this.registeredNames().filter((name) => allowed.has(name));
  }

  /** `tools/list` — لا يعرض شيئًا عندما تكون الطبقة معطلة. */
  listTools(): McpToolDefinition[] {
    return this.visibleNames().map((name) => {
      const tool = this.tools.get(name) as McpTool;
      return {
        name,
        description: tool.definition.description,
        inputSchema: tool.definition.inputSchema,
      };
    });
  }

  /** مانيفست إداري للعرض فقط — يشمل الحالة الفعلية للحدود المفروضة. */
  describeTools(): McpToolDescriptor[] {
    const timeoutMs = clampInt(process.env.MCP_TOOL_TIMEOUT_MS, MCP_POLICY_LIMITS.timeoutMs);
    const maxResultChars = clampInt(
      process.env.MCP_MAX_RESULT_CHARS,
      MCP_POLICY_LIMITS.maxResultChars
    );
    return this.visibleNames().map((name) => {
      const tool = this.tools.get(name) as McpTool;
      return {
        name,
        description: tool.definition.description,
        input_schema: tool.definition.inputSchema,
        read_only: tool.policy.readOnly === true,
        timeout_ms: timeoutMs,
        max_result_chars: maxResultChars,
      };
    });
  }

  find(name: string): McpTool | null {
    if (!this.visibleNames().includes(name)) return null;
    return this.tools.get(name) ?? null;
  }

  newBudget(): McpCallBudget {
    return new RequestBudget(
      clampInt(process.env.MCP_MAX_CALLS_PER_REQUEST, MCP_POLICY_LIMITS.maxCallsPerRequest)
    );
  }

  /** `tools/call` — لا يرمي أبدًا: كل مخرجاته نتيجة MCP صالحة. */
  async callTool(
    name: string,
    rawArguments: unknown,
    ctx: McpCallContext = {}
  ): Promise<McpToolResult> {
    const started = Date.now();
    const outcome = await this.execute(name, rawArguments, ctx);
    const durationMs = Date.now() - started;

    metrics.recordMcpToolCall(name || "unknown", outcome.status, durationMs);
    // سطر تدقيقي بلا وسائط ولا مخرجات ولا أسرار — الأرقام والحالة فقط.
    console.log(
      JSON.stringify({
        level: "info",
        event: "mcp_tool_call",
        tool: name || "unknown",
        status: outcome.status,
        duration_ms: durationMs,
        request_id: ctx.requestId ?? null,
      })
    );

    const result: McpToolResult = { content: [{ type: "text", text: outcome.text }] };
    if (outcome.status === "ok" && outcome.structured) result.structuredContent = outcome.structured;
    if (outcome.status !== "ok") result.isError = true;
    return result;
  }

  private async execute(
    name: string,
    rawArguments: unknown,
    ctx: McpCallContext
  ): Promise<{ status: McpCallStatus; text: string; structured?: Record<string, unknown> }> {
    if (!isMcpToolsEnabled()) {
      return { status: "disabled", text: "أدوات المتجر غير مفعّلة في هذه البيئة." };
    }

    const tool = this.find(name);
    if (!tool) return { status: "denied", text: "الأداة غير متاحة." };

    if (ctx.budget && !ctx.budget.consume()) {
      return { status: "budget_exceeded", text: "تم بلوغ الحد الأقصى لاستدعاءات الأدوات في هذا الطلب." };
    }

    const parsed = parseArguments(rawArguments);
    if (!parsed.ok) return { status: "invalid", text: parsed.message };

    const validated = tool.validate(parsed.value);
    if (!validated.ok) return { status: "invalid", text: validated.message };

    const timeoutMs = clampInt(process.env.MCP_TOOL_TIMEOUT_MS, MCP_POLICY_LIMITS.timeoutMs);
    const maxResultChars = clampInt(
      process.env.MCP_MAX_RESULT_CHARS,
      MCP_POLICY_LIMITS.maxResultChars
    );

    const execution = await this.runWithinTimeout(tool, validated.value, timeoutMs, ctx);
    if (!execution.ok) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "mcp_tool_error",
          tool: name,
          status: execution.status,
          message: redactSecrets(String(execution.message ?? "")).slice(0, 200),
          request_id: ctx.requestId ?? null,
        })
      );
      return {
        status: execution.status,
        text:
          execution.status === "timeout"
            ? "انتهت مهلة تنفيذ الأداة، أكمل بالإجابة من المعلومات المتاحة."
            : "تعذر تنفيذ الأداة، أكمل بالإجابة من المعلومات المتاحة.",
      };
    }

    const text = truncate(String(execution.text ?? "").trim(), maxResultChars);
    if (!text) return { status: "error", text: "الأداة لم تُعد نتيجة." };
    // المحتوى المنظّم يمر بفحص النوع فقط: كائن مسطّح بلا دوال، فلا يُنفَّذ شيء منه.
    const structured =
      execution.structured && typeof execution.structured === "object"
        ? execution.structured
        : undefined;
    return { status: "ok", text, structured };
  }

  /**
   * التنفيذ بحد زمني مركزي. يُحوَّل وعد الأداة إلى نتيجة دائمًا (لا رفض معلّق
   * يتحول إلى unhandled rejection) ويُلغى الإشارة عند انتهاء المهلة.
   */
  private async runWithinTimeout(
    tool: McpTool,
    value: unknown,
    timeoutMs: number,
    ctx: McpCallContext
  ): Promise<
    | { ok: true; text: string; structured?: Record<string, unknown> }
    | { ok: false; status: McpCallStatus; message?: string }
  > {
    const controller = new AbortController();
    const parent = ctx.signal;
    const onParentAbort = () => controller.abort();
    parent?.addEventListener("abort", onParentAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol("timeout");

    try {
      const execution = tool.run(value, { signal: controller.signal }).then(
        (output) =>
          typeof output === "string"
            ? { ok: true as const, text: output, structured: undefined }
            : { ok: true as const, text: output.text, structured: output.structured },
        (error: unknown) => ({ ok: false as const, error })
      );

      const timeout = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(timedOut);
        }, timeoutMs);
      });

      const outcome = await Promise.race([execution, timeout]);
      if (outcome === timedOut) return { ok: false, status: "timeout" };
      if (outcome.ok) return { ok: true, text: outcome.text, structured: outcome.structured };
      return {
        ok: false,
        status: "error",
        message: String((outcome.error as Error)?.message ?? outcome.error ?? ""),
      };
    } finally {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    }
  }
}

export { RequestBudget };
export type { McpToolOutput };
