import {
  requireSession,
  identityRepo,
  requestIdentityChange,
  policyFromEnv,
  devOtpHintEnabled,
  deliverOtp,
} from "@/lib/identity";
import { rateLimit } from "@/lib/rate-limit";
import { recordSecurityEvent } from "@/lib/monitoring";
import { json, ipOf } from "../helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** طلب تغيير الهوية: إعادة مصادثة → تحقق من القيمة الجديدة (OTP) → تأخير أمني → تنفيذ */
export async function POST(request: Request) {
  const s = await requireSession(request);
  if ("error" in s) return json({ error: s.error }, s.status);
  const repo = identityRepo();
  if (!repo) return json({ error: "قاعدة البيانات غير متاحة" }, 503);

  const body = await request.json().catch(() => ({}));
  const kind = body?.kind;
  if (kind !== "email" && kind !== "phone") return json({ error: "kind غير صالح" }, 400);

  // معدّل طلبات تغيير الهوية — سياسة لكل عملية (5/15 دقيقة)
  const changeLimit = rateLimit(request, `identity-change-${kind}`, 5, 15 * 60 * 1000);
  if (!changeLimit.ok) {
    await recordSecurityEvent(repo, {
      event: "otp_rate_limited",
      userId: s.user.id,
      ip: ipOf(request),
      requestId: request.headers.get("x-request-id"),
      metadata: { scope: `identity-change-${kind}`, limit: 5, windowMs: 15 * 60 * 1000 },
    }).catch(() => undefined);
    const response = json({ error: "محاولات كثيرة، حاول بعد قليل" }, 429);
    response.headers.set("Retry-After", String(changeLimit.retryAfter));
    return response;
  }

  const result = await requestIdentityChange({
    repo,
    user: s.user,
    kind,
    newValue: String(body?.newValue ?? ""),
    password: String(body?.password ?? ""),
    ctx: { ip: ipOf(request), requestId: request.headers.get("x-request-id") },
    now: Date.now,
    policy: policyFromEnv(),
    devOtpHint: devOtpHintEnabled(),
    deliverOtp,
  });
  if (!result.ok) return json({ error: result.error }, result.status ?? 400);
  return json(result, 202);
}
