import { describe, it, expect, vi, afterEach } from "vitest";
import { clientIp, isVercelRuntime } from "@/lib/client-ip";
import { rateLimit } from "@/lib/rate-limit";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://x/", { headers });
}

describe("P2#2 — clientIp (trusted client IP)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("1) Vercel + trusted XFF → clientIp = العنوان", () => {
    vi.stubEnv("VERCEL", "1");
    expect(isVercelRuntime()).toBe(true);
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4" }))).toBe("1.2.3.4");
  });

  it("2) Vercel + XFF قد يكون مزوّرًا من العميل → ما يصل موثوق (الثقة في الحدود لا في القيمة)", () => {
    // على Vercel، القيمة التي تصل هي ما كتبه Vercel (يستبدل قيمة العميل — وثائق رسمية).
    // طبقة التطبيق تثق بالحدود (VERCEL=1)، وتعقيم الـspoofing مسؤولية المنصة
    // (موثّق رسميًا + بوابة تحقق post-deploy). قارن مع الحالة (5).
    vi.stubEnv("VERCEL", "1");
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.99" }))).toBe("203.0.113.99");
  });

  it("3) Vercel + XFF مفقود (ولا x-real-ip) → null", () => {
    vi.stubEnv("VERCEL", "1");
    expect(clientIp(req())).toBeNull();
  });

  it("4) Vercel + x-real-ip fallback (XFF مفقود) → x-real-ip", () => {
    vi.stubEnv("VERCEL", "1");
    expect(clientIp(req({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
  });

  it("5) non-Vercel + XFF مزوّر → null (يُتجاهل تمامًا)", () => {
    vi.stubEnv("VERCEL", "");
    expect(isVercelRuntime()).toBe(false);
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.99" }))).toBeNull();
  });

  it("6) non-Vercel + x-real-ip مزوّر → null (يُتجاهل تمامًا)", () => {
    vi.stubEnv("VERCEL", "");
    expect(clientIp(req({ "x-real-ip": "198.51.100.7" }))).toBeNull();
  });

  it("7) direct/local بلا أي headers → null (على Vercel وخارجه)", () => {
    vi.stubEnv("VERCEL", "");
    expect(clientIp(req())).toBeNull();
    vi.stubEnv("VERCEL", "1");
    expect(clientIp(req())).toBeNull();
  });

  it("8) integration: Vercel = دلاء per-IP · non-Vercel = دلو مشترك 'anonymous'", () => {
    vi.stubEnv("VERCEL", "1");
    expect(rateLimit(req({ "x-forwarded-for": "1.1.1.1" }), "int-scope", 1, 60_000).ok).toBe(true);
    // عنوان حقيقي مختلف → دلو مستقل (لا يُحجب)
    expect(rateLimit(req({ "x-forwarded-for": "2.2.2.2" }), "int-scope", 1, 60_000).ok).toBe(true);
    // نفس العنوان مرة أخرى → يُحجب
    expect(rateLimit(req({ "x-forwarded-for": "1.1.1.1" }), "int-scope", 1, 60_000).ok).toBe(false);

    vi.stubEnv("VERCEL", "");
    // خارج Vercel: القيم المزورة لا تنشئ هويات — دلو مشترك واحد
    expect(rateLimit(req({ "x-forwarded-for": "9.9.9.9" }), "int-shared", 1, 60_000).ok).toBe(true);
    expect(rateLimit(req({ "x-forwarded-for": "8.8.8.8" }), "int-shared", 1, 60_000).ok).toBe(false);
  });
});
