/**
 * Error Budget — YEAR-1-RELIABILITY #3 (SLO).
 *
 * نافذة متحركة من العينات (نجاح/فشل) مع هدف نجاح (مثلًا 0.999 = 99.9%).
 * consumed(): كم نسبة ميزانية الخطأ المستهلكة (0..∞).
 * exhausted(): هل تجاوزنا الحد → يجب إيقاف الميزات والتركيز على reliability.
 *
 * الملاحظة: التغذية الحقيقية تحتاج مقاييس إنتاج (متاحة بعد النشر)؛
 * هذه الفئة هي الآلة الحاسبة — جاهزة للربط بـ monitoring.
 */
export type ErrorBudgetOptions = {
  /** نافذة القياس بالميلي ثانية (مثلًا شهر = 30*24*3600*1000). */
  windowMs: number;
  /** الهدف: نسبة النجاح المطلوبة (مثلًا 0.999). */
  targetSuccess: number;
  now?: () => number;
};

export type ErrorBudgetSnapshot = {
  total: number;
  errors: number;
  errorRate: number;
  allowedErrorRate: number;
  consumed: number; // 0..1 = 100% الميزانية مستهلكة
  exhausted: boolean;
};

export class ErrorBudget {
  private samples: { ok: boolean; at: number }[] = [];
  private readonly opts: Required<ErrorBudgetOptions>;

  constructor(opts: ErrorBudgetOptions) {
    if (opts.windowMs <= 0 || opts.targetSuccess <= 0 || opts.targetSuccess >= 1) {
      throw new Error("invalid error budget options");
    }
    this.opts = { now: () => Date.now(), ...opts };
  }

  record(ok: boolean, at?: number): void {
    const t = at ?? this.opts.now();
    this.samples.push({ ok, at: t });
    this.prune(t);
  }

  private prune(at: number) {
    const cutoff = at - this.opts.windowMs;
    while (this.samples.length > 0 && this.samples[0].at < cutoff) this.samples.shift();
  }

  snapshot(at?: number): ErrorBudgetSnapshot {
    const t = at ?? this.opts.now();
    this.prune(t);
    const total = this.samples.length;
    const errors = this.samples.filter((s) => !s.ok).length;
    const errorRate = total === 0 ? 0 : errors / total;
    const allowedErrorRate = 1 - this.opts.targetSuccess;
    // epsilon: حماية من أخطاء الفاصلة العائمة (مثل 1 - 0.9 = 0.09999999999999998)
    const EPSILON = 1e-9;
    return {
      total,
      errors,
      errorRate,
      allowedErrorRate,
      consumed: allowedErrorRate === 0 ? (errors > 0 ? Infinity : 0) : errorRate / allowedErrorRate,
      exhausted: errorRate > allowedErrorRate + EPSILON,
    };
  }
}
