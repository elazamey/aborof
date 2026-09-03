import { authenticateAdminRequest, identityRepo, policyFromEnv } from "@/lib/identity";
import { json } from "../helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Security Center — حالة الهوية، الجلسات النشطة، طلبات التغيير المعلقة، الأحداث الأخيرة */
export async function GET(request: Request) {
  const s = await authenticateAdminRequest(request);
  if ("error" in s) return json({ error: s.error }, s.status);
  const repo = identityRepo();
  if (!repo) return json({ error: "قاعدة البيانات غير متاحة" }, 503);
  const { user } = s;
  const now = Date.now();
  const policy = policyFromEnv();

  const sessions = (await repo.listSessions(user.id)).filter(
    (x) => x.revokedAt === null && now - x.createdAt <= policy.sessionMaxAgeMs
  );
  const pending = await repo.listPendingChangeRequests(user.id);
  const events = await repo.listSecurityEvents(user.id, 10);

  return json({
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    emailVerifiedAt: user.emailVerifiedAt,
    phone: user.phone,
    phoneVerified: user.phoneVerifiedAt !== null,
    phoneVerifiedAt: user.phoneVerifiedAt,
    passwordConfigured: user.passwordHash !== null,
    role: user.role,
    lastLoginAt: user.lastLoginAt,
    activeSessions: sessions.length,
    pendingChanges: pending.map((c) => ({
      id: c.id,
      kind: c.kind,
      status: c.status,
      requestedAt: c.requestedAt,
      expiresAt: c.expiresAt,
      securityDelayUntil: c.securityDelayUntil,
    })),
    recentEvents: events.map((e) => ({ event: e.event, createdAt: e.createdAt })),
  });
}
