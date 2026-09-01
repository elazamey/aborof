import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE = "aborof_admin_session";
const SESSION_MAX_AGE = 60 * 60 * 8;

function secret() {
  const value = process.env.ADMIN_SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error("ADMIN_SESSION_SECRET must be at least 32 characters");
  }
  return value;
}

function sign(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/**
 * Session token آمن للكوكي من باب التصميم (وليس كحل ترقيعي):
 *   token = base64url(issuedAt:random).signature
 * الأبجدية Base64URL (A-Z a-z 0-9 - _) لا تحتوي على ":" أو أي حرف يحتاج
 * URL-encoding، فيتجنب تماماً مشكلة اختلاف الترميز بين Set-Cookie وقراءة
 * الكوكي التي كانت تكسر التحقق من التوقيع.
 */
export function createAdminSession() {
  const payload = Buffer.from(`${Date.now()}:${randomBytes(24).toString("base64url")}`).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyAdminSession(token: string | undefined) {
  if (!token) return false;
  // دفاع إضافي: لو وصلت القيمة مشفّرة من أي وسيط، فك الترميز بلا ضرر.
  try {
    token = decodeURIComponent(token);
  } catch {
    return false;
  }
  // strict parsing: جزءان بالضبط (payload.signature)
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const [payload, provided] = parts;

  const expected = sign(payload);
  if (provided.length !== expected.length) return false;
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return false;
  }
  const colon = decoded.indexOf(":");
  const issuedAt = Number(colon > 0 ? decoded.slice(0, colon) : NaN);
  if (!Number.isFinite(issuedAt)) return false;
  // رفض تواريخ المستقبل (سماحية فرق ساعة صغيرة فقط) + انتهاء الصلاحية
  if (issuedAt > Date.now() + 60_000) return false;
  return Date.now() - issuedAt <= SESSION_MAX_AGE * 1000;
}

export function isAdminRequest(request: Request) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const token = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_COOKIE}=`))
    ?.slice(ADMIN_COOKIE.length + 1);
  return verifyAdminSession(token);
}

export function isAdminConfigured() {
  return Boolean(
    process.env.ADMIN_PASSWORD && process.env.ADMIN_SESSION_SECRET && process.env.ADMIN_SESSION_SECRET.length >= 32
  );
}

export function passwordMatches(input: string) {
  const configured = process.env.ADMIN_PASSWORD;
  if (!configured || !input) return false;
  const inputBuffer = Buffer.from(input);
  const configuredBuffer = Buffer.from(configured);
  return inputBuffer.length === configuredBuffer.length && timingSafeEqual(inputBuffer, configuredBuffer);
}

export const sessionMaxAge = SESSION_MAX_AGE;
