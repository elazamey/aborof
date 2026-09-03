import { authenticateAdminRequest, identityRepo, changePassword, policyFromEnv } from "@/lib/identity";
import { json, ipOf } from "../helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** تغيير كلمة المرور: إعادة مصادثة + إبطال جلسات الأجهزة الأخرى */
export async function POST(request: Request) {
  const s = await authenticateAdminRequest(request);
  if ("error" in s) return json({ error: s.error }, s.status);
  const repo = identityRepo();
  if (!repo) return json({ error: "قاعدة البيانات غير متاحة" }, 503);

  const body = await request.json().catch(() => ({}));
  const result = await changePassword({
    repo,
    user: s.user,
    currentPassword: String(body?.currentPassword ?? ""),
    newPassword: String(body?.newPassword ?? ""),
    keepSessionId: s.sessionId,
    ctx: { ip: ipOf(request), requestId: request.headers.get("x-request-id") },
    now: Date.now,
    policy: policyFromEnv(),
  });
  if (!result.ok) return json({ error: result.error }, result.status ?? 400);
  return json({ ok: true });
}
