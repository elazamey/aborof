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
 * ينشئ جلسة إدارة. الرمز كله بحروف آمنة داخل الكوكي (`A-Za-z0-9-_.`) عن قصد:
 * مُسلسِل الكوكي في Next يرمّز أي حرف غير آمن (مثل `:` إلى `%3A`)، وبما أننا
 * نقرأ الكوكي من الترويسة الخام فإن أي ترميز كان يُبطل التحقق تمامًا.
 * لذلك الفاصل داخل الحمولة هو `.` وليس `:`، والتحقق يقبلهما معًا للتوافق.
 */
export function createAdminSession() {
  const payload = `${Date.now()}.${randomBytes(24).toString("base64url")}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyAdminSession(token: string | undefined) {
  if (!token) return false;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return false;

  const payload = token.slice(0, separator);
  const provided = token.slice(separator + 1);
  const expected = sign(payload);
  if (provided.length !== expected.length) return false;

  const validSignature = timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!validSignature) return false;

  // نقرأ وقت الإصدار من أول مقطع رقمي أياً كان الفاصل المستخدم (`.` أو `:`).
  const issuedAt = Number(payload.split(/[.:]/, 1)[0]);
  return Number.isFinite(issuedAt) && Date.now() - issuedAt <= SESSION_MAX_AGE * 1000;
}

/**
 * يقرأ رمز الجلسة من ترويسة الكوكي الخام. إن وصلت القيمة مُرمَّزة (`%3A` مثلاً)
 * من مُسلسِل كوكي أو من وسيط، نفكّ الترميز قبل التحقق حتى لا تُرفض جلسة صحيحة.
 */
function readAdminToken(request: Request): string | undefined {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const raw = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_COOKIE}=`))
    ?.slice(ADMIN_COOKIE.length + 1);
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    // قيمة غير مُرمَّزة بشكل صالح ⇒ نستخدمها كما هي.
    return raw;
  }
}

export function isAdminRequest(request: Request) {
  return verifyAdminSession(readAdminToken(request));
}

/**
 * تشخيص دقيق لمشكلات تهيئة الإدارة دون كشف أي قيمة: يعيد رسائل تسمّي
 * المتغير الناقص أو غير الصالح بعينه، لتظهر في رسالة 503 بدل رسالة عامة.
 */
export function adminConfigIssues(): string[] {
  const issues: string[] = [];
  if (!process.env.ADMIN_PASSWORD) {
    issues.push("ADMIN_PASSWORD غير مُعيَّن");
  }
  const sessionSecret = process.env.ADMIN_SESSION_SECRET;
  if (!sessionSecret) {
    issues.push("ADMIN_SESSION_SECRET غير مُعيَّن");
  } else if (sessionSecret.length < 32) {
    issues.push("ADMIN_SESSION_SECRET يجب ألا يقل عن 32 حرفًا");
  }
  return issues;
}

export function isAdminConfigured() {
  return adminConfigIssues().length === 0;
}

export function passwordMatches(input: string) {
  const configured = process.env.ADMIN_PASSWORD;
  if (!configured || !input) return false;
  const inputBuffer = Buffer.from(input);
  const configuredBuffer = Buffer.from(configured);
  return inputBuffer.length === configuredBuffer.length && timingSafeEqual(inputBuffer, configuredBuffer);
}

export const sessionMaxAge = SESSION_MAX_AGE;
