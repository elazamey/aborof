import { describe, expect, it, afterEach } from "vitest";
import {
  applyIdentityChange,
  cancelIdentityChange,
  changePassword,
  confirmRecovery,
  confirmVerification,
  startVerification,
  requestRecovery,
  verifyChangeOtp,
  requestIdentityChange,
  hashSecret,
  newId,
  DEFAULT_POLICY,
} from "@/lib/identity";
import { normalizeEmail } from "@/lib/identity/normalize";
import { User } from "@/lib/identity/types";
import { MemoryRepo } from "./helpers/memory-repo";
import {
  computeMetrics,
  DEFAULT_MONITORING_POLICY,
  EV,
  evaluateAlerts,
  monitoringPolicyFromEnv,
  pruneSecurityData,
  recordSecurityEvent,
  sanitizeMetadata,
} from "@/lib/monitoring";

// ── إعداد مشترك ───────────────────────────────────────────────────
const T0 = 1_800_000_000_000; // زمن ثابت حتمي (2027-01-11 تقريبًا)
const now = () => T0;

function makeUser(over: Partial<User> = {}): User {
  const email = normalizeEmail(over.email ?? "owner@test.local")!;
  return {
    id: newId(),
    email,
    emailNormalized: email,
    emailVerifiedAt: 1000,
    phone: "+201000000000",
    phoneNormalized: "+201000000000",
    phoneVerifiedAt: 1000,
    passwordHash: hashSecret("correct-password-123"),
    role: "owner",
    tenantId: null,
    createdAt: 0,
    updatedAt: 0,
    lastLoginAt: 1000,
    ...over,
  };
}

const ctx = { ip: "10.0.0.9", requestId: "req-123" };

/** سياسة سريعة للاختبار: تأخير أمني صفري (لا ننتظر 6 ساعات). */
const fastPolicy = { ...DEFAULT_POLICY, ownerSecurityDelayMs: 0, regularSecurityDelayMs: 0 };

/** تسجيل حدث بزمن الاختبار الثابت (كل الأحداث داخل نوافذ الكشف). */
function rec(repo: MemoryRepo, ev: Parameters<typeof recordSecurityEvent>[1], at = T0) {
  return recordSecurityEvent(repo, ev, { now: () => at });
}

afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("MONITOR_")) delete process.env[k];
});

