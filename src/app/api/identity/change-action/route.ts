import { authenticateAdminRequest, identityRepo, cancelIdentityChange, applyIdentityChange } from "@/lib/identity";
import { json, ipOf } from "../helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** إلغاء طلب تغيير معلق قبل التنفيذ */
export async function POST(request: Request) {
  const s = await authenticateAdminRequest(request);
  if ("error" in s) return json({ error: s.error }, s.status);
  const repo = identityRepo();
  if (!repo) return json({ error: "قاعدة البيانات غير متاحة" }, 503);

  const body = await request.json().catch(() => ({}));
  const requestId = String(body?.requestId ?? "");
  const action = body?.action === "apply" ? "apply" : "cancel";

  const result =
    action === "apply"
      ? await applyIdentityChange({
          repo,
          user: s.user,
          requestId,
          keepSessionId: s.sessionId,
          ctx: { ip: ipOf(request), requestId: request.headers.get("x-request-id") },
          now: Date.now,
        })
      : await cancelIdentityChange({
          repo,
          user: s.user,
          requestId,
          ctx: { ip: ipOf(request), requestId: request.headers.get("x-request-id") },
          now: Date.now,
        });
  if (!result.ok) return json({ error: result.error }, result.status ?? 400);
  return json(result);
}
