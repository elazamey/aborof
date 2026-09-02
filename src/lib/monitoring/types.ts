/**
 * IDENTITY SECURITY MONITORING (P0) — الأنواع والثوابت والسياسة الافتراضية.
 *
 * الأحداث المسجَّلة (security_events) بأسماء قانونية ثابتة — تُستهلك من
 * metrics (تجميع خفيف) و detectors (عتبات → تنبيهات) دون أي PII كامل:
 * لا OTP ولا كلمات مرور ولا رموز جلسات ولا أسرار — فقط hashes / أسباب / عدادات.
 */

export const EV = {
  EMAIL_VERIFICATION_REQUESTED: "email_verification_requested",
  EMAIL_VERIFICATION_SUCCEEDED: "email_verification_succeeded",
  EMAIL_VERIFICATION_FAILED: "email_verification_failed",
  PHONE_VERIFICATION_REQUESTED: "phone_verification_requested",
  PHONE_VERIFICATION_SUCCEEDED: "phone_verification_succeeded",
  PHONE_VERIFICATION_FAILED: "phone_verification_failed",
  EMAIL_CHANGE_REQUESTED: "email_change_requested",
  EMAIL_CHANGE_VERIFIED: "email_change_verified",
  EMAIL_CHANGE_COMPLETED: "email_change_completed",
  EMAIL_CHANGE_CANCELLED: "email_change_cancelled",
  EMAIL_CHANGE_EXPIRED: "email_change_expired",
  PHONE_CHANGE_REQUESTED: "phone_change_requested",
  PHONE_CHANGE_VERIFIED: "phone_change_verified",
  PHONE_CHANGE_COMPLETED: "phone_change_completed",
  PHONE_CHANGE_CANCELLED: "phone_change_cancelled",
  PHONE_CHANGE_EXPIRED: "phone_change_expired",
  PASSWORD_CHANGE: "password_change",
  SESSION_REVOKED: "session_revoked",
  RECOVERY_REQUESTED: "recovery_requested",
  RECOVERY_COMPLETED: "recovery_completed",
  RECOVERY_FAILED: "recovery_failed",
  /** امتداد داخلي للتجميع: رفض OTP (تغيير البريد/الهاتف) — يُحتسب في otp.rejections */
  OTP_REJECTED: "otp_rejected",
  OTP_RATE_LIMITED: "otp_rate_limited",
  SUSPICIOUS_IDENTITY_ACTIVITY: "suspicious_identity_activity",
} as const;

export type SecurityEventName = (typeof EV)[keyof typeof EV];

export type AlertLevel = "INFO" | "WARNING" | "CRITICAL";

export type SecurityAlert = {
  id: string;
  /** مفتاح إلغاء التكرار لكل نافذة زمنية (bucket) */
  alertKey: string;
  level: AlertLevel;
  type: string; // otp_failure_spike | many_accounts_from_source | impossible_identity_change | recovery_abuse | session_revoke_spike
  userId: string | null;
  ipHash: string | null;
  message: string;
  metadata: string; // JSON مُطهَّر — بلا أسرار
  createdAt: number;
  resolvedAt: number | null;
};

/** عتبات قابلة للضبط عبر البيئة — ليست hard-coded في المسارات. */
export type MonitoringPolicy = {
  enabled: boolean; // MONITOR_DISABLED=1 → وضع مُعطّل (fail-open)
  otpFailureWindowMs: number;
  otpFailuresWarn: number; // 5 محاولات خاطئة → WARNING
  otpFailuresCritical: number; // 50 → CRITICAL
  accountsSourceWindowMs: number;
  accountsPerSourceWarn: number; // 10 حسابات من مصدر واحد → WARNING
  accountsPerSourceCritical: number; // 100 → CRITICAL
  impossibleChangeBucketMs: number; // 60s — نافذة "تغيير مستحيل"
  impossibleChangeOps: number; // ≥3 عمليات حرجة في دقيقة → تنبيه + risk score
  recoveryWindowMs: number;
  recoveryWarn: number; // 5
  recoveryCritical: number; // 20
  sessionRevokeWindowMs: number;
  sessionRevokeWarn: number; // 3 إبطالات جلسات في النافذة → WARNING
  hotRetentionDays: number; // العدادات الساخنة 30 يومًا
  auditRetentionDays: number; // أحداث التدقيق (الأطول)
  alertRetentionDays: number; // التنبيهات
};

export const DEFAULT_MONITORING_POLICY: MonitoringPolicy = {
  enabled: true,
  otpFailureWindowMs: 15 * 60 * 1000,
  otpFailuresWarn: 5,
  otpFailuresCritical: 50,
  accountsSourceWindowMs: 15 * 60 * 1000,
  accountsPerSourceWarn: 10,
  accountsPerSourceCritical: 100,
  impossibleChangeBucketMs: 60 * 1000,
  impossibleChangeOps: 3,
  recoveryWindowMs: 15 * 60 * 1000,
  recoveryWarn: 5,
  recoveryCritical: 20,
  sessionRevokeWindowMs: 15 * 60 * 1000,
  sessionRevokeWarn: 3,
  hotRetentionDays: 30,
  auditRetentionDays: 365,
  alertRetentionDays: 90,
};

export type IdentityMetrics = {
  windowMs: number;
  email: { requested: number; succeeded: number; failed: number; successRate: number | null };
  phone: { requested: number; succeeded: number; failed: number; successRate: number | null };
  verification: { successRate: number | null; failureRate: number | null };
  otp: { attempts: number; rejections: number; rateLimitHits: number };
  identityChanges: { attempts: number; failures: number };
  recovery: { attempts: number; failures: number };
  sessionRevocations: number;
  suspiciousEvents: number;
};
