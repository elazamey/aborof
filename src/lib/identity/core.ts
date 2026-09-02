import {
  ChangeRequest,
  ChangeStatus,
  DEFAULT_POLICY,
  IdentityPolicy,
  IdentityRepo,
  OtpKind,
  OtpRecord,
  SessionRecord,
  User,
} from "./types";
import { normalizeEmail, normalizePhone, sha256Hex } from "./normalize";
import { EV } from "../monitoring/types";
import { recordSecurityEvent } from "../monitoring/events";
import { Clock, checkOtp, generateOtp, hashSecret, hashToken, newId, verifySecret } from "./otp";

/**
 * تدفقات الهوية — كلها دوال نقية على مستودع محقون (اختبارات حتمية بدون DB).
 * المبادئ: لا تغيير مباشر للهوية؛ طلب تغيير → تحقق → (تأخير أمني) → تنفيذ،
 * مع إعادة مصادقة، إشعار، تدقيق، وإلغاء قبل التنفيذ.
 */

export type Ctx = { ip: string | null; requestId: string | null };

async function audit(repo: IdentityRepo, userId: string, event: string, meta: Record<string, unknown>, ctx: Ctx) {
  // Fail-open: فشل تسجيل/كشف أحداث المراقبة لا يكسر تدفقات الهوية أبدًا.
  await recordSecurityEvent(
    repo,
    { event, userId, ip: ctx.ip, requestId: ctx.requestId, metadata: meta },
    { detect: true }
  ).catch(() => undefined);
}

export function hashValue(normalized: string): string {
  return sha256Hex(normalized);
}

export function pendingDisplayStatus(c: ChangeRequest, now: number): ChangeStatus {
  if (c.status === "COMPLETED" || c.status === "EXPIRED" || c.status === "CANCELLED") return c.status;
  if (now > c.expiresAt) return "EXPIRED";
  if (c.status === "CHANGE_REQUESTED") return "CHANGE_REQUESTED";
  if (c.securityDelayUntil && now < c.securityDelayUntil) return "SECURITY_REVIEW";
  return "NEW_VALUE_VERIFIED";
}

// ───────────────────────── طلب تغيير الهوية ─────────────────────────

export type RequestChangeResult =
  | { ok: true; requestId: string; status: ChangeStatus; channel: "email" | "phone"; devOtpHint?: string }
  | { ok: false; error: string; status?: number };

