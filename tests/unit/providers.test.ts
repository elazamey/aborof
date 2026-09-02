import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  CODProvider,
  createFakePaymentProvider,
  NoopNotificationProvider,
  createFakeNotificationProvider,
  createFakeAIProvider,
  withAIFallback,
  MemoryStorageProvider,
  createFailingStorageProvider,
  createHmacWebhookVerifier,
  RejectAllWebhookVerifier,
  createWebhookDeduplicator,
} from "@/lib/providers";

// ───────────────────────── Payment ─────────────────────────

describe("PaymentProvider contract", () => {
  it("COD real provider: succeeds without charging now (paidNow=false)", async () => {
    const r = await CODProvider.charge({ orderId: "ORD-1", amount: 160 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mode).toBe("cod");
      expect(r.paidNow).toBe(false);
      expect(r.reference).toContain("ORD-1");
    }
  });

  it("fake success: deterministic reference and mode", async () => {
    const p = createFakePaymentProvider("success");
    const r = await p.charge({ orderId: "ORD-2", amount: 50 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reference).toBe("FAKE-ORD-2");
  });

  it("fake failure: returns ok=false (declined) without throwing", async () => {
    const p = createFakePaymentProvider("failure");
    const r = await p.charge({ orderId: "ORD-3", amount: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("declined");
  });

  it("fake timeout: throws so the caller can fail safely", async () => {
    const p = createFakePaymentProvider("timeout");
    await expect(p.charge({ orderId: "ORD-4", amount: 50 })).rejects.toThrow(/timeout/);
  });

  it("fake unavailable: throws (provider not reachable)", async () => {
    const p = createFakePaymentProvider("unavailable");
    await expect(p.charge({ orderId: "ORD-5", amount: 50 })).rejects.toThrow(/unavailable/);
  });
});

// ───────────────────────── Notifications ─────────────────────────

describe("NotificationProvider contract", () => {
  it("noop real provider: succeeds silently (no external service configured)", async () => {
    const r = await NoopNotificationProvider.send({ type: "order_created", orderId: "ORD-10" });
    expect(r.ok).toBe(true);
  });

  it("fake provider records sends and dedupes duplicate notifications", async () => {
    const p = createFakeNotificationProvider();
    const first = await p.send({ type: "order_created", orderId: "ORD-11" });
    const dup = await p.send({ type: "order_created", orderId: "ORD-11" });
    expect(first.ok).toBe(true);
    expect(dup.ok).toBe(true);
    if (dup.ok) expect(dup.duplicate).toBe(true);
    expect(p.sent.get("order_created:ORD-11")?.count).toBe(2);
  });

  it("fake failure: notification failure does not corrupt the order payload", async () => {
    const p = createFakeNotificationProvider({ fail: true });
    const order = { id: "ORD-12", total: 160, status: "جديد" };
    const r = await p.send({ type: "order_created", orderId: order.id, data: order });
    expect(r.ok).toBe(false); // فشل الإشعار لا يرمي ولا يغيّر الطلب
    expect(order).toEqual({ id: "ORD-12", total: 160, status: "جديد" });
  });

  it("fake timeout: provider hangs must be bounded by the caller (throws after delay)", async () => {
    const p = createFakeNotificationProvider({ timeoutMs: 50 });
    const start = Date.now();
    const r = await p.send({ type: "order_created", orderId: "ORD-13" });
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    expect(r.ok).toBe(true);
  });
});

// ───────────────────────── AI ─────────────────────────

describe("AIProvider contract", () => {
  it("fake success: deterministic reply text", async () => {
    const p = createFakeAIProvider({ replyText: "أهلاً! 😊" });
    const r = await p.reply("ctx", [{ role: "user", content: "مرحبا" }]);
    expect(r.text).toBe("أهلاً! 😊");
    expect(r.source).toBe("fake-ai");
  });

  it("fake failure: throws so the fallback path can kick in", async () => {
    const p = createFakeAIProvider({ fail: true });
    await expect(p.reply("ctx", [])).rejects.toThrow(/failed/);
  });

  it("withAIFallback: primary failure → fallback reply, no throw", async () => {
    const primary = createFakeAIProvider({ fail: true });
    const fallback = createFakeAIProvider({ replyText: "fallback reply" });
    const r = await withAIFallback(primary, fallback, "ctx", []);
    expect(r.text).toBe("fallback reply");
  });

  it("withAIFallback: primary success → no fallback involved", async () => {
    const primary = createFakeAIProvider({ replyText: "primary reply" });
    const fallback = createFakeAIProvider({ fail: true });
    const r = await withAIFallback(primary, fallback, "ctx", []);
    expect(r.text).toBe("primary reply");
  });

  it("timeout behavior: provider exceeding the deadline throws (caller must enforce AbortSignal)", async () => {
    const p = createFakeAIProvider({ timeoutMs: 200 });
    const start = Date.now();
    await expect(p.reply("ctx", [])).resolves.toMatchObject({ source: "fake-ai" });
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
  });
});

// ───────────────────────── Storage ─────────────────────────

describe("StorageProvider contract", () => {
  it("memory provider: put/get/delete round-trip with size and contentType", async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const f = await MemoryStorageProvider.put("img/1.png", data, "image/png");
    expect(f.size).toBe(4);
    expect(f.contentType).toBe("image/png");
    const got = await MemoryStorageProvider.get("img/1.png");
    expect(got).toEqual(data);
    expect(await MemoryStorageProvider.delete("img/1.png")).toBe(true);
    expect(await MemoryStorageProvider.get("img/1.png")).toBeNull();
  });

  it("missing key → null (no throw)", async () => {
    expect(await MemoryStorageProvider.get("does-not-exist")).toBeNull();
  });

  it("failing provider: put throws (storage error handling contract)", async () => {
    const p = createFailingStorageProvider();
    await expect(p.put("k", new Uint8Array(1), "text/plain")).rejects.toThrow(/unavailable/);
  });
});

// ───────────────────────── Webhooks ─────────────────────────

describe("Webhook signature contract", () => {
  const secret = "whsec_test_secret_123";
  const body = '{"event":"order.created","id":"ORD-20"}';

  it("HMAC verifier accepts a valid signature", () => {
    const verifier = createHmacWebhookVerifier(secret);
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(verifier.verify(body, sig)).toBe(true);
  });

  it("HMAC verifier rejects a tampered body with the original signature", () => {
    const verifier = createHmacWebhookVerifier(secret);
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(verifier.verify(body + "x", sig)).toBe(false);
  });

  it("HMAC verifier rejects a wrong secret / missing signature", () => {
    const verifier = createHmacWebhookVerifier(secret);
    const other = createHmacWebhookVerifier("wrong-secret");
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(other.verify(body, sig)).toBe(false);
    expect(verifier.verify(body, "")).toBe(false);
  });

  it("reject-all verifier: unavailable verification never accepts", () => {
    expect(RejectAllWebhookVerifier.verify(body, "sha256=anything")).toBe(false);
  });

  it("deduplicator: duplicate callback within the window is detected once", () => {
    const d = createWebhookDeduplicator(60_000);
    expect(d.isDuplicate("evt-1")).toBe(false);
    expect(d.isDuplicate("evt-1")).toBe(true);
    expect(d.isDuplicate("evt-2")).toBe(false);
    // انتهاء النافذة → يُقبل من جديد
    expect(d.isDuplicate("evt-1", Date.now() + 61_000)).toBe(false);
  });
});