// ── 1) عدادات النجاح/الفشل + معدل النجاح ─────────────────────────
describe("metrics", () => {
  it("increments on verification success (email) and computes success rate", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    await rec(repo, { event: EV.EMAIL_VERIFICATION_REQUESTED, userId: user.id, ip: ctx.ip, requestId: ctx.requestId });
    await rec(repo, { event: EV.EMAIL_VERIFICATION_SUCCEEDED, userId: user.id, ip: ctx.ip, requestId: ctx.requestId });

    const m = await computeMetrics(repo, DEFAULT_MONITORING_POLICY, 24 * 3600 * 1000, T0);
    expect(m.email.requested).toBe(1);
    expect(m.email.succeeded).toBe(1);
    expect(m.email.failed).toBe(0);
    expect(m.email.successRate).toBe(100);
    expect(m.verification.successRate).toBe(100);
    expect(m.verification.failureRate).toBe(0);
  });

  it("increments on verification failure and lowers success rate", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    await rec(repo, { event: EV.EMAIL_VERIFICATION_SUCCEEDED, userId: user.id, ip: ctx.ip });
    await rec(repo, { event: EV.EMAIL_VERIFICATION_SUCCEEDED, userId: user.id, ip: ctx.ip });
    await rec(repo, { event: EV.EMAIL_VERIFICATION_FAILED, userId: user.id, ip: ctx.ip });
    const m = await computeMetrics(repo, DEFAULT_MONITORING_POLICY, 24 * 3600 * 1000, T0);
    expect(m.email.succeeded).toBe(2);
    expect(m.email.failed).toBe(1);
    expect(m.email.successRate).toBe(66.7); // 2/3
  });

  it("counts phone verification events separately", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    await rec(repo, { event: EV.PHONE_VERIFICATION_REQUESTED, userId: user.id, ip: ctx.ip });
    await rec(repo, { event: EV.PHONE_VERIFICATION_FAILED, userId: user.id, ip: ctx.ip });
    const m = await computeMetrics(repo, DEFAULT_MONITORING_POLICY, 24 * 3600 * 1000, T0);
    expect(m.phone.requested).toBe(1);
    expect(m.phone.failed).toBe(1);
    expect(m.phone.successRate).toBe(0);
  });

  it("counts OTP attempts (tokens), rejections and rate-limit hits", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    await repo.createOtp({
      id: newId(),
      userId: user.id,
      kind: "email_verify",
      channel: "email",
      tokenHash: hashSecret("123456"),
      expiresAt: T0 + 600000,
      maxAttempts: 5,
      attempts: 3,
      consumedAt: null,
      createdAt: T0 - 1000,
      requestId: null,
      target: user.emailNormalized,
    });
    await rec(repo, { event: EV.OTP_REJECTED, userId: user.id, ip: ctx.ip });
    await rec(repo, { event: EV.OTP_RATE_LIMITED, userId: user.id, ip: ctx.ip });
    const m = await computeMetrics(repo, DEFAULT_MONITORING_POLICY, 24 * 3600 * 1000, T0);
    expect(m.otp.attempts).toBe(3);
    expect(m.otp.rejections).toBe(1);
    expect(m.otp.rateLimitHits).toBe(1);
  });

  it("counts identity-change attempts/failures, recovery, session revocations, suspicious events", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    await rec(repo, { event: EV.EMAIL_CHANGE_REQUESTED, userId: user.id, ip: ctx.ip });
    await rec(repo, { event: EV.PHONE_CHANGE_REQUESTED, userId: user.id, ip: ctx.ip });
    await rec(repo, { event: EV.PASSWORD_CHANGE, userId: user.id, ip: ctx.ip });
    await rec(repo, { event: EV.EMAIL_CHANGE_EXPIRED, userId: user.id, ip: ctx.ip });
    await rec(repo, { event: EV.EMAIL_CHANGE_CANCELLED, userId: user.id, ip: ctx.ip });
    await rec(repo, { event: EV.RECOVERY_REQUESTED, userId: user.id, ip: ctx.ip });
    await rec(repo, { event: EV.RECOVERY_FAILED, userId: user.id, ip: ctx.ip });
    await rec(repo, { event: EV.SESSION_REVOKED, userId: user.id, ip: ctx.ip });
    await rec(repo, { event: EV.SUSPICIOUS_IDENTITY_ACTIVITY, userId: user.id, ip: ctx.ip });
    const m = await computeMetrics(repo, DEFAULT_MONITORING_POLICY, 24 * 3600 * 1000, T0);
    expect(m.identityChanges.attempts).toBe(3);
    expect(m.identityChanges.failures).toBe(2);
    expect(m.recovery.attempts).toBe(1);
    expect(m.recovery.failures).toBe(1);
    expect(m.sessionRevocations).toBe(1);
    expect(m.suspiciousEvents).toBe(1);
  });
});

