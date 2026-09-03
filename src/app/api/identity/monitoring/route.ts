import { identityRepo, authenticateAdminRequest } from "@/lib/identity";
import {
  computeMetrics,
  evaluateAlerts,
  monitoringPolicyFromEnv,
  pruneSecurityData,
  hotWindowMs,
} from "@/lib/monitoring";
import { json } from "../helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * لوحة المراقبة الأمنية (داخل Security Center) — owner/admin فقط.
 * Event → Aggregation → Threshold → Alert: يستدعي الكواشف عند الطلب،
 * يطبّق الاحتفاظ (prune)، ويجمع العدادات. أي فشل → degraded (لا 500).
 */
export async function GET(request: Request) {
  const s = await authenticateAdminRequest(request);
  if ("error" in s) return json({ error: s.error }, s.status);
  if (s.user.role !== "owner" && s.user.role !== "admin") {
    return json({ error: "غير مصرح", status: 403 }, 403);
  }
  const repo = identityRepo();
  if (!repo) return json({ degraded: true, metrics: null, alerts: [] });

  try {
    const policy = monitoringPolicyFromEnv();
    if (!policy.enabled) {
      // المراقبة معطلة (MONITOR_DISABLED=1) — لوحة degraded صراحة، التدفقات تعمل
      return json({ degraded: true, disabled: true, metrics: null, alerts: [] });
    }
    const now = Date.now();
    const sinceParam = Number(new URL(request.url).searchParams.get("sinceHours"));
    const sinceHours = Number.isFinite(sinceParam) && sinceParam > 0 ? Math.min(sinceParam, 24 * 30) : 24;

    // 1) كشف فوري (عتبات → تنبيهات) 2) احتفاظ 3) تجميع
    const detection = await evaluateAlerts(repo, policy, now);
    await pruneSecurityData(repo, policy, now);
    const metrics = await computeMetrics(repo, policy, sinceHours * 3600 * 1000, now);
    const alerts = await repo.listAlerts(now - 7 * 24 * 3600 * 1000, 200);

    return json({
      degraded: false,
      sinceHours,
      hotWindowDays: policy.hotRetentionDays,
      hotWindowMs: hotWindowMs(policy),
      metrics,
      alerts,
      newAlerts: detection.created.length,
    });
  } catch (error) {
    // Fail-open: لوحة المراقبة نفسها لا تُسقط — تُبلغ degraded
    console.error("[monitor] monitoring API degraded:", error);
    return json({ degraded: true, metrics: null, alerts: [] });
  }
}
