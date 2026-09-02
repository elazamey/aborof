/**
 * Webhook — واجهة التحقق من توقيع الـ webhooks مع تطبيقات حتمية.
 *
 * قاعدة PRE_RELEASE_GATE:
 *  - المتجر لا يتلقى webhooks حالياً — لكن العقد يُختبر مسبقاً:
 *    التوقيع HMAC-SHA256 (نمط "sha256=<hex>" الشائع) + حماية من التكرار (dedupe).
 *  - عند إضافة مزوّد حقيقي لاحقاً: تنفيذ WebhookVerifier بتوقيعه وإبقاء الاختبارات.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookVerifier {
  readonly name: string;
  /** يتحقق من توقيع الطلب الوارد. يجب ألا يعتمد على مقارنة غير ثابتة الزمن. */
  verify(rawBody: string, signatureHeader: string): boolean;
}

/** تحقق HMAC-SHA256 ثابت الزمن — نمط "sha256=<hex>" المستخدم لدى معظم المزوّدين. */
export function createHmacWebhookVerifier(secret: string): WebhookVerifier {
  return {
    name: "hmac-sha256",
    verify(rawBody, signatureHeader) {
      const provided = signatureHeader
        .replace(/^sha256=/, "")
        .trim()
        .toLowerCase();
      const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
      if (provided.length !== expected.length) return false;
      return timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));
    },
  };
}

/** رافض دائم — للاختبارات: توقيع مفقود/مزوّر يجب أن يُرفض. */
export const RejectAllWebhookVerifier: WebhookVerifier = {
  name: "reject-all",
  verify() {
    return false;
  },
};

/** حماية التكرار: نفس مفتاح الحدث مرة واحدة فقط (نافذة زمنية). */
export function createWebhookDeduplicator(windowMs = 5 * 60 * 1000) {
  const seen = new Map<string, number>();
  return {
    /** يعيد true إذا كان الحدث مكرراً (شوهد سابقاً داخل النافذة). */
    isDuplicate(key: string, now = Date.now()): boolean {
      const prev = seen.get(key);
      if (prev !== undefined && now - prev < windowMs) return true;
      seen.set(key, now);
      if (seen.size > 1000) {
        for (const [k, t] of seen) if (now - t >= windowMs) seen.delete(k);
      }
      return false;
    },
  };
}
