/**
 * مقاييس تشغيلية خفيفة في الذاكرة لكشف المعدلات الحرجة (4xx/5xx/429)
 * وبطء قاعدة البيانات وفشل مزودي الذكاء الاصطناعي. لا تُصدَّر أي بيانات
 * حساسة؛ الأرقام والتواريخ فقط.
 */

export type MetricKind =
  | "request"
  | "rate_limited"
  | "ai_provider_failure"
  | "db_timing"
  | "validation_failed"
  | "mcp_tool_call";

interface RequestSample {
  route: string;
  status: number;
  at: number;
}

interface TimingSample {
  name: string;
  ms: number;
  at: number;
}

interface McpCallSample {
  tool: string;
  status: string;
  ms: number;
  at: number;
}

const MAX_SAMPLES = 500;

const requests: RequestSample[] = [];
const aiFailures: { provider: string; at: number }[] = [];
const timings: TimingSample[] = [];
const mcpCalls: McpCallSample[] = [];
const counters = new Map<string, number>();

function push<T>(arr: T[], item: T) {
  arr.push(item);
  if (arr.length > MAX_SAMPLES) arr.shift();
}

export const metrics = {
  recordRequest(route: string, status: number) {
    push(requests, { route, status, at: Date.now() });
  },
  recordRateLimit(scope: string) {
    counters.set(`rate_limited:${scope}`, (counters.get(`rate_limited:${scope}`) ?? 0) + 1);
  },
  recordValidationFailure(route: string) {
    counters.set(`validation_failed:${route}`, (counters.get(`validation_failed:${route}`) ?? 0) + 1);
  },
  recordAiFailure(provider: string) {
    push(aiFailures, { provider, at: Date.now() });
  },
  recordTiming(name: string, ms: number) {
    push(timings, { name, ms: Math.round(ms), at: Date.now() });
  },
  /**
   * تفعيلة سقوط للبديل المحلي (بذرة/احتياطي) بعد محاولة قاعدة فاشلة.
   * القيد الصريح: العدّاد في الذاكرة لكل نسخة serverless — يُظهر «هل يسقط
   * هذا النسخة» لا إجماليًا عالميًا؛ الإجمالي العالمي يحتاج مصرفًا خارجيًا (P3).
   * يُعرَض في `snapshot().counters["db.fallback_activations_total"]`.
   */
  recordDbFallback() {
    counters.set("db.fallback_activations_total", (counters.get("db.fallback_activations_total") ?? 0) + 1);
  },
  /** استدعاء أداة MCP: الاسم والحالة والزمن فقط — لا وسائط ولا مخرجات. */
  recordMcpToolCall(tool: string, status: string, ms: number) {
    push(mcpCalls, { tool, status, ms: Math.round(ms), at: Date.now() });
  },
};

function bucketByStatus(since: number) {
  const out: Record<string, number> = { "2xx": 0, "4xx": 0, "5xx": 0, "429": 0 };
  for (const r of requests) {
    if (r.at < since) continue;
    if (r.status === 429) out["429"] += 1;
    else if (r.status >= 500) out["5xx"] += 1;
    else if (r.status >= 400) out["4xx"] += 1;
    else if (r.status >= 200 && r.status < 300) out["2xx"] += 1;
  }
  return out;
}

/** لقطة ملائمة للعرض عبر نقطة التشخيص — لا تتضمن أي محتوى طلبات. */
export function snapshot(windowMs = 60 * 60 * 1000) {
  const since = Date.now() - windowMs;
  const recentTimings = timings.filter((t) => t.at >= since);
  const dbTimings = recentTimings.filter((t) => t.name === "db");
  const avgDb = dbTimings.length
    ? Math.round(dbTimings.reduce((n, t) => n + t.ms, 0) / dbTimings.length)
    : 0;
  const slowDb = dbTimings.filter((t) => t.ms > 1000).length;
  const recentMcp = mcpCalls.filter((c) => c.at >= since);
  const mcpByTool: Record<string, number> = {};
  const mcpByStatus: Record<string, number> = {};
  for (const call of recentMcp) {
    mcpByTool[call.tool] = (mcpByTool[call.tool] ?? 0) + 1;
    mcpByStatus[call.status] = (mcpByStatus[call.status] ?? 0) + 1;
  }
  return {
    window_ms: windowMs,
    generated_at: new Date().toISOString(),
    requests: bucketByStatus(since),
    ai_provider_failures_last_hour: aiFailures.filter((f) => f.at >= since).length,
    db: {
      samples: dbTimings.length,
      avg_ms: avgDb,
      slow_over_1s: slowDb,
    },
    mcp: {
      calls: recentMcp.length,
      errors: recentMcp.filter((c) => c.status !== "ok").length,
      avg_ms: recentMcp.length
        ? Math.round(recentMcp.reduce((n, c) => n + c.ms, 0) / recentMcp.length)
        : 0,
      by_tool: mcpByTool,
      by_status: mcpByStatus,
    },
    counters: Object.fromEntries(counters),
  };
}

export type MetricsSnapshot = ReturnType<typeof snapshot>;
