import type { IdentityRepo } from "@/lib/identity/types";
import { newId } from "@/lib/identity/otp";
import { sha256Hex } from "@/lib/identity/normalize";
import { monitoringPolicyFromEnv } from "./policy";
import { insertEvent } from "./events";
import { AlertLevel, EV, MonitoringPolicy, SecurityAlert, SecurityEventName } from "./types";

/**
 * Abuse Detectors — مستقلة عن المسارات: تقرأ security_events في نوافذ زمنية
 * وتنتج تنبيهات (INFO/WARNING/CRITICAL) + risk score. لا تمنع المستخدم تلقائيًا
 * إلا وفق السياسة (المنع الفعلي موجود في معدّلات المعدّل/OTP في مكانه).
 */

type AlertDraft = Omit<SecurityAlert, "id" | "createdAt" | "resolvedAt">;

const FAILURE_EVENTS: ReadonlySet<string> = new Set([
  EV.EMAIL_VERIFICATION_FAILED,
  EV.PHONE_VERIFICATION_FAILED,
  EV.OTP_REJECTED,
  EV.RECOVERY_FAILED,
]);

function bucket(now: number, windowMs: number): number {
  return Math.floor(now / windowMs);
}

async function existingKeys(repo: IdentityRepo, since: number): Promise<Set<string>> {
  const alerts = await repo.listAlerts(since, 1000);
  return new Set(alerts.map((a) => a.alertKey));
}

async function persistNew(
  repo: IdentityRepo,
  drafts: AlertDraft[],
  since: number,
  now: number
): Promise<SecurityAlert[]> {
  if (drafts.length === 0) return [];
  const keys = await existingKeys(repo, since);
  const created: SecurityAlert[] = [];
  for (const d of drafts) {
    if (keys.has(d.alertKey)) continue; // إلغاء التكرار لكل نافذة
    const alert: SecurityAlert = { ...d, id: newId(), createdAt: now, resolvedAt: null };
    try {
      await repo.createAlert(alert);
      created.push(alert);
    } catch {
      // منافسة إدراج أو قياس معطّل — لا نكسر شيئًا
    }
  }
  return created;
}

// ── 1) OTP failure spike (لكل حساب) ───────────────────────────────
function detectOtpFailureSpike(
  events: Awaited<ReturnType<IdentityRepo["listSecurityEventsSince"]>>,
  policy: MonitoringPolicy,
  now: number
): AlertDraft[] {
  const byUser = new Map<string, number>();
  for (const e of events) {
    if (!FAILURE_EVENTS.has(e.event) || !e.userId) continue;
    byUser.set(e.userId, (byUser.get(e.userId) ?? 0) + 1);
  }
  const out: AlertDraft[] = [];
  for (const [userId, count] of byUser) {
    if (count >= policy.otpFailuresCritical) {
      out.push({
        alertKey: `otp-spike:${userId}:${bucket(now, policy.otpFailureWindowMs)}`,
        level: "CRITICAL",
        type: "otp_failure_spike",
        userId,
        ipHash: null,
        message: `${count} فشل OTP على حساب واحد — يُرجَّح credential stuffing / OTP abuse`,
        metadata: JSON.stringify({ count, threshold: policy.otpFailuresCritical }),
      });
    } else if (count >= policy.otpFailuresWarn) {
      out.push({
        alertKey: `otp-spike:${userId}:${bucket(now, policy.otpFailureWindowMs)}`,
        level: "WARNING",
        type: "otp_failure_spike",
        userId,
        ipHash: null,
        message: `${count} محاولات OTP خاطئة على حساب واحد`,
        metadata: JSON.stringify({ count, threshold: policy.otpFailuresWarn }),
      });
    }
  }
  return out;
}

