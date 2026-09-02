import type { IdentityRepo, SecurityEvent } from "@/lib/identity/types";
import { newId } from "@/lib/identity/otp";
import { monitoringPolicyFromEnv } from "./policy";
import { runInlineDetection } from "./detectors";
import { MonitoringPolicy, SecurityEventName } from "./types";

/** مفاتيح تُمنع من دخول metadata الأحداث — لا OTP ولا أسرار ولا PII كامل. */
const SENSITIVE_KEY = /otp|pass|secret|token|code|authorization|cookie|raw|plain/i;

/** تطهير عميق لأي metadata قبل التسجيل — يمنع تسريب الأسرار حتى لو أُرسلت سهوًا. */
export function sanitizeMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (SENSITIVE_KEY.test(k)) continue; // مفتاح حساس → لا يُسجَّل
    if (typeof v === "string") out[k] = v.length > 256 ? v.slice(0, 256) : v;
    else if (v !== null && typeof v === "object") out[k] = sanitizeMetadata(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}

/** إدراج خام بدون كشف — تستخدمه الكواشف نفسها (تجنّب الاستدعاء الذاتي). */
export async function insertEvent(
  repo: IdentityRepo,
  ev: {
    event: SecurityEventName | string;
    userId?: string | null;
    ip?: string | null;
    requestId?: string | null;
    metadata?: Record<string, unknown>;
    createdAt?: number;
  }
): Promise<void> {
  const e: SecurityEvent = {
    id: newId(),
    userId: ev.userId ?? "",
    event: ev.event,
    metadata: JSON.stringify(sanitizeMetadata(ev.metadata ?? {})),
    ip: ev.ip ?? null,
    requestId: ev.requestId ?? null,
    createdAt: ev.createdAt ?? Date.now(),
  };
  await repo.createSecurityEvent(e);
}

/**
 * تسجيل حدث أمني STRUCTURED — فشل التسجيل/الكشف لا يكسر تدفقات الهوية:
 * أي خطأ يُبتلع ويُعاد degraded:true (fail-open)، ومتى كان الحدث من عائلة
 * الفشل يعمل الكشف الفوري (عتبات → تنبيهات) داخل نفس المسار.
 */
export async function recordSecurityEvent(
  repo: IdentityRepo,
  ev: {
    event: SecurityEventName | string;
    userId?: string | null;
    ip?: string | null;
    requestId?: string | null;
    metadata?: Record<string, unknown>;
  },
  opts: { detect?: boolean; policy?: MonitoringPolicy; now?: () => number } = {}
): Promise<{ ok: true } | { ok: false; degraded: true }> {
  try {
    const policy = opts.policy ?? monitoringPolicyFromEnv();
    if (!policy.enabled) return { ok: false, degraded: true }; // وضع مُعطّل (MONITOR_DISABLED)
    await insertEvent(repo, { ...ev, createdAt: opts.now?.() });
    if (opts.detect) await runInlineDetection(repo, policy, ev.event, opts.now?.() ?? Date.now());
    return { ok: true };
  } catch (error) {
    // Fail-open: مشاكل القياس لا يجب أن تكسر authentication/verification/change
    console.error("[monitor] recordSecurityEvent failed (fail-open):", error);
    return { ok: false, degraded: true };
  }
}
