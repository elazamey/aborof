/**
 * Retry Policy ذكية — YEAR-1-RELIABILITY #5.
 *
 * Exponential backoff + jitter + max retries + timeout لكل محاولة.
 *
 * قاعدة صارمة:
 *   retry يُستخدم فقط للعمليات الآمنة للتكرار أو idempotent.
 *   (إنشاء طلب عبر /api/orders يستخدم idempotencyKey — آمن. الدفع الأحادي غير الآمن لا يُعاد.)
 *
 * backoffDelay دالة نقية قابلة للاختبار؛ withRetry تنفّذ الحلقة مع sleep قابل للحقن.
 */
export type RetryOptions = {
  /** عدد المحاولات الإضافية بعد الأولى (مثلًا 3 → إجمالي 4 محاولات). */
  maxRetries: number;
  /** التأخير الأساسي بالميلي ثانية (مثلًا 1000). */
  baseDelayMs: number;
  /** سقف التأخير (مثلًا 8000). */
  maxDelayMs: number;
  /** نسبة عشوائية ± حول التأخير (0 = حتمي). */
  jitterRatio?: number;
  /** مهلة لكل محاولة بالميلي ثانية (اختياري). */
  timeoutMs?: number;
  /** متى نعيد المحاولة؟ الافتراضي: أي خطأ (المتصل يقرر الأمان). */
  shouldRetry?: (error: unknown) => boolean;
  /** نوم قابل للحقن (للاختبارات). */
  sleep?: (ms: number) => Promise<void>;
  /** عشوائية قابلة للحقن (للاختبارات). */
  random?: () => number;
};

export function backoffDelay(
  attempt: number,
  opts: Pick<RetryOptions, "baseDelayMs" | "maxDelayMs" | "jitterRatio" | "random">
): number {
  const base = Math.min(opts.baseDelayMs * 2 ** attempt, opts.maxDelayMs);
  const ratio = opts.jitterRatio ?? 0;
  if (ratio <= 0) return base;
  const random = opts.random ?? Math.random;
  const spread = base * ratio;
  return Math.max(0, base - spread + random() * 2 * spread);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RetryExhaustedError extends Error {
  constructor(
    public readonly lastError: unknown,
    public readonly attempts: number
  ) {
    super(`retry exhausted after ${attempts} attempts`);
    this.name = "RetryExhaustedError";
  }
}

/** ينفّذ العملية مع إعادة محاولة بحدود و backoff + jitter. يرمي RetryExhaustedError بعد النفاد. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const shouldRetry = opts.shouldRetry ?? (() => true);
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(backoffDelay(attempt - 1, { ...opts, random }));
    }
    try {
      const work = fn();
      if (opts.timeoutMs) {
        return await withTimeout(work, opts.timeoutMs, "retry attempt");
      }
      return await work;
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error)) throw error;
    }
  }
  throw new RetryExhaustedError(lastError, opts.maxRetries + 1);
}

import { withTimeout } from "./timeout-budget";
