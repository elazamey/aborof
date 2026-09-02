/**
 * IDENTITY-HARDENING-01 — أنواع ومستودع الهوية (P0 Security).
 * تصميم مستقل عن orders/ — قابل للتوسع لاحقًا لكل tenant (tenantId).
 */

export type UserRole = "owner" | "admin";

export type User = {
  id: string;
  email: string;
  emailNormalized: string;
  emailVerifiedAt: number | null;
  phone: string | null;
  phoneNormalized: string | null;
  phoneVerifiedAt: number | null;
  passwordHash: string | null; // scrypt$salt$hash — لا تُخزَّن كلمة مرور نصًا
  role: UserRole;
  tenantId: string | null;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
};

export type OtpKind = "email_verify" | "phone_verify" | "email_change" | "phone_change" | "password_reset";
export type OtpChannel = "email" | "phone";

export type OtpRecord = {
  id: string;
  userId: string;
  kind: OtpKind;
  channel: OtpChannel;
  tokenHash: string; // hash للـOTP — لا نص صريح أبدًا
  expiresAt: number;
  maxAttempts: number;
  attempts: number;
  consumedAt: number | null;
  createdAt: number;
  requestId: string | null;
  /** القيمة الطبيعية المستهدفة (مثال: +20... للهاتف) — لتعبئة الحساب عند النجاح */
  target: string | null;
};

export type ChangeStatus =
  "CHANGE_REQUESTED" | "NEW_VALUE_VERIFIED" | "SECURITY_REVIEW" | "COMPLETED" | "EXPIRED" | "CANCELLED";

export type ChangeRequest = {
  id: string;
  userId: string;
  kind: "email" | "phone";
  currentValueHash: string; // sha256 للتطبيع — لا قيمة كاملة في السجلات العادية
  newValueNormalized: string;
  status: ChangeStatus;
  requestedAt: number;
  verifiedAt: number | null;
  securityDelayUntil: number | null;
  expiresAt: number;
  completedAt: number | null;
  createdAt: number;
  requestId: string | null;
};

export type SessionRecord = {
  id: string;
  userId: string;
  tokenHash: string;
  label: string | null;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
};

export type SecurityEvent = {
  id: string;
  userId: string;
  event: string;
  metadata: string; // JSON — قيم مجزّأة (hashes) وليست PII كاملة
  ip: string | null;
  requestId: string | null;
  createdAt: number;
};

export interface IdentityRepo {
  getUserById(id: string): Promise<User | null>;
  getUserByEmail(normalized: string): Promise<User | null>;
  getUserByPhone(normalized: string): Promise<User | null>;
  createUser(u: User): Promise<void>;
  updateUser(u: User): Promise<void>;
  createOtp(o: OtpRecord): Promise<void>;
  getOtpById(id: string): Promise<OtpRecord | null>;
  listOtps(userId: string, kind: OtpKind): Promise<OtpRecord[]>;
  updateOtp(o: OtpRecord): Promise<void>;
  createChangeRequest(c: ChangeRequest): Promise<void>;
  getChangeRequestById(id: string): Promise<ChangeRequest | null>;
  listPendingChangeRequests(userId: string, kind?: "email" | "phone"): Promise<ChangeRequest[]>;
  updateChangeRequest(c: ChangeRequest): Promise<void>;
  createSession(s: SessionRecord): Promise<void>;
  getSessionById(id: string): Promise<SessionRecord | null>;
  getSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  listSessions(userId: string): Promise<SessionRecord[]>;
  revokeSession(id: string): Promise<void>;
  revokeOtherSessions(userId: string, keepId: string): Promise<void>;
  revokeAllSessions(userId: string): Promise<void>;
  createSecurityEvent(e: SecurityEvent): Promise<void>;
  listSecurityEvents(userId: string, limit: number): Promise<SecurityEvent[]>;
}

export type IdentityPolicy = {
  otpTtlMs: number; // افتراضي 10 دقائق
  otpMaxAttempts: number; // افتراضي 5
  otpResendCooldownMs: number;
  changeExpiryMs: number; // مهلة طلب التغيير (24 ساعة)
  ownerSecurityDelayMs: number; // تأخير أمني للمالك (عدة ساعات)
  regularSecurityDelayMs: number; // صفر للمستخدم العادي
  minPasswordLength: number;
  sessionMaxAgeMs: number;
};

export const DEFAULT_POLICY: IdentityPolicy = {
  otpTtlMs: 10 * 60 * 1000,
  otpMaxAttempts: 5,
  otpResendCooldownMs: 60 * 1000,
  changeExpiryMs: 24 * 60 * 60 * 1000,
  ownerSecurityDelayMs: 6 * 60 * 60 * 1000, // 6 ساعات
  regularSecurityDelayMs: 0,
  minPasswordLength: 10,
  sessionMaxAgeMs: 8 * 60 * 60 * 1000,
};
