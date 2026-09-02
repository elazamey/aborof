import { NextResponse } from "next/server";
import { getRequestId } from "./request-context";
import { DomainError, Errors, toErrorResponse } from "./index";
import { metrics } from "@/lib/observability/metrics";

/**
 * غلاف موحّد لمعالجات مسارات API:
 *  - يولّد/يلتقط request_id لكل طلب ويربطه بالاستجابة.
 *  - يحوّل أي خطأ إلى استجابة آمنة عبر `toErrorResponse` (لا stack trace للعميل).
 *  - يسجّل مقاييس 4xx/5xx/429 للمراقبة.
 */
export function apiHandler(
  route: string,
  handler: (req: Request, ctx: { requestId: string }) => Promise<Response> | Response
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const requestId = getRequestId(req);
    try {
      const res = await handler(req, { requestId });
      // ضمان وجود request_id ورأس منع التخزين المؤقت للأخطاء.
      res.headers.set("X-Request-Id", requestId);
      metrics.recordRequest(route, res.status);
      return res;
    } catch (error) {
      const { status, body, headers } = toErrorResponse(error, requestId);
      if (status === 429) metrics.recordRateLimit(route);
      if (status === 422) metrics.recordValidationFailure(route);
      metrics.recordRequest(route, status);
      return NextResponse.json(body, { status, headers });
    }
  };
}

/** يقرأ جسم JSON مع حد أقصى للحجم، ويرمي خطأ DomainError بدل كشف خطأ المحلل. */
export async function readJson(request: Request, maxBytes = 32_000): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) throw Errors.payloadTooLarge();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw Errors.validationFailed("جسم الطلب ليس JSON صالحًا");
  }
  if (body == null || typeof body !== "object") throw Errors.validationFailed("بنية الطلب غير صالحة");
  return body;
}

export { DomainError, Errors };
