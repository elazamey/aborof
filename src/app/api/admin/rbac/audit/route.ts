import { NextResponse } from "next/server";
import { apiHandler, Errors } from "@/lib/errors/handler";
import { isRbacEnabled, listAudit, requirePermission } from "@/lib/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * سجل التدقيق الإداري — قراءة فقط (صلاحية `audit:read`).
 *
 * السجل يحوي: من فعل ماذا ومتى (action/entity/entity_id/actor/created_at)
 * وتفاصيل مُنقّاة عبر `sanitizeAuditDetails` (أي مفتاح يشبه كلمة مرور/بصمة/سر
 * يُستبدل بـ`[REDACTED]` قبل الكتابة أصلًا). لا يُنفَّذ هنا أي تعديل أو حذف:
 * سجل التدقيق للإضافة فقط — لا نقطة واحدة في النظام تعدّله.
 */
export const GET = apiHandler("/api/admin/rbac/audit", async (request) => {
  if (!isRbacEnabled()) throw Errors.notFound("هذه النقطة غير متاحة");

  await requirePermission(request, "audit:read");

  const raw = new URL(request.url).searchParams.get("limit");
  const limit = raw ? Number(raw) : 50;
  if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
    throw Errors.validationFailed("limit يجب أن يكون رقمًا بين 1 و200");
  }

  const entries = await listAudit(limit);
  return NextResponse.json({ ok: true, count: entries.length, entries });
});
