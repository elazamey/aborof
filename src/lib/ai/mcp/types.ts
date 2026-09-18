/**
 * طبقة MCP المحكومة (المرحلة الثانية) — العقود.
 *
 * العقود هنا مطابقة لشكل MCP القياسي (`tools/list` و`tools/call`) لكنها
 * **داخل العملية**: لا يوجد نقل شبكي للأدوات ولا نقطة نهاية تنفيذ عبر HTTP،
 * فالسطح المكشوف لا يزيد بحرف واحد. الموديل يرى `McpToolDefinition` فقط،
 * ولا يستطيع تنفيذ شيء خارج بوابات `McpToolRegistry`.
 *
 * المبدأ الحاكم: الأداة تُعلن، والطبقة تفرض. زمن المهلة وحد المخرجات وسقف
 * الاستدعاءات كلها تُقرأ من السياسة المركزية ولا تستطيع أي أداة توسيعها.
 */

/** جزء محتوى نصي — نفس شكل محتوى نتيجة MCP. */
export interface McpTextContent {
  type: "text";
  text: string;
}

/**
 * مخرجات أداة: نص دائمًا، ومعها — عند الحاجة — محتوى منظّم اختياري.
 * النص هو ما يقرأه الموديل، والمنظّم يقود المكونات المرئية في الواجهة
 * (بطاقات المنتجات) بنفس مبدأ MCP: `content` + `structuredContent`.
 */
export interface McpToolOutput {
  text: string;
  structured?: Record<string, unknown>;
}

/** نتيجة `tools/call` — الأخطاء تُعاد كنتيجة لا كاستثناء (سلوك MCP القياسي). */
export interface McpToolResult {
  content: McpTextContent[];
  /** محتوى منظّم اختياري للواجهة — يُقتص ويُنقّى ولا يُبنى عليه أي تنفيذ. */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** تعريف الأداة كما يراه الموديل/العميل في `tools/list`. */
export interface McpToolDefinition {
  name: string;
  description: string;
  /** مخطط JSON للوسائط — مطابق لعقد zod المعلن في الأداة. */
  inputSchema: Record<string, unknown>;
}

/**
 * سياسة الأداة التشغيلية:
 *  - `readOnly` إلزامية؛ الأدوات الكاتبة مرفوضة في التسجيل افتراضيًا.
 *  - المهلة وحد المخرجات قيمتان افتراضيتان تُستبدلان بحدود السياسة المركزية.
 */
export interface McpToolPolicy {
  readOnly: boolean;
  timeoutMs: number;
  maxResultChars: number;
}

export type McpToolValidation = { ok: true; value: unknown } | { ok: false; message: string };

export interface McpToolExecutionContext {
  signal: AbortSignal;
}

/** أداة واحدة: تعريف + سياسة + تحقق من الوسائط + تنفيذ نصي. */
export interface McpTool {
  definition: McpToolDefinition;
  policy: McpToolPolicy;
  /**
   * بوابة علم خاصة بالأداة تُقرأ عند كل نداء (لا عند التسجيل).
   * غيابها يعني «مفعّلة متى كانت الطبقة مفعّلة».
   */
  isEnabled?: () => boolean;
  validate(raw: unknown): McpToolValidation;
  run(value: unknown, ctx: McpToolExecutionContext): Promise<string | McpToolOutput>;
}

/** سقف استدعاءات لكل طلب — يُنشأ مرة واحدة لكل رسالة مستخدم. */
export interface McpCallBudget {
  readonly limit: number;
  readonly used: number;
  remaining(): number;
  /** يستهلك استدعاءً واحدًا؛ يعيد false عند تجاوز السقف. */
  consume(): boolean;
}

export interface McpCallContext {
  budget?: McpCallBudget;
  requestId?: string;
  signal?: AbortSignal;
}

/** حالات التتبع — تُسجَّل في المقاييس والسجل التدقيقي. */
export type McpCallStatus =
  | "ok"
  | "disabled"
  | "denied"
  | "invalid"
  | "timeout"
  | "error"
  | "budget_exceeded";

/** مستوى رؤية الأداة للإدارة (بيان المانيفست الإداري). */
export interface McpToolDescriptor {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  read_only: boolean;
  timeout_ms: number;
  max_result_chars: number;
}
