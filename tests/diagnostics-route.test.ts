import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_COOKIE, createAdminSession } from "../src/lib/auth";

/**
 * نقطة التشخيص الإدارية — انحدار D-6.
 *
 * الوعد المكتوب في تعليق المسار: عند التعطيل «تُعيد 404 موحّدًا حتى لا يُكشف
 * وجودها». لكنها كانت تُرجع كود `DIAGNOSTICS_DISABLED` ورسالة «التشخيص معطل في
 * بيئة الإنتاج»، أي أنها تُثبت للمهاجم أن المسار موجود وأنه محمي بعلم بيئة —
 * وهو نقيض المقصد. نقطة MCP المجاورة كانت تفعل الصواب (`NOT_FOUND` عام).
 *
 * لذلك تثبت هذه الاختبارات:
 *  - التعطيل ⇒ 404 بكود `NOT_FOUND` ورسالة عامة، بلا أي ذكر للتشخيص.
 *  - جسم 404 من نقطتي التشخيص وMCP متطابق حرفيًا (عدا `request_id`)، فلا يمكن
 *    التمييز بينهما ولا استنتاج أي منهما موجود.
 *  - التفعيل بمفتاح مستقل وجلسة إدارة ما زال يعمل (لم نكسر الوظيفة).
 */

const KEYS = [
  "DIAGNOSTICS_ENABLED",
  "DIAGNOSTICS_KEY",
  "ADMIN_SESSION_SECRET",
  "ENABLE_MCP_TOOLS",
] as const;

const SECRET = "s".repeat(40);
const DIAG_KEY = "d".repeat(40);

function resetEnv() {
  for (const key of KEYS) delete process.env[key];
}

type Body = { error?: string; code?: string; request_id?: string; ok?: boolean };

async function body(res: Response): Promise<Body> {
  return (await res.json()) as Body;
}

function diagRequest(init: { cookie?: string; key?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = `${ADMIN_COOKIE}=${init.cookie}`;
  const url = new URL("http://x/api/admin/diagnostics");
  if (init.key) url.searchParams.set("key", init.key);
  return new Request(url, { headers });
}

function mcpRequest(): Request {
  return new Request("http://x/api/admin/mcp/tools");
}

beforeEach(resetEnv);
afterEach(resetEnv);

describe("diagnostics route — unified 404 (D-6)", () => {
  test("disabled diagnostics answers 404 NOT_FOUND with a generic message", async () => {
    process.env.DIAGNOSTICS_ENABLED = "false";
    const { GET } = await import("../src/app/api/admin/diagnostics/route");

    const res = await GET(diagRequest());
    assert.equal(res.status, 404);

    const b = await body(res);
    assert.equal(b.code, "NOT_FOUND");
    assert.ok(b.request_id);
  });

  test("disabled response never names diagnostics or its feature flag", async () => {
    process.env.DIAGNOSTICS_ENABLED = "false";
    const { GET } = await import("../src/app/api/admin/diagnostics/route");

    const res = await GET(diagRequest());
    const raw = JSON.stringify(await body(res));

    for (const forbidden of ["DIAGNOSTICS", "diagnostics", "التشخيص", "بيئة الإنتاج"]) {
      assert.ok(!raw.includes(forbidden), `يجب ألا يحتوي الرد على ${forbidden}: ${raw}`);
    }
  });

  test("diagnostics 404 body is byte-identical to the MCP 404 body", async () => {
    process.env.DIAGNOSTICS_ENABLED = "false";
    const diag = await import("../src/app/api/admin/diagnostics/route");
    const mcp = await import("../src/app/api/admin/mcp/tools/route");

    const dRes = await diag.GET(diagRequest());
    const mRes = await mcp.GET(mcpRequest());

    assert.equal(dRes.status, 404);
    assert.equal(mRes.status, 404);

    const strip = (b: Body) => ({ error: b.error, code: b.code });
    assert.deepEqual(strip(await body(dRes)), strip(await body(mRes)));
  });

  test("a guessed diagnostics key cannot tell the endpoint apart", async () => {
    process.env.DIAGNOSTICS_ENABLED = "false";
    const { GET } = await import("../src/app/api/admin/diagnostics/route");

    const without = await body(await GET(diagRequest()));
    const withKey = await body(await GET(diagRequest({ key: "k".repeat(40) })));

    assert.equal(without.code, withKey.code);
    assert.equal(without.error, withKey.error);
  });

  test("enabled diagnostics still serves an admin session and the diagnostics key", async () => {
    process.env.DIAGNOSTICS_ENABLED = "true";
    process.env.DIAGNOSTICS_KEY = DIAG_KEY;
    process.env.ADMIN_SESSION_SECRET = SECRET;
    const { GET } = await import("../src/app/api/admin/diagnostics/route");

    // بلا أي اعتماد → 401 لا 404، لأن النقطة موجودة ومفعّلة.
    const anonymous = await GET(diagRequest());
    assert.equal(anonymous.status, 401);

    const viaKey = await GET(diagRequest({ key: DIAG_KEY }));
    assert.equal(viaKey.status, 200);
    assert.equal((await body(viaKey)).ok, true);

    const viaSession = await GET(diagRequest({ cookie: createAdminSession() }));
    assert.equal(viaSession.status, 200);
    assert.equal((await body(viaSession)).ok, true);
  });
});
