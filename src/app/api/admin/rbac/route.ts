import { NextResponse } from "next/server";
import { apiHandler, Errors } from "@/lib/errors/handler";
import {
  PERMISSION_ENFORCEMENT,
  PERMISSION_GROUPS,
  PERMISSION_LABELS,
  PERMISSION_WILDCARD,
  RBAC_PERMISSIONS,
  OWNER_ROLE_ID,
  actorCan,
  describeActor,
  isRbacEnabled,
  listRoles,
  listUsers,
  requirePermission,
} from "@/lib/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * لقطة لوحة الصلاحيات — قراءة فقط:
 * الأدوار والمستخدمون (بلا أي بصمة كلمة مرور) + كتالوج الصلاحيات ونقاط فرضه
 * + هوية الفاعل وصلاحياته الفعلية.
 *
 *  - العلم مغلق (`ENABLE_RBAC != "true"`) ⇒ 404 موحّد لا يكشف وجود النقطة،
 *    بنفس مبدأ `/api/admin/mcp/tools` و`/api/admin/agents`.
 *  - مفعّل ⇒ جلسة v2 إلزامية + صلاحية `rbac:read` (401 ثم 403).
 */
export const GET = apiHandler("/api/admin/rbac", async (request) => {
  if (!isRbacEnabled()) throw Errors.notFound("هذه النقطة غير متاحة");

  const actor = await requirePermission(request, "rbac:read");
  const [roles, users] = await Promise.all([listRoles(), listUsers()]);

  return NextResponse.json({
    ok: true,
    enabled: true,
    actor: describeActor(actor),
    can: {
      write: actorCan(actor, "rbac:write"),
      audit: actorCan(actor, "audit:read"),
      wildcard: actor.wildcard,
    },
    catalog: {
      permissions: [...RBAC_PERMISSIONS],
      labels: PERMISSION_LABELS,
      groups: PERMISSION_GROUPS,
      enforcement: PERMISSION_ENFORCEMENT,
      wildcard: PERMISSION_WILDCARD,
      wildcardRole: OWNER_ROLE_ID,
    },
    counts: {
      roles: roles.length,
      users: users.length,
      activeUsers: users.filter((u) => u.status === "active").length,
      /** عدد من يملك اليوم صلاحية تعديل الأدوار — رقمه لا ينزل إلى صفر أبدًا. */
      rbacWriters: users.filter((u) => u.status === "active" && (u.permissions.includes(PERMISSION_WILDCARD) || u.permissions.includes("rbac:write"))).length,
    },
    roles,
    users,
  });
});
