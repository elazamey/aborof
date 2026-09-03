import {
  authenticateAdminRequest,
  identityRepo,
  startVerification,
  confirmVerification,
  policyFromEnv,
  devOtpHintEnabled,
  deliverOtp,
} from "@/lib/identity";
import { rateLimit } from "@/lib/rate-limit";
import { recordSecurityEvent } from "@/lib/monitoring";
import { json, ipOf } from "../helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** التحقق الأولي للهوية: start (يرسل OTP) / confirm (يؤكد) — email أو phone */
export async function POST(request: Request) {
  const s = await authenticateAdminRequest(request);
  if ("error" in s) return json({ error: s.error }, s.status);
  const repo = identityRepo();
  if (!repo) return json({ error: "قاعدة البيانات غير متاحة" }, 503);

  const body = await request.json().catch(() => ({}));
  const mode = body?.mode;
  const kind = body?.kind;
  if ((mode !== "start" && mode !== "confirm") || (kind !== "email" && kind !== "phone")) {
    return json({ error: "mode/kind غير صالح" }, 400);
  }
  const ctx = { ip: ipOf(request), requestId: request.headers.get("x-request-id") };

  if (mode === "start") {
    // معدّل إرسال OTP للتحقق — سياسة لكل عملية (5/15 دقيقة لكل حساب)
    const sendLimit = rateLimit(request, `identity-otp-send-${kind}`, 5, 15 * 60 * 1000);
    if (!sendLimit.ok) {
      await recordSecurityEvent(repo, {
        event: "otp_rate_limited",
        userId: s.user.id,
        ip: ipOf(request),
        requestId: request.headers.get("x-request-id"),
        metadata: { scope: `identity-otp-send-${kind}`, limit: 5, windowMs: 15 * 60 * 1000 },
      }).catch(() => undefined);
      const response = json({ error: "محاولات كثيرة، حاول بعد قليل" }, 429);
      response.headers.set("Retry-After", String(sendLimit.retryAfter));
      return response;
    }
    const value = kind === "email" ? s.user.email : String(body?.value ?? "");
    const result = await startVerification({
      repo,
      user: s.user,
      kind,
      value,
      ctx,
      now: Date.now,
      policy: policyFromEnv(),
      devOtpHint: devOtpHintEnabled(),
      deliverOtp,
    });
    if (!result.ok) {
      const status = result.status ?? 400;
      const response = json({ error: result.error }, status);
      if (result.retryAfterMs) response.headers.set("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
      return response;
    }
    return json({ ok: true, devOtpHint: result.devOtpHint });
  }

  const result = await confirmVerification({
    repo,
    user: s.user,
    kind,
    code: String(body?.code ?? ""),
    ctx,
    now: Date.now,
  });
  if (!result.ok) return json({ error: result.error }, result.status ?? 400);
  return json({ ok: true });
}