// ── 2) الأحداث من التدفقات الحقيقية (core) ────────────────────────
describe("core flow event emission", () => {
  it("email change request → verify → complete records all events", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    const r = await requestIdentityChange({
      repo,
      user,
      kind: "email",
      newValue: "new@test.local",
      password: "correct-password-123",
      ctx,
      now,
      policy: fastPolicy,
      devOtpHint: true,
      deliverOtp: async () => {},
    });
    if (!r.ok) throw new Error("request failed");
    const v = await verifyChangeOtp({ repo, user, requestId: r.requestId, code: r.devOtpHint!, ctx, now });
    if (!v.ok) throw new Error("verify failed");
    const a = await applyIdentityChange({ repo, user, requestId: r.requestId, keepSessionId: "s1", ctx, now });
    if (!a.ok) throw new Error("apply failed");

    const names = repo.events.map((e) => e.event);
    expect(names).toContain(EV.EMAIL_CHANGE_REQUESTED);
    expect(names).toContain(EV.EMAIL_CHANGE_VERIFIED);
    expect(names).toContain(EV.EMAIL_CHANGE_COMPLETED);
    expect(names).toContain(EV.SESSION_REVOKED);
  });

  it("cancel and expiry record events", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    const r = await requestIdentityChange({
      repo,
      user,
      kind: "phone",
      newValue: "+201099999999",
      password: "correct-password-123",
      ctx,
      now,
      policy: fastPolicy,
      devOtpHint: true,
      deliverOtp: async () => {},
    });
    if (!r.ok) throw new Error("request failed");
    const c = await cancelIdentityChange({ repo, user, requestId: r.requestId, ctx, now });
    if (!c.ok) throw new Error("cancel failed");
    expect(repo.events.some((e) => e.event === EV.PHONE_CHANGE_CANCELLED)).toBe(true);

    // انتهاء المهلة عند التنفيذ
    const r2 = await requestIdentityChange({
      repo,
      user,
      kind: "email",
      newValue: "other@test.local",
      password: "correct-password-123",
      ctx,
      now: () => T0 + 1000,
      policy: fastPolicy,
      devOtpHint: true,
      deliverOtp: async () => {},
    });
    if (!r2.ok) throw new Error("request failed");
    const req = await repo.getChangeRequestById(r2.requestId);
    req!.expiresAt = T0 - 1;
    await repo.updateChangeRequest(req!);
    const a = await applyIdentityChange({ repo, user, requestId: r2.requestId, ctx, now });
    expect(a.ok).toBe(false);
    expect(repo.events.some((e) => e.event === EV.EMAIL_CHANGE_EXPIRED)).toBe(true);
  });

  it("password change and recovery record events + session revocation", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    await changePassword({
      repo,
      user,
      currentPassword: "correct-password-123",
      newPassword: "new-password-456",
      keepSessionId: "s1",
      ctx,
      now,
      policy: fastPolicy,
    });
    expect(repo.events.some((e) => e.event === EV.PASSWORD_CHANGE)).toBe(true);
    expect(repo.events.some((e) => e.event === EV.SESSION_REVOKED)).toBe(true);

    await requestRecovery({
      repo,
      email: user.email,
      ctx,
      now,
      policy: fastPolicy,
      devOtpHint: true,
      deliverOtp: async () => {},
    });
    expect(repo.events.some((e) => e.event === EV.RECOVERY_REQUESTED)).toBe(true);

    const c = await confirmRecovery({
      repo,
      email: user.email,
      code: "000000",
      newPassword: "valid-pass-123",
      ctx,
      now,
      policy: fastPolicy,
    });
    expect(c.ok).toBe(false); // رمز خاطئ
    expect(repo.events.some((e) => e.event === EV.RECOVERY_FAILED)).toBe(true);
  });

  it("verification success/failure events from the real flow", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    const s = await startVerification({
      repo,
      user,
      kind: "email",
      value: user.email,
      ctx,
      now,
      policy: fastPolicy,
      devOtpHint: true,
      deliverOtp: async () => {},
    });
    if (!s.ok) throw new Error("start failed");
    const f = await confirmVerification({ repo, user, kind: "email", code: "000000", ctx, now });
    expect(f.ok).toBe(false);
    const ok = await confirmVerification({ repo, user, kind: "email", code: s.devOtpHint!, ctx, now });
    if (!ok.ok) throw new Error("confirm failed");
    const names = repo.events.map((e) => e.event);
    expect(names).toContain(EV.EMAIL_VERIFICATION_REQUESTED);
    expect(names).toContain(EV.EMAIL_VERIFICATION_FAILED);
    expect(names).toContain(EV.EMAIL_VERIFICATION_SUCCEEDED);
  });
});

