import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE = "aborof_admin_session";
const SESSION_MAX_AGE = 60 * 60 * 8;

/**
 * جلسات الإدارة — إصداران متعايشان:
 *
 *  - **v1 (قديمة):** `<issuedAt>:<nonce>` — جلسة "مشغّل مفرد" بلا هوية، تُنشأ من
 *    كلمة مرور الإدارة المشتركة. تبقى صالحة فقط عندما يكون RBAC مغلقًا
 *    (`ENABLE_RBAC != "true"`)، أي أن غياب العلم لا يغيّر السلوك القائم حرفيًا.
 *  - **v2 (RBAC):** `v2:<userId>:<tokenVersion>:<issuedAt>:<nonce>` — تحمل هوية
 *    المستخدم وإصدار توكنه، فيصبح تعطيل المستخدم أو تغيير كلمة مروره أو دوره
 *    **مُبطِلًا فوريًا** لكل جلساته بلا قائمة إبطال منفصلة.
 *
 * قرارات محكمة (fail-closed):
 *  - `ADMIN_SESSION_SECRET` يبقى محصورًا في هذا الملف (بوابة `security-gates`).
 *  - أي خلل (سر غائب/قصير، صيغة مشوّهة، توقيع مختلف، انتهاء المدة) = `null`
 *    لا استثناء — فلا يتحول خطأ تهيئة إلى 500 يكشف بنية الجلسة.
 *  - الجلسات v1 تبقى «صالحة شكليًا» هنا (`isAdminRequest`)، وتُرفض في طبقة
 *    RBAC عند تشغيل العلم — فصلٌ مقصود بين «توقيع صحيح» و«مصرّح بالدخول».
 */

export interface AdminSessionRecord {
  version: 1 | 2;
  issuedAt: number;
  /** موجود في v2 فقط. */
  userId?: string;
  /** إصدار توكن المستخدم وقت الإصدار — يقارَن بصف المستخدم الحالي عند الفحص. */
  tokenVersion?: number;
}

export interface AdminSessionIdentity {
  userId: string;
  tokenVersion: number;
}

/** معرّف مستخدم صالح داخل حمولة الجلسة (يمنع حقن الفواصل `:`). */
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,60}$/;

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

function nonce() {
  return randomBytes(24).toString("base64url");
}

/**
 * ينشئ جلسة إدارة: بلا وسيط ⇒ جلسة v1 القديمة (سلوك اليوم حرفيًا)،
 * وبوسيط الهوية ⇒ جلسة v2 مرتبطة بمستخدم RBAC.
 */
export function createAdminSession(identity?: AdminSessionIdentity) {
  if (!identity) {
    const payload = `${Date.now()}:${nonce()}`;
    return `${payload}.${sign(payload)}`;
  }
  if (!USER_ID_PATTERN.test(identity.userId)) {
    throw new Error("admin session: invalid user id");
  }
  const tokenVersion = Number(identity.tokenVersion);
  if (!Number.isInteger(tokenVersion) || tokenVersion < 1 || tokenVersion > 1_000_000) {
    throw new Error("admin session: invalid token version");
  }
  const payload = `v2:${identity.userId}:${tokenVersion}:${Date.now()}:${nonce()}`;
  return `${payload}.${sign(payload)}`;
}

/** يفكّ حمولة جلسة بعد التحقق من التوقيع والمدة. لا يرمي أبدًا. */
export function readAdminSession(token: string | undefined | null): AdminSessionRecord | null {
  if (!token || typeof token !== "string") return null;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;

  const payload = token.slice(0, separator);
  const provided = token.slice(separator + 1);
  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    // سر الجلسات غير مهيأ أو قصير ⇒ لا جلسة صالحة (فشل مغلق بلا استثناء).
    return null;
  }
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(providedBuffer, expectedBuffer)) return null;

  const parts = payload.split(":");
  const isV2 = parts[0] === "v2";
  const issuedAtRaw = isV2 ? parts[3] : parts[0];
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return null;
  if (Date.now() - issuedAt > SESSION_MAX_AGE * 1000) return null;
  if (Date.now() - issuedAt < -60_000) return null;

  if (!isV2) {
    if (parts.length !== 2) return null;
    return { version: 1, issuedAt };
  }

  if (parts.length !== 5) return null;
  const userId = parts[1];
  const tokenVersion = Number(parts[2]);
  if (!USER_ID_PATTERN.test(userId)) return null;
  if (!Number.isInteger(tokenVersion) || tokenVersion < 1) return null;
  return { version: 2, issuedAt, userId, tokenVersion };
}

export function verifyAdminSession(token: string | undefined) {
  return readAdminSession(token) !== null;
}

/** توكن الجلسة من ترويسة الكوكيز (يفكّ التكويد الذي تضيفه NextResponse). */
export function adminSessionToken(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const raw = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_COOKIE}=`))
    ?.slice(ADMIN_COOKIE.length + 1);
  if (!raw) return null;
  try {
    // NextResponse.cookies.set يُكوّد القيمة (":"→"%3A")، والمتصفح يعيدها مُكوّدة
    // — نفك التكويد مع تحمّل الحالتين (مُكوّدة أو خام كما في الاختبارات)
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** الجلسة الكاملة من الطلب (v1 أو v2) — نقطة الفحص الوحيدة لطبقة RBAC. */
export function readAdminSessionFromRequest(request: Request): AdminSessionRecord | null {
  return readAdminSession(adminSessionToken(request));
}

export function isAdminRequest(request: Request) {
  return readAdminSessionFromRequest(request) !== null;
}

export function passwordMatches(input: string) {
  const configured = process.env.ADMIN_PASSWORD;
  if (!configured || !input) return false;
  const inputBuffer = Buffer.from(input);
  const configuredBuffer = Buffer.from(configured);
  return inputBuffer.length === configuredBuffer.length && timingSafeEqual(inputBuffer, configuredBuffer);
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

export const sessionMaxAge = SESSION_MAX_AGE;