export async function requestIdentityChange(args: {
  repo: IdentityRepo;
  user: User;
  kind: "email" | "phone";
  newValue: string;
  password: string;
  ctx: Ctx;
  now: Clock;
  policy?: IdentityPolicy;
  devOtpHint?: boolean;
  deliverOtp: (channel: "email" | "phone", address: string, code: string, kind: OtpKind) => Promise<void>;
}): Promise<RequestChangeResult> {
  const {
    repo,
    user,
    kind,
    newValue,
    password,
    ctx,
    now,
    policy = DEFAULT_POLICY,
    devOtpHint = false,
    deliverOtp,
  } = args;
  const current = now();

  // 1) إعادة مصادثة — لا نثق بجلسة عمرها طويل
  if (!user.passwordHash || !verifySecret(password, user.passwordHash)) {
    return { ok: false, error: "إعادة المصادقة مطلوبة: كلمة المرور الحالية غير صحيحة", status: 403 };
  }

  // 2) الهوية الحالية يجب أن تكون موثقة قبل تغييرها (منع استيلاء مبكر)
  if (user.emailVerifiedAt === null) {
    return { ok: false, error: "يجب توثيق البريد الحالي قبل طلب تغييره", status: 409 };
  }

  const normalized = kind === "email" ? normalizeEmail(newValue) : normalizePhone(newValue);
  if (!normalized) return { ok: false, error: "القيمة الجديدة غير صالحة", status: 400 };

  const currentNormalized = kind === "email" ? user.emailNormalized : user.phoneNormalized;
  if (currentNormalized && normalized === currentNormalized) {
    return { ok: false, error: "القيمة الجديدة مطابقة للحالية", status: 409 };
  }

  // 3) uniqueness واضح على مستوى المنصة
  const dup = kind === "email" ? await repo.getUserByEmail(normalized) : await repo.getUserByPhone(normalized);
  if (dup && dup.id !== user.id) {
    return { ok: false, error: "هذه القيمة مستخدمة من حساب آخر", status: 409 };
  }

  // 4) تأخير أمني حسب الصلاحية
  const delayMs = user.role === "owner" ? policy.ownerSecurityDelayMs : policy.regularSecurityDelayMs;
  const request: ChangeRequest = {
    id: newId(),
    userId: user.id,
    kind,
    currentValueHash: currentNormalized ? hashValue(currentNormalized) : "",
    newValueNormalized: normalized,
    status: "CHANGE_REQUESTED",
    requestedAt: current,
    verifiedAt: null,
    securityDelayUntil: delayMs > 0 ? current + delayMs : null,
    expiresAt: current + policy.changeExpiryMs,
    completedAt: null,
    createdAt: current,
    requestId: ctx.requestId,
  };
  await repo.createChangeRequest(request);

  // 5) OTP إلى القيمة الجديدة (وليس رابطًا فقط)
  const code = generateOtp();
  await repo.createOtp({
    id: newId(),
    userId: user.id,
    kind: kind === "email" ? "email_change" : "phone_change",
    channel: kind,
    tokenHash: hashSecret(code),
    expiresAt: current + policy.otpTtlMs,
    maxAttempts: policy.otpMaxAttempts,
    attempts: 0,
    consumedAt: null,
    createdAt: current,
    requestId: request.id,
    target: normalized,
  });

  await deliverOtp(kind, normalized, code, kind === "email" ? "email_change" : "phone_change").catch(() => undefined);
  await audit(
    repo,
    user.id,
    kind === "email" ? EV.EMAIL_CHANGE_REQUESTED : EV.PHONE_CHANGE_REQUESTED,
    { kind, requestId: request.id, newValueHash: hashValue(request.newValueNormalized) },
    ctx
  );

  return {
    ok: true,
    requestId: request.id,
    status: "CHANGE_REQUESTED",
    channel: kind,
    devOtpHint: devOtpHint ? code : undefined,
  };
}

// ───────────────────────── تحقق OTP القيمة الجديدة ─────────────────────────

export async function verifyChangeOtp(args: {
  repo: IdentityRepo;
  user: User;
  requestId: string;
  code: string;
  ctx: Ctx;
  now: Clock;
}): Promise<{ ok: true; status: ChangeStatus } | { ok: false; error: string; status?: number }> {
  const { repo, user, requestId, code, ctx, now } = args;
  const req = await repo.getChangeRequestById(requestId);
  if (!req || req.userId !== user.id) return { ok: false, error: "طلب غير موجود", status: 404 };
  if (req.status === "COMPLETED" || req.status === "CANCELLED" || req.status === "EXPIRED") {
    return { ok: false, error: `الطلب في حالة ${req.status}`, status: 409 };
  }
  if (now() > req.expiresAt) {
    req.status = "EXPIRED";
    await repo.updateChangeRequest(req);
    await audit(
      repo,
      user.id,
      req.kind === "email" ? EV.EMAIL_CHANGE_EXPIRED : EV.PHONE_CHANGE_EXPIRED,
      { reason: "expired", requestId: req.id },
      ctx
    );
    return { ok: false, error: "انتهت مهلة طلب التغيير", status: 410 };
  }

  const otpKind = req.kind === "email" ? "email_change" : "phone_change";
  const otps = await repo.listOtps(user.id, otpKind);
  const rec =
    [...otps].reverse().find((o) => o.requestId === requestId && o.consumedAt === null) ??
    [...otps].reverse().find((o) => o.requestId === requestId);
  if (!rec) return { ok: false, error: "لا يوجد رمز تحقق مفعّل", status: 410 };

  const res = checkOtp(rec, code, now(), async (attempts, consumed) => {
    rec.attempts = attempts;
    if (consumed) rec.consumedAt = now();
    await repo.updateOtp(rec);
  });
  if (!res.ok) {
    if (res.reason === "attempts_exceeded" || res.reason === "expired" || res.reason === "used") {
      req.status = res.reason === "attempts_exceeded" ? "EXPIRED" : req.status;
      if (res.reason === "attempts_exceeded") {
        await repo.updateChangeRequest(req);
        await audit(
          repo,
          user.id,
          req.kind === "email" ? EV.EMAIL_CHANGE_EXPIRED : EV.PHONE_CHANGE_EXPIRED,
          { reason: "attempts_exceeded", requestId },
          ctx
        );
      }
    }
    await audit(repo, user.id, EV.OTP_REJECTED, { kind: req.kind, requestId, reason: res.reason }, ctx);
    return { ok: false, error: "رمز التحقق غير صحيح أو منتهٍ", status: 400 };
  }

  rec.consumedAt = now();
  await repo.updateOtp(rec);
  req.status = "NEW_VALUE_VERIFIED";
  req.verifiedAt = now();
  await repo.updateChangeRequest(req);
  await audit(
    repo,
    user.id,
    req.kind === "email" ? EV.EMAIL_CHANGE_VERIFIED : EV.PHONE_CHANGE_VERIFIED,
    { requestId },
    ctx
  );
  return { ok: true, status: pendingDisplayStatus(req, now()) };
}