// ── 3) الكواشف والتنبيهات ─────────────────────────────────────────
describe("abuse detectors & alerts", () => {
  it("OTP failure spike triggers WARNING at threshold (5), CRITICAL at 50, dedupe per bucket", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    for (let i = 0; i < 5; i++)
      await rec(repo, {
        event: EV.EMAIL_VERIFICATION_FAILED,
        userId: user.id,
        ip: ctx.ip,
        metadata: { reason: "wrong_code" },
      });
    const res = await evaluateAlerts(repo, DEFAULT_MONITORING_POLICY, T0);
    const warn = res.created.find((a) => a.type === "otp_failure_spike");
    expect(warn).toBeDefined();
    expect(warn!.level).toBe("WARNING");
    expect(warn!.userId).toBe(user.id);

    // نفس النافذة → نفس alert_key → لا تكرار
    const resAgain = await evaluateAlerts(repo, DEFAULT_MONITORING_POLICY, T0);
    expect(resAgain.created.filter((a) => a.type === "otp_failure_spike")).toHaveLength(0);

    // نافذة جديدة: 50 فشل إضافية → CRITICAL
    const T1 = T0 + 16 * 60 * 1000;
    for (let i = 0; i < 50; i++)
      await rec(repo, { event: EV.EMAIL_VERIFICATION_FAILED, userId: user.id, ip: ctx.ip }, T1);
    const res2 = await evaluateAlerts(repo, DEFAULT_MONITORING_POLICY, T1);
    const crit = res2.created.find((a) => a.type === "otp_failure_spike");
    expect(crit).toBeDefined();
    expect(crit!.level).toBe("CRITICAL");
    expect(JSON.parse(crit!.metadata).count).toBe(50);
  });

  it("many accounts from one source → CRITICAL + suspicious event (IP hashed)", async () => {
    const repo = new MemoryRepo();
    const policy = { ...DEFAULT_MONITORING_POLICY, accountsPerSourceWarn: 2, accountsPerSourceCritical: 4 };
    const users = Array.from({ length: 4 }, () => makeUser({ email: `${newId()}@test.local` }));
    for (const u of users) await repo.createUser(u);
    for (const u of users) await rec(repo, { event: EV.PHONE_VERIFICATION_FAILED, userId: u.id, ip: "203.0.113.7" });
    const res = await evaluateAlerts(repo, policy, T0);
    const alert = res.created.find((a) => a.type === "many_accounts_from_source");
    expect(alert).toBeDefined();
    expect(alert!.level).toBe("CRITICAL");
    expect(alert!.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(repo.events.some((e) => e.event === EV.SUSPICIOUS_IDENTITY_ACTIVITY)).toBe(true);
  });

  it("impossible identity change (3+ critical ops in bucket) → alert + risk score", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    const policy = { ...DEFAULT_MONITORING_POLICY, impossibleChangeBucketMs: 120_000 };
    const t = T0 - 30_000; // داخل نفس الحاوية الزمنية (دقيقتان)
    await rec(repo, { event: EV.EMAIL_CHANGE_COMPLETED, userId: user.id, ip: ctx.ip }, t);
    await rec(repo, { event: EV.PHONE_CHANGE_COMPLETED, userId: user.id, ip: ctx.ip }, t + 10_000);
    await rec(repo, { event: EV.PASSWORD_CHANGE, userId: user.id, ip: ctx.ip }, t + 20_000);
    await rec(repo, { event: EV.SESSION_REVOKED, userId: user.id, ip: ctx.ip }, t + 30_000);

    const res = await evaluateAlerts(repo, policy, T0);
    const alert = res.created.find((a) => a.type === "impossible_identity_change");
    expect(alert).toBeDefined();
    expect(alert!.level).toBe("CRITICAL"); // 4 عمليات
    const meta = JSON.parse(alert!.metadata);
    expect(meta.riskScore).toBe(40);
    expect(meta.ops).toContain("email_change");
    expect(repo.events.some((e) => e.event === EV.SUSPICIOUS_IDENTITY_ACTIVITY)).toBe(true);
  });

  it("recovery abuse triggers WARNING per account", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    const policy = { ...DEFAULT_MONITORING_POLICY, recoveryWarn: 3, recoveryCritical: 6 };
    for (let i = 0; i < 3; i++) await rec(repo, { event: EV.RECOVERY_REQUESTED, userId: user.id, ip: ctx.ip });
    const res = await evaluateAlerts(repo, policy, T0);
    const alert = res.created.find((a) => a.type === "recovery_abuse");
    expect(alert).toBeDefined();
    expect(alert!.level).toBe("WARNING");
  });

  it("session revoke spike triggers WARNING", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    const policy = { ...DEFAULT_MONITORING_POLICY, sessionRevokeWarn: 3 };
    for (let i = 0; i < 3; i++) await rec(repo, { event: EV.SESSION_REVOKED, userId: user.id, ip: ctx.ip });
    const res = await evaluateAlerts(repo, policy, T0);
    expect(res.created.some((a) => a.type === "session_revoke_spike" && a.level === "WARNING")).toBe(true);
  });

  it("alert thresholds are configurable via env (no hard-coded route values)", async () => {
    process.env.MONITOR_OTP_FAIL_WARN = "2";
    process.env.MONITOR_OTP_FAIL_CRITICAL = "7";
    process.env.MONITOR_ACCOUNTS_SOURCE_CRITICAL = "12";
    process.env.MONITOR_IMPOSSIBLE_CHANGE_OPS = "2";
    const p = monitoringPolicyFromEnv();
    expect(p.otpFailuresWarn).toBe(2);
    expect(p.otpFailuresCritical).toBe(7);
    expect(p.accountsPerSourceCritical).toBe(12);
    expect(p.impossibleChangeOps).toBe(2);

    // عتبة 2 تعني تنبيهًا بعد محاولتين خاطئتين فقط
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    for (let i = 0; i < 2; i++) await rec(repo, { event: EV.EMAIL_VERIFICATION_FAILED, userId: user.id, ip: ctx.ip });
    const res = await evaluateAlerts(repo, p, T0);
    expect(res.created.some((a) => a.type === "otp_failure_spike" && a.level === "WARNING")).toBe(true);
  });
});

