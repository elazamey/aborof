import {
  identityRepo,
  requestRecovery,
  confirmRecovery,
  policyFromEnv,
  devOtpHintEnabled,
  deliverOtp,
} from "@/lib/identity";
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
    // نفس الرد دائمًا — لا فرق بين "بريد موجود" و"غير موجود"
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