async function latestOtp(repo: IdentityRepo, userId: string, kind: OtpKind): Promise<OtpRecord | null> {
  const all = await repo.listOtps(userId, kind);
  const active = all.filter((o) => o.consumedAt === null);
  const pool = active.length > 0 ? active : all;
  if (pool.length === 0) return null;
  return pool.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
}

// ───────────────────────── تنفيذ التغيير (بعد التأخير الأمني) ─────────────────────────

export async function applyIdentityChange(args: {
  repo: IdentityRepo;
  user: User;
  requestId: string;
  keepSessionId?: string;
  ctx: Ctx;
  now: Clock;
}): Promise<{ ok: true; user: User } | { ok: false; error: string; status?: number }> {
  const { repo, user, requestId, keepSessionId, ctx, now } = args;
  const req = await repo.getChangeRequestById(requestId);
  if (!req || req.userId !== user.id) return { ok: false, error: "طلب غير موجود", status: 404 };
  if (req.status === "COMPLETED") return { ok: false, error: "تم تنفيذ الطلب مسبقًا", status: 409 };
  if (req.status === "CANCELLED") return { ok: false, error: "تم إلغاء الطلب", status: 409 };
  if (now() > req.expiresAt) {
    req.status = "EXPIRED";
    await repo.updateChangeRequest(req);
    await audit(
      repo,
      user.id,
      req.kind === "email" ? EV.EMAIL_CHANGE_EXPIRED : EV.PHONE_CHANGE_EXPIRED,
      { reason: "expired", requestId: req.id },
      ctx
    );
    return { ok: false, error: "انتهت مهلة طلب التغيير", status: 410 };
  }
  if (req.status !== "NEW_VALUE_VERIFIED") {
    return { ok: false, error: "لم يكتمل التحقق من القيمة الجديدة", status: 409 };
  }
  if (req.securityDelayUntil && now() < req.securityDelayUntil) {
    return { ok: false, error: "لا يزال التغيير قيد المراجعة الأمنية (تأخير أمني)", status: 409 };
  }

  const updated: User = { ...user, updatedAt: now() };
  if (req.kind === "email") {
    updated.email = req.newValueNormalized;
    updated.emailNormalized = req.newValueNormalized;
    updated.emailVerifiedAt = now(); // القيمة الجديدة موثقة عبر OTP
  } else {
    updated.phone = req.newValueNormalized;
    updated.phoneNormalized = req.newValueNormalized;
    updated.phoneVerifiedAt = now();
  }
  await repo.updateUser(updated);
  req.status = "COMPLETED";
  req.completedAt = now();
  await repo.updateChangeRequest(req);

  // إبطال جلسات الأجهزة الأخرى — لا يبقى المهاجم في جلسة قديمة
  if (keepSessionId) await repo.revokeOtherSessions(user.id, keepSessionId);
  else await repo.revokeAllSessions(user.id);
  await audit(
    repo,
    user.id,
    EV.SESSION_REVOKED,
    { scope: keepSessionId ? "other" : "all", reason: "identity_change" },
    ctx
  );

  await audit(
    repo,
    user.id,
    req.kind === "email" ? EV.EMAIL_CHANGE_COMPLETED : EV.PHONE_CHANGE_COMPLETED,
    { kind: req.kind, requestId: req.id },
    ctx
  );
  return { ok: true, user: updated };
}

