import { NextResponse } from "next/server";
import { apiHandler, Errors, readJson } from "@/lib/errors/handler";
import { rateLimit } from "@/lib/rate-limit";
import { ROLE_ID_PATTERN, createRole, deleteRole, isRbacEnabled, requirePermission, updateRole } from "@/lib/rbac";
import {
  firstZodIssue,
  rbacRoleCreateContract,
  rbacRoleUpdateContract,
} from "@/lib/validation/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * تعديل الأدوار (M1) — كل عملية كتابية هنا:
 *   1. 404 إن كان العلم مغلقًا (لا كشف لوجود النقطة).
 *   2. 401 بلا جلسة v2 صالحة، ثم 403 بلا صلاحية `rbac:write`.
 *   3. حدّ معدل على الكتابة، وعقد Zod `.strict()` لا يقبل صلاحية خارج الكتالوج.
 *   4. الأدوار المدمجة محصّنة (409) — ولا يُحذف دور مُسنَد لمستخدمين.
 *   5. سطر تدقيق بمعرّف الفاعل يُكتب في نفس معاملة التغيير.
 */

async function enforceRateLimit(request: Request, scope: string) {
  const limit = await rateLimit(request, scope, 30, 10 * 60 * 1000);
  if (!limit.ok) throw Errors.rateLimited(limit.retryAfter);
}

function guard() {
  if (!isRbacEnabled()) throw Errors.notFound("هذه النقطة غير متاحة");
}

export const POST = apiHandler("/api/admin/rbac/roles/create", async (request) => {
  guard();
  const actor = await requirePermission(request, "rbac:write");
  await enforceRateLimit(request, "admin-rbac-roles");

  const raw = await readJson(request, 8_000);
  const parsed = rbacRoleCreateContract.safeParse(raw);
  if (!parsed.success) throw Errors.validationFailed(firstZodIssue(parsed.error));

  const { role } = parsed.data;
  const result = await createRole(
    { id: role.id, label: role.label, description: role.description, permissions: role.permissions },
    actor.username
  );
  return NextResponse.json({ ok: true, ...result });
});

export const PATCH = apiHandler("/api/admin/rbac/roles/update", async (request) => {
  guard();
  const actor = await requirePermission(request, "rbac:write");
  await enforceRateLimit(request, "admin-rbac-roles");

  const raw = await readJson(request, 8_000);
  const parsed = rbacRoleUpdateContract.safeParse(raw);
  if (!parsed.success) throw Errors.validationFailed(firstZodIssue(parsed.error));

  const { role } = parsed.data;
  const result = await updateRole(
    { id: role.id, label: role.label, description: role.description, permissions: role.permissions },
    actor.username
  );
  return NextResponse.json({ ok: true, ...result });
});

export const DELETE = apiHandler("/api/admin/rbac/roles/delete", async (request) => {
  guard();
  const actor = await requirePermission(request, "rbac:write");
  await enforceRateLimit(request, "admin-rbac-roles");

  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!ROLE_ID_PATTERN.test(id)) throw Errors.validationFailed("معرّف دور غير صالح");

  const result = await deleteRole(id, actor.username);
  return NextResponse.json({ ok: true, ...result });
});
