import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { buildSecurityHeaders } from "@/lib/security/headers";

/**
 * يطبّق رؤوس الأمان على كل الاستجابات. CSP في وضع المراقبة (Report-Only)
 * حتى تُجمع التقارير وتُشدد لاحقًا؛ يمكن تبديلها بمتغير بيئة.
 */
export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  const reportOnly = process.env.CSP_ENFORCE !== "true";
  const headers = buildSecurityHeaders(reportOnly);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  matcher: [
    // كل المسارات ما عدا أصول Next الداخلية والملفات الثابتة.
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