// ── 4) الخصوصية والارتباط ─────────────────────────────────────────
describe("redaction & correlation", () => {
  it("sensitive values are absent from event payloads (no OTP/password/tokens)", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    await rec(repo, {
      event: EV.EMAIL_VERIFICATION_FAILED,
      userId: user.id,
      ip: ctx.ip,
      metadata: {
        otp: "123456",
        password: "super-secret",
        token: "abc.def.ghi",
        secret: "hunter2",
        authorization: "Bearer xyz",
        code: "987654",
        ok: "يُحتفظ به",
      },
    });
    const parsed = JSON.parse(repo.events[0].metadata);
    expect(parsed.otp).toBeUndefined();
    expect(parsed.password).toBeUndefined();
    expect(parsed.token).toBeUndefined();
    expect(parsed.secret).toBeUndefined();
    expect(parsed.authorization).toBeUndefined();
    expect(parsed.code).toBeUndefined();
    expect(parsed.ok).toBe("يُحتفظ به");
    const raw = JSON.stringify(repo.events[0]);
    expect(raw).not.toContain("123456");
    expect(raw).not.toContain("super-secret");
  });

  it("sanitizeMetadata strips nested secrets too", () => {
    const out = sanitizeMetadata({ a: 1, nested: { otpCode: "111111", fine: "x" } });
    expect(JSON.stringify(out)).not.toContain("111111");
    expect((out.nested as Record<string, unknown>).fine).toBe("x");
  });

  it("event correlation preserves request_id", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    await rec(repo, { event: EV.EMAIL_VERIFICATION_FAILED, userId: user.id, ip: ctx.ip, requestId: "req-correl-42" });
    await rec(repo, {
      event: EV.EMAIL_VERIFICATION_SUCCEEDED,
      userId: user.id,
      ip: ctx.ip,
      requestId: "req-correl-42",
    });
    const withRid = repo.events.filter((e) => e.requestId === "req-correl-42");
    expect(withRid).toHaveLength(2);
    expect(withRid.every((e) => e.userId === user.id && e.ip === ctx.ip)).toBe(true);
  });

  it("retention/prune removes events and alerts older than policy", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    await rec(repo, { event: EV.EMAIL_VERIFICATION_FAILED, userId: user.id, ip: ctx.ip }, T0 - 400 * 24 * 3600 * 1000);
    await rec(repo, { event: EV.EMAIL_VERIFICATION_SUCCEEDED, userId: user.id, ip: ctx.ip }, T0);
    const policy = { ...DEFAULT_MONITORING_POLICY, auditRetentionDays: 365 };
    await pruneSecurityData(repo, policy, T0);
    expect(repo.events).toHaveLength(1);
    expect(repo.events[0].event).toBe(EV.EMAIL_VERIFICATION_SUCCEEDED);
  });
});