export async function cancelIdentityChange(args: {
  repo: IdentityRepo;
  user: User;
  requestId: string;
  ctx: Ctx;
  now: Clock;
}): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const { repo, user, requestId, ctx, now } = args;
  const req = await repo.getChangeRequestById(requestId);
  if (!req || req.userId !== user.id) return { ok: false, error: "طلب غير موجود", status: 404 };
  if (req.status === "COMPLETED") return { ok: false, error: "لا يمكن إلغاء طلب منفَّذ", status: 409 };
  req.status = "CANCELLED";
  req.completedAt = now();
  await repo.updateChangeRequest(req);
  await audit(
    repo,
    user.id,
    req.kind === "email" ? EV.EMAIL_CHANGE_CANCELLED : EV.PHONE_CHANGE_CANCELLED,
    { requestId: req.id },
    ctx
  );
  return { ok: true };
}

// ───────────────────────── تغيير كلمة المرور ─────────────────────────

export async function changePassword(args: {
  repo: IdentityRepo;
  user: User;
  currentPassword: string;
  newPassword: string;
  keepSessionId?: string;
  ctx: Ctx;
  now: Clock;
  policy?: IdentityPolicy;
}): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const { repo, user, currentPassword, newPassword, keepSessionId, ctx, now, policy = DEFAULT_POLICY } = args;
  if (!user.passwordHash || !verifySecret(currentPassword, user.passwordHash)) {
    return { ok: false, error: "كلمة المرور الحالية غير صحيحة", status: 403 };
  }
  if (newPassword.length < policy.minPasswordLength) {
    return { ok: false, error: `كلمة المرور يجب ألا تقل عن ${policy.minPasswordLength} أحرف`, status: 400 };
  }
  const updated: User = { ...user, passwordHash: hashSecret(newPassword), updatedAt: now() };
  await repo.updateUser(updated);
  if (keepSessionId) await repo.revokeOtherSessions(user.id, keepSessionId);
  else await repo.revokeAllSessions(user.id);
  await audit(repo, user.id, EV.PASSWORD_CHANGE, {}, ctx);
  await audit(
    repo,
    user.id,
    EV.SESSION_REVOKED,
    { scope: keepSessionId ? "other" : "all", reason: "password_change" },
    ctx
  );
  return { ok: true };
}

// ───────────────────────── التحقق الأولي (email/phone) ─────────────────────────

