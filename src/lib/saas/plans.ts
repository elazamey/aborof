/**
 * SaaS plans — باقات المنصة (راجع SAAS-MODEL.md).
 *
 * القرار: 5 باقات + 3 أشهر مجانية لكل متجر جديد (بلا رسوم تأسيس).
 * كل باقة تحدد 6 حدود صريحة: المنتجات، الطلبات/شهر، مدراء، تخزين، AI credits، تكاملات.
 * البيانات مرجعية (قابلة للتعديل لاحقًا دون إعادة كتابة التطبيق — Entitlement Engine).
 */
export type PlanId = "starter" | "growth" | "pro" | "business" | "enterprise";

export type PlanLimits = {
  productsMax: number;
  ordersPerMonthMax: number;
  adminUsersMax: number;
  storageGb: number;
  aiActionsPerMonth: number;
  integrationsMax: number;
};

export type PlanFeatures = {
  customDomain: boolean;
  customBranding: boolean;
  multiStore: boolean;
  webhooks: boolean;
  apiAccess: boolean;
  prioritySupport: boolean;
  sla: boolean;
  advancedAnalytics: boolean;
};

export type Plan = {
  id: PlanId;
  nameAr: string;
  priceEgpPerMonth: number;
  trialMonths: number;
  limits: PlanLimits;
  features: PlanFeatures;
};

export const PLAN_ORDER: PlanId[] = ["starter", "growth", "pro", "business", "enterprise"];

export const PLANS: Record<PlanId, Plan> = {
  starter: {
    id: "starter",
    nameAr: "Starter",
    priceEgpPerMonth: 200,
    trialMonths: 3,
    limits: {
      productsMax: 100,
      ordersPerMonthMax: 500,
      adminUsersMax: 1,
      storageGb: 2,
      aiActionsPerMonth: 100,
      integrationsMax: 0,
    },
    features: {
      customDomain: false,
      customBranding: false,
      multiStore: false,
      webhooks: false,
      apiAccess: false,
      prioritySupport: false,
      sla: false,
      advancedAnalytics: false,
    },
  },
  growth: {
    id: "growth",
    nameAr: "Growth",
    priceEgpPerMonth: 500,
    trialMonths: 3,
    limits: {
      productsMax: 1_000,
      ordersPerMonthMax: 3_000,
      adminUsersMax: 3,
      storageGb: 10,
      aiActionsPerMonth: 500,
      integrationsMax: 2,
    },
    features: {
      customDomain: false,
      customBranding: true,
      multiStore: false,
      webhooks: false,
      apiAccess: false,
      prioritySupport: false,
      sla: false,
      advancedAnalytics: false,
    },
  },
  pro: {
    id: "pro",
    nameAr: "Pro",
    priceEgpPerMonth: 1_000,
    trialMonths: 3,
    limits: {
      productsMax: 10_000,
      ordersPerMonthMax: 20_000,
      adminUsersMax: 10,
      storageGb: 30,
      aiActionsPerMonth: 2_000,
      integrationsMax: 10,
    },
    features: {
      customDomain: true,
      customBranding: true,
      multiStore: false,
      webhooks: true,
      apiAccess: true,
      prioritySupport: false,
      sla: false,
      advancedAnalytics: true,
    },
  },
  business: {
    id: "business",
    nameAr: "Business",
    priceEgpPerMonth: 2_500,
    trialMonths: 3,
    limits: {
      productsMax: 100_000,
      ordersPerMonthMax: 100_000,
      adminUsersMax: 25,
      storageGb: 100,
      aiActionsPerMonth: 10_000,
      integrationsMax: 50,
    },
    features: {
      customDomain: true,
      customBranding: true,
      multiStore: true,
      webhooks: true,
      apiAccess: true,
      prioritySupport: true,
      sla: false,
      advancedAnalytics: true,
    },
  },
  enterprise: {
    id: "enterprise",
    nameAr: "Enterprise",
    priceEgpPerMonth: 5_000,
    trialMonths: 3,
    limits: {
      productsMax: Infinity,
      ordersPerMonthMax: Infinity,
      adminUsersMax: Infinity,
      storageGb: 1_000,
      aiActionsPerMonth: 100_000,
      integrationsMax: Infinity,
    },
    features: {
      customDomain: true,
      customBranding: true,
      multiStore: true,
      webhooks: true,
      apiAccess: true,
      prioritySupport: true,
      sla: true,
      advancedAnalytics: true,
    },
  },
};

/**
 * حدود فترة التجربة (Trial) — أقل من Starter عمدًا:
 * 50 منتجًا · 200 طلب/شهر · مدير واحد · تخزين 1GB · 50 AI action/شهر.
 * حتى لا تتحول "3 أشهر مجانية" إلى تكلفة مفتوحة.
 */
export const TRIAL_MONTHS = 3;
export const TRIAL_LIMITS: PlanLimits = {
  productsMax: 50,
  ordersPerMonthMax: 200,
  adminUsersMax: 1,
  storageGb: 1,
  aiActionsPerMonth: 50,
  integrationsMax: 0,
};

/** Add-ons — مصدر ربح إضافي بدون إجبار على ترقية كاملة. */
export type Addon = { id: string; nameAr: string; priceEgpPerMonth: number; unit: string; unitPriceEgp: number };

export const ADDONS: Addon[] = [
  { id: "ai-500", nameAr: "+500 AI actions", priceEgpPerMonth: 100, unit: "action", unitPriceEgp: 0.2 },
  { id: "storage-10gb", nameAr: "+10 GB تخزين", priceEgpPerMonth: 50, unit: "GB", unitPriceEgp: 5 },
  { id: "admin-extra", nameAr: "Admin إضافي", priceEgpPerMonth: 50, unit: "user", unitPriceEgp: 50 },
  { id: "whatsapp-automation", nameAr: "أتمتة واتساب", priceEgpPerMonth: 150, unit: "store", unitPriceEgp: 150 },
  { id: "advanced-analytics", nameAr: "تحليلات متقدمة", priceEgpPerMonth: 200, unit: "store", unitPriceEgp: 200 },
];