// ── 5) عزل الفشل (fail-open) ──────────────────────────────────────
describe("monitoring failure isolation", () => {
  /** مستودع يُفشل عمليات المراقبة فقط (الأحداث/التنبيهات/الاستعلامات). */
  function failingMonitoringRepo(fail: "events" | "detectors" | "all"): MemoryRepo {
    const base = new MemoryRepo();
    const failProps = new Set<string>();
    if (fail === "events" || fail === "all") failProps.add("createSecurityEvent");
    if (fail === "detectors" || fail === "all") failProps.add("listSecurityEventsSince");
    failProps.add("createAlert");
    failProps.add("listAlerts");
    return new Proxy(base, {
      get(target, prop, receiver) {
        if (failProps.has(String(prop))) {
          return async () => {
            throw new Error("monitoring DB unavailable");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as MemoryRepo;
  }

  it("metric failure does not break authentication/verification flows", async () => {
    const repo = failingMonitoringRepo("all");
    const user = makeUser();
    await repo.createUser(user);

    const s = await startVerification({
      repo,
      user,
      kind: "email",
      value: user.email,
      ctx,
      now,
      policy: DEFAULT_POLICY,
      devOtpHint: true,
      deliverOtp: async () => {},
    });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const ok = await confirmVerification({ repo, user, kind: "email", code: s.devOtpHint!, ctx, now });
    expect(ok.ok).toBe(true);
  });

  it("recordSecurityEvent never throws — returns degraded instead", async () => {
    const repo = failingMonitoringRepo("events");
    const user = makeUser();
    await repo.createUser(user);
    const res = await recordSecurityEvent(repo, { event: EV.PASSWORD_CHANGE, userId: user.id, ip: ctx.ip }, { now });
    expect(res).toEqual({ ok: false, degraded: true });
  });

  it("MONITOR_DISABLED=1 degrades monitoring without affecting flows", async () => {
    process.env.MONITOR_DISABLED = "1";
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    const s = await startVerification({
      repo,
      user,
      kind: "email",
      value: user.email,
      ctx,
      now,
      policy: fastPolicy,
      devOtpHint: true,
      deliverOtp: async () => {},
    });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const ok = await confirmVerification({ repo, user, kind: "email", code: s.devOtpHint!, ctx, now });
    expect(ok.ok).toBe(true);
    expect(repo.events).toHaveLength(0); // لا تسجيل في الوضع المعطّل
    expect(monitoringPolicyFromEnv().enabled).toBe(false);
  });

  it("inline detection failure is swallowed (fail-open)", async () => {
    const repo = failingMonitoringRepo("detectors");
    const user = makeUser();
    await repo.createUser(user);
    const res = await recordSecurityEvent(
      repo,
      { event: EV.EMAIL_VERIFICATION_FAILED, userId: user.id, ip: ctx.ip },
      { now, detect: true }
    );
    expect(res).toEqual({ ok: true }); // التسجيل نجح والكشف فشل بهدوء
  });
});
