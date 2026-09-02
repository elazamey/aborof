/**
 * Provider Interfaces — طبقة التكاملات الخارجية (PRE_RELEASE_GATE).
 *
 * القاعدة: لا تُستدعى الخدمات الخارجية داخل منطق الأعمال مباشرة.
 *   Real Provider (الإنتاج) ← Provider Interface ← Test Double / Fake (CI والتطوير).
 *
 * الحالة الحالية لكل مزوّد (تُحدَّث في evidence/pre-release):
 *   - Payment : real = COD فقط (بلا بوابة إلكترونية) — online gateway NOT_CONFIGURED
 *   - Email   : NOT_CONFIGURED (لا مزوّد) — العقد مختبر عبر Fake
 *   - WhatsApp: NOT_CONFIGURED (روابط wa.me فقط) — العقد مختبر عبر Fake
 *   - AI      : local fallback حقيقي (chat-local) + Gemini/Groq اختياري NOT_CONFIGURED
 *   - Storage : NOT_CONFIGURED (لا رفع وسائط) — العقد مختبر عبر Memory/Failing
 *   - Webhooks: NOT_CONFIGURED (لا webhooks) — التحقق مختبر عبر HMAC verifier
 */
export * from "./payment";
export * from "./notifications";
export * from "./ai";
export * from "./storage";
export * from "./webhooks";
