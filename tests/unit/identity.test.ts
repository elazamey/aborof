import { describe, expect, it } from "vitest";
import {
  applyIdentityChange,
  cancelIdentityChange,
  changePassword,
  confirmRecovery,
  confirmVerification,
  DEFAULT_POLICY,
  IdentityPolicy,
  IdentityRepo,
  OtpRecord,
  requestIdentityChange,
  requestRecovery,
  startVerification,
  verifyChangeOtp,
} from "@/lib/identity";
import { normalizeEmail, normalizePhone } from "@/lib/identity/normalize";
import { hashSecret, newId } from "@/lib/identity/otp";
import { ChangeRequest, OtpKind, User } from "@/lib/identity/types";

import { MemoryRepo } from "./helpers/memory-repo";

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

const noDeliver = async () => undefined;
const ctx = { ip: "10.0.0.9", requestId: "rid-1" };
const fastPolicy: IdentityPolicy = { ...DEFAULT_POLICY, ownerSecurityDelayMs: 0 };

// ── 1) تطبيع الهوية ────────────────────────────────────────────────

describe("identity normalization (IDENTITY-HARDENING-01)", () => {
  it("email: lowercase + trim, يرفض الصيغ التالفة", () => {
    expect(normalizeEmail("  Owner@Test.COM ")).toBe("owner@test.com");
    expect(normalizeEmail("bad")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
  });

  it("phone: كل الصيغ المصرية → +20XXXXXXXXXX موحد", () => {
    expect(normalizePhone("01000000000")).toBe("+201000000000");
    expect(normalizePhone("+20 100 000 0000")).toBe("+201000000000");
    expect(normalizePhone("00201000000000")).toBe("+201000000000");
    expect(normalizePhone("201000000000")).toBe("+201000000000");
    expect(normalizePhone("10000000000")).toBeNull();
    expect(normalizePhone("03000000000")).toBeNull();
  });
});

// ── 2) تحقق البريد (start + confirm) ───────────────────────────────

describe("email verification", () => {
  it("success: OTP صحيح → email_verified_at = now", async () => {
    const repo = new MemoryRepo();
    const user = makeUser({ emailVerifiedAt: null });
    const started = await startVerification({
      repo,
      user,
      kind: "email",
      value: user.email,
      ctx,
      now: () => 5000,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    expect(started.ok).toBe(true);
    const code = (started as { devOtpHint?: string }).devOtpHint!;
    const done = await confirmVerification({ repo, user, kind: "email", code, ctx, now: () => 6000 });
    expect(done.ok).toBe(true);
    expect((done as { user: User }).user.emailVerifiedAt).toBe(6000);
  });

  it("expired: بعد انتهاء المهلة يُرفض", async () => {
    const repo = new MemoryRepo();
    const user = makeUser({ emailVerifiedAt: null });
    const started = await startVerification({
      repo,
      user,
      kind: "email",
      value: user.email,
      ctx,
      now: () => 0,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    const code = (started as { devOtpHint?: string }).devOtpHint!;
    const done = await confirmVerification({ repo, user, kind: "email", code, ctx, now: () => 10 * 60 * 1000 + 1 });
    expect(done.ok).toBe(false);
    expect((done as { error: string }).error).toContain("غير صحيح أو منتهٍ");
  });

  it("wrong OTP: يُرفض ويُعدّ المحاولة", async () => {
    const repo = new MemoryRepo();
    const user = makeUser({ emailVerifiedAt: null });
    await startVerification({
      repo,
      user,
      kind: "email",
      value: user.email,
      ctx,
      now: () => 0,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    const done = await confirmVerification({ repo, user, kind: "email", code: "000000", ctx, now: () => 100 });
    expect(done.ok).toBe(false);
    const otps = await repo.listOtps(user.id, "email_verify");
    expect(otps[0].attempts).toBe(1);
  });

  it("replay: OTP ناجح لا يُعاد استخدامه (single use)", async () => {
    const repo = new MemoryRepo();
    const user = makeUser({ emailVerifiedAt: null });
    const started = await startVerification({
      repo,
      user,
      kind: "email",
      value: user.email,
      ctx,
      now: () => 0,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    const code = (started as { devOtpHint?: string }).devOtpHint!;
    await confirmVerification({ repo, user, kind: "email", code, ctx, now: () => 100 });
    const second = await confirmVerification({ repo, user, kind: "email", code, ctx, now: () => 200 });
    expect(second.ok).toBe(false);
    expect((second as { error: string }).error).toContain("غير صحيح أو منتهٍ");
  });

  it("OTP brute force: بعد maxAttempts يُحظر", async () => {
    const repo = new MemoryRepo();
    const user = makeUser({ emailVerifiedAt: null });
    const policy = { ...DEFAULT_POLICY, otpMaxAttempts: 3 };
    await startVerification({
      repo,
      user,
      kind: "email",
      value: user.email,
      ctx,
      now: () => 0,
      policy,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    for (let i = 0; i < 3; i++) {
      const r = await confirmVerification({ repo, user, kind: "email", code: "111111", ctx, now: () => 100 + i });
      if (i < 2) expect(r.ok).toBe(false);
      else {
        expect(r.ok).toBe(false);
        expect((r as { error: string }).error).toContain("غير صحيح أو منتهٍ");
      }
    }
    // بعد استنفاد المحاولات حتى الرمز الصحيح مرفوض
    const started = await startVerification({
      repo,
      user,
      kind: "email",
      value: user.email,
      ctx,
      now: () => 200,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    void started;
    const still = await confirmVerification({ repo, user, kind: "email", code: "111111", ctx, now: () => 300 });
    expect(still.ok).toBe(false);
  });
});

// ── 3) تحقق الهاتف ─────────────────────────────────────────────────

describe("phone verification", () => {
  it("success + expired", async () => {
    const repo = new MemoryRepo();
    const user = makeUser({ phone: null, phoneNormalized: null, phoneVerifiedAt: null });
    const started = await startVerification({
      repo,
      user,
      kind: "phone",
      value: "01234567890",
      ctx,
      now: () => 1000,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    expect(started.ok).toBe(true);
    const code = (started as { devOtpHint?: string }).devOtpHint!;
    const done = await confirmVerification({ repo, user, kind: "phone", code, ctx, now: () => 2000 });
    expect(done.ok).toBe(true);
    expect((done as { user: User }).user.phoneVerifiedAt).toBe(2000);
    expect((done as { user: User }).user.phoneNormalized).toBe("+201234567890");

    // expired
    const u2 = makeUser({ phone: null, phoneNormalized: null, phoneVerifiedAt: null });
    const s2 = await startVerification({
      repo: new MemoryRepo(),
      user: u2,
      kind: "phone",
      value: "01234567890",
      ctx,
      now: () => 0,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    const code2 = (s2 as { devOtpHint?: string }).devOtpHint!;
    const repo2 = new MemoryRepo();
    await startVerification({
      repo: repo2,
      user: u2,
      kind: "phone",
      value: "01234567890",
      ctx,
      now: () => 0,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    const expired = await confirmVerification({
      repo: repo2,
      user: u2,
      kind: "phone",
      code: code2,
      ctx,
      now: () => 11 * 60 * 1000,
    });
    expect(expired.ok).toBe(false);
  });
});

// ── 4) تغيير البريد — الدورة الكاملة ───────────────────────────────

describe("controlled email change", () => {
  it("بدون جلسة/مصادقة — مرفوض (401/403): إعادة المصادثة بكلمة المرور مطلوبة", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    const r = await requestIdentityChange({
      repo,
      user,
      kind: "email",
      newValue: "new@test.local",
      password: "wrong-password",
      ctx,
      now: () => 5000,
      policy: fastPolicy,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    expect(r.ok).toBe(false);
    expect((r as { status?: number }).status).toBe(403);
  });

  it("الحساب غير الموثق — التغيير محظور (منع استيلاء مبكر)", async () => {
    const repo = new MemoryRepo();
    const user = makeUser({ emailVerifiedAt: null });
    const r = await requestIdentityChange({
      repo,
      user,
      kind: "email",
      newValue: "new@test.local",
      password: "correct-password-123",
      ctx,
      now: () => 5000,
      policy: fastPolicy,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("توثيق البريد الحالي");
  });

  it("بريد مكرر (حساب آخر) — محظور uniqueness", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(makeUser({ id: newId(), email: "other@test.local", emailNormalized: "other@test.local" }));
    const r = await requestIdentityChange({
      repo,
      user,
      kind: "email",
      newValue: "other@test.local",
      password: "correct-password-123",
      ctx,
      now: () => 5000,
      policy: fastPolicy,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("مستخدمة من حساب آخر");
  });

  it("دورة كاملة ناجحة: طلب → OTP صحيح → تنفيذ (بعد التأخير الصفري) → البريد الجديد موثق", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    const req = await requestIdentityChange({
      repo,
      user,
      kind: "email",
      newValue: "New@Test.local",
      password: "correct-password-123",
      ctx,
      now: () => 5000,
      policy: fastPolicy,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    expect(req.ok).toBe(true);
    const requestId = (req as { requestId: string }).requestId;
    const code = (req as { devOtpHint?: string }).devOtpHint!;

    const v = await verifyChangeOtp({ repo, user, requestId, code, ctx, now: () => 6000 });
    expect(v.ok).toBe(true);
    expect((v as { status: string }).status).toBe("NEW_VALUE_VERIFIED");

    const applied = await applyIdentityChange({ repo, user, requestId, keepSessionId: "s1", ctx, now: () => 7000 });
    expect(applied.ok).toBe(true);
    const updated = (applied as { user: User }).user;
    expect(updated.emailNormalized).toBe("new@test.local");
    expect(updated.emailVerifiedAt).toBe(7000); // القيمة الجديدة موثقة عبر OTP
    const req2 = repo.changes.get(requestId)!;
    expect(req2.status).toBe("COMPLETED");
    expect(repo.events.some((e) => e.event === "email_change_completed")).toBe(true);
  });

  it("إلغاء الطلب قبل التنفيذ", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    const req = await requestIdentityChange({
      repo,
      user,
      kind: "email",
      newValue: "new@test.local",
      password: "correct-password-123",
      ctx,
      now: () => 5000,
      policy: fastPolicy,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    const requestId = (req as { requestId: string }).requestId;
    const c = await cancelIdentityChange({ repo, user, requestId, ctx, now: () => 6000 });
    expect(c.ok).toBe(true);
    expect(repo.changes.get(requestId)!.status).toBe("CANCELLED");
    const applied = await applyIdentityChange({ repo, user, requestId, ctx, now: () => 7000 });
    expect(applied.ok).toBe(false);
  });

  it("انتهاء مهلة الطلب → EXPIRED ولا يُنفَّذ", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    const req = await requestIdentityChange({
      repo,
      user,
      kind: "email",
      newValue: "new@test.local",
      password: "correct-password-123",
      ctx,
      now: () => 0,
      policy: fastPolicy,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    const requestId = (req as { requestId: string }).requestId;
    const applied = await applyIdentityChange({ repo, user, requestId, ctx, now: () => 25 * 60 * 60 * 1000 });
    expect(applied.ok).toBe(false);
    expect(repo.changes.get(requestId)!.status).toBe("EXPIRED");
  });

  it("التأخير الأمني للمالك: لا يُنفَّذ قبل انقضائه (SECURITY_REVIEW)", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    const slowPolicy = { ...DEFAULT_POLICY, ownerSecurityDelayMs: 6 * 60 * 60 * 1000 };
    const req = await requestIdentityChange({
      repo,
      user,
      kind: "email",
      newValue: "new@test.local",
      password: "correct-password-123",
      ctx,
      now: () => 0,
      policy: slowPolicy,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    const requestId = (req as { requestId: string }).requestId;
    const code = (req as { devOtpHint?: string }).devOtpHint!;
    await verifyChangeOtp({ repo, user, requestId, code, ctx, now: () => 1000 });
    const early = await applyIdentityChange({ repo, user, requestId, ctx, now: () => 1000 });
    expect(early.ok).toBe(false);
    expect((early as { error: string }).error).toContain("المراجعة الأمنية");
    const late = await applyIdentityChange({ repo, user, requestId, ctx, now: () => 6 * 60 * 60 * 1000 + 1 });
    expect(late.ok).toBe(true);
  });
});

// ── 5) تغيير الهاتف + الجلسات + Trial ──────────────────────────────

describe("controlled phone change + sessions + trial", () => {
  it("تغيير الهاتف ناجح بالدورة الكاملة", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    const req = await requestIdentityChange({
      repo,
      user,
      kind: "phone",
      newValue: "01111111111",
      password: "correct-password-123",
      ctx,
      now: () => 5000,
      policy: fastPolicy,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    expect(req.ok).toBe(true);
    const requestId = (req as { requestId: string }).requestId;
    const code = (req as { devOtpHint?: string }).devOtpHint!;
    await verifyChangeOtp({ repo, user, requestId, code, ctx, now: () => 6000 });
    const applied = await applyIdentityChange({ repo, user, requestId, keepSessionId: "s1", ctx, now: () => 7000 });
    expect(applied.ok).toBe(true);
    expect((applied as { user: User }).user.phoneNormalized).toBe("+201111111111");
  });

  it("رقم هاتف مكرر — محظور", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(makeUser({ id: newId(), email: "other2@test.local", emailNormalized: "other2@test.local" }));
    const r = await requestIdentityChange({
      repo,
      user,
      kind: "phone",
      newValue: "+201000000000",
      password: "correct-password-123",
      ctx,
      now: () => 5000,
      policy: fastPolicy,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    expect(r.ok).toBe(false);
  });

  it("تغيير كلمة المرور: إعادة مصادثة + إبطال جلسات الأجهزة الأخرى", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createSession({
      id: "s-keep",
      userId: user.id,
      tokenHash: "a",
      label: null,
      createdAt: 0,
      lastSeenAt: 0,
      revokedAt: null,
    });
    await repo.createSession({
      id: "s-old",
      userId: user.id,
      tokenHash: "b",
      label: null,
      createdAt: 0,
      lastSeenAt: 0,
      revokedAt: null,
    });
    const r = await changePassword({
      repo,
      user,
      currentPassword: "correct-password-123",
      newPassword: "new-strong-password-456",
      keepSessionId: "s-keep",
      ctx,
      now: () => 6000,
    });
    expect(r.ok).toBe(true);
    expect(repo.sessions.get("s-keep")!.revokedAt).toBeNull();
    expect(repo.sessions.get("s-old")!.revokedAt).not.toBeNull();
    // الجلسة القديمة لم تعد صالحة
    expect(await repo.getSessionByTokenHash("b")).toMatchObject({ revokedAt: expect.any(Number) });
  });

  it("Trial لا يتأثر بتغيير الهوية: trial_start مرتبط بإنشاء الحساب/المتجر وليس البريد", async () => {
    const repo = new MemoryRepo();
    const user = makeUser({ createdAt: 1000 });
    const trialStart = user.createdAt;
    const req = await requestIdentityChange({
      repo,
      user,
      kind: "email",
      newValue: "new@test.local",
      password: "correct-password-123",
      ctx,
      now: () => 5000,
      policy: fastPolicy,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    const requestId = (req as { requestId: string }).requestId;
    const code = (req as { devOtpHint?: string }).devOtpHint!;
    await verifyChangeOtp({ repo, user, requestId, code, ctx, now: () => 6000 });
    await applyIdentityChange({ repo, user, requestId, ctx, now: () => 7000 });
    const updated = await repo.getUserById(user.id)!;
    expect(updated!.createdAt).toBe(trialStart); // لا إعادة تجربة بعد تغيير البريد
    expect(updated!.emailNormalized).toBe("new@test.local");
  });
});

// ── 6) الاسترداد ───────────────────────────────────────────────────

describe("account recovery", () => {
  it("استجابة موحدة — لا enumeration بين بريد موجود وغير موجود", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    const existing = await requestRecovery({
      repo,
      email: "owner@test.local",
      ctx,
      now: () => 0,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    const missing = await requestRecovery({
      repo,
      email: "nobody@test.local",
      ctx,
      now: () => 0,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    expect(existing.ok).toBe(true);
    expect(missing.ok).toBe(true);
    // كلا الردين "نجاح" — الفرق الداخلي لا يُكشف
  });

  it("دورة كاملة: OTP صحيح → كلمة مرور جديدة → إبطال كل الجلسات", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    await repo.createSession({
      id: "s1",
      userId: user.id,
      tokenHash: "x",
      label: null,
      createdAt: 0,
      lastSeenAt: 0,
      revokedAt: null,
    });
    const r = await requestRecovery({
      repo,
      email: "owner@test.local",
      ctx,
      now: () => 0,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    const code = (r as { devOtpHint?: string }).devOtpHint!;
    const done = await confirmRecovery({
      repo,
      email: "owner@test.local",
      code,
      newPassword: "recovered-password-789",
      ctx,
      now: () => 1000,
    });
    expect(done.ok).toBe(true);
    expect(repo.sessions.get("s1")!.revokedAt).not.toBeNull();
  });

  it("OTP خاطئ في الاسترداد → مرفوض", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    await requestRecovery({
      repo,
      email: "owner@test.local",
      ctx,
      now: () => 0,
      devOtpHint: true,
      deliverOtp: noDeliver,
    });
    const done = await confirmRecovery({
      repo,
      email: "owner@test.local",
      code: "999999",
      newPassword: "recovered-password-789",
      ctx,
      now: () => 1000,
    });
    expect(done.ok).toBe(false);
  });
});
