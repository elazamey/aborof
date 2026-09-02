/**
 * Outbox Pattern + Dead Letter Queue — YEAR-1-RELIABILITY #8, #10.
 *
 * المبدأ: الأعمال غير الضرورية لإتمام الطلب (إشعارات، تحليلات، تكاملات)
 * لا تكون داخل المعاملة الرئيسية. تُسجَّل كحدث (Outbox) ثم يعالجها Worker.
 *
 * هذا التنفيذ هو **مرجع العقد الحتمي** (in-memory) للاختبارات والتطوير.
 * للإنتاج يُستبدل المخزن بجدول DB (Outbox) بنفس العقد — مقترح migration v4
 * موثّق في YEAR-1-RELIABILITY.md (يتطلب موافقة — تجميد schema).
 *
 * الخصائص:
 *  - enqueue يمنع التكرار (نفس id = لا شيء) — idempotency.
 *  - drain يعالج الأحداث المستحقة فقط (backoff قابل للحقن).
 *  - بعد maxAttempts يفشل → Dead Letter Queue (لا تختفي الأخطاء).
 */
import { randomUUID } from "node:crypto";
import { backoffDelay } from "./retry";

export type OutboxEventStatus = "pending" | "done" | "dead";

export type OutboxEvent = {
  id: string;
  type: string;
  payload: unknown;
  occurredAt: number;
  attempts: number;
  status: OutboxEventStatus;
  nextAttemptAt: number;
  lastError?: string;
};

export type OutboxOptions = {
  /** أقصى محاولات قبل DLQ (مثلًا 3). */
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => number;
};

export type DrainResult = { processed: number; failed: number; dead: number };

export class Outbox {
  private events = new Map<string, OutboxEvent>();
  private readonly opts: Required<OutboxOptions>;

  constructor(opts: OutboxOptions = {}) {
    this.opts = {
      maxAttempts: 3,
      retryBaseMs: 1000,
      retryMaxMs: 8000,
      now: () => Date.now(),
      ...opts,
    };
  }

  private now() {
    return this.opts.now();
  }

  /** يسجّل حدثًا. نفس id → لا شيء (منع التكرار). يعيد الحدث. */
  enqueue(type: string, payload: unknown, id: string = randomUUID()): OutboxEvent {
    const existing = this.events.get(id);
    if (existing) return existing;
    const now = this.now();
    const event: OutboxEvent = {
      id,
      type,
      payload,
      occurredAt: now,
      attempts: 0,
      status: "pending",
      nextAttemptAt: now,
    };
    this.events.set(id, event);
    return event;
  }

  /** الأحداث المستحقة الآن (pending و nextAttemptAt <= now). */
  dueEvents(): OutboxEvent[] {
    const now = this.now();
    return [...this.events.values()].filter((e) => e.status === "pending" && e.nextAttemptAt <= now);
  }

  /**
   * يعالج الأحداث المستحقة عبر handler.
   * - نجاح → done.
   * - فشل → attempts++ ; إن بلغ maxAttempts → dead (DLQ) مع lastError؛
   *   وإلا nextAttemptAt = now + backoff(attempts-1).
   */
  async drain(handler: (event: OutboxEvent) => Promise<void>): Promise<DrainResult> {
    const result: DrainResult = { processed: 0, failed: 0, dead: 0 };
    for (const event of this.dueEvents()) {
      try {
        await handler(event);
        event.status = "done";
        result.processed += 1;
      } catch (error) {
        event.attempts += 1;
        event.lastError = error instanceof Error ? error.message : String(error);
        if (event.attempts >= this.opts.maxAttempts) {
          event.status = "dead";
          result.dead += 1;
        } else {
          event.nextAttemptAt =
            this.now() +
            backoffDelay(event.attempts - 1, {
              baseDelayMs: this.opts.retryBaseMs,
              maxDelayMs: this.opts.retryMaxMs,
            });
          result.failed += 1;
        }
      }
    }
    return result;
  }

  deadLetter(): OutboxEvent[] {
    return [...this.events.values()].filter((e) => e.status === "dead");
  }

  stats(): { pending: number; done: number; dead: number } {
    let pending = 0;
    let done = 0;
    let dead = 0;
    for (const e of this.events.values()) {
      if (e.status === "pending") pending += 1;
      else if (e.status === "done") done += 1;
      else dead += 1;
    }
    return { pending, done, dead };
  }
}
