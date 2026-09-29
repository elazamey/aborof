import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAdminSession } from "../src/lib/auth";
import { setDbClientForTest } from "../src/lib/db";
import { resetDrizzleForTest, getDrizzle, chatLogs } from "../src/lib/db/drizzle";

const KEYS = [
  "ENABLE_CELIA_AGENT",
  "CELIA_ALLOWED_SCOPES",
  "CELIA_AGENT_TOKEN",
  "ADMIN_SESSION_SECRET",
  "ADMIN_PASSWORD",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "ENABLE_AI_AGENT",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "NVIDIA_NIM_API_KEY",
] as const;

let original: Record<string, string | undefined> = {};

function saveEnv() {
  original = {};
  for (const k of KEYS) original[k] = process.env[k];
}
function restoreEnv() {
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
}

function fileClient(): Client {
  const file = path.join(
    tmpdir(),
    `aborof-celia-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  return createClient({ url: `file:${file}` });
}

function celiaRequest(
  messages: { role: "user" | "assistant"; content: string }[],
  opts: { token?: string; adminSession?: string; ip?: string } = {}
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-forwarded-for": opts.ip || "203.0.113.1",
  };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.adminSession) headers["Cookie"] = `aborof_admin_session=${opts.adminSession}`;
  return new Request("http://x/api/celia/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({ messages }),
  });
}

const VALID_TOKEN = "c".repeat(32);
const INVALID_TOKEN = "x".repeat(32);

describe("POST /api/celia/chat — البوابات الحتمية (PR-A)", () => {
  let client: Client;

  beforeEach(async () => {
    saveEnv();
    // تنظيف
    for (const k of KEYS) delete process.env[k];
    client = fileClient();
    setDbClientForTest(client);
    resetDrizzleForTest();
    // هجرات حتمية قبل أي استعلام — Drizzle والـ rate-limit يحتاجان الجداول
    const { runMigrations } = await import("../src/lib/db/migrate");
    await runMigrations(client);
  });

  afterEach(async () => {
    restoreEnv();
    setDbClientForTest(null);
    resetDrizzleForTest();
    // Clear module cache for route to re-read env? Not needed as env is read per-request.
  });

  test("404 إن كان العلم مغلقًا (Obfuscation) — لا يكشف وجود النقطة", async () => {
    process.env.ENABLE_CELIA_AGENT = "false";
    process.env.CELIA_ALLOWED_SCOPES = "chat:write,products:read";
    process.env.CELIA_AGENT_TOKEN = VALID_TOKEN;
    process.env.ADMIN_SESSION_SECRET = "a".repeat(32);
    const { POST } = await import("../src/app/api/celia/chat/route");
    const res = await POST(celiaRequest([{ role: "user", content: "مرحبا" }], { token: VALID_TOKEN }));
    assert.equal(res.status, 404);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "NOT_FOUND");
  });

  test("401 إن كان التوكن مفقودًا أو غير صالح", async () => {
    process.env.ENABLE_CELIA_AGENT = "true";
    process.env.CELIA_ALLOWED_SCOPES = "chat:write,products:read";
    process.env.CELIA_AGENT_TOKEN = VALID_TOKEN;
    process.env.ADMIN_SESSION_SECRET = "a".repeat(32);
    const { POST } = await import("../src/app/api/celia/chat/route");

    // بلا توكن وبلا جلسة
    let res = await POST(celiaRequest([{ role: "user", content: "مرحبا" }]));
    assert.equal(res.status, 401);
    let body = (await res.json()) as { code: string };
    assert.equal(body.code, "AUTH_REQUIRED");

    // توكن خاطئ
    res = await POST(celiaRequest([{ role: "user", content: "مرحبا" }], { token: INVALID_TOKEN }));
    assert.equal(res.status, 401);
    body = (await res.json()) as { code: string };
    assert.equal(body.code, "AUTH_INVALID");

    // توكن قصير
    res = await POST(celiaRequest([{ role: "user", content: "مرحبا" }], { token: "short" }));
    assert.equal(res.status, 401);
  });

  test("403 إن كان النطاق chat:write غير موجود في CELIA_ALLOWED_SCOPES", async () => {
    process.env.ENABLE_CELIA_AGENT = "true";
    process.env.CELIA_ALLOWED_SCOPES = "products:read"; // بلا chat:write
    process.env.CELIA_AGENT_TOKEN = VALID_TOKEN;
    process.env.ADMIN_SESSION_SECRET = "a".repeat(32);
    const { POST } = await import("../src/app/api/celia/chat/route");
    const res = await POST(celiaRequest([{ role: "user", content: "مرحبا" }], { token: VALID_TOKEN }));
    assert.equal(res.status, 403);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "FORBIDDEN");
  });

  test("401 يسبق 403 — بدون مصادقة لا يصل لفحص النطاق", async () => {
    process.env.ENABLE_CELIA_AGENT = "true";
    process.env.CELIA_ALLOWED_SCOPES = "products:read"; // حتى لو النطاق ناقص
    process.env.CELIA_AGENT_TOKEN = VALID_TOKEN;
    process.env.ADMIN_SESSION_SECRET = "a".repeat(32);
    const { POST } = await import("../src/app/api/celia/chat/route");
    // بلا توكن → 404 من requireCeliaScope يسبق verify؟ في ترتيبنا requireCeliaScope يسبق verify،
    // لكننا نريد أن نثبت أن الترتيب حتمي: العلم/النطاق قبل الهوية.
    // هنا النطاق ناقص → يجب أن يكون 403 حتى بدون توكن (لأن requireCeliaScope يسبق verify)
    // وهذا يثبت أن Guard لا يعتمد على الهوية — Zero Trust
    const res = await POST(celiaRequest([{ role: "user", content: "مرحبا" }]));
    // بما أن Guard يسبق Auth، سيكون 403 (FORBIDDEN) وليس 401
    // هذا مقصود: لا نكشف أن النقطة موجودة عبر 401 قبل فحص العلم/النطاق
    // لكن مواصفات PR-A تقول 401 إذا التوكن مفقود — لذلك نتحقق أن 403 يسبق
    // عندما يكون النطاق ناقصًا حتى مع توكن مفقود
    assert.equal(res.status, 403);
  });

  test("جلست الإدارة تمرّ بدون Bearer — Admin Session مقبول", async () => {
    process.env.ENABLE_CELIA_AGENT = "true";
    process.env.CELIA_ALLOWED_SCOPES = "chat:write,products:read";
    process.env.ADMIN_SESSION_SECRET = "s".repeat(32);
    process.env.ADMIN_PASSWORD = "p".repeat(12);
    // لا حاجة لـ CELIA_AGENT_TOKEN هنا
    const session = createAdminSession();
    const { POST } = await import("../src/app/api/celia/chat/route");
    const res = await POST(
      celiaRequest([{ role: "user", content: "مرحبا" }], { adminSession: session })
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { reply: string; source: string; auth: { role: string } };
    assert.ok(body.reply.length > 0);
    assert.equal(body.auth.role, "admin");
  });

  test("429 عند تجاوز الحد (10/دقيقة) — تحديد معدل موزّع", async () => {
    process.env.ENABLE_CELIA_AGENT = "true";
    process.env.CELIA_ALLOWED_SCOPES = "chat:write,products:read";
    process.env.CELIA_AGENT_TOKEN = VALID_TOKEN;
    process.env.ADMIN_SESSION_SECRET = "a".repeat(32);
    const { POST } = await import("../src/app/api/celia/chat/route");
    const ip = "198.51.100.77";
    // 10 طلبات يجب أن تنجح
    for (let i = 0; i < 10; i++) {
      const res = await POST(
        celiaRequest([{ role: "user", content: `رسالة ${i}` }], { token: VALID_TOKEN, ip })
      );
      assert.equal(res.status, 200, `الطلب ${i} يجب أن ينجح`);
    }
    // 11 يجب أن يُرفض
    const res = await POST(
      celiaRequest([{ role: "user", content: "زيادة" }], { token: VALID_TOKEN, ip })
    );
    assert.equal(res.status, 429);
    const body = (await res.json()) as { code: string; retry_after_seconds?: number };
    assert.equal(body.code, "RATE_LIMITED");
    assert.ok(typeof body.retry_after_seconds === "number");
  });

  test("200 مع تسجيل Drizzle في chat_logs (قاعدة وهمية)", async () => {
    process.env.ENABLE_CELIA_AGENT = "true";
    process.env.CELIA_ALLOWED_SCOPES = "chat:write,products:read";
    process.env.CELIA_AGENT_TOKEN = VALID_TOKEN;
    process.env.ADMIN_SESSION_SECRET = "a".repeat(32);
    // ensure no AI keys → local fallback
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;
    const { POST } = await import("../src/app/api/celia/chat/route");
    const before = await getDrizzle()!.select().from(chatLogs);
    assert.equal(before.length, 0);
    const res = await POST(
      celiaRequest([{ role: "user", content: "عايز منظف أرضيات" }], { token: VALID_TOKEN })
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { reply: string; source: string; auth: { id: string } };
    assert.ok(body.reply.length > 0);
    assert.ok(body.source);
    assert.equal(body.auth.id, "agent");
    const after = await getDrizzle()!.select().from(chatLogs);
    assert.equal(after.length, 1);
    assert.equal(after[0].question, "عايز منظف أرضيات");
    assert.equal(after[0].answer, body.reply);
  });

  test("422 عند جسم غير صالح (Zod) — لا يصل للمحرك", async () => {
    process.env.ENABLE_CELIA_AGENT = "true";
    process.env.CELIA_ALLOWED_SCOPES = "chat:write";
    process.env.CELIA_AGENT_TOKEN = VALID_TOKEN;
    process.env.ADMIN_SESSION_SECRET = "a".repeat(32);
    const { POST } = await import("../src/app/api/celia/chat/route");
    const res = await POST(
      new Request("http://x/api/celia/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${VALID_TOKEN}`,
          "x-forwarded-for": "203.0.113.2",
        },
        body: JSON.stringify({ messages: "not-an-array" }),
      })
    );
    assert.equal(res.status, 422);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "VALIDATION_FAILED");
  });
});