export async function startVerification(args: {
  repo: IdentityRepo;
  user: User;
  kind: "email" | "phone";
  value: string;
  ctx: Ctx;
  now: Clock;
  policy?: IdentityPolicy;
  devOtpHint?: boolean;
  deliverOtp: (channel: "email" | "phone", address: string, code: string, kind: OtpKind) => Promise<void>;
}): Promise<{ ok: true; otpId?: string; devOtpHint?: string } | { ok: false; error: string; status?: number }> {
  const { repo, user, kind, value, ctx, now, policy = DEFAULT_POLICY, devOtpHint = false, deliverOtp } = args;
  const normalized = kind === "email" ? normalizeEmail(value) : normalizePhone(value);
  if (!normalized) return { ok: false, error: "القيمة غير صالحة", status: 400 };
  const dup = kind === "email" ? await repo.getUserByEmail(normalized) : await repo.getUserByPhone(normalized);
  if (dup && dup.id !== user.id) return { ok: false, error: "مستخدمة من حساب آخر", status: 409 };

  const code = generateOtp();
  await repo.createOtp({
    id: newId(),
    userId: user.id,
    kind: kind === "email" ? "email_verify" : "phone_verify",
    channel: kind,
    tokenHash: hashSecret(code),
    expiresAt: now() + policy.otpTtlMs,
    maxAttempts: policy.otpMaxAttempts,
    attempts: 0,
    consumedAt: null,
    createdAt: now(),
    requestId: null,
    target: normalized,
  });
  await deliverOtp(kind, normalized, code, kind === "email" ? "email_verify" : "phone_verify").catch(() => undefined);
  await audit(
    repo,
    user.id,
    kind === "email" ? EV.EMAIL_VERIFICATION_REQUESTED : EV.PHONE_VERIFICATION_REQUESTED,
    { kind, targetHash: sha256Hex(normalized) },
    ctx
  );
  return { ok: true, devOtpHint: devOtpHint ? code : undefined };
}

export async function confirmVerification(args: {
  repo: IdentityRepo;
  user: User;
  kind: "email" | "phone";
  code: string;
  ctx: Ctx;
  now: Clock;
}): Promise<{ ok: true; user: User } | { ok: false; error: string; status?: number }> {
  const { repo, user, kind, code, ctx, now } = args;
  const otpKind = kind === "email" ? "email_verify" : "phone_verify";
  const rec = await latestOtp(repo, user.id, otpKind);
  if (!rec) return { ok: false, error: "ابدأ التحقق أولًا", status: 410 };
  const res = checkOtp(rec, code, now(), async (attempts, consumed) => {
    rec.attempts = attempts;
    if (consumed) rec.consumedAt = now();
    await repo.updateOtp(rec);
  });
  if (!res.ok) {
    await audit(
      repo,
      user.id,
      kind === "email" ? EV.EMAIL_VERIFICATION_FAILED : EV.PHONE_VERIFICATION_FAILED,
      { kind, reason: res.reason },
      ctx
    );
    return { ok: false, error: "رمز التحقق غير صحيح أو منتهٍ", status: 400 };
  }
  rec.consumedAt = now();
  await repo.updateOtp(rec);
  const updated: User = { ...user, updatedAt: now() };
  if (kind === "email") {
    updated.email = user.email; // القيمة الأساسية ثابتة — نُوثّق ما هو مسجل
    updated.emailVerifiedAt = now();
  } else {
    if (rec.target && !updated.phoneNormalized) {
      updated.phone = rec.target;
      updated.phoneNormalized = rec.target;
    }
    updated.phoneVerifiedAt = now();
  }
  await repo.updateUser(updated);
  await audit(
    repo,
    user.id,
    kind === "email" ? EV.EMAIL_VERIFICATION_SUCCEEDED : EV.PHONE_VERIFICATION_SUCCEEDED,
    { kind },
    ctx
  );
  return { ok: true, user: updated };
}

// ───────────────────────── الاسترداد (Recovery) ─────────────────────────

