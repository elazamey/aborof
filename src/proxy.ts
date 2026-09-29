import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { buildSecurityHeaders } from "@/lib/security/headers";

/**
 * يطبّق رؤوس الأمان على كل الاستجابات. CSP في وضع المراقبة (Report-Only)
 * حتى تُجمع التقارير وتُشدد لاحقًا؛ يمكن تبديلها بمتغير بيئة.
 *
 * كان هذا الملف `src/middleware.ts`. Next.js 16 أوقف اصطلاح `middleware`
 * («The "middleware" file convention is deprecated. Please use "proxy" instead»)
 * وصار الملف `src/proxy.ts` والدالة المصدَّرة `proxy`، ويعمل على Node.js لا Edge.
 * السلوك واحد حرفيًا: نفس الرؤوس ونفس المطابِق.
 */
export function proxy(request: NextRequest) {
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
