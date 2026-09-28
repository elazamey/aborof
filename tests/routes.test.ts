import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { setDbClientForTest } from "../src/lib/db";
import { start401Stub } from "./stub-helpers";
import { ADMIN_COOKIE, createAdminSession } from "../src/lib/auth";

/**
 * اختبارات على مستوى المسار (تُستدعى الدوال مباشرة دون شبكة).
 * تثبت أن:
 *  - المدخلات السيئة تتحول إلى VALIDATION_FAILED (422) عبر العقد المركزية.
 *  - المسارات المحمية ترفض بلا جلسة بـ AUTH_REQUIRED (401).
 *  - الاستجابات تحمل request_id ولا تُسرّب رسائل داخلية.
 */

async function json(res: Response) {
  return (await res.json()) as { error?: string; code?: string; request_id?: string };
}

describe("orders route", () => {
  test("POST rejects malformed payload with 422 VALIDATION_FAILED and request_id", async () => {
    process.env.TURSO_DATABASE_URL = ":memory:";
    const { POST } = await import("../src/app/api/orders/route");
    const req = new Request("http://x/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "content-length": "30" },
      body: JSON.stringify({ customer: "x" }), // ناقص + حقول مخالفة
    });
    const res = await POST(req);
    assert.equal(res.status, 422);
    const body = await json(res);
    assert.equal(body.code, "VALIDATION_FAILED");
    assert.ok(body.request_id);
    assert.match(res.headers.get("x-request-id") ?? "", /^req|^.+$/);
  });

  test("POST rejects unknown/extra fields (strict contract)", async () => {
    const { POST } = await import("../src/app/api/orders/route");
    const req = new Request("http://x/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer: "محمد أحمد",
        phone: "01095032221",
        address: "عنوان تفصيلي طويل بما يكفي",
        governorate: "القاهرة",
        payment: "vodafone_cash",
        items: [{ id: "p1", qty: 1 }],
        tenantId: "spoof",
      }),
    });
    const res = await POST(req);
    assert.equal(res.status, 422);
    const body = await json(res);
    assert.equal(body.code, "VALIDATION_FAILED");
  });

  test("POST with valid body but 401-rejecting database returns 503 (not 500)", async () => {
    // كتابة الطلب تصل للقاعدة (عقد صالح + مخزون كافٍ في البذرة) ثم يرفض
    // الخادم بـ 401 ⇒ يجب أن يُترجم إلى 503 محكوم.
    delete process.env.TURSO_DATABASE_URL;
    const stub = await start401Stub();
    const client = createClient({ url: stub.url, authToken: "stub-token-value" });
    setDbClientForTest(client);
    try {
      const { POST } = await import("../src/app/api/orders/route");
      const res = await POST(
        new Request("http://x/api/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customer: "محمد أحمد",
            phone: "01095032221",
            address: "شارع طويل بما يكفي لعنوان التوصيل",
            governorate: "القاهرة",
            payment: "vodafone_cash",
            items: [{ id: "p1", qty: 1 }],
          }),
        })
      );
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.code, "SERVICE_UNAVAILABLE");
      assert.ok(body.request_id);
    } finally {
      setDbClientForTest(null);
      client.close();
      await stub.close();
      delete process.env.TURSO_DATABASE_URL;
    }
  });

  test("PATCH without admin session returns 401 AUTH_REQUIRED", async () => {
    const { PATCH } = await import("../src/app/api/orders/route");
    const req = new Request("http://x/api/orders", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ORD-12345678-abcd1234", status: "مؤكد" }),
    });
    const res = await PATCH(req);
    assert.equal(res.status, 401);
    const body = await json(res);
    assert.equal(body.code, "AUTH_REQUIRED");
    assert.ok(!body.error?.toLowerCase().includes("token"));
  });
});

describe("products route", () => {
  test("POST without admin session returns 401", async () => {
    const { POST } = await import("../src/app/api/products/route");
    const req = new Request("http://x/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product: { name: "x", price: 10, stock: 1 } }),
    });
    const res = await POST(req);
    assert.equal(res.status, 401);
  });

  test("GET is public and returns products envelope", async () => {
    delete process.env.TURSO_DATABASE_URL; // استخدم بيانات البذور المحلية
    const { GET } = await import("../src/app/api/products/route");
    const res = await GET(new Request("http://x/api/products"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.products));
  });

  test("GET with malformed TURSO_DATABASE_URL falls back to seed (200) instead of 500", async () => {
    // انحدار عطل فحص 2026-09-28: رابط معطوب في بيئة الإنتاج أسقط المسار بـ 500.
    process.env.TURSO_DATABASE_URL = "not-a-url";
    try {
      const { GET } = await import("../src/app/api/products/route");
      const res = await GET(new Request("http://x/api/products"));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.products));
      assert.ok(body.products.length > 0);
    } finally {
      delete process.env.TURSO_DATABASE_URL;
    }
  });

  test("GET with 401-rejecting database returns seed (200) — الحالة B الصريحة", async () => {
    // العقد المطلوب: رفض المصادقة وقت الاستعلام (401 حقيقي من الخادم) يجب أن
    // يعطي بيانات البذرة — لا 500. يحاكي Turso: Bearer ثم رفض.
    delete process.env.TURSO_DATABASE_URL;
    const stub = await start401Stub();
    const client = createClient({ url: stub.url, authToken: "stub-token-value" });
    setDbClientForTest(client);
    try {
      const { GET } = await import("../src/app/api/products/route");
      const res = await GET(new Request("http://x/api/products"));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.products) && body.products.length > 0);
      assert.ok(stub.seen.count > 0, "يجب أن يكون السقوط بعد محاولة حقيقية مرفوضة");
      assert.ok(stub.seen.auth?.startsWith("Bearer "));
    } finally {
      setDbClientForTest(null);
      client.close();
      await stub.close();
      delete process.env.TURSO_DATABASE_URL;
    }
  });

  test("POST (admin) with 401-rejecting database returns 503 SERVICE_UNAVAILABLE", async () => {
    // الكتابة لا بديل بذرة لها: الفشل يُترجم إلى 503 محكوم — لا 500 خام.
    delete process.env.TURSO_DATABASE_URL;
    process.env.ADMIN_SESSION_SECRET = "s".repeat(40);
    const stub = await start401Stub();
    const client = createClient({ url: stub.url, authToken: "stub-token-value" });
    setDbClientForTest(client);
    try {
      const session = createAdminSession();
      const { POST } = await import("../src/app/api/products/route");
      const res = await POST(
        new Request("http://x/api/products", {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: `${ADMIN_COOKIE}=${session}` },
          body: JSON.stringify({ product: { name: "صنف اختبار", price: 25, stock: 4 } }),
        })
      );
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.code, "SERVICE_UNAVAILABLE");
    } finally {
      setDbClientForTest(null);
      client.close();
      await stub.close();
      delete process.env.TURSO_DATABASE_URL;
      delete process.env.ADMIN_SESSION_SECRET;
    }
  });
});

describe("chat route", () => {
  test("invalid body returns 422 instead of leaking errors as 200", async () => {
    delete process.env.TURSO_DATABASE_URL;
    const { POST } = await import("../src/app/api/chat/route");
    const req = new Request("http://x/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "evil", content: "hi" }] }),
    });
    const res = await POST(req);
    assert.equal(res.status, 422);
    const body = await json(res);
    assert.equal(body.code, "VALIDATION_FAILED");
  });
});
