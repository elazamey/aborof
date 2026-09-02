import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * محرك OTP و hashing — بلا تبعيات خارجية:
 *  - OTP: 6 أرقام، يُخزَّن hash (scrypt) فقط، مقارنة timing-safe.
 *  - كلمة المرور: scrypt مع salt عشوائي.
 *  - كل دوال الحالة نقية مع ساعة قابلة للحقن (للاختبارات الحتمية).
 */

export type Clock = () => number;

export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function newId(): string {
  return randomBytes(16).toString("hex");
}

export function hashSecret(value: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(value, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifySecret(value: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, expectedHex] = parts;
  const actual = scryptSync(value, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type OtpCheckResult =
  { ok: true } | { ok: false; reason: "expired" | "used" | "wrong" | "attempts_exceeded" | "not_found" };

export type OtpRecordLike = {
  tokenHash: string;
  expiresAt: number;
  maxAttempts: number;
  attempts: number;
  consumedAt: number | null;
};

/**
 * فحص رمز OTP + تحديث المحاولات (عبر callback لأن التخزين قد يختلف).
 *  - منتهي → expired (لا يُعدّ محاولة)
 *  - مستهلك (single-use) → used
 *  - خاطئ → wrong + عدّ المحاولة؛ تجاوز الحد → attempts_exceeded (يُستهلك لمنع استمرار المحاولة)
 */
export function checkOtp(
  rec: OtpRecordLike,
  code: string,
  now: number,
  onUpdate: (attempts: number, consumed: boolean) => void
): OtpCheckResult {
  if (rec.consumedAt !== null) return { ok: false, reason: "used" };
  if (now > rec.expiresAt) return { ok: false, reason: "expired" };
  if (rec.attempts >= rec.maxAttempts) return { ok: false, reason: "attempts_exceeded" };
  if (!verifySecret(code, rec.tokenHash)) {
    const attempts = rec.attempts + 1;
    const consumed = attempts >= rec.maxAttempts;
    onUpdate(attempts, consumed);
    return { ok: false, reason: consumed ? "attempts_exceeded" : "wrong" };
  }
  return { ok: true };
}
