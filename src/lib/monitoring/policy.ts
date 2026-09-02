import { DEFAULT_MONITORING_POLICY, MonitoringPolicy } from "./types";

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** عتبات المراقبة من البيئة — قابلة للضبط دون تغيير كود المسارات. */
export function monitoringPolicyFromEnv(): MonitoringPolicy {
  return {
    ...DEFAULT_MONITORING_POLICY,
    enabled: process.env.MONITOR_DISABLED !== "1",
    otpFailuresWarn: num(process.env.MONITOR_OTP_FAIL_WARN, DEFAULT_MONITORING_POLICY.otpFailuresWarn),
    otpFailuresCritical: num(process.env.MONITOR_OTP_FAIL_CRITICAL, DEFAULT_MONITORING_POLICY.otpFailuresCritical),
    accountsPerSourceWarn: num(
      process.env.MONITOR_ACCOUNTS_SOURCE_WARN,
      DEFAULT_MONITORING_POLICY.accountsPerSourceWarn
    ),
    accountsPerSourceCritical: num(
      process.env.MONITOR_ACCOUNTS_SOURCE_CRITICAL,
      DEFAULT_MONITORING_POLICY.accountsPerSourceCritical
    ),
    impossibleChangeOps: num(process.env.MONITOR_IMPOSSIBLE_CHANGE_OPS, DEFAULT_MONITORING_POLICY.impossibleChangeOps),
    recoveryWarn: num(process.env.MONITOR_RECOVERY_WARN, DEFAULT_MONITORING_POLICY.recoveryWarn),
    recoveryCritical: num(process.env.MONITOR_RECOVERY_CRITICAL, DEFAULT_MONITORING_POLICY.recoveryCritical),
    sessionRevokeWarn: num(process.env.MONITOR_SESSION_REVOKE_WARN, DEFAULT_MONITORING_POLICY.sessionRevokeWarn),
    hotRetentionDays: num(process.env.MONITOR_HOT_RETENTION_DAYS, DEFAULT_MONITORING_POLICY.hotRetentionDays),
    auditRetentionDays: num(process.env.MONITOR_AUDIT_RETENTION_DAYS, DEFAULT_MONITORING_POLICY.auditRetentionDays),
    alertRetentionDays: num(process.env.MONITOR_ALERT_RETENTION_DAYS, DEFAULT_MONITORING_POLICY.alertRetentionDays),
  };
}