export async function requestRecovery(args: {
  repo: IdentityRepo;
  email: string;
  ctx: Ctx;
  now: Clock;
  policy?: IdentityPolicy;
  devOtpHint?: boolean;
  deliverOtp: (channel: "email", address: string, code: string, kind: OtpKind) => Promise<void>;
}): Promise<{ ok: true; devOtpHint?: string }> {
  const { repo, email, ctx, now, policy = DEFAULT_POLICY, devOtpHint = false, deliverOtp } = args;
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: true }; // استجابة موحدة حتى للبريد غير الصالح
  const user = await repo.getUserByEmail(normalized);
  // استجابة موحدة — لا كشف عن وجود/عدم وجود الحساب (منع enumeration)
  if (user) {
    const code = generateOtp();
    await repo.createOtp({
      id: newId(),
      userId: user.id,
      kind: "password_reset",
      channel: "email",
      tokenHash: hashSecret(code),
      expiresAt: now() + policy.otpTtlMs,
      maxAttempts: policy.otpMaxAttempts,
      attempts: 0,
      consumedAt: null,
      createdAt: now(),
      requestId: null,
      target: normalized,
    });
    await deliverOtp("email", normalized, code, "password_reset").catch(() => undefined);
    await audit(repo, user.id, EV.RECOVERY_REQUESTED, { emailHash: sha256Hex(normalized) }, ctx);
    return { ok: true, devOtpHint: devOtpHint ? code : undefined };
  }
  // استجابة موحدة + حدث موحّد (لا فرق بين موجود/غير موجود) — منع enumeration
  await audit(repo, "", EV.RECOVERY_REQUESTED, { unknown: true, emailHash: sha256Hex(normalized) }, ctx);
  return { ok: true };
}

export async function confirmRecovery(args: {
  repo: IdentityRepo;
  email: string;
  code: string;
  newPassword: string;
  ctx: Ctx;
  now: Clock;
  policy?: IdentityPolicy;
}): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const { repo, email, code, newPassword, ctx, now, policy = DEFAULT_POLICY } = args;
  const normalized = normalizeEmail(email);
  const user = normalized ? await repo.getUserByEmail(normalized) : null;
  if (!user) {
    await audit(
      repo,
      "",
      EV.RECOVERY_FAILED,
      { reason: "no_account", emailHash: normalized ? sha256Hex(normalized) : null },
      ctx
    );
    return { ok: false, error: "رمز التحقق غير صحيح", status: 400 };
  }
  if (newPassword.length < policy.minPasswordLength) {
    return { ok: false, error: `كلمة المرور يجب ألا تقل عن ${policy.minPasswordLength} أحرف`, status: 400 };
  }
  const rec = await latestOtp(repo, user.id, "password_reset");
  if (!rec) {
    await audit(repo, user.id, EV.RECOVERY_FAILED, { reason: "no_otp" }, ctx);
    return { ok: false, error: "ابدأ الاسترداد أولًا", status: 410 };
  }
  const res = checkOtp(rec, code, now(), async (attempts, consumed) => {
    rec.attempts = attempts;
    if (consumed) rec.consumedAt = now();
    await repo.updateOtp(rec);
  });
  if (!res.ok) {
    await audit(repo, user.id, EV.RECOVERY_FAILED, { reason: res.reason }, ctx);
    return { ok: false, error: "رمز التحقق غير صحيح أو منتهٍ", status: 400 };
  }
  rec.consumedAt = now();
  await repo.updateOtp(rec);
  const updated: User = { ...user, passwordHash: hashSecret(newPassword), updatedAt: now() };
  await repo.updateUser(updated);
  await repo.revokeAllSessions(user.id); // إبطال كل الجلسات بعد الاسترداد
  await audit(repo, user.id, EV.SESSION_REVOKED, { scope: "all", reason: "recovery" }, ctx);
  await audit(repo, user.id, EV.RECOVERY_COMPLETED, {}, ctx);
  return { ok: true };
}

// ───────────────────────── جلسات ─────────────────────────

export async function createSessionRecord(args: {
  repo: IdentityRepo;
  user: User;
  rawToken: string;
  label?: string;
  now: Clock;
  policy?: IdentityPolicy;
}): Promise<SessionRecord> {
  const { repo, user, rawToken, label, now, policy = DEFAULT_POLICY } = args;
  const rec: SessionRecord = {
    id: newId(),
    userId: user.id,
    tokenHash: hashToken(rawToken),
    label: label ?? null,
    createdAt: now(),
    lastSeenAt: now(),
    revokedAt: null,
  };
  await repo.createSession(rec);
  return rec;
}

export async function sessionActive(s: SessionRecord | null, now: number, maxAgeMs: number): Promise<boolean> {
  return Boolean(s && s.revokedAt === null && now - s.createdAt <= maxAgeMs);
}
