import {
  requireSession,
  identityRepo,
  startVerification,
  confirmVerification,
  policyFromEnv,
  devOtpHintEnabled,
  deliverOtp,
} from "@/lib/identity";
import { json, ipOf } from "../helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** التحقق الأولي للهوية: start (يرسل OTP) / confirm (يؤكد) — email أو phone */
export async function POST(request: Request) {
  const s = await requireSession(request);
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
    if (!result.ok) return json({ error: result.error }, result.status ?? 400);
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
