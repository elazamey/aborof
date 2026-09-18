/**
 * سياسة طبقة MCP المحكومة — مصدر الحقيقة الوحيد للحدود.
 *
 * كل القيم fail-closed ومقيّدة بنطاقات صارمة:
 *  - `ENABLE_MCP_TOOLS` غيابه أو أي قيمة غير `true` ⇒ صفر أدوات وصفر تنفيذ.
 *  - `MCP_ALLOWED_TOOLS` قائمة سماح صريحة؛ غيابها يعني المجموعة الافتراضية
 *    للقراءة فقط، وتسمية أداة غير مسجّلة لا تضيف شيئًا.
 *  - `MCP_ALLOW_WRITE_TOOLS` بوابة مستقلة للأدوات الكاتبة؛ مرفوضة افتراضيًا
 *    حتى لا يُمنح الموديل قدرة تعديل بيانات المتجر بالخطأ.
 *  - الحدود (سقف الاستدعاءات/المهلة/حجم المخرجات) تُقيَّد رياضيًا فلا يمكن
 *    لأي قيمة بيئية خاطئة أن توسّعها.
 */

export interface NumericBounds {
  min: number;
  max: number;
  fallback: number;
}

export const MCP_POLICY_LIMITS = {
  /** أقصى عدد تنفيذ أدوات في الطلب الواحد. */
  maxCallsPerRequest: { min: 0, max: 8, fallback: 3 },
  /** مهلة تنفيذ الأداة الواحدة بالمللي ثانية. */
  timeoutMs: { min: 300, max: 10_000, fallback: 4_000 },
  /** أقصى طول نص تُعاد به نتيجة الأداة إلى الموديل. */
  maxResultChars: { min: 200, max: 20_000, fallback: 4_000 },
} as const satisfies Record<string, NumericBounds>;

/**
 * قراءة عدد صحيح وتقييده داخل نطاق، مع سقوط آمن إلى القيمة الافتراضية.
 * ملاحظة مهمة: الغياب أو الفراغ يعني القيمة الافتراضية لا الصفر
 * (`Number("")` تساوي صفرًا، وهي فخ يغلق الميزة بدل أن يبقيها على وضعها).
 */
export function clampInt(raw: string | undefined | null, bounds: NumericBounds): number {
  const text = String(raw ?? "").trim();
  if (text === "") return bounds.fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) return bounds.fallback;
  const rounded = Math.trunc(value);
  if (rounded < bounds.min) return bounds.min;
  if (rounded > bounds.max) return bounds.max;
  return rounded;
}

/** هل الطبقة مُفعّلة؟ لا شيء آخر يفتحها. */
export function isMcpToolsEnabled(): boolean {
  return process.env.ENABLE_MCP_TOOLS === "true";
}

/** بوابة منفصلة للأدوات الكاتبة — مغلقة حتى لو كانت الطبقة مفعّلة. */
export function areWriteToolsAllowed(): boolean {
  return process.env.MCP_ALLOW_WRITE_TOOLS === "true";
}

/**
 * قائمة الأسماء المسموح بها. غياب المتغير ⇒ المجموعة الافتراضية.
 * التطابق حرفي بعد trim، فلا تتحول قيمة فاسدة إلى منح ضمني.
 */
export function resolveAllowedToolNames(defaults: readonly string[]): string[] {
  const raw = process.env.MCP_ALLOWED_TOOLS;
  if (raw == null || raw.trim() === "") return [...defaults];
  const names = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (names.length === 0) return [...defaults];
  return Array.from(new Set(names));
}

export interface McpPolicySnapshot {
  enabled: boolean;
  write_tools_allowed: boolean;
  allowed_tools: string[];
  max_calls_per_request: number;
  tool_timeout_ms: number;
  max_result_chars: number;
}

/** لقطة سياسة للعرض في التشخيص/المانيفست الإداري — لا تحتوي أي سر. */
export function mcpPolicySnapshot(defaults: readonly string[]): McpPolicySnapshot {
  return {
    enabled: isMcpToolsEnabled(),
    write_tools_allowed: areWriteToolsAllowed(),
    allowed_tools: resolveAllowedToolNames(defaults),
    max_calls_per_request: clampInt(process.env.MCP_MAX_CALLS_PER_REQUEST, MCP_POLICY_LIMITS.maxCallsPerRequest),
    tool_timeout_ms: clampInt(process.env.MCP_TOOL_TIMEOUT_MS, MCP_POLICY_LIMITS.timeoutMs),
    max_result_chars: clampInt(process.env.MCP_MAX_RESULT_CHARS, MCP_POLICY_LIMITS.maxResultChars),
  };
}
