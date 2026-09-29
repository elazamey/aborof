import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors/handler";
import { ADMIN_COOKIE } from "@/lib/auth";
import { describeActor, isRbacEnabled, resolveActor } from "@/lib/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * حالة جلسة الإدارة — الآن مع هوية وصلاحيات.
 *
 * في وضع RBAC، `authenticated` تعني "جلسة v2 لمستخدم فعّال" (لا مجرد توقيع
 * صحيح): جلسة v1 قديمة تعود `authenticated: false` فتُظهر الواجهة شاشة الدخول
 * بدل لوحة تفشل كل عملياتها بـ401. وعند غياب العلم يبقى السلوك كما هو حرفيًا.
 */
export const GET = apiHandler("/api/admin/session", async (request) => {
  const actor = await resolveActor(request);
  return NextResponse.json({
    authenticated: actor !== null,
    rbac: isRbacEnabled(),
    actor: actor ? describeActor(actor) : null,
  });
});

export const POST = apiHandler("/api/admin/session/logout", async () => {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
});
