import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ADMIN_COOKIE } from "../src/lib/auth";

/**
 * حراسة جلسة الإدارة **عبر HTTP فعليًا**: من تسجيل الدخول إلى الوصول لمسار محمي.
 *
 * هذا الاختبار وُلد من خلل حقيقي اكتُشف أثناء التحقق الشامل: مُسلسِل الكوكي
 * يُرمّز `:` إلى `%3A`، وكان التحقق يقرأ الكوكي الخام فيُبطِل التوقيع دائمًا،
 * أي أن لوحة الإدارة لا تعمل في الإنتاج رغم نجاح تسجيل الدخول.
 *
 * القاعدة المستخلصة: أي عقد يمر عبر كوكي يجب أن يُختبر بالقيمة **كما تخرج من
 * الترويسة حرفيًا**، لا بقيمة مُصنَّعة داخل العملية.
 */

const KEYS = ["ADMIN_PASSWORD", "ADMIN_SESSION_SECRET", "ENABLE_MCP_TOOLS", "ENABLE_RAG"] as const;
const PASSWORD = "smoke-demo-password-1234";
const SECRET = "s".repeat(40);

function resetEnv() {
  for (const key of KEYS) delete process.env[key];
}

function loginRequest(password: string): Request {
  return new Request("http://x/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

/** يستخرج قيمة الكوكي كما وردت في الترويسة بالحرف (بلا فك ترميز). */
function cookieHeaderValue(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(new RegExp(`${ADMIN_COOKIE}=([^;]+)`));
  assert.ok(match, "يجب أن تُعاد ترويسة Set-Cookie");
  return `${ADMIN_COOKIE}=${match![1]}`;
}

beforeEach(() => {
  resetEnv();
  process.env.ADMIN_PASSWORD = PASSWORD;
  process.env.ADMIN_SESSION_SECRET = SECRET;
});
afterEach(resetEnv);

describe("admin session end-to-end over http", () => {
  test("the cookie exactly as returned authenticates the protected routes", async () => {
    const login = await import("../src/app/api/admin/login/route");
    const session = await import("../src/app/api/admin/session/route");

    const loginRes = await login.POST(loginRequest(PASSWORD));
    assert.equal(loginRes.status, 200);

    const cookie = cookieHeaderValue(loginRes);
    const sessionRes = await session.GET(
      new Request("http://x/api/admin/session", { headers: { cookie } })
    );
    assert.equal(sessionRes.status, 200);
    assert.deepEqual(await sessionRes.json(), { authenticated: true });
  });

  test("a wrong password never yields a session cookie", async () => {
    const login = await import("../src/app/api/admin/login/route");
    const res = await login.POST(loginRequest("wrong-password-1234"));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null);
  });

  test("the same cookie opens the governed MCP manifest when the layers are on", async () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.ENABLE_RAG = "true";

    const login = await import("../src/app/api/admin/login/route");
    const manifest = await import("../src/app/api/admin/mcp/tools/route");

    const loginRes = await login.POST(loginRequest(PASSWORD));
    const cookie = cookieHeaderValue(loginRes);

    const res = await manifest.GET(new Request("http://x/api/admin/mcp/tools", { headers: { cookie } }));
    assert.equal(res.status, 200);
    const payload = (await res.json()) as { tools: { name: string }[] };
    assert.equal(payload.tools.length, 5);
    assert.ok(payload.tools.some((tool) => tool.name === "search_knowledge"));
  });

  test("a token signed the legacy way (with a colon, url-encoded) still verifies", async () => {
    // توافق مع كوكي أُصدر قبل الإصلاح: الحمولة كانت `ts:random`.
    const issuedAt = Date.now();
    const payload = `${issuedAt}:${"r".repeat(32)}`;
    const signature = createHmac("sha256", SECRET).update(payload).digest("base64url");
    const legacyToken = `${payload}.${signature}`;
    const encoded = encodeURIComponent(legacyToken);
    assert.match(encoded, /%3A/, "الترميز يجب أن يظهر فعلًا في هذا النمط");

    const session = await import("../src/app/api/admin/session/route");
    const res = await session.GET(
      new Request("http://x/api/admin/session", {
        headers: { cookie: `${ADMIN_COOKIE}=${encoded}` },
      })
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { authenticated: true });
  });

  test("tampered or expired tokens are rejected", async () => {
    const session = await import("../src/app/api/admin/session/route");
    const now = Date.now();

    const tamperedPayload = `${now}.${"x".repeat(32)}`;
    const badSig = createHmac("sha256", "another-secret-value-32-chars-min").update(tamperedPayload).digest("base64url");
    const tampered = await session.GET(
      new Request("http://x", { headers: { cookie: `${ADMIN_COOKIE}=${tamperedPayload}.${badSig}` } })
    );
    assert.deepEqual(await tampered.json(), { authenticated: false });

    // جلسة قديمة (9 ساعات) تخرج من نافذة الصلاحية (8 ساعات).
    const oldPayload = `${now - 9 * 60 * 60 * 1000}.${"y".repeat(32)}`;
    const oldSig = createHmac("sha256", SECRET).update(oldPayload).digest("base64url");
    const expired = await session.GET(
      new Request("http://x", { headers: { cookie: `${ADMIN_COOKIE}=${oldPayload}.${oldSig}` } })
    );
    assert.deepEqual(await expired.json(), { authenticated: false });

    const none = await session.GET(new Request("http://x"));
    assert.deepEqual(await none.json(), { authenticated: false });
  });
});
