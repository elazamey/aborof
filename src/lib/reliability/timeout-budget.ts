/**
 * Timeout Budget — YEAR-1-RELIABILITY #6.
 *
 * القاعدة: لا يوجد `await externalCall()` بدون حد زمني.
 * كل استدعاء خارجي (DB, AI, Email, WhatsApp, Storage, Payment) له مهلة واضحة.
 */
export class TimeoutError extends Error {
  constructor(
    public readonly label: string,
    public readonly timeoutMs: number
  ) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * يركض promise مع مهلة: إذا انتهت المهلة أولًا نرفض TimeoutError.
 * ملاحظة: لا يلغي العملية الخلفية (في Node الافتراضي لا يمكن إلغاء promise) —
 * لكن المتصل يفشل بأمان ولا ينتظر إلى الأبد.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label = "operation"): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive finite number");
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
