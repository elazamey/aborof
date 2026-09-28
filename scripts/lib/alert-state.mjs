/**
 * آلة حالة التنبيه المجدول — التنبيه stateful لا stateless.
 *
 * المشكلة: فتح/إغلاق قضية فقط يفقد الذاكرة (كم مرة فشل متتالية؟ متى آخر
 * نجاح؟ هل هذا تعافٍ أم أول تشغيل؟). الحل: الحالة تُحفَظ **داخل متن قضية
 * التتبّع** (كتلة HTML مخفية `<!-- probe-state: {...} -->`) — فلا مخزن
 * خارجيًا، والقضية نفسها لوحة الحالة. التشغيل المجدول يقرأ السابقة ويحسب
 * التالية بهذه الدوال النقية (تُختبَر بلا شبكة)، والـ workflow يلصق الكتلة.
 *
 * الحالات: GREEN (سليم) · DEGRADED (أول عطل) · FAILED (عطلان متتاليان
 * فأكثر) · RECOVERED (نجاح بعد عطل — ثم GREEN في النجاح التالي).
 * UNKNOWN (لا أسرار في أي نطاق) يُعامَل كعطل: حدث يستحق التنبيه لا صمت.
 */

/** @typedef {"GREEN"|"DEGRADED"|"FAILED"|"RECOVERED"} AlertStateName */
/** @typedef {{state: AlertStateName, consecutive_failures: number, last_success_at: string|null, last_failure_at: string|null}} AlertState */

export const ALERT_STATES = ["GREEN", "DEGRADED", "FAILED", "RECOVERED"];

/** @returns {AlertState} */
export function freshAlertState() {
  return {
    state: "GREEN",
    consecutive_failures: 0,
    last_success_at: null,
    last_failure_at: null,
  };
}

const STATE_BLOCK_RE = /<!--\s*probe-state:\s*(\{.*?\})\s*-->/s;

/**
 * يستخرج الحالة السابقة من متن القضية — غياب الكتلة أو فسادها = حالة جديدة
 * (لا رمي أبدًا: قضية قديمة بلا كتلة تُعامَل كأول عطل موثّق).
 * @param {string} body
 * @returns {AlertState}
 */
export function parseAlertState(body) {
  const m = STATE_BLOCK_RE.exec(String(body ?? ""));
  if (!m) return freshAlertState();
  try {
    const parsed = JSON.parse(m[1]);
    if (!ALERT_STATES.includes(parsed?.state)) return freshAlertState();
    return {
      state: parsed.state,
      consecutive_failures:
        Number.isInteger(parsed.consecutive_failures) && parsed.consecutive_failures >= 0
          ? parsed.consecutive_failures
          : 0,
      last_success_at: typeof parsed.last_success_at === "string" ? parsed.last_success_at : null,
      last_failure_at: typeof parsed.last_failure_at === "string" ? parsed.last_failure_at : null,
    };
  } catch {
    return freshAlertState();
  }
}

/**
 * الحالة التالية من (السابقة، حكم المجسّ، الطابع).
 * @param {AlertState} prev
 * @param {string} probeVerdict "PASS"|"BLOCKED"|"UNKNOWN"
 * @param {string} [nowIso] طابع ISO (حقنًا للحتمية في الاختبار)
 * @returns {AlertState}
 */
export function nextAlertState(prev, probeVerdict, nowIso) {
  const base = prev && ALERT_STATES.includes(prev?.state) ? prev : freshAlertState();
  const now = String(nowIso ?? new Date().toISOString());
  if (probeVerdict === "PASS") {
    if (base.state === "GREEN" || base.state === "RECOVERED") {
      return {
        state: "GREEN",
        consecutive_failures: 0,
        last_success_at: now,
        last_failure_at: base.last_failure_at,
      };
    }
    return {
      state: "RECOVERED",
      consecutive_failures: 0,
      last_success_at: now,
      last_failure_at: base.last_failure_at,
    };
  }
  const consecutive = base.consecutive_failures + 1;
  return {
    state: consecutive >= 2 ? "FAILED" : "DEGRADED",
    consecutive_failures: consecutive,
    last_success_at: base.last_success_at,
    last_failure_at: now,
  };
}

/**
 * كتلة الحالة كما تُحفَظ في متن القضية (مخفية عن العرض، مقروءة آليًا).
 * @param {AlertState} state
 * @param {string} [updatedAt]
 */
export function formatAlertStateBlock(state, updatedAt) {
  const s = state && ALERT_STATES.includes(state?.state) ? state : freshAlertState();
  return `<!-- probe-state: ${JSON.stringify({ ...s, updated_at: String(updatedAt ?? new Date().toISOString()) })} -->`;
}
