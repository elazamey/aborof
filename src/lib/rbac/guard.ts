import { Errors } from "@/lib/errors";
import { readAdminSessionFromRequest } from "@/lib/auth";
import { metrics } from "@/lib/observability/metrics";
import { PERMISSION_LABELS, type RbacPermission } from "./permissions";
import { recordDenial, getUserSessionState } from "./store";

/**
 * حارس الصلاحيات — نقطة الفرض الوحيدة لكل مسار إداري.
 *
 * العلم `ENABLE_RBAC` (مغلق افتراضيًا) يقرر الوضعين:
 *
 *  - **مغلق:** أي جلسة إدارة صالحة = مشغّل مفرد بكل الصلاحيات. هذا هو سلوك
 *    المستودع اليوم حرفيًا، فالغياب لا يغيّر شيئًا (`mode: "legacy"`).
 *  - **مفتوح:** الجلسة يجب أن تكون من الإصدار الثاني (v2) وتحمل هوية مستخدم
 *    موجود وحالته `active` وإصدار توكنه مطابقًا. أي خلل ⇒ 401 (فشل مغلق).
 *    الجلسة القديمة v1 **لا تُقبل** مع RBAC: لا مسار خلفي بكلمة المرور المشتركة.
 *
 * ومن هنا أيضًا تُفرض الصلاحية: النقص ⇒ 403 + عدّاد مراقبة + سطر تدقيق
 * `rbac.denied`، وكل ذلك بلا أي تفاصيل حساسة في الاستجابة.
 */

export const RBAC_FLAG = "ENABLE_RBAC" as const;

/** هل العلم مفتوح؟ قيمة واحدة مقبولة: النص "true" حرفيًا (حساس لحالة الأحرف). */
export function isRbacEnabled(): boolean {
  return process.env[RBAC_FLAG] === "true";
}

export interface RbacActor {
  id: string;
  username: string;
  displayName: string;
  roleId: string;
  roleLabel: string;
  /** الصلاحيات الفعلية كما حُلّت من الدور (قد تحوي `*`). */
  permissions: Set<string>;
  wildcard: boolean;
  /**
   * `legacy` = وضع ما قبل RBAC (مشغّل مفرد بكلمة مرور مشتركة).
   * `rbac`   = مستخدم حقيقي بدور وصلاحيات محسوبة.
   */
  mode: "rbac" | "legacy";
}

const LEGACY_ACTOR: RbacActor = {
  id: "admin",
  username: "admin",
  displayName: "مشغّل مفرد",
  roleId: "owner",
  roleLabel: "المالك (وضع قديم)",
  permissions: new Set(["*"]),
  wildcard: true,
  mode: "legacy",
};

/** هل يملك الفاعل الصلاحية؟ (وضع legacy = كل الصلاحيات، كما كان قبل RBAC). */
export function actorCan(actor: RbacActor, permission: RbacPermission): boolean {
  if (actor.mode === "legacy") return true;
  if (actor.wildcard) return true;
  return actor.permissions.has(permission);
}

export function describeActor(actor: RbacActor) {
  return {
    id: actor.id,
    username: actor.username,
    displayName: actor.displayName,
    roleId: actor.roleId,
    roleLabel: actor.roleLabel,
    mode: actor.mode,
    wildcard: actor.wildcard,
    permissions: [...actor.permissions].sort(),
  };
}

/**
 * يحسم هوية الطالب من الجلسة. يُعيد `null` لكل حالة غير صالحة (بلا استثناءات
 * متسربة)، ويرمي 503 فقط عند تعذّر قاعدة البيانات — وهي حالة فشل مغلق.
 */
export async function resolveActor(request: Request): Promise<RbacActor | null> {
  const session = readAdminSessionFromRequest(request);
  if (!session) return null;

  if (!isRbacEnabled()) {
    // العلم مغلق: سلوك اليوم حرفيًا (جلسة v1 أو v2 صالحة ⇒ مشغّل مفرد).
    return LEGACY_ACTOR;
  }

  // العلم مفتوح: v1 مرفوضة نهائيًا — لا مسار بكلمة المرور المشتركة.
  if (session.version !== 2 || !session.userId) return null;

  const state = await getUserSessionState(session.userId);
  if (!state) return null;
  if (state.status !== "active") return null;
  if (state.tokenVersion !== session.tokenVersion) return null;

  return {
    id: state.id,
    username: state.username,
    displayName: state.displayName,
    roleId: state.roleId,
    roleLabel: state.roleLabel,
    permissions: new Set(state.permissions),
    wildcard: state.wildcard,
    mode: "rbac",
  };
}

/**
 * يفرض صلاحية على الطلب أو يرمي:
 *  - 401 `AUTH_REQUIRED` بلا جلسة صالحة (نفس سلوك ما قبل RBAC).
 *  - 403 `FORBIDDEN` بجلسة صالحة بلا صلاحية — مع تدقيق وعدّاد.
 */
export async function requirePermission(request: Request, permission: RbacPermission): Promise<RbacActor> {
  const actor = await resolveActor(request);
  if (!actor) throw Errors.authRequired();

  if (!actorCan(actor, permission)) {
    metrics.recordAuthzDenied(permission);
    await recordDenial({ actor: actor.username, permission, route: new URL(request.url).pathname });
    throw Errors.forbidden(`صلاحيتك الحالية لا تشمل «${PERMISSION_LABELS[permission]}».`);
  }
  return actor;
}

/** نسخة غير رميّة للعرض في الواجهة: هل يملك الفاعل الصلاحية؟ */
export async function actorHas(request: Request, permission: RbacPermission): Promise<boolean> {
  const actor = await resolveActor(request);
  return actor ? actorCan(actor, permission) : false;
}
