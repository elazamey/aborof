import { describe, it, expect, beforeEach } from "vitest";
import { localAnswer } from "@/lib/chat-local";

describe("localAnswer (chat-local.ts) — offline fallback", () => {
  beforeEach(() => {
    // بدون قاعدة بيانات: يجب أن يعمل من بيانات العرض (seed)
    delete process.env.TURSO_DATABASE_URL;
  });

  it("REGRESSION: answers shipping questions ending with the Arabic question mark", async () => {
    const reply = await localAnswer("كم سعر الشحن؟");
    expect(reply).toContain("50 جنيه");
  });

  it("answers the same question without punctuation", async () => {
    const reply = await localAnswer("كم سعر الشحن");
    expect(reply).toContain("50 جنيه");
  });

  it("answers payment questions", async () => {
    const reply = await localAnswer("طرق الدفع؟");
    expect(reply).toContain("فودافون كاش");
  });

  it("recommends matching products", async () => {
    const reply = await localAnswer("رشحلي منظف أرضيات");
    expect(reply).toContain("منظف أرضيات");
  });

  it("falls back to a friendly generic reply when nothing matches", async () => {
    const reply = await localAnswer("ما هو معنى الحياة؟");
    expect(reply).toContain("روفيده");
    expect(reply).toContain("سيليا");
  });
});
