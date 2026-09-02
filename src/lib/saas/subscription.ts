/**
 * Subscription State Machine + دورة حياة الاشتراك (راجع SAAS-MODEL.md).
 *
 * الحالات: TRIAL → ACTIVE → PAST_DUE → GRACE → READ_ONLY → SUSPENDED → CANCELLED
 *
 * القاعدة: لا يُحذف متجر العميل فور انتهاء الاشتراك؛
 *   انتهاء → فترة سماح (المتجر يعمل مع تنبيهات) → Read-only (تصدير) → Suspended → Archive.
 * البيانات ملك العميل — التصدير متاح حتى في read_only.
 */
export type SubscriptionState = "trial" | "active" | "past_due" | "grace" | "read_only" | "suspended" | "cancelled";

export const VALID_TRANSITIONS: Record<SubscriptionState, SubscriptionState[]> = {
  trial: ["active", "cancelled"],
  active: ["past_due", "cancelled"],
  past_due: ["active", "grace", "suspended"],
  grace: ["active", "read_only", "suspended", "cancelled"],
  read_only: ["active", "suspended", "cancelled"],
  suspended: ["active", "cancelled"],
  cancelled: [],
};

export function canTransition(from: SubscriptionState, to: SubscriptionState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/** ينفّذ الانتقال أو يرمي خطأ (لا انتقالات عشوائية). */
export function transition(from: SubscriptionState, to: SubscriptionState): SubscriptionState {
  if (!canTransition(from, to)) {
    throw new Error(`invalid subscription transition: ${from} → ${to}`);
  }
  return to;
}

/** الجدول الزمني لانتهاء الاشتراك (policy). */
export const LIFECYCLE_POLICY = {
  graceDays: 7, // Days 1–7: المتجر يعمل + تنبيهات
  readOnlyDays: 7, // Days 8–14: Read Only (تصدير البيانات)
  archiveAfterDays: 30, // بعدها Suspended ثم Archive حسب السياسة
} as const;

export type LifecycleStage = "active" | "grace" | "read_only" | "suspended" | "archived";

export function lifecycleStageAt(expiresAt: number, now: number): { stage: LifecycleStage; daysSinceExpiry: number } {
  const days = Math.floor((now - expiresAt) / 86_400_000);
  if (days <= 0) return { stage: "active", daysSinceExpiry: 0 };
  if (days <= LIFECYCLE_POLICY.graceDays) return { stage: "grace", daysSinceExpiry: days };
  if (days <= LIFECYCLE_POLICY.graceDays + LIFECYCLE_POLICY.readOnlyDays)
    return { stage: "read_only", daysSinceExpiry: days };
  if (days <= LIFECYCLE_POLICY.archiveAfterDays) return { stage: "suspended", daysSinceExpiry: days };
  return { stage: "archived", daysSinceExpiry: days };
}

/**
 * حماية إساءة استخدام الـ 3 أشهر المجانية:
 * تجربة واحدة لكل نشاط تجاري — البريد وحده ليس كافيًا.
 * (يُطابق businessId أو البريد أو الهاتف عبر التاريخ)
 */
export type TrialGuardInput = { businessId: string; emailHash: string; phoneHash?: string };

export function hasUsedTrial(history: TrialGuardInput[], input: TrialGuardInput): boolean {
  return history.some(
    (h) =>
      h.businessId === input.businessId ||
      h.emailHash === input.emailHash ||
      (input.phoneHash !== undefined && h.phoneHash === input.phoneHash)
  );
}

/**
 * Dormant Tenant Protection: متجر تجريبي بلا نشاط (90 يومًا) →
 * suspend compute + retain database (لا حذف — يستأنف عند العودة).
 */
export function dormantTenant(
  lastActivityAt: number,
  now: number,
  thresholdDays = 90
): { dormant: boolean; action: "suspend_compute" | "retain" } {
  const dormant = now - lastActivityAt >= thresholdDays * 86_400_000;
  return dormant ? { dormant: true, action: "suspend_compute" } : { dormant: false, action: "retain" };
}
