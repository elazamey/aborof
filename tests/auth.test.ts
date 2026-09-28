import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  adminConfigIssues,
  isAdminConfigured,
  ADMIN_COOKIE,
  createAdminSession,
  verifyAdminSession,
  isAdminRequest,
  sessionMaxAge,
} from "../src/lib/auth";

/**
 * اختبارات تشخيص تهيئة الإدارة:
 *  - الدالة تسمّي المتغير الناقص/غير الصالح بدقة بدل رسالة عامة.
 *  - لا تُكشف أي قيمة، فقط أسماء المتغيرات وشروطها.
 *  - رسالة 503 عبر المسار الفعلي تحمل التشخيص الدقيق.
 */

const KEYS = ["ADMIN_PASSWORD", "ADMIN_SESSION_SECRET"] as const;

function resetEnv() {
  for (const k of KEYS) delete process.env[k];
}

beforeEach(resetEnv);
afterEach(resetEnv);

describe("admin configuration diagnostics", () => {
  test("names every missing variable when nothing is configured", () => {
    const issues = adminConfigIssues();
    assert.equal(issues.length, 2);
    assert.ok(issues.some((m) => m.includes("ADMIN_PASSWORD")));
    assert.ok(issues.some((m) => m.includes("ADMIN_SESSION_SECRET")));
    assert.equal(isAdminConfigured(), false);
  });

  test("flags a too-short session secret by variable name", () => {
    process.env.ADMIN_PASSWORD = "correct-horse-battery";
    process.env.ADMIN_SESSION_SECRET = "short-secret";
    const issues = adminConfigIssues();
    assert.equal(issues.length, 1);
    assert.match(issues[0], /ADMIN_SESSION_SECRET/);
    assert.equal(isAdminConfigured(), false);
  });

  test("reports only the password when the secret alone is valid", () => {
    process.env.ADMIN_SESSION_SECRET = "s".repeat(32);
    const issues = adminConfigIssues();
    assert.equal(issues.length, 1);
    assert.match(issues[0], /ADMIN_PASSWORD/);
    assert.equal(isAdminConfigured(), false);
  });

  test("configured when both variables are valid", () => {
    process.env.ADMIN_PASSWORD = "correct-horse-battery";
    process.env.ADMIN_SESSION_SECRET = "s".repeat(32);
    assert.deepEqual(adminConfigIssues(), []);
    assert.equal(isAdminConfigured(), true);
  });

  test("login route returns 503 naming the missing variables, leaking nothing", async () => {
    resetEnv();
    const { POST } = await import("../src/app/api/admin/login/route");
    const req = new Request("http://x/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "content-length": "36" },
      body: JSON.stringify({ password: "probe-not-a-real-password" }),
    });
    const res = await POST(req);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error?: string; code?: string; request_id?: string };
    assert.equal(body.code, "SERVICE_UNAVAILABLE");
    assert.match(body.error ?? "", /ADMIN_PASSWORD/);
    assert.match(body.error ?? "", /ADMIN_SESSION_SECRET/);
    // لا تسريب لمدخلات المستخدم أو لأي قيمة سرية.
    assert.ok(!(body.error ?? "").includes("probe-not-a-real-password"));
    assert.ok(body.request_id);
  });
});

/**
 * اختبارات رحلة الجلسة الكاملة (انحدار D-1).
 *
 * السبب الذي جعل 133 اختبارًا أخضر تتعايش مع لوحة تحكم ميتة: كل الاختبارات
 * السابقة كانت تفحص `adminConfigIssues` فقط، ولا شيء يمرّر الرمز عبر ترميز
 * الكوكيز الفعلي. `response.cookies.set()` ترمّز القيمة نسبة-مئويًا، وكان
 * الفاصل `:` يصير `%3A` على السلك، فيحسب `verifyAdminSession` الـHMAC فوق نص
 * مختلف عن المُوقَّع ويرفض كل جلسة سليمة.
 *
 * لذلك هذه الاختبارات تقيس الرحلة كما تحدث فعلًا: Route → Set-Cookie →
 * ترويسة Cookie → isAdminRequest. وأي حرف يُرمَّز داخل الرمز يُسقطها فورًا.
 */
