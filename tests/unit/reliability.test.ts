import { describe, it, expect } from "vitest";
import {
  CircuitBreaker,
  withCircuitBreaker,
  backoffDelay,
  withRetry,
  RetryExhaustedError,
  withTimeout,
  TimeoutError,
  Outbox,
  ErrorBudget,
} from "@/lib/reliability";

// ───────────────────────── Circuit Breaker ─────────────────────────

describe("CircuitBreaker", () => {
  const opts = { failureThreshold: 3, cooldownMs: 1000, successThreshold: 2 };

  it("starts closed and allows calls", () => {
    const cb = new CircuitBreaker(opts);
    expect(cb.getStatus().state).toBe("closed");
    expect(cb.allow()).toBe(true);
  });

  it("opens after failureThreshold consecutive failures and blocks calls", () => {
    const cb = new CircuitBreaker(opts);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.allow()).toBe(true);
    cb.recordFailure();
    expect(cb.getStatus().state).toBe("open");
    expect(cb.allow()).toBe(false);
  });

  it("a success in closed resets the failure counter", () => {
    const cb = new CircuitBreaker(opts);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getStatus().state).toBe("open");
  });

  it("reopens into half_open after the cooldown (injectable clock)", () => {
    let t = 0;
    const cb = new CircuitBreaker({ ...opts, now: () => t });
    for (let i = 0; i < 3; i++) cb.recordFailure();
    expect(cb.allow()).toBe(false);
    t = 999;
    expect(cb.allow()).toBe(false);
    t = 1000; // cooldown انتهى
    expect(cb.allow()).toBe(true);
    expect(cb.getStatus().state).toBe("half_open");
  });

  it("half_open: successThreshold successes close the circuit", () => {
    let t = 0;
    const cb = new CircuitBreaker({ ...opts, now: () => t });
    for (let i = 0; i < 3; i++) cb.recordFailure();
    t = 1000;
    expect(cb.allow()).toBe(true); // probe 1
    cb.recordSuccess();
    expect(cb.allow()).toBe(true); // probe 2
    cb.recordSuccess();
    expect(cb.getStatus().state).toBe("closed");
    expect(cb.getStatus().remainingToClose).toBeNull();
  });

  it("half_open: a probe failure reopens with a fresh cooldown", () => {
    let t = 0;
    const cb = new CircuitBreaker({ ...opts, now: () => t });
    for (let i = 0; i < 3; i++) cb.recordFailure();
    t = 1000;
    expect(cb.allow()).toBe(true);
    cb.recordFailure();
    expect(cb.getStatus().state).toBe("open");
    t = 1500;
    expect(cb.allow()).toBe(false); // cooldown جديد من لحظة الفشل
    t = 2000;
    expect(cb.allow()).toBe(true);
  });

  it("withCircuitBreaker: open circuit fails fast without calling the fn", async () => {
    let t = 0;
    const cb = new CircuitBreaker({ ...opts, now: () => t });
    let calls = 0;
    const guarded = withCircuitBreaker(cb, async () => {
      calls += 1;
      throw new Error("provider error");
    });
    for (let i = 0; i < 3; i++) {
      try {
        await guarded();
      } catch {
        /* expected */
      }
    }
    expect(cb.getStatus().state).toBe("open");
    await expect(guarded()).rejects.toThrow(/circuit open/);
    expect(calls).toBe(3); // لم يُستدعَ في المحاولة الرابعة
  });

  it("withCircuitBreaker: records success and returns the value", async () => {
    const cb = new CircuitBreaker(opts);
    const guarded = withCircuitBreaker(cb, async () => 42);
    await expect(guarded()).resolves.toBe(42);
    expect(cb.getStatus().failureCount).toBe(0);
  });
});

// ───────────────────────── Retry ─────────────────────────

describe("retry (backoff + jitter + timeout)", () => {
  it("backoffDelay is exponential and capped (deterministic without jitter)", () => {
    const base = { baseDelayMs: 1000, maxDelayMs: 8000 };
    expect(backoffDelay(0, base)).toBe(1000);
    expect(backoffDelay(1, base)).toBe(2000);
    expect(backoffDelay(2, base)).toBe(4000);
    expect(backoffDelay(3, base)).toBe(8000);
    expect(backoffDelay(10, base)).toBe(8000); // capped
  });

  it("backoffDelay jitter stays within the spread bounds", () => {
    // attempt 0 → base 1000 · spread 200 → المدى [800, 1200]
    const r = backoffDelay(0, { baseDelayMs: 1000, maxDelayMs: 8000, jitterRatio: 0.2, random: () => 1 });
    expect(r).toBeGreaterThanOrEqual(800);
    expect(r).toBeLessThanOrEqual(1200);
  });

  it("withRetry succeeds on the second attempt and respects injected sleep", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        return "done";
      },
      {
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 8000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }
    );
    expect(result).toBe("done");
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([1000]); // backoff للمحاولة الأولى الفاشلة
  });

  it("withRetry exhausts maxRetries and throws RetryExhaustedError with the last error", async () => {
    const sleeps: number[] = [];
    await expect(
      withRetry(
        async () => {
          throw new Error("always fails");
        },
        {
          maxRetries: 2,
          baseDelayMs: 10,
          maxDelayMs: 100,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        }
      )
    ).rejects.toMatchObject({ name: "RetryExhaustedError", attempts: 3 });
    expect(sleeps).toEqual([10, 20]);
  });

  it("withRetry does not retry when shouldRetry says no", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new Error("permanent");
        },
        {
          maxRetries: 5,
          baseDelayMs: 1,
          maxDelayMs: 10,
          shouldRetry: (e) => !(e instanceof Error && e.message === "permanent"),
        }
      )
    ).rejects.toThrow("permanent");
    expect(attempts).toBe(1);
  });

  it("withRetry applies a per-attempt timeout (wraps the last error)", async () => {
    await expect(
      withRetry(async () => new Promise((resolve) => setTimeout(() => resolve("late"), 100)), {
        maxRetries: 0,
        baseDelayMs: 1,
        maxDelayMs: 10,
        timeoutMs: 10,
      })
    ).rejects.toMatchObject({
      name: "RetryExhaustedError",
      lastError: expect.any(TimeoutError),
    });
  });
});

