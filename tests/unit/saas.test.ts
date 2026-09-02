import { describe, it, expect } from "vitest";
import { PLANS, PLAN_ORDER, TRIAL_LIMITS, TRIAL_MONTHS, ADDONS } from "@/lib/saas/plans";
import { checkLimit, evaluateUsage, planOf } from "@/lib/saas/entitlements";
import {
  canTransition,
  transition,
  lifecycleStageAt,
  hasUsedTrial,
  dormantTenant,
  VALID_TRANSITIONS,
} from "@/lib/saas/subscription";
import {
  monthlyRecurringRevenue,
  annualRunRate,
  trialToPaidConversion,
  monthlyChurn,
  averageRevenuePerPaidTenant,
  addonsMonthly,
} from "@/lib/saas/kpis";

// ───────────────────────── Plans ─────────────────────────

describe("plans (SAAS tiers)", () => {
  it("prices match the approved model (200/500/1000/2500/5000 EGP)", () => {
    expect(PLANS.starter.priceEgpPerMonth).toBe(200);
    expect(PLANS.growth.priceEgpPerMonth).toBe(500);
    expect(PLANS.pro.priceEgpPerMonth).toBe(1000);
    expect(PLANS.business.priceEgpPerMonth).toBe(2500);
    expect(PLANS.enterprise.priceEgpPerMonth).toBe(5000);
  });

  it("every limit is strictly increasing across tiers (starter < growth < pro < business < enterprise)", () => {
    const metrics = [
      "productsMax",
      "ordersPerMonthMax",
      "adminUsersMax",
      "storageGb",
      "aiActionsPerMonth",
      "integrationsMax",
    ] as const;
    for (const m of metrics) {
      for (let i = 1; i < PLAN_ORDER.length; i++) {
        const prev = PLANS[PLAN_ORDER[i - 1]].limits[m];
        const curr = PLANS[PLAN_ORDER[i]].limits[m];
        expect(curr > prev, `${m}: ${PLAN_ORDER[i - 1]}→${PLAN_ORDER[i]}`).toBe(true);
      }
    }
  });

  it("features ladder: customDomain only from Pro, multiStore only from Business, SLA only Enterprise", () => {
    expect(PLANS.starter.features.customDomain).toBe(false);
    expect(PLANS.growth.features.customDomain).toBe(false);
    expect(PLANS.pro.features.customDomain).toBe(true);
    expect(PLANS.starter.features.multiStore).toBe(false);
    expect(PLANS.business.features.multiStore).toBe(true);
    expect(PLANS.enterprise.features.sla).toBe(true);
  });

  it("trial: 3 months free with limits at or below Starter (no open-ended free cost)", () => {
    expect(TRIAL_MONTHS).toBe(3);
    const metrics = [
      "productsMax",
      "ordersPerMonthMax",
      "adminUsersMax",
      "storageGb",
      "aiActionsPerMonth",
      "integrationsMax",
    ] as const;
    for (const m of metrics) {
      expect(TRIAL_LIMITS[m], m).toBeLessThanOrEqual(PLANS.starter.limits[m]);
    }
    // منتجات التجربة أقل صرامة من Starter (50 < 100) — التجربة ليست بديلًا مجانيًا للباقة
    expect(TRIAL_LIMITS.productsMax).toBeLessThan(PLANS.starter.limits.productsMax);
  });

  it("add-ons: approved prices (AI 100/500, storage 50/10GB, admin 50, whatsapp 150, analytics 200)", () => {
    const byId = Object.fromEntries(ADDONS.map((a) => [a.id, a]));
    expect(byId["ai-500"].priceEgpPerMonth).toBe(100);
    expect(byId["storage-10gb"].priceEgpPerMonth).toBe(50);
    expect(byId["admin-extra"].priceEgpPerMonth).toBe(50);
    expect(byId["whatsapp-automation"].priceEgpPerMonth).toBe(150);
    expect(byId["advanced-analytics"].priceEgpPerMonth).toBe(200);
  });
});

