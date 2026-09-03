import {
  identityRepo,
  requestRecovery,
  confirmRecovery,
  policyFromEnv,
  devOtpHintEnabled,
  deliverOtp,
} from "@/lib/identity";
import { recordSecurityEvent } from "@/lib/monitoring";
import { rateLimit } from "@/lib/rate-limit";
import { json, ipOf } from "../helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Account Recovery — لا استرداد ضعيف ("أرسل اسم المتجر")؛
 * استرداد عبر OTP للبريد الموثق + استجابة موحدة (منع enumeration) + إبطال كل الجلسات بعد النجاح.
 */

/** طلب استرداد — استجابة موحدة دائمًا، مهما وُجد البريد أو لا */
export async function POST(request: Request) {
  const limit = rateLimit(request, "identity-recovery", 5, 15 * 60 * 1000);
  if (!limit.ok) {
    // حدث معدّل — يُحتسب في otp_rate_limit_hits (fail-open: لا يكسر الرد 429)
    const repo = identityRepo();
    if (repo) {
      await recordSecurityEvent(repo, {
        event: "otp_rate_limited",
        userId: "",
        ip: ipOf(request),
        requestId: request.headers.get("x-request-id"),
        metadata: { scope: "identity-recovery", limit: 5, windowMs: 15 * 60 * 1000 },
      }).catch(() => undefined);
    }
    const response = json({ error: "محاولات كثيرة، حاول بعد قليل" }, 429);
    response.headers.set("Retry-After", String(limit.retryAfter));
    return response;
  }
  const repo = identityRepo();
  if (!repo) return json({ error: "قاعدة البيانات غير متاحة" }, 503);

  const body = await request.json().catch(() => ({}));
  const mode = body?.mode;
  const ctx = { ip: ipOf(request), requestId: request.headers.get("x-request-id") };

  if (mode === "request") {
    const result = await requestRecovery({
      repo,
      email: String(body?.email ?? ""),
      ctx,
      now: Date.now,
      policy: policyFromEnv(),
      devOtpHint: devOtpHintEnabled(),
      deliverOtp,
    });
    // رد موحّد دائمًا إلا عند cooldown إعادة الإرسال — 429 موحّد لكل بريد
    // (موجود أو غير موجود) فلا يتسرّب وجود الحساب.
    if (!result.ok) {
      const status = result.status ?? 429;
      const response = json({ error: result.error }, status);
      if (result.retryAfterMs) response.headers.set("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
      return response;
    }
    return json({ ok: true, hint: result.devOtpHint ? "dev" : undefined });
  }

  if (mode === "confirm") {
    const result = await confirmRecovery({
      repo,
      email: String(body?.email ?? ""),
      code: String(body?.code ?? ""),
      newPassword: String(body?.newPassword ?? ""),
      ctx,
      now: Date.now,
      policy: policyFromEnv(),
    });
    if (!result.ok) return json({ error: result.error }, result.status ?? 400);
    return json({ ok: true });
  }

  return json({ error: "mode غير صالح" }, 400);
}
