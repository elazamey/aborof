/**
 * Circuit Breaker — قاطع دائرة للخدمات الخارجية (YEAR-1-RELIABILITY #4).
 *
 * الحالات: CLOSED (يعمل) → OPEN (يتوقف عن القصف) → HALF_OPEN (تجربة استكشافية)
 * ثم يعود CLOSED عند النجاح أو OPEN عند الفشل.
 *
 * يمنع: فشل مزوّد → 1000 طلب → 1000 timeout → استنزاف التطبيق.
 * قابل للحقن بالوقت (clock) للاختبار الحتمي.
 */
export type CircuitState = "closed" | "open" | "half_open";

export type CircuitBreakerOptions = {
  /** عدد الإخفاقات المتتالية لفتح الدائرة (مثلًا 3). */
  failureThreshold: number;
  /** مدة بقاء الدائرة مفتوحة قبل السماح بتجربة استكشافية (مثلًا 30_000ms). */
  cooldownMs: number;
  /** عدد النجاحات المتتالية في HALF_OPEN لإغلاق الدائرة (مثلًا 2). */
  successThreshold: number;
  /** ساعة قابلة للحقن (للاختبارات). */
  now?: () => number;
};

export type CircuitBreakerStatus = {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  openedAt: number;
  /** كم نجاحًا متبقيًا في HALF_OPEN لإغلاق الدائرة. */
  remainingToClose: number | null;
};

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private openedAt = 0;
  private readonly opts: Required<CircuitBreakerOptions>;

  constructor(opts: CircuitBreakerOptions) {
    if (opts.failureThreshold < 1 || opts.cooldownMs < 0 || opts.successThreshold < 1) {
      throw new Error("invalid circuit breaker options");
    }
    this.opts = { now: () => Date.now(), ...opts };
  }

  private now() {
    return this.opts.now();
  }

  /** هل نسمح بتنفيذ العملية الآن؟ */
  allow(): boolean {
    const t = this.now();
    if (this.state === "open") {
      if (t - this.openedAt >= this.opts.cooldownMs) {
        this.transition("half_open");
        this.successCount = 0;
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    if (this.state === "half_open") {
      this.successCount += 1;
      if (this.successCount >= this.opts.successThreshold) {
        this.failureCount = 0;
        this.successCount = 0;
        this.transition("closed");
      }
    } else {
      // في CLOSED: نجاح واحد يصفّر عدّاد الإخفاقات المتتالية
      this.failureCount = 0;
    }
  }

  recordFailure(): void {
    if (this.state === "half_open") {
      // فشل التجربة الاستكشافية → نعود OPEN فورًا (cooldown جديد)
      this.failureCount = 0;
      this.successCount = 0;
      this.openedAt = this.now();
      this.transition("open");
      return;
    }
    this.failureCount += 1;
    if (this.failureCount >= this.opts.failureThreshold) {
      this.openedAt = this.now();
      this.transition("open");
    }
  }

  getStatus(): CircuitBreakerStatus {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      openedAt: this.openedAt,
      remainingToClose: this.state === "half_open" ? Math.max(0, this.opts.successThreshold - this.successCount) : null,
    };
  }

  private transition(next: CircuitState) {
    this.state = next;
  }
}

/**
 * يغلّف دالة بمزوّد خارجي بقاطع الدائرة:
 *  - OPEN → يرفض فورًا (خطأ "circuit open") دون استدعاء المزوّد.
 *  - نجاح → recordSuccess · فشل → recordFailure.
 */
export function withCircuitBreaker<T extends unknown[]>(
  breaker: CircuitBreaker,
  fn: (...args: T) => Promise<unknown>
): (...args: T) => Promise<unknown> {
  return async (...args: T) => {
    if (!breaker.allow()) {
      throw new Error("circuit open — provider skipped (fallback should be used)");
    }
    try {
      const result = await fn(...args);
      breaker.recordSuccess();
      return result;
    } catch (error) {
      breaker.recordFailure();
      throw error;
    }
  };
}