// ───────────────────────── Timeout budget ─────────────────────────

describe("withTimeout", () => {
  it("resolves when the promise is faster than the budget", async () => {
    await expect(withTimeout(Promise.resolve("fast"), 50)).resolves.toBe("fast");
  });

  it("rejects TimeoutError when the budget is exceeded", async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve("late"), 200));
    await expect(withTimeout(slow, 20, "my-op")).rejects.toMatchObject({
      name: "TimeoutError",
      label: "my-op",
    });
  });

  it("propagates the original rejection (no timeout)", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 50)).rejects.toThrow("boom");
  });
});

// ───────────────────────── Outbox + DLQ ─────────────────────────

describe("Outbox (outbox pattern + dead letter queue)", () => {
  it("enqueue dedupes by id (idempotency)", () => {
    let t = 0;
    const box = new Outbox({ now: () => t });
    const a = box.enqueue("order.created", { id: 1 }, "evt-1");
    const b = box.enqueue("order.created", { id: 1 }, "evt-1");
    expect(b).toBe(a);
    expect(box.stats().pending).toBe(1);
  });

  it("drain processes due events and marks them done", async () => {
    let t = 0;
    const box = new Outbox({ now: () => t });
    box.enqueue("email", { to: "a" }, "e1");
    box.enqueue("whatsapp", { to: "b" }, "e2");
    const handled: string[] = [];
    const r = await box.drain(async (e) => {
      handled.push(e.id);
    });
    expect(r).toEqual({ processed: 2, failed: 0, dead: 0 });
    expect(handled).toEqual(["e1", "e2"]);
    expect(box.stats()).toEqual({ pending: 0, done: 2, dead: 0 });
  });

  it("a failing handler retries with backoff (injectable clock), then succeeds", async () => {
    let t = 0;
    const box = new Outbox({ now: () => t, retryBaseMs: 1000, retryMaxMs: 4000, maxAttempts: 5 });
    box.enqueue("email", {}, "e1");
    let calls = 0;
    const r1 = await box.drain(async () => {
      calls += 1;
      if (calls < 3) throw new Error("provider down");
    });
    expect(r1.processed).toBe(0);
    expect(r1.failed).toBe(1);
    expect(calls).toBe(1);
    // غير مستحق بعد (backoff 1000)
    await box.drain(async () => {});
    expect(calls).toBe(1);
    t = 1000;
    const r2 = await box.drain(async () => {
      calls += 1;
      if (calls < 3) throw new Error("provider down");
    });
    expect(calls).toBe(2);
    expect(r2.failed).toBe(1);
    t = 3000; // backoff 2000 من t=1000
    const r3 = await box.drain(async () => {
      calls += 1;
    });
    expect(calls).toBe(3);
    expect(r3.processed).toBe(1);
    expect(box.stats()).toEqual({ pending: 0, done: 1, dead: 0 });
  });

  it("events that keep failing land in the DLQ with the last error", async () => {
    let t = 0;
    const box = new Outbox({ maxAttempts: 2, retryBaseMs: 1000, retryMaxMs: 4000, now: () => t });
    box.enqueue("webhook", {}, "e1");
    const r1 = await box.drain(async () => {
      throw new Error("always broken");
    });
    expect(r1.failed).toBe(1);
    t = 1000; // انتهى backoff (المحاولة الأولى)
    const r2 = await box.drain(async () => {
      throw new Error("always broken");
    });
    expect(r2.dead).toBe(1);
    const dead = box.deadLetter();
    expect(dead).toHaveLength(1);
    expect(dead[0].lastError).toBe("always broken");
    expect(box.stats()).toEqual({ pending: 0, done: 0, dead: 1 });
  });
});

// ───────────────────────── Error Budget ─────────────────────────

describe("ErrorBudget (SLO)", () => {
  const opts = { windowMs: 1000, targetSuccess: 0.9, now: () => 0 };

  it("consumed is 0 when everything succeeds", () => {
    const b = new ErrorBudget(opts);
    for (let i = 0; i < 100; i++) b.record(true, i);
    const s = b.snapshot(100);
    expect(s.errorRate).toBe(0);
    expect(s.consumed).toBe(0);
    expect(s.exhausted).toBe(false);
  });

  it("exhausted when error rate exceeds the allowed budget", () => {
    const b = new ErrorBudget(opts);
    for (let i = 0; i < 90; i++) b.record(true, i);
    for (let i = 90; i < 100; i++) b.record(false, i); // 10% أخطاء = الحد تمامًا
    const at = b.snapshot(100);
    expect(at.errorRate).toBeCloseTo(0.1, 5);
    expect(at.exhausted).toBe(false); // 0.1 ليس > 0.1
    b.record(false, 101);
    expect(b.snapshot(101).exhausted).toBe(true);
  });

  it("samples older than the window are pruned (sliding window)", () => {
    const b = new ErrorBudget(opts);
    for (let i = 0; i < 50; i++) b.record(false, i); // كلها أخطاء قديمة
    const s = b.snapshot(2000); // خارج النافذة كلها
    expect(s.total).toBe(0);
    expect(s.consumed).toBe(0);
  });
});
