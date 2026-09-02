import type { IdentityRepo } from "@/lib/identity/types";
import { EV, IdentityMetrics, MonitoringPolicy } from "./types";

/**
 * تجميع خفيف للعدادات من security_events (نفس قاعدة البيانات — لا بنية تحتية
 * ثقيلة): Event → Aggregation → Threshold → Alert. النافذة الافتراضية للوحة
 * 24 ساعة؛ النوافذ الأطول (30 يومًا) تُحسب عند الطلب.
 */
export async function computeMetrics(
  repo: IdentityRepo,
  policy: MonitoringPolicy,
  windowMs: number,
  now: number = Date.now()
): Promise<IdentityMetrics> {
  const since = now - windowMs;
  const events = await repo.listSecurityEventsSince(since, 20000);
  const count = (name: string) => events.filter((e) => e.event === name).length;

  const emailSucceeded = count(EV.EMAIL_VERIFICATION_SUCCEEDED);
  const emailFailed = count(EV.EMAIL_VERIFICATION_FAILED);
  const phoneSucceeded = count(EV.PHONE_VERIFICATION_SUCCEEDED);
  const phoneFailed = count(EV.PHONE_VERIFICATION_FAILED);

  const successRate = (s: number, f: number) => (s + f === 0 ? null : Math.round((s / (s + f)) * 1000) / 10);
  const totalSucc = emailSucceeded + phoneSucceeded;
  const totalFail = emailFailed + phoneFailed;

  const otpAttempts = await repo.sumOtpAttemptsSince(since);

  const emailChangeFailed = count(EV.EMAIL_CHANGE_CANCELLED) + count(EV.EMAIL_CHANGE_EXPIRED);
  const phoneChangeFailed = count(EV.PHONE_CHANGE_CANCELLED) + count(EV.PHONE_CHANGE_EXPIRED);

  return {
    windowMs,
    email: {
      requested: count(EV.EMAIL_VERIFICATION_REQUESTED),
      succeeded: emailSucceeded,
      failed: emailFailed,
      successRate: successRate(emailSucceeded, emailFailed),
    },
    phone: {
      requested: count(EV.PHONE_VERIFICATION_REQUESTED),
      succeeded: phoneSucceeded,
      failed: phoneFailed,
      successRate: successRate(phoneSucceeded, phoneFailed),
    },
    verification: {
      successRate: successRate(totalSucc, totalFail),
      failureRate: successRate(totalFail, totalSucc),
    },
    otp: {
      attempts: otpAttempts,
      rejections: count(EV.OTP_REJECTED),
      rateLimitHits: count(EV.OTP_RATE_LIMITED),
    },
    identityChanges: {
      attempts: count(EV.EMAIL_CHANGE_REQUESTED) + count(EV.PHONE_CHANGE_REQUESTED) + count(EV.PASSWORD_CHANGE),
      failures: emailChangeFailed + phoneChangeFailed,
    },
    recovery: {
      attempts: count(EV.RECOVERY_REQUESTED),
      failures: count(EV.RECOVERY_FAILED),
    },
    sessionRevocations: count(EV.SESSION_REVOKED),
    suspiciousEvents: count(EV.SUSPICIOUS_IDENTITY_ACTIVITY),
  };
}

/** النافذة الساخنة الافتراضية (hot metrics) من السياسة. */
export function hotWindowMs(policy: MonitoringPolicy): number {
  return policy.hotRetentionDays * 24 * 3600 * 1000;
}
