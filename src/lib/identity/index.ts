import { ADMIN_COOKIE, isAdminConfigured, verifyAdminSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { DEFAULT_POLICY, IdentityPolicy, IdentityRepo, SessionRecord, User } from "./types";
import { normalizeEmail } from "./normalize";
import { hashSecret, hashToken, newId, verifySecret } from "./otp";
import { createSqlIdentityRepo } from "./sql";
import { sessionActive } from "./core";

export * from "./types";
export * from "./normalize";
export * from "./otp";
export * from "./core";
export { createSqlIdentityRepo, IDENTITY_SCHEMA } from "./sql";

let repo: IdentityRepo | null = null;
export function identityRepo(): IdentityRepo | null {
  const client = db();
  if (!client) return null;
  if (!repo) repo = createSqlIdentityRepo(client);
  return repo;
}

export function policyFromEnv(): IdentityPolicy {
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    ...DEFAULT_POLICY,
    otpTtlMs: num(process.env.IDENTITY_OTP_TTL_MINUTES, 10) * 60_000,
    otpMaxAttempts: num(process.env.IDENTITY_OTP_MAX_ATTEMPTS, 5),
    ownerSecurityDelayMs: num(process.env.IDENTITY_SECURITY_DELAY_MINUTES, 6 * 60) * 60_000,
    minPasswordLength: num(process.env.IDENTITY_MIN_PASSWORD_LENGTH, 10),
  };
}

/** رمز OTP للتطوير/البوابة فقط — يُفعَّل صراحةً (IDENTITY_DEV_OTP_HINT=1) وليس افتراضيًا أبدًا */
export function devOtpHintEnabled(): boolean {
  return process.env.IDENTITY_DEV_OTP_HINT === "1";
}

export async function deliverOtp(
  channel: "email" | "phone",
  address: string,
  code: string,
  kind: string
): Promise<void> {
  // التوصيل الفعلي عبر موفّر (EX02-EMAIL / EX05) عند التهيئة لاحقًا؛
  // بدونه: لا إرسال — رمز التطوير متاح فقط مع IDENTITY_DEV_OTP_HINT=1.
  console.log(`[identity] otp ${kind} → ${channel}:${address} (delivery provider NOT_CONFIGURED)`);
}

export type AuthResult = { ok: true; user: User; sessionId: string } | { ok: false; error: string; status: number };

/**
 * authenticateAdminRequest — نقطة السلطة الوحيدة لتفويض الإدارة.
 * كل مسار محمي (orders / products / admin-session / identity/*) يمر من هنا،
 * ولا يوجد أي مسار بديل للتحقق من صلاحية الإدارة.
 *
 * الدلالات:
 *  - HMAC (verifyAdminSession) = إثبات سلامة الرمز وحيازته فقط — ليس تفويضًا بذاته.
 *  - جدول sessions = السلطة الوحيدة للتفويض: يجب أن يوجد سجل نشط غير مُبطَل
 *    (revoked_at IS NULL) ضمن sessionMaxAgeMs.
 *  - قاعدة البيانات غير متاحة → 503 (fail-closed): لا تفويض افتراضي أبدًا.
 */
export async function authenticateAdminRequest(
  request: Request,
  repo: IdentityRepo | null = identityRepo()
): Promise<AuthResult> {
  if (!repo) return { ok: false, error: "قاعدة البيانات غير متاحة", status: 503 };
  const cookieHeader = request.headers.get("cookie") ?? "";
  const token = cookieHeader
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${ADMIN_COOKIE}=`))
    ?.slice(ADMIN_COOKIE.length + 1);
  if (!token || !verifyAdminSession(token)) return { ok: false, error: "غير مصرح", status: 401 };

  const session = await repo.getSessionByTokenHash(hashToken(token));
  if (!session) return { ok: false, error: "غير مصرح", status: 401 };
  const active = await sessionActive(session, Date.now(), policyFromEnv().sessionMaxAgeMs);
  if (!active) return { ok: false, error: "غير مصرح", status: 401 };

  const user = await repo.getUserById(session.userId);
  if (!user) return { ok: false, error: "غير مصرح", status: 401 };
  return { ok: true, user, sessionId: session.id };
}

/**
 * مصدر الحقيقة الوحيد للتحقق من كلمة المرور: users.password_hash.
 * (البيئة ADMIN_PASSWORD هي bootstrap فقط — انظر ensureOwner).
 * لا يوجد مالك أو لا يوجد hash → فشل مغلق (false) — لا إنشاء حالة تلقائية هنا.
 */
export function verifyOwnerCredentials(user: User | null, input: string): boolean {
  if (!user || !user.passwordHash || typeof input !== "string" || input.length === 0) return false;
  return verifySecret(input, user.passwordHash);
}

/**
 * بذر حساب المالك عند أول تسجيل دخول (bootstrap فقط) — الهوية تُوثَّق عبر OTP لاحقًا.
 * كلمة المرور تُؤخذ من ADMIN_PASSWORD عند الإنشاء فقط؛ بعدها users.password_hash
 * هو المصدر الوحيد (لا يُحدَّث الهاش عند كل استدعاء لاحق).
 */
export async function ensureOwner(r: IdentityRepo, now = Date.now()): Promise<User> {
  // المالك الوحيد يُعرَّف بالدور (role='owner') لا بالبريد — حتى لا يُنشأ مالك ثانٍ
  // عند تغيير البريد لاحقًا. الدخول يجب ألا يُنشئ حالة غير متوقعة (fail-closed).
  const existing = await r.getOwner();
  if (existing) return existing;
  const email = normalizeEmail(process.env.ADMIN_EMAIL ?? "owner@aborof.store")!;
  const user: User = {
    id: newId(),
    email,
    emailNormalized: email,
    emailVerifiedAt: null,
    phone: null,
    phoneNormalized: null,
    phoneVerifiedAt: null,
    passwordHash: process.env.ADMIN_PASSWORD ? hashSecret(process.env.ADMIN_PASSWORD) : null,
    role: "owner",
    tenantId: null,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
  };
  await r.createUser(user);
  return user;
}

export { isAdminConfigured } from "@/lib/auth";
export { hashToken } from "./otp";
