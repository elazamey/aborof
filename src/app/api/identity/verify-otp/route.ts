import { authenticateAdminRequest, identityRepo, verifyChangeOtp } from "@/lib/identity";
import { json, ipOf } from "../helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** تحقق OTP القيمة الجديدة لطلب تغيير معلق */
export async function POST(request: Request) {
  const s = await authenticateAdminRequest(request);
  if ("error" in s) return json({ error: s.error }, s.status);
  const repo = identityRepo();
  if (!repo) return json({ error: "قاعدة البيانات غير متاحة" }, 503);

  const body = await request.json().catch(() => ({}));
  const result = await verifyChangeOtp({
    repo,
    user: s.user,
    requestId: String(body?.requestId ?? ""),
    code: String(body?.code ?? ""),
    ctx: { ip: ipOf(request), requestId: request.headers.get("x-request-id") },
    now: Date.now,
  });
  if (!result.ok) return json({ error: result.error }, result.status ?? 400);
  return json(result);
}
