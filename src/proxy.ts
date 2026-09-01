import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Observability: يعيّن request id لكل طلب (يكرّم x-vercel-id إن وُجد من المنصة)
 * ويمرّره للـ handlers عبر الترويسة، ويعيده في الاستجابة لتتبّع الأخطاء.
 * (Next 16: اصطلاح proxy.ts — بديل middleware.ts القديم)
 */
export function proxy(request: NextRequest) {
  const rid = request.headers.get("x-request-id") || request.headers.get("x-vercel-id") || crypto.randomUUID();

  const headers = new Headers(request.headers);
  headers.set("x-request-id", rid);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("x-request-id", rid);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
