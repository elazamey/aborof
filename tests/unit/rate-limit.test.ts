import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { rateLimit, rateLimitMapSize } from "@/lib/rate-limit";

function req(ip: string): Request {
  return new Request("http://x/", { headers: { "x-forwarded-for": ip } });
}

describe("rate limiter (rate-limit.ts)", () => {
  beforeEach(() => {
    // محاكاة حدود الثقة: Vercel runtime (المصدر الموثوق لعنوان العميل).
    vi.stubEnv("VERCEL", "1");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("allows up to the limit then rejects with Retry-After", () => {
    for (let i = 0; i < 3; i++) {
      expect(rateLimit(req("1.1.1.1"), "test", 3, 60_000).ok).toBe(true);
    }
    const blocked = rateLimit(req("1.1.1.1"), "test", 3, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("resets after the window elapses", () => {
    vi.useFakeTimers();
    rateLimit(req("2.2.2.2"), "test", 1, 1000);
    expect(rateLimit(req("2.2.2.2"), "test", 1, 1000).ok).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(rateLimit(req("2.2.2.2"), "test", 1, 1000).ok).toBe(true);
  });

  it("keeps separate buckets per IP and per scope", () => {
    expect(rateLimit(req("3.3.3.3"), "scopeA", 1, 60_000).ok).toBe(true);
    expect(rateLimit(req("3.3.3.3"), "scopeB", 1, 60_000).ok).toBe(true);
    expect(rateLimit(req("3.3.3.3"), "scopeA", 1, 60_000).ok).toBe(false);
    expect(rateLimit(req("4.4.4.4"), "scopeA", 1, 60_000).ok).toBe(true);
  });

  it("outside Vercel: spoofed XFF does not create per-client buckets (shared 'anonymous')", () => {
    vi.stubEnv("VERCEL", "");
    // عميلان بقيمتي XFF مختلفتين — لكن خارج حدود الثقة لا يُوثَّق أي عنوان:
    // كلاهما يقع في الدلو المشترك "anonymous" (best-effort، وليس per-client).
    expect(rateLimit(req("1.1.1.1"), "shared-scope", 1, 60_000).ok).toBe(true);
    expect(rateLimit(req("2.2.2.2"), "shared-scope", 1, 60_000).ok).toBe(false);
  });

  it("is bounded: expired buckets are pruned when the map grows", () => {
    vi.useFakeTimers();
    // أكثر من MAX_BUCKETS دلوًأ بفترات تنتهي فوراً تقريباً
    for (let i = 0; i < 1050; i++) {
      rateLimit(req(`10.0.0.${i % 250}`), `scope${i % 7}`, 5, 1);
    }
    expect(rateLimitMapSize()).toBeGreaterThanOrEqual(1000);
    // مرور الوقت → كل الدلاء انتهت
    vi.advanceTimersByTime(50);
    // استدعاء جديد يفعّل التنظيف
    rateLimit(req("10.9.9.9"), "scope-new", 5, 1);
    expect(rateLimitMapSize()).toBeLessThan(10);
  });
});
