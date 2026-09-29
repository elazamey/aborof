/**
 * مصادقة Celia — مساران معزولان، كلاهما خلف نفس البوابة الحتمية.
 *
 * - المسار 1: جلسة الإدارة (Admin Session) عبر HMAC-SHA256 في الكوكيز
 *   (`aborof_admin_session`) — نفس `isAdminRequest` المستخدم في `/admin`.
 * - المسار 2: توكن الوكيل (Agent Token) عبر ترويسة `Authorization: Bearer <token>`
 *   حيث `CELIA_AGENT_TOKEN` لا يقل عن 32 حرفًا (نفس سياسة طول سر الجلسة).
 *
 * كلاهما يُعيد هوية موحّدة `{ id, role }` أو يرمي `DomainError` (401/503).
 * لا يكشف أي فرع وجود التوكن من عدمه beyond 401 موحّد.
 */

import { Errors } from "@/lib/errors";
import { actorCan, resolveActor } from "@/lib/rbac";
import { timingSafeEqual } from "node:crypto";

export type CeliaAuth = {
  id: string;
  role: "admin" | "agent";
  method: "admin_session" | "agent_token";
  /** اسم المستخدم في وضع RBAC (غائب في الوضع القديم). */
  username?: string;
};

const TOKEN_ENV = "CELIA_AGENT_TOKEN" as const;
const MIN_TOKEN_LENGTH = 32;

/** هل توكن الوكيل مهيأ بشكل صالح (≥32)؟ */
export function isCeliaAgentTokenConfigured(): boolean {
  const v = process.env[TOKEN_ENV];
  return typeof v === "string" && v.length >= MIN_TOKEN_LENGTH;
}

/** استخراج التوكن من ترويسة Authorization (Bearer) — لا يرمي. */
function bearerToken(request: Request): string | null {
  const raw = request.headers.get("authorization") ?? request.headers.get("Authorization") ?? "";
  if (!raw) return null;
  // Bearer <token> — غير حساس لحالة الأحرف في الكلمة المفتاحية
  const m = raw.match(/^\s*Bearer\s+(.+?)\s*$/i);
  if (!m) return null;
  const token = m[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * يتحقق من هوية Celia.
 * - إن كانت جلسة الإدارة صالحة → admin
 * - وإلا إن كان Bearer يطابق CELIA_AGENT_TOKEN (مقارنة ثابتة الزمن) → agent
 * - وإلا يرمي 401 (بدون تفريق بين "لا توكن" و"توكن خاطئ" beyond الرسالة)
 */
export async function verifyCeliaAuth(request: Request): Promise<CeliaAuth> {
  // المسار 1: جلسة الإدارة — عبر طبقة الصلاحيات (تعمل في الوضعين).
  // مع العلم مغلقًا: أي جلسة صالحة = مشغّل مفرد (سلوك اليوم حرفيًا).
  // ومع `ENABLE_RBAC=true`: جلسة v2 لمستخدم فعّال **تحمل صلاحية `celia:use`**.
  const actor = await resolveActor(request);
  if (actor) {
    if (!actorCan(actor, "celia:use")) {
      throw Errors.forbidden("صلاحية «استخدام سيليا من جلسة الإدارة» غير متاحة لحسابك.");
    }
    return { id: actor.id, username: actor.username, role: "admin", method: "admin_session" };
  }

  // المسار 2: توكن الوكيل
  const token = bearerToken(request);
  const expected = process.env[TOKEN_ENV];

  // لا توكن مرسل أصلًا → 401 موحّد
  if (!token) {
    throw Errors.authRequired("المصادقة مطلوبة — أرسل جلسة الإدارة أو Bearer CELIA_AGENT_TOKEN.");
  }

  // التوكن قصير جدًا → 401 (لا نكشف الحد الأدنى للخادم beyond الرسالة)
  if (token.length < MIN_TOKEN_LENGTH) {
    throw Errors.authInvalid("توكن غير صالح.");
  }

  // الخادم غير مهيأ بتوكن صالح → 503 (تشخيص دقيق لا يكشف القيمة)
  if (!expected || expected.length < MIN_TOKEN_LENGTH) {
    throw Errors.serviceUnavailable("توكن الوكيل غير مهيأ على الخادم (CELIA_AGENT_TOKEN).");
  }

  // مقارنة ثابتة الزمن — نتجنب التسريب الزمني
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  const sameLength = a.length === b.length;
  // even if length differs, we still do a dummy compare to keep timing
  const ok = sameLength && timingSafeEqual(a, b);
  if (!ok) {
    throw Errors.authInvalid("توكن غير صالح.");
  }

  return { id: "agent", role: "agent", method: "agent_token" };
}
