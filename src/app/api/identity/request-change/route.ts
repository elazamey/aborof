import {
  requireSession,
  identityRepo,
  requestIdentityChange,
  policyFromEnv,
  devOtpHintEnabled,
  deliverOtp,
} from "@/lib/identity";
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
