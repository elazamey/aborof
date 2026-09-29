/**
 * واجهة Celia العامة — نقطة استيراد واحدة.
 *
 * - العلم `ENABLE_CELIA_AGENT` منفصل تمامًا عن `ENABLE_AGENT_FLEET` و `ENABLE_AI_AGENT`.
 * - لا يغيّر أي سلوك قائم ما دام العلم مغلقًا (القيمة الافتراضية `false`).
 * - كل فحص يقرأ البيئة مباشرة (لا cache) ليتسق عبر نسخ Vercel.
 */

export {
  CELIA_FLAG,
  CELIA_ALLOWED_SCOPES_ENV,
  CELIA_KNOWN_SCOPES,
  celiaAllowedScopes,
  isCeliaAgentActive,
  isCeliaAgentEnabled,
  isScopeAllowed,
  type CeliaScope,
} from "./config";

export {
  createCeliaScopeGuard,
  requireCeliaScope,
  type CeliaScopeGuard,
} from "./scope-guard";