// ── 2) Many accounts targeted from one source (IP hash) ───────────
function detectManyAccountsFromSource(
  events: Awaited<ReturnType<IdentityRepo["listSecurityEventsSince"]>>,
  policy: MonitoringPolicy,
  now: number
): { alerts: AlertDraft[]; suspicious: { userId: string | null; metadata: Record<string, unknown> }[] } {
  const byIp = new Map<string, Set<string>>();
  for (const e of events) {
    if (!FAILURE_EVENTS.has(e.event) || !e.ip) continue;
    const set = byIp.get(e.ip) ?? new Set<string>();
    if (e.userId) set.add(e.userId);
    byIp.set(e.ip, set);
  }
  const alerts: AlertDraft[] = [];
  const suspicious: { userId: string | null; metadata: Record<string, unknown> }[] = [];
  for (const [ip, users] of byIp) {
    const ipHash = sha256Hex(ip);
    if (users.size >= policy.accountsPerSourceCritical) {
      alerts.push({
        alertKey: `accounts-source:${ipHash}:${bucket(now, policy.accountsSourceWindowMs)}`,
        level: "CRITICAL",
        type: "many_accounts_from_source",
        userId: null,
        ipHash,
        message: `${users.size} حسابًا مستهدفة من مصدر واحد — يُرجَّح account enumeration / credential stuffing`,
        metadata: JSON.stringify({ accounts: users.size, threshold: policy.accountsPerSourceCritical }),
      });
      suspicious.push({
        userId: null,
        metadata: { type: "many_accounts_source", accounts: users.size, ipHash },
      });
    } else if (users.size >= policy.accountsPerSourceWarn) {
      alerts.push({
        alertKey: `accounts-source:${ipHash}:${bucket(now, policy.accountsSourceWindowMs)}`,
        level: "WARNING",
        type: "many_accounts_from_source",
        userId: null,
        ipHash,
        message: `${users.size} حسابات مستهدفة من مصدر واحد`,
        metadata: JSON.stringify({ accounts: users.size, threshold: policy.accountsPerSourceWarn }),
      });
    }
  }
  return { alerts, suspicious };
}

// ── 3) Impossible identity change (تغيير مستحيل خلال دقيقة) ────────
const CRITICAL_OPS: Record<string, string> = {
  [EV.EMAIL_CHANGE_COMPLETED]: "email_change",
  [EV.PHONE_CHANGE_COMPLETED]: "phone_change",
  [EV.PASSWORD_CHANGE]: "password_change",
  [EV.SESSION_REVOKED]: "session_revoke",
};

function detectImpossibleChange(
  events: Awaited<ReturnType<IdentityRepo["listSecurityEventsSince"]>>,
  policy: MonitoringPolicy,
  now: number
): { alerts: AlertDraft[]; suspicious: { userId: string | null; metadata: Record<string, unknown> }[] } {
  const byUser = new Map<string, Set<string>>();
  for (const e of events) {
    const op = CRITICAL_OPS[e.event];
    if (!op || !e.userId) continue;
    const set = byUser.get(e.userId) ?? new Set<string>();
    set.add(op);
    byUser.set(e.userId, set);
  }
  const alerts: AlertDraft[] = [];
  const suspicious: { userId: string | null; metadata: Record<string, unknown> }[] = [];
  for (const [userId, ops] of byUser) {
    if (ops.size < policy.impossibleChangeOps) continue;
    const riskScore = ops.size * 10; // سلوك عالي الخطورة — لا منع تلقائي إلا حسب السياسة
    const level: AlertLevel = ops.size >= 4 ? "CRITICAL" : "WARNING";
    alerts.push({
      alertKey: `impossible-change:${userId}:${bucket(now, policy.impossibleChangeBucketMs)}`,
      level,
      type: "impossible_identity_change",
      userId,
      ipHash: null,
      message: `تغييرات هوية متزامنة خلال ${Math.round(policy.impossibleChangeBucketMs / 1000)}ث: ${[...ops].join("+")} — risk score ${riskScore}`,
      metadata: JSON.stringify({ ops: [...ops].sort(), riskScore, threshold: policy.impossibleChangeOps }),
    });
    suspicious.push({
      userId,
      metadata: { type: "impossible_identity_change", ops: [...ops].sort(), riskScore },
    });
  }
  return { alerts, suspicious };
}

// ── 4) Recovery abuse ─────────────────────────────────────────────
function detectRecoveryAbuse(
  events: Awaited<ReturnType<IdentityRepo["listSecurityEventsSince"]>>,
  policy: MonitoringPolicy,
  now: number
): AlertDraft[] {
  const byUser = new Map<string, number>();
  for (const e of events) {
    if ((e.event !== EV.RECOVERY_REQUESTED && e.event !== EV.RECOVERY_FAILED) || !e.userId) continue;
    byUser.set(e.userId, (byUser.get(e.userId) ?? 0) + 1);
  }
  const out: AlertDraft[] = [];
  for (const [userId, count] of byUser) {
    if (count >= policy.recoveryCritical) {
      out.push({
        alertKey: `recovery-abuse:${userId}:${bucket(now, policy.recoveryWindowMs)}`,
        level: "CRITICAL",
        type: "recovery_abuse",
        userId,
        ipHash: null,
        message: `${count} محاولات استرداد على حساب واحد — يُرجَّح هجوم استرداد`,
        metadata: JSON.stringify({ count, threshold: policy.recoveryCritical }),
      });
    } else if (count >= policy.recoveryWarn) {
      out.push({
        alertKey: `recovery-abuse:${userId}:${bucket(now, policy.recoveryWindowMs)}`,
        level: "WARNING",
        type: "recovery_abuse",
        userId,
        ipHash: null,
        message: `${count} محاولات استرداد على حساب واحد`,
        metadata: JSON.stringify({ count, threshold: policy.recoveryWarn }),
      });
    }
  }
  return out;
}

