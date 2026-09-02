/**
 * Payment Provider — واجهة مزوّد الدفع مع التطبيقات الحقيقية والاختبارية.
 *
 * قاعدة PRE_RELEASE_GATE:
 *  - لا تُستدعى بوابات الدفع الحقيقية داخل منطق الأعمال مباشرة.
 *  - الإنتاج → Real Provider (حاليًا COD فقط — دفع عند الاستلام).
 *  - الاختبارات → Test Double حتمي (Fake) يختبر العقد: success/failure/timeout/unavailable.
 *
 * ملاحظة: هذا الملف إضافي (additive) — لا يغيّر سلوك /api/orders الحالي.
 * النمط الحالي للمتجر: PAYMENT_MODE = "cod" | "vodafone_cash" (تحويل/استلام، بلا بوابة إلكترونية).
 */
export type PaymentMode = "cod" | "vodafone_cash";

export type PaymentCharge = {
  orderId: string;
  amount: number;
  customerPhone?: string;
  transferRef?: string;
};

export type PaymentResult =
  { ok: true; reference: string; mode: PaymentMode; paidNow: boolean } | { ok: false; error: string };

export interface PaymentProvider {
  readonly mode: PaymentMode;
  readonly name: string;
  /** يبدأ/يسجّل عملية الدفع للطلب. يرمي خطأً عند timeout/unavailable. */
  charge(charge: PaymentCharge): Promise<PaymentResult>;
}

/**
 * Real provider: الدفع عند الاستلام (COD) — لا مبلغ يُخصم لحظياً؛
 * العملية تُسجَّل بنجاح ويُدفع عند التوصيل. هذا هو نمط المتجر الحالي الفعلي.
 */
export const CODProvider: PaymentProvider = {
  mode: "cod",
  name: "cod-real",
  async charge(c) {
    return { ok: true, reference: `COD-${c.orderId}`, mode: "cod", paidNow: false };
  },
};

export type FakePaymentBehavior = "success" | "failure" | "timeout" | "unavailable";

/**
 * Test Double حتمي — يختبر عقد PaymentProvider في كل الحالات
 * دون أي خدمة خارجية أو دفع حقيقي.
 */
export function createFakePaymentProvider(behavior: FakePaymentBehavior = "success"): PaymentProvider {
  return {
    mode: "cod",
    name: `fake-${behavior}`,
    async charge(c) {
      switch (behavior) {
        case "timeout":
          throw new Error("payment provider timeout (fake)");
        case "unavailable":
          throw new Error("payment provider unavailable (fake)");
        case "failure":
          return { ok: false, error: "payment declined (fake)" };
        default:
          return { ok: true, reference: `FAKE-${c.orderId}`, mode: "cod", paidNow: false };
      }
    },
  };
}
