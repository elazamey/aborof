import { NextResponse } from "next/server";
import { apiHandler, Errors, readJson } from "@/lib/errors/handler";
import { rateLimit } from "@/lib/rate-limit";
import { ADMIN_COOKIE } from "@/lib/auth";
import {
  actorCan,
  createUser,
  deleteUser,
  isRbacEnabled,
  requirePermission,
  resolveActor,
  updateUser,
  verifyUserPassword,
} from "@/lib/rbac";
import {
  firstZodIssue,
  rbacUserCreateContract,
  rbacUserUpdateContract,
} from "@/lib/validation/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * تعديل المستخدمين (M1).
 *
 * صلاحيتان مختلفتان عمدًا:
 *
 *  - **`rbac:write`** — إنشاء/تعديل/حذف أي مستخدم (تغيير الدور، التعطيل،
 *    وكلمة المرور بلا معرفة القديمة؛ هذا هو معنى "صلاحية حكم").
 *  - **بدون `rbac:write`** — الوزر الوحيد المسموح هو **تغيير كلمة مرور النفس**
 *    وبشرط إرسال `currentPassword` الصحيحة، وبلا أي تغيير في الدور أو الحالة
 *    (منع تصعيد الصلاحيات الذاتي). أي تعديل آخر ⇒ 403.
 *
 * وفي كل الأحوال: تغيير كلمة المرور/الدور/الحالة يرفع `token_version`، فتُبطل
 * كل جلسات ذلك المستخدم فورًا — وإذا كان هو نفسه من غيّر كلمة مروره، نُخرج
 * جلسته الحالية صراحةً (كوكي فارغ) ليعيد الدخول بكلمة المرور الجديدة.
 */

async function enforceRateLimit(request: Request, scope: string) {
  const limit = await rateLimit(request, scope, 30, 10 * 60 * 1000);
  if (!limit.ok) throw Errors.rateLimited(limit.retryAfter);
}

function guard() {
  if (!isRbacEnabled()) throw Errors.notFound("هذه النقطة غير متاحة");
}

export const POST = apiHandler("/api/admin/rbac/users/create", async (request) => {
  guard();
  const actor = await requirePermission(request, "rbac:write");
  await enforceRateLimit(request, "admin-rbac-users");

  const raw = await readJson(request, 8_000);
  const parsed = rbacUserCreateContract.safeParse(raw);
  if (!parsed.success) throw Errors.validationFailed(firstZodIssue(parsed.error));

  const { user } = parsed.data;
  const result = await createUser(
    {
      username: user.username,
      displayName: user.displayName,
      roleId: user.roleId,
      password: user.password,
    },
    actor.username
  );
  return NextResponse.json({ ok: true, ...result });
});

export const PATCH = apiHandler("/api/admin/rbac/users/update", async (request) => {
  guard();
  const actor = await resolveActor(request);
  if (!actor) throw Errors.authRequired();

  await enforceRateLimit(request, "admin-rbac-users");

  const raw = await readJson(request, 8_000);
  const parsed = rbacUserUpdateContract.safeParse(raw);
  if (!parsed.success) throw Errors.validationFailed(firstZodIssue(parsed.error));
  const { user } = parsed.data;

  const canWrite = actorCan(actor, "rbac:write");
  let selfServicePassword = false;

  if (!canWrite) {
    // مسار الوزر الوحيد: كلمة مرور النفس. أي حقل آخر = محاولة تصعيد ⇒ 403.
    if (actor.mode !== "rbac" || user.id !== actor.id) {
      throw Errors.forbidden("تعديل مستخدم آخر يحتاج صلاحية «تعديل الأدوار والمستخدمين».");
    }
    if (user.roleId !== undefined || user.status !== undefined || user.displayName !== undefined) {
      throw Errors.forbidden("لا يمكنك تغيير دورك أو حالتك أو اسمك — هذا يحتاج صلاحية «تعديل الأدوار والمستخدمين».");
    }
    if (user.password === undefined) {
      throw Errors.validationFailed("لا يوجد أي تغيير في الطلب");
    }
    if (!user.currentPassword || !(await verifyUserPassword(actor.id, user.currentPassword))) {
      throw Errors.authInvalid("كلمة المرور الحالية غير صحيحة.");
    }
    selfServicePassword = true;
  }

  await updateUser(
    {
      id: user.id,
      displayName: user.displayName,
      roleId: user.roleId,
      status: user.status,
      password: user.password,
    },
    actor.username
  );

  const response = NextResponse.json({
    ok: true,
    id: user.id,
    // تغيير كلمة المرور يُبطل الجلسات؛ إن كان لصاحبها نُخرجه ليعيد الدخول.
    reauth_required: Boolean(user.password) && user.id === actor.id,
    self_service: selfServicePassword,
  });
  if (user.password && user.id === actor.id) {
    response.cookies.set(ADMIN_COOKIE, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
  }
  return response;
});

export const DELETE = apiHandler("/api/admin/rbac/users/delete", async (request) => {
  guard();
  const actor = await requirePermission(request, "rbac:write");
  await enforceRateLimit(request, "admin-rbac-users");

  const id = (new URL(request.url).searchParams.get("id") ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(id)) throw Errors.validationFailed("معرّف مستخدم غير صالح");

  const result = await deleteUser(id, actor.username);
  if (id === actor.id) {
    // حذف النفس: لا استثناء منطقي، لكن نُخرج الجلسة بدل إبقاء كوكي لحساب زال.
    const response = NextResponse.json({ ok: true, ...result, self_deleted: true });
    response.cookies.set(ADMIN_COOKIE, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return response;
  }
  return NextResponse.json({ ok: true, ...result });
});
