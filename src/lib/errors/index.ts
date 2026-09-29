/**
 * طبقة أخطاء مركزية.
 *
 * المبدأ: كل خطأ داخلي له كود مستقر (error code) ويُحوَّل إلى استجابة آمنة
 * لا تكشف رسائل المزودين أو الـ stack traces أو أسرار البيئة. الربط بين
 * الاستجابة وما في السجلات يتم عبر `request_id`.
 */

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "AUTH_INVALID"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "SERVICE_UNAVAILABLE"
  | "DIAGNOSTICS_DISABLED"
  | "INTERNAL_ERROR";

export interface ErrorBody {
  error: string;
  code: ErrorCode;
  request_id: string;
  /** رقم الثواني المطلوب انتظارها قبل إعادة المحاولة — يُضبط لتجاوز حد المعدل. */
  retry_after_seconds?: number;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** الرسالة الآمنة التي يجوز إظهارها للعميل. */
  readonly safeMessage: string;
  /** بيانات إضافية للسجلات فقط — لا تصل للعميل أبدًا. */
  readonly internalDetails?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(
    code: ErrorCode,
    status: number,
    safeMessage: string,
    options: { internalDetails?: Record<string, unknown>; retryAfterSeconds?: number; cause?: unknown } = {}
  ) {
    super(safeMessage, options.cause ? { cause: options.cause } : undefined);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
    this.safeMessage = safeMessage;
    this.internalDetails = options.internalDetails;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export const Errors = {
  validationFailed: (message = "البيانات المُرسلة غير صالحة", details?: Record<string, unknown>) =>
    new DomainError("VALIDATION_FAILED", 422, message, { internalDetails: details }),
  authInvalid: (message = "بيانات الدخول غير صحيحة") =>
    new DomainError("AUTH_INVALID", 401, message),
  authRequired: (message = "غير مصرح بهذا الإجراء") =>
    new DomainError("AUTH_REQUIRED", 401, message),
  forbidden: (message = "غير مصرح بهذا الإجراء") =>
    new DomainError("FORBIDDEN", 403, message),
  rateLimited: (retryAfterSeconds: number, message = "محاولات كثيرة، حاول بعد قليل") =>
    new DomainError("RATE_LIMITED", 429, message, { retryAfterSeconds }),
  notFound: (message = "العنصر غير موجود") => new DomainError("NOT_FOUND", 404, message),
  conflict: (message = "تعارض في حالة البيانات") => new DomainError("CONFLICT", 409, message),
  payloadTooLarge: (message = "حجم الطلب كبير جدًا") => new DomainError("PAYLOAD_TOO_LARGE", 413, message),
  serviceUnavailable: (message = "الخدمة غير متاحة مؤقتًا") =>
    new DomainError("SERVICE_UNAVAILABLE", 503, message),
  diagnosticsDisabled: (message = "التشخيص معطل في بيئة الإنتاج") =>
    new DomainError("DIAGNOSTICS_DISABLED", 404, message),
  internal: (message = "حدث خطأ داخلي، حاول مرة أخرى") =>
    new DomainError("INTERNAL_ERROR", 500, message),
};

/**
 * أنماط تُستخدم لإخفاء الأسرار من أي نص قبل كتابته في السجلات
 * (مثل ردود المزودين الخارجيين التي قد تحتوي توكنات).
 */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_GEMINI_KEY]"],
  [/gsk_[0-9A-Za-z_-]{20,}/g, "[REDACTED_GROQ_KEY]"],
  [/nvapi-[0-9A-Za-z_-]{16,}/g, "[REDACTED_NVIDIA_KEY]"],
  [/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]"],
  [/(key|token|secret|password)[=:]\s*[^\s"&]+/gi, "$1=[REDACTED]"],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function isProduction() {
  return process.env.NODE_ENV === "production";
}

/**
 * يحول أي خطأ إلى استجابة JSON آمنة، ويكتب التفاصيل الكاملة في السجل فقط.
 * لا يُرسَل `error.message` الخام ولا الـ stack trace إلى العميل في الإنتاج.
 */
export function toErrorResponse(error: unknown, requestId: string): { status: number; body: ErrorBody; headers?: Record<string, string> } {
  const domain =
    error instanceof DomainError
      ? error
      : (() => {
          // أخطاء مُحوَّلة مسبقًا (مثل رفض JSON كبير) لا تُلف مرتين.
          const maybe = error as { code?: ErrorCode; status?: number; safeMessage?: string };
          if (maybe && typeof maybe.code === "string" && typeof maybe.status === "number") {
            return new DomainError(maybe.code, maybe.status, maybe.safeMessage ?? "خطأ", { cause: error });
          }
          return Errors.internal();
        })();

  const internalMessage =
    error instanceof Error ? redactSecrets(`${error.name}: ${error.message}`) : String(error);

  // السجل الداخلي يحتوي التفاصيل الكاملة (مع إخفاء الأسرار) و request_id للربط.
  console.error(
    JSON.stringify({
      level: "error",
      request_id: requestId,
      code: domain.code,
      status: domain.status,
      internal_message: internalMessage,
      details: domain.internalDetails ?? null,
      stack: error instanceof Error ? redactSecrets(error.stack ?? "").split("\n").slice(0, 8).join("\n") : undefined,
    })
  );

  const body: ErrorBody = {
    error: domain.safeMessage,
    code: domain.code,
    request_id: requestId,
  };
  const headers: Record<string, string> = {
    "X-Request-Id": requestId,
    "Cache-Control": "no-store",
  };
  if (domain.retryAfterSeconds) {
    body.retry_after_seconds = domain.retryAfterSeconds;
    headers["Retry-After"] = String(domain.retryAfterSeconds);
  }
  return { status: domain.status, body, headers };
}