describe("admin session round-trip", () => {
  beforeEach(() => {
    process.env.ADMIN_PASSWORD = "correct-horse-battery";
    process.env.ADMIN_SESSION_SECRET = "s".repeat(32);
  });
  afterEach(resetEnv);

  test("session token is unchanged by cookie percent-encoding", () => {
    const token = createAdminSession();
    // هذه هي الثابتة التي كُسرت: أي حرف يتغير تحت الترميز يكسر تطابق HMAC.
    assert.equal(encodeURIComponent(token), token);
    assert.equal(verifyAdminSession(token), true);
  });

  test("token carries only cookie-safe characters", () => {
    for (let i = 0; i < 25; i++) {
      const token = createAdminSession();
      assert.match(token, /^[0-9]+-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    }
  });

  test("login route cookie is accepted by isAdminRequest end-to-end", async () => {
    const { POST } = await import("../src/app/api/admin/login/route");
    const res = await POST(
      new Request("http://x/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "content-length": "38" },
        body: JSON.stringify({ password: "correct-horse-battery" }),
      })
    );
    assert.equal(res.status, 200);

    // نأخذ الكوكيز كما أصدره Route فعلًا (بعد ترميز Next) لا كنص خام.
    const setCookie = res.headers.getSetCookie()[0];
    assert.ok(setCookie, "يجب أن يصدر Route كوكيز جلسة");
    const pair = setCookie.split(";")[0];
    assert.ok(pair.startsWith(`${ADMIN_COOKIE}=`));

    const req = new Request("http://x/api/admin/session", { headers: { cookie: pair } });
    assert.equal(isAdminRequest(req), true, "الجلسة كما تُرسل على السلك يجب أن تُقبل");
  });

  test("session route reports authenticated for its own cookie", async () => {
    const { POST } = await import("../src/app/api/admin/login/route");
    const login = await POST(
      new Request("http://x/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "content-length": "38" },
        body: JSON.stringify({ password: "correct-horse-battery" }),
      })
    );
    const pair = login.headers.getSetCookie()[0].split(";")[0];

    const { GET } = await import("../src/app/api/admin/session/route");
    const res = await GET(new Request("http://x/api/admin/session", { headers: { cookie: pair } }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { authenticated: true });
  });

  test("wrong password issues no cookie", async () => {
    const { POST } = await import("../src/app/api/admin/login/route");
    const res = await POST(
      new Request("http://x/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "content-length": "30" },
        body: JSON.stringify({ password: "not-the-password" }),
      })
    );
    assert.equal(res.status, 401);
    assert.equal(res.headers.getSetCookie().length, 0);
  });

  test("tampered signature and tampered payload are rejected", () => {
    const token = createAdminSession();
    const payload = token.slice(0, token.lastIndexOf("."));
    const signature = token.slice(token.lastIndexOf(".") + 1);

    assert.equal(verifyAdminSession(`${payload}.${"A".repeat(signature.length)}`), false);
    assert.equal(verifyAdminSession(`${payload}x.${signature}`), false);
    assert.equal(verifyAdminSession(token.slice(0, -1)), false);
  });

  test("malformed tokens are rejected without throwing", () => {
    for (const bad of [undefined, "", "garbage", ".sig", "payload.", "a.b.c.d"]) {
      assert.equal(verifyAdminSession(bad), false);
    }
  });

  test("isAdminRequest rejects missing and forged cookies", () => {
    assert.equal(isAdminRequest(new Request("http://x/")), false);
    assert.equal(
      isAdminRequest(new Request("http://x/", { headers: { cookie: `${ADMIN_COOKIE}=1700000000000-x.deadbeef` } })),
      false
    );
    assert.equal(isAdminRequest(new Request("http://x/", { headers: { cookie: "other=1" } })), false);
  });

  test("session expires after sessionMaxAge", () => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    try {
      const token = createAdminSession();
      assert.equal(verifyAdminSession(token), true, "صالحة فور الإصدار");
      mock.timers.tick((sessionMaxAge + 60) * 1000);
      assert.equal(verifyAdminSession(token), false, "مرفوضة بعد انتهاء العمر");
    } finally {
      mock.timers.reset();
    }
  });
});