// ───────────────────────── Entitlements ─────────────────────────

describe("entitlement engine", () => {
  it("checkLimit allows under the limit and computes remaining", () => {
    const r = checkLimit(PLANS.starter, "productsMax", 60);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(40);
  });

  it("checkLimit rejects at the limit (usage-driven upgrade trigger)", () => {
    const r = checkLimit(PLANS.starter, "productsMax", 100);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it("checkLimit with Infinity never blocks", () => {
    const r = checkLimit(PLANS.enterprise, "productsMax", 1_000_000);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(Infinity);
  });

  it("evaluateUsage: full usage within limits → allowed, no violations", () => {
    const e = evaluateUsage(PLANS.growth, {
      products: 500,
      ordersThisMonth: 2000,
      adminUsers: 2,
      storageGb: 5,
      aiActionsThisMonth: 300,
      integrations: 1,
    });
    expect(e.allowed).toBe(true);
    expect(e.violations).toHaveLength(0);
    expect(e.upgradeHints).toHaveLength(0);
  });

  it("evaluateUsage: reaching the products limit suggests the next tier (growth)", () => {
    const e = evaluateUsage(PLANS.starter, {
      products: 100,
      ordersThisMonth: 100,
      adminUsers: 0,
      storageGb: 1,
      aiActionsThisMonth: 10,
      integrations: 0,
    });
    expect(e.allowed).toBe(false);
    expect(e.violations.map((v) => v.metric)).toEqual(["productsMax"]);
    expect(e.upgradeHints).toEqual([{ metric: "productsMax", planId: "growth" }]);
  });

  it("evaluateUsage: exceeding AI credits on Pro suggests Business", () => {
    const e = evaluateUsage(PLANS.pro, {
      products: 100,
      ordersThisMonth: 100,
      adminUsers: 1,
      storageGb: 1,
      aiActionsThisMonth: 2500,
      integrations: 0,
    });
    expect(e.upgradeHints).toEqual([{ metric: "aiActionsPerMonth", planId: "business" }]);
  });

  it("planOf falls back to starter for unknown plan ids", () => {
    expect(planOf(null).id).toBe("starter");
    expect(planOf("nonexistent").id).toBe("starter");
    expect(planOf("pro").id).toBe("pro");
  });
});

// ───────────────────────── Subscription state machine ─────────────────────────

describe("subscription state machine", () => {
  it("approves the valid happy path", () => {
    expect(canTransition("trial", "active")).toBe(true);
    expect(canTransition("active", "past_due")).toBe(true);
    expect(canTransition("past_due", "grace")).toBe(true);
    expect(canTransition("grace", "read_only")).toBe(true);
    expect(canTransition("read_only", "suspended")).toBe(true);
    expect(canTransition("suspended", "active")).toBe(true);
    expect(canTransition("trial", "cancelled")).toBe(true);
    expect(canTransition("grace", "cancelled")).toBe(true);
  });

  it("rejects invalid jumps (no random state changes)", () => {
    expect(canTransition("trial", "suspended")).toBe(false);
    expect(canTransition("active", "read_only")).toBe(false);
    expect(canTransition("read_only", "trial")).toBe(false);
    expect(canTransition("cancelled", "active")).toBe(false);
  });

  it("transition throws on invalid moves and returns the target on valid ones", () => {
    expect(() => transition("trial", "suspended")).toThrow(/invalid subscription transition/);
    expect(transition("past_due", "grace")).toBe("grace");
  });

  it("every state has a defined transition set (no undefined)", () => {
    for (const state of Object.keys(VALID_TRANSITIONS)) {
      expect(Array.isArray(VALID_TRANSITIONS[state as keyof typeof VALID_TRANSITIONS])).toBe(true);
    }
  });
});

// ───────────────────────── Lifecycle after expiry ─────────────────────────

describe("subscription lifecycle after expiry", () => {
  const DAY = 86_400_000;
  const expires = 1_000_000_000_000;

  it("before expiry → active", () => {
    expect(lifecycleStageAt(expires, expires - DAY).stage).toBe("active");
  });

  it("days 1-7 → grace (store keeps working + alerts)", () => {
    expect(lifecycleStageAt(expires, expires + DAY).stage).toBe("grace");
    expect(lifecycleStageAt(expires, expires + 7 * DAY).stage).toBe("grace");
  });

  it("days 8-14 → read_only (export allowed)", () => {
    expect(lifecycleStageAt(expires, expires + 8 * DAY).stage).toBe("read_only");
    expect(lifecycleStageAt(expires, expires + 14 * DAY).stage).toBe("read_only");
  });

  it("days 15-30 → suspended (data retained, not deleted)", () => {
    expect(lifecycleStageAt(expires, expires + 15 * DAY).stage).toBe("suspended");
    expect(lifecycleStageAt(expires, expires + 30 * DAY).stage).toBe("suspended");
  });

  it("after 30 days → archived", () => {
    expect(lifecycleStageAt(expires, expires + 31 * DAY).stage).toBe("archived");
  });
});

// ───────────────────────── Trial abuse + dormant ─────────────────────────

describe("trial abuse protection & dormant tenants", () => {
  it("one trial per business: same businessId or emailHash or phoneHash → used", () => {
    const history = [{ businessId: "b-1", emailHash: "h-1", phoneHash: "p-1" }];
    expect(hasUsedTrial(history, { businessId: "b-1", emailHash: "other", phoneHash: "other" })).toBe(true);
    expect(hasUsedTrial(history, { businessId: "b-2", emailHash: "h-1", phoneHash: "other" })).toBe(true);
    expect(hasUsedTrial(history, { businessId: "b-2", emailHash: "other", phoneHash: "p-1" })).toBe(true);
    expect(hasUsedTrial(history, { businessId: "b-2", emailHash: "other", phoneHash: "p-2" })).toBe(false);
  });

  it("dormant: no activity for 90 days → suspend compute, retain database", () => {
    const DAY = 86_400_000;
    const now = 2_000_000_000_000;
    expect(dormantTenant(now - 89 * DAY, now).dormant).toBe(false);
    const d = dormantTenant(now - 90 * DAY, now);
    expect(d).toEqual({ dormant: true, action: "suspend_compute" });
  });
});

// ───────────────────────── KPIs ─────────────────────────

describe("platform KPIs", () => {
  it("MRR counts active + grace + past_due only (not trial/suspended/cancelled)", () => {
    const subs = [
      { plan: PLANS.starter, status: "active" as const },
      { plan: PLANS.growth, status: "grace" as const },
      { plan: PLANS.pro, status: "past_due" as const },
      { plan: PLANS.starter, status: "trial" as const },
      { plan: PLANS.starter, status: "suspended" as const },
      { plan: PLANS.growth, status: "cancelled" as const },
    ];
    expect(monthlyRecurringRevenue(subs)).toBe(200 + 500 + 1000);
  });

  it("ARR = MRR × 12", () => {
    expect(annualRunRate(121_000)).toBe(1_452_000);
  });

  it("trial→paid conversion: 250 paid / 1000 trials = 25%", () => {
    expect(trialToPaidConversion(1000, 250)).toBeCloseTo(0.25, 5);
    expect(trialToPaidConversion(0, 0)).toBe(0);
  });

  it("monthly churn: 5 cancelled of 100 active = 5%", () => {
    expect(monthlyChurn(100, 5)).toBeCloseTo(0.05, 5);
    expect(monthlyChurn(0, 5)).toBe(0);
  });

  it("ARPU = MRR / paid tenants", () => {
    expect(averageRevenuePerPaidTenant(30_000, 100)).toBe(300);
    expect(averageRevenuePerPaidTenant(30_000, 0)).toBe(0);
  });

  it("add-ons monthly revenue sums the selected add-ons", () => {
    expect(addonsMonthly(["ai-500", "storage-10gb", "whatsapp-automation"])).toBe(100 + 50 + 150);
    expect(addonsMonthly([])).toBe(0);
  });
});
