/**
 * Entitlement Engine — التحقق من حدود الباقة (راجع SAAS-MODEL.md).
 *
 * القاعدة: لا يُتحقق من الخطة في الـ Frontend فقط، بل:
 *   Frontend → API → Entitlement Service → Plan Limits → Allow / Reject
 *
 * هذا التنفيذ مرجع حتمي (إضافي) — غير مربوط بالمتجر الحالي.
 */
import { PLANS, PLAN_ORDER, type Plan, type PlanLimits, type PlanId } from "./plans";

export type LimitMetric = keyof PlanLimits;

export type UsageSnapshot = {
  products: number;
  ordersThisMonth: number;
  adminUsers: number;
  storageGb: number;
  aiActionsThisMonth: number;
  integrations: number;
};

export type EntitlementResult = {
  metric: LimitMetric;
  allowed: boolean;
  limit: number;
  usage: number;
  remaining: number;
};

export function checkLimit(plan: Plan, metric: LimitMetric, usage: number): EntitlementResult {
  const limit = plan.limits[metric];
  // القاعدة: بلوغ الحد الموجب = رفض (trigger ترقية)؛ الحد الصفري يسمح بالاستخدام الصفري فقط.
  const allowed = usage < limit || (limit === 0 && usage === 0);
  const remaining = limit === Infinity ? (allowed ? Infinity : 0) : Math.max(0, limit - usage);
  return { metric, allowed, limit, usage, remaining };
}

export type UsageEvaluation = {
  allowed: boolean;
  violations: EntitlementResult[];
  /** ترقية مقترحة عند بلوغ الحد (usage-driven upgrade). */
  upgradeHints: { metric: LimitMetric; planId: PlanId }[];
};

export function evaluateUsage(plan: Plan, usage: UsageSnapshot): UsageEvaluation {
  const checks: EntitlementResult[] = [
    checkLimit(plan, "productsMax", usage.products),
    checkLimit(plan, "ordersPerMonthMax", usage.ordersThisMonth),
    checkLimit(plan, "adminUsersMax", usage.adminUsers),
    checkLimit(plan, "storageGb", usage.storageGb),
    checkLimit(plan, "aiActionsPerMonth", usage.aiActionsThisMonth),
    checkLimit(plan, "integrationsMax", usage.integrations),
  ];
  const violations = checks.filter((c) => !c.allowed);
  const hints: { metric: LimitMetric; planId: PlanId }[] = [];
  for (const v of violations) {
    const idx = PLAN_ORDER.indexOf(plan.id);
    const next = PLAN_ORDER[idx + 1];
    if (next) hints.push({ metric: v.metric, planId: next });
  }
  return { allowed: violations.length === 0, violations, upgradeHints: hints };
}

/** استرجاع خطة بالمعرّف مع fallback آمن (تُستخدم عند عدم تطابق خطة). */
export function planOf(id: string | null | undefined): Plan {
  return (id && PLANS[id as PlanId]) || PLANS.starter;
}
