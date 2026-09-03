import { NextResponse } from "next/server";
import { clientIp, isVercelRuntime } from "@/lib/client-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Diagnostic endpoint لبوابة تحقق post-deploy (P2#2) — أداة تحقق وليست ميزة منتج.
 * يعيد عنوان العميل كما يحسبه clientIp() + الرؤوس ذات الصلة، لتثبيت أن
 * السلوك الفعلي في Vercel يطابق الموثّق رسميًا (استبدال x-forwarded-for المزوّرة).
 * لا يكشف إلا عنوان المُتصل نفسه — لا أسرار ولا بيانات منتج.
 */
export function GET(request: Request) {
  return NextResponse.json({
    clientIp: clientIp(request),
    vercel: isVercelRuntime(),
    xForwardedFor: request.headers.get("x-forwarded-for") ?? null,
    xRealIp: request.headers.get("x-real-ip") ?? null,
  });
}