// ── 5) Repeated suspicious session changes ────────────────────────
function detectSessionRevokeSpike(
  events: Awaited<ReturnType<IdentityRepo["listSecurityEventsSince"]>>,
  policy: MonitoringPolicy,
  now: number
): AlertDraft[] {
  const byUser = new Map<string, number>();
  for (const e of events) {
    if (e.event !== EV.SESSION_REVOKED || !e.userId) continue;
    byUser.set(e.userId, (byUser.get(e.userId) ?? 0) + 1);
  }
  const out: AlertDraft[] = [];
  for (const [userId, count] of byUser) {
    if (count < policy.sessionRevokeWarn) continue;
    out.push({
      alertKey: `session-revoke:${userId}:${bucket(now, policy.sessionRevokeWindowMs)}`,
      level: "WARNING",
      type: "session_revoke_spike",
      userId,
      ipHash: null,
      message: `${count} عمليات إبطال جلسات على حساب واحد خلال النافذة`,
      metadata: JSON.stringify({ count, threshold: policy.sessionRevokeWarn }),
    });
  }
  return out;
}

export type DetectionResult = {
  created: SecurityAlert[];
  events: { userId: string | null; metadata: Record<string, unknown> }[];
};

/**
 * الفحص الكامل: كل الكواشف على النافذة المطلوبة (windowMs) —
 * يُستدعى من مسار لوحة المراقبة وعند الطلب، والنتائج تُخزَّن (dedupe لكل bucket).
 */
export async function runDetectors(
  repo: IdentityRepo,
  policy: MonitoringPolicy,
  now: number,
  windowMs = policy.otpFailureWindowMs
): Promise<DetectionResult> {
  const events = await repo.listSecurityEventsSince(now - windowMs, 5000);
  const drafts: AlertDraft[] = [
    ...detectOtpFailureSpike(events, policy, now),
    ...detectRecoveryAbuse(events, policy, now),
    ...detectSessionRevokeSpike(events, policy, now),
  ];
  const source = detectManyAccountsFromSource(events, policy, now);
  const impossible = detectImpossibleChange(events, policy, now);
  drafts.push(...source.alerts, ...impossible.alerts);
  const created = await persistNew(repo, drafts, now - windowMs, now);
  return { created, events: [...source.suspicious, ...impossible.suspicious] };
}

/** كشف فوري على حدث واحد (بعد تسجيله) — نفس الكواشف بلا نافذة مخصصة. */
export async function runInlineDetection(
  repo: IdentityRepo,
  policy: MonitoringPolicy,
  event: SecurityEventName | string,
  now: number
): Promise<DetectionResult> {
  try {
    if (event === EV.SUSPICIOUS_IDENTITY_ACTIVITY) return { created: [], events: [] }; // لا إعادة تدوير
    const res = await runDetectors(repo, policy, now);
    for (const s of res.events) {
      await insertEvent(repo, { event: EV.SUSPICIOUS_IDENTITY_ACTIVITY, userId: s.userId, metadata: s.metadata }).catch(
        () => undefined
      );
    }
    return res;
  } catch (error) {
    console.error("[monitor] inline detection failed (fail-open):", error);
    return { created: [], events: [] };
  }
}

/** واجهة واحدة للوحة: كشف + تخزين + إعادة الأحداث المشبوهة. */
export async function evaluateAlerts(
  repo: IdentityRepo,
  policy: MonitoringPolicy = monitoringPolicyFromEnv(),
  now: number = Date.now()
): Promise<DetectionResult> {
  return runInlineDetection(repo, policy, "evaluate", now);
}

/** الاحتفاظ: حذف الأحداث والتنبيهات الأقدم من السياسة (يُستدعى من لوحة المراقبة). */
export async function pruneSecurityData(
  repo: IdentityRepo,
  policy: MonitoringPolicy,
  now: number = Date.now()
): Promise<void> {
  await repo.deleteSecurityEventsOlderThan(now - policy.auditRetentionDays * 24 * 3600 * 1000);
  await repo.deleteAlertsOlderThan(now - policy.alertRetentionDays * 24 * 3600 * 1000);
}
