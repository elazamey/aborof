/**
 * KPIs المنصة — دوال حسابية نقية للوحة الإدارة (راجع SAAS-MODEL.md).
 *
 * تُغذّى لاحقًا ببيانات حقيقية من نظام الفوترة؛ هذه الآلة الحاسبة مرجع حتمي.
 */
import { ADDONS, type Plan } from "./plans";

export type BillingStatus = "trial" | "active" | "past_due" | "grace" | "read_only" | "suspended" | "cancelled";

export type SubscriptionRow = { plan: Plan; status: BillingStatus };

/** MRR = مجموع اشتراكات الدفع الفعّالة (active + grace + past_due) — لا trial/suspended/cancelled. */
export function monthlyRecurringRevenue(subscriptions: SubscriptionRow[]): number {
  return subscriptions
    .filter((s) => s.status === "active" || s.status === "grace" || s.status === "past_due")
    .reduce((sum, s) => sum + s.plan.priceEgpPerMonth, 0);
}

export function annualRunRate(mrrValue: number): number {
  return mrrValue * 12;
}

/** Trial → Paid Conversion (أهم KPI). */
export function trialToPaidConversion(trials: number, paid: number): number {
  if (trials <= 0) return 0;
  return paid / trials;
}

/** Monthly Churn = مُلغون خلال الفترة / نشطون في بدايتها. */
export function monthlyChurn(startActive: number, cancelledDuring: number): number {
  if (startActive <= 0) return 0;
  return cancelledDuring / startActive;
}

/** ARPU = MRR / عدد المتاجر المدفوعة. */
export function averageRevenuePerPaidTenant(mrrValue: number, paidTenants: number): number {
  return paidTenants > 0 ? mrrValue / paidTenants : 0;
}

/** إيراد الـ add-ons الشهري. */
export function addonsMonthly(addonIds: string[]): number {
  return ADDONS.filter((a) => addonIds.includes(a.id)).reduce((sum, a) => sum + a.priceEgpPerMonth, 0);
}
