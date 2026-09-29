import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createClient, type Client } from "@libsql/client";
import { tmpdir } from "node:os";
import path from "node:path";

import { setDbClientForTest } from "../src/lib/db";
import { resetDrizzleForTest } from "../src/lib/db/drizzle";
import { runMigrations } from "../src/lib/db/migrate";
import { ADMIN_COOKIE } from "../src/lib/auth";
import { CELIA_KNOWN_SCOPES } from "../src/lib/celia/config";
import { createCeliaScopeGuard, intersectScopes } from "../src/lib/celia/scope-guard";
import { verifyCeliaAuth } from "../src/lib/celia/auth";
import {
  SCOPE_GRANT_MAP,
  TOKEN_LENGTH,
  TOKEN_PREFIX,
  assertCanGrant,
  createToken,
  effectiveTokenScopes,
  generateToken,
  grantableScopes,
  hashToken,
  listTokens,
  looksLikeManagedToken,
  normalizeScopes,
  parseScopes,
  revokeToken,
  rotateToken,
  tokenPrefix,
  verifyManagedToken,
} from "../src/lib/celia/tokens";
import type { RbacActor } from "../src/lib/rbac/guard";

/**
 * اختبارات CeliaTokenManager — توكنات وكلاء مُدارة.
 *
 * تغطي خمس طبقات:
 *  1. الكتالوج ومصفوفة النطاقات وخريطة المنح (منطق نقي).
 *  2. التوليد والبصمة (طول/بادئة/عشوائية/صيغة).
 *  3. المخزن على قاعدة بيانات حقيقية: كشف واحد، لا نص صريح، إلغاء/تدوير، انتهاء.
 *  4. الرفض: تصعيد الصلاحيات، العلم المغلق، النطاقات المجهولة.
 *  5. الفرض على المسارات (401/403/404) + تقييد النطاقات على مسار المحادثة.
 */

const ENV_KEYS = [
  "ENABLE_RBAC",
  "ENABLE_CELIA_TOKENS",
  "ENABLE_CELIA_AGENT",
  "CELIA_ALLOWED_SCOPES",
  "CELIA_AGENT_TOKEN",
  "ADMIN_PASSWORD",
  "ADMIN_SESSION_SECRET",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
] as const;

const GOOD_SECRET = "s".repeat(32);
const GOOD_PASSWORD = "correct-horse-battery";

function fileClient(): Client {
  const file = path.join(tmpdir(), `aborof-celia-tokens-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return createClient({ url: `file:${file}` });
}

/** فاعل اختباري — يُبنى مباشرة لأن هذه الوحدة تستهلك `RbacActor` ولا تصنعه. */
function actor(permissions: string[], opts: { wildcard?: boolean; mode?: "rbac" | "legacy" } = {}): RbacActor {
  return {
    id: "u1",
    username: "tester",
    displayName: "مختبر",
    roleId: "custom",
    roleLabel: "مخصص",
    permissions: new Set(permissions),
    wildcard: opts.wildcard ?? false,
    mode: opts.mode ?? "rbac",
  };
}

function request(url: string, init: { method?: string; body?: unknown; token?: string; bearer?: string; ip?: string } = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-forwarded-for": init.ip ?? `10.20.0.${Math.floor(Math.random() * 250) + 1}`,
  };
  if (init.token) headers.cookie = `${ADMIN_COOKIE}=${init.token}`;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  return new Request(url, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function body(res: Response) {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const first = header.split(";")[0];
  const value = first.slice(first.indexOf("=") + 1);
  return value ? decodeURIComponent(value) : "";
}

// ---------------------------------------------------------------------------

describe("CeliaTokenManager — الكتالوج ومصفوفة النطاقات", () => {
  test("chat:write مُدرج في الكتالوج (إصلاح ثغرة الفرض بلا كتالوج)", () => {
    assert.ok((CELIA_KNOWN_SCOPES as readonly string[]).includes("chat:write"));
    assert.equal(new Set(CELIA_KNOWN_SCOPES).size, CELIA_KNOWN_SCOPES.length, "لا تكرار في الكتالوج");
  });

  test("كل نطاق معروف له خريطة منح صريحة (لا منح ضمني)", () => {
    for (const scope of CELIA_KNOWN_SCOPES) {
      const needed = SCOPE_GRANT_MAP[scope];
      assert.ok(Array.isArray(needed) && needed.length > 0, `نطاق بلا خريطة منح: ${scope}`);
    }
  });

  test("normalizeScopes يرفض المجهول والفارغ ويزيل التكرار", () => {
    assert.deepEqual(normalizeScopes(["orders:read", "orders:read", "chat:write"]), ["orders:read", "chat:write"]);
    assert.throws(() => normalizeScopes(["orders:delete"]), /نطاق غير معروف/);
    assert.throws(() => normalizeScopes(["*"]), /نطاق غير معروف/);
    assert.throws(() => normalizeScopes([]), /نطاقًا واحدًا على الأقل/);
  });

  test("grantableScopes: المالك يمنح الكل، والفاعل المحدود يمنح ما تخوّله صلاحياته فقط", () => {
    const owner = actor([], { wildcard: true });
    assert.equal(grantableScopes(owner).size, CELIA_KNOWN_SCOPES.length);
    assert.equal(grantableScopes(actor([], { mode: "legacy" })).size, CELIA_KNOWN_SCOPES.length);

    // دور «عمليات»: products:write + orders:* + admin:read + mcp:read + celia:use (بلا celia:manage)
    const operations = actor(["products:write", "orders:read", "orders:write", "admin:read", "mcp:read", "celia:use"]);
    const grantable = grantableScopes(operations);
    for (const scope of ["products:read", "products:write", "orders:read", "orders:write", "admin:read", "mcp:read"]) {
      assert.equal(grantable.has(scope), true, `يجب أن يمنح ${scope}`);
    }
    for (const scope of ["faq:read", "faq:write", "chat:read", "chat:write", "mcp:write"]) {
      assert.equal(grantable.has(scope), false, `يجب ألا يمنح ${scope}`);
    }
  });

  test("assertCanGrant يرفض منح نطاق خارج صلاحيات المانح (anti-escalation)", () => {
    const support = actor(["orders:read", "orders:write"]);
    assert.doesNotThrow(() => assertCanGrant(support, ["orders:read", "orders:write"]));
    assert.throws(() => assertCanGrant(support, ["products:write"]), /لا تصعيد/);
    assert.throws(() => assertCanGrant(support, ["chat:write"]), /لا تصعيد/);
  });
});

describe("CeliaTokenManager — التوليد والبصمة", () => {
  test("التوكن 256 بت بصيغة cel_<base64url> وبلا تكرار", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i++) {
      const { token, hash, prefix } = generateToken();
      assert.equal(token.length, TOKEN_LENGTH);
      assert.ok(token.startsWith(TOKEN_PREFIX));
      assert.match(token.slice(TOKEN_PREFIX.length), /^[A-Za-z0-9_-]{43}$/, "base64url بلا حشو");
      assert.equal(hash.length, 64);
      assert.match(hash, /^[0-9a-f]{64}$/);
      assert.equal(hash, createHash("sha256").update(token, "utf8").digest("hex"));
      assert.equal(prefix, token.slice(0, 12));
      assert.equal(tokenPrefix(token), prefix);
      assert.ok(!seen.has(token), "تكرار توكن — هذا يجب ألا يحدث أبدًا");
      seen.add(token);
    }
  });

  test("looksLikeManagedToken يقبل البنية المتوقعة ويرفض ما عداها", () => {
    const { token } = generateToken();
    assert.equal(looksLikeManagedToken(token), true);
    assert.equal(looksLikeManagedToken(token.slice(0, -1)), false, "طول ناقص");
    assert.equal(looksLikeManagedToken("x" + token), false, "بادئة خاطئة");
    assert.equal(looksLikeManagedToken(""), false);
  });
});

describe("CeliaTokenManager — المخزن على قاعدة بيانات حقيقية", () => {
  let client: Client;

  beforeEach(async () => {
    client = fileClient();
    setDbClientForTest(client);
    resetDrizzleForTest();
    await runMigrations(client);
    process.env.ENABLE_CELIA_TOKENS = "true";
  });

  afterEach(() => {
    setDbClientForTest(null);
    resetDrizzleForTest();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  test("هجرة 0004 تُنشئ الجدول بقيود البصمة والصيغة والحالة", async () => {
    const insert = { sql: "INSERT INTO celia_tokens (id,label,token_prefix,token_hash,scopes,created_by) VALUES (?,?,?,?,?,?)" };
    const good = ["ct_abcdef123456", "بوت الطلبات", "cel_abcdefgh", "a".repeat(64), '["orders:read"]', "owner"];
    await client.execute({ ...insert, args: good });

    await assert.rejects(() => client.execute({ ...insert, args: ["bad-id", "بوت", "cel_abcdefgh", "b".repeat(64), "[]", "owner"] }), /CHECK|constraint/i);
    await assert.rejects(() => client.execute({ ...insert, args: ["ct_111111111111", "بوت", "cel_abcdefgh", "tooshort", "[]", "owner"] }), /CHECK|constraint/i);
    await assert.rejects(() => client.execute({ ...insert, args: ["ct_222222222222", "بوت", "cel_abcdefgh", "c".repeat(64), "{oops", "owner"] }), /CHECK|constraint/i);
    await assert.rejects(() => client.execute({ ...insert, args: ["ct_333333333333", "بوت", "cel_abcdefgh", "d".repeat(64), '{"a":1}', "owner"] }), /CHECK|constraint/i);
    await assert.rejects(() => client.execute({ ...insert, args: ["ct_444444444444", "بوت", "cel_abcdefgh", "a".repeat(64), "[]", "owner"] }), /UNIQUE|constraint/i);
    // حالة غير محصورة
    await assert.rejects(() => client.execute({ sql: "UPDATE celia_tokens SET status = 'pending' WHERE id = ?", args: [good[0]] }), /CHECK|constraint/i);
  });

  test("الإنشاء يعيد النص الصريح مرة واحدة، والمخزَّن بصمة فقط", async () => {
    const owner = actor([], { wildcard: true });
    const created = await createToken({ label: "بوت الطلبات", scopes: ["orders:read", "chat:write"] }, owner);

    assert.ok(created.plaintext.startsWith(TOKEN_PREFIX));
    assert.equal(created.token.status, "active");
    assert.deepEqual(created.token.scopes.sort(), ["chat:write", "orders:read"]);
    assert.equal(created.token.prefix, created.plaintext.slice(0, 12));
    assert.equal(created.token.createdBy, "tester");

    // الصف الحقيقي: بصمة مطابقة، ولا أثر للنص الصريح.
    const row = await client.execute("SELECT token_hash, token_prefix, label, scopes FROM celia_tokens WHERE id = ?", [created.token.id]);
    const stored = row.rows[0] as unknown as Record<string, unknown>;
    assert.equal(String(stored.token_hash), hashToken(created.plaintext));
    assert.ok(!JSON.stringify(stored).includes(created.plaintext), "النص الصريح لا يُخزَّن");
    assert.equal(parseScopes(stored.scopes).length, 2);
  });

  test("القائمة لا تحمل نصًا صريحًا ولا بصمة (فحص الحمولة كاملة)", async () => {
    const owner = actor([], { wildcard: true });
    const created = await createToken({ label: "بوت", scopes: ["orders:read"] }, owner);
    const tokens = await listTokens();
    const payload = JSON.stringify(tokens);
    assert.equal(payload.includes(created.plaintext), false);
    assert.equal(payload.includes(hashToken(created.plaintext)), false);
    assert.equal(payload.includes("token_hash"), false);
    assert.equal(tokens.length, 1);
  });

  test("التحقق: الصحيح يمرّ، والمجهول/الملغى/المنتهي لا يمرّ، والاستخدام يُحصى", async () => {
    const owner = actor([], { wildcard: true });
    const created = await createToken({ label: "بوت", scopes: ["chat:write"] }, owner);
    const plaintext = created.plaintext;

    const ok = await verifyManagedToken(plaintext);
    assert.ok(ok);
    assert.deepEqual(ok?.scopes, ["chat:write"]);

    assert.equal(await verifyManagedToken(generateToken().token), null, "توكن مجهول");
    assert.equal(await verifyManagedToken("cel_" + "A".repeat(43)), null, "بنية صحيحة لكن غير مخزّنة");
    assert.equal(await verifyManagedToken("short"), null);
    assert.equal(await verifyManagedToken(plaintext.replace(/.$/, "X")), null, "تغيير حرف واحد يبطل البصمة");

    await new Promise((r) => setTimeout(r, 30));
    const after = (await listTokens())[0];
    assert.equal(after.useCount, 1, "عدّاد الاستخدام يُحدَّث");
    assert.ok(after.lastUsedAt, "آخر استخدام يُسجَّل");

    // منتهٍ: نضبط الانتهاء في الماضي
    await client.execute("UPDATE celia_tokens SET expires_at = ? WHERE id = ?", [Date.now() - 1000, created.token.id]);
    assert.equal(await verifyManagedToken(plaintext), null, "توكن منتهٍ");
  });

  test("الإلغاء فعّال فورًا، وتكراره 409، والإلغاء لا يحذف الصف", async () => {
    const owner = actor([], { wildcard: true });
    const created = await createToken({ label: "بوت", scopes: ["orders:read"] }, owner);

    const revoked = await revokeToken(created.token.id, owner);
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.revokedBy, "tester");
    assert.equal(await verifyManagedToken(created.plaintext), null, "التوكن الملغى لا يمرّ");
    await assert.rejects(() => revokeToken(created.token.id, owner), /ملغى بالفعل/);

    const rows = await client.execute("SELECT COUNT(*) AS n FROM celia_tokens");
    assert.equal(Number((rows.rows[0] as unknown as { n: number }).n), 1, "لا حذف فيزيائي");
    await assert.rejects(() => revokeToken("ct_ffffffffffff", owner), /لا يوجد توكن/);
  });

  test("التدوير: القديم يُلغى والجديد يعمل بنفس النطاقات داخل معاملة واحدة", async () => {
    const owner = actor([], { wildcard: true });
    const first = await createToken({ label: "بوت", scopes: ["orders:read", "chat:write"] }, owner);

    const second = await rotateToken(first.token.id, owner);
    assert.notEqual(second.plaintext, first.plaintext);
    assert.deepEqual(second.token.scopes.sort(), ["chat:write", "orders:read"]);
    assert.equal(second.token.label, "بوت");

    assert.equal(await verifyManagedToken(first.plaintext), null, "القديم ملغى");
    const live = await verifyManagedToken(second.plaintext);
    assert.ok(live, "الجديد فعّال");

    const actives = await client.execute("SELECT COUNT(*) AS n FROM celia_tokens WHERE status = 'active'");
    assert.equal(Number((actives.rows[0] as unknown as { n: number }).n), 1, "لا توكنان فعّالان معًا");
    await assert.rejects(() => rotateToken(first.token.id, owner), /توكن ملغى/);
  });

  test("التدقيق يحمل هوية الفاعل ولا يحمل أي سر", async () => {
    const owner = actor([], { wildcard: true });
    const created = await createToken({ label: "بوت", scopes: ["orders:read"] }, owner);
    await rotateToken(created.token.id, owner);
    await revokeToken(created.token.id, owner).catch(() => {});

    const audit = await client.execute("SELECT action, entity, entity_id, details, actor FROM admin_audit_log ORDER BY id");
    const actions = audit.rows.map((r) => String((r as unknown as { action: string }).action));
    assert.ok(actions.includes("celia.token_created"));
    assert.ok(actions.includes("celia.token_rotated"));

    for (const row of audit.rows) {
      const rec = row as unknown as Record<string, unknown>;
      assert.equal(String(rec.actor), "tester", "كل سطر تدقيق يحمل هوية الفاعل");
      const details = String(rec.details);
      assert.equal(details.includes(created.plaintext), false, "لا نص صريح في التدقيق");
      assert.equal(details.includes(hashToken(created.plaintext)), false, "لا بصمة في التدقيق");
      assert.equal(/"(secret|hash|token)"/i.test(details), false, "لا مفاتيح أسرار في التفاصيل");
    }
  });

  test("العلم مغلق ⇒ كل عمليات الكتابة 404 موحّد", async () => {
    const owner = actor([], { wildcard: true });
    const created = await createToken({ label: "بوت", scopes: ["orders:read"] }, owner);
    delete process.env.ENABLE_CELIA_TOKENS;

    await assert.rejects(() => createToken({ label: "آخر", scopes: ["orders:read"] }, owner), /غير متاحة/);
    await assert.rejects(() => revokeToken(created.token.id, owner), /غير متاحة/);
    await assert.rejects(() => rotateToken(created.token.id, owner), /غير متاحة/);
    assert.equal(await verifyManagedToken(created.plaintext), null, "العلم المغلق يوقف التحقق أيضًا");
  });
});

describe("CeliaTokenManager — تقييد النطاقات الفعلي", () => {
  test("سقف المتجر يقيّد نطاقات التوكن (تقاطع لا اتحاد)", () => {
    const ceiling = new Set(["chat:write", "products:read"]);
    const effective = effectiveTokenScopes(["chat:write", "orders:write"], ceiling);
    assert.deepEqual([...effective], ["chat:write"]);
    assert.equal(intersectScopes(["orders:write"], ceiling).size, 0);

    process.env.ENABLE_CELIA_AGENT = "true";
    process.env.CELIA_ALLOWED_SCOPES = "chat:write,products:read";
    try {
      const guard = createCeliaScopeGuard(["chat:write", "orders:write"]);
      assert.equal(guard.can("chat:write"), true);
      assert.equal(guard.can("orders:write"), false, "التوكن لا يرفع سقف المتجر");
      assert.throws(() => createCeliaScopeGuard(["orders:write"]).assert("orders:write"), /لا تتقاطع/);
    } finally {
      delete process.env.ENABLE_CELIA_AGENT;
      delete process.env.CELIA_ALLOWED_SCOPES;
    }
  });

  test("verifyCeliaAuth: توكن مُدار يحمل هويته ونطاقاته، والملغى 401", async () => {
    const client = fileClient();
    setDbClientForTest(client);
    resetDrizzleForTest();
    await runMigrations(client);
    process.env.ENABLE_CELIA_TOKENS = "true";
    try {
      const owner = actor([], { wildcard: true });
      const created = await createToken({ label: "بوت المحادثة", scopes: ["chat:write"] }, owner);

      const auth = await verifyCeliaAuth(request("http://x/api/celia/chat", { bearer: created.plaintext }));
      assert.equal(auth.method, "managed_token");
      assert.equal(auth.role, "agent");
      assert.equal(auth.label, "بوت المحادثة");
      assert.deepEqual([...(auth.scopes ?? [])], ["chat:write"]);

      await revokeToken(created.token.id, owner);
      await assert.rejects(
        () => verifyCeliaAuth(request("http://x/api/celia/chat", { bearer: created.plaintext })),
        /توكن غير صالح|المصادقة مطلوبة/
      );
      await assert.rejects(() => verifyCeliaAuth(request("http://x/api/celia/chat")), /المصادقة مطلوبة/);
    } finally {
      setDbClientForTest(null);
      resetDrizzleForTest();
      for (const key of ENV_KEYS) delete process.env[key];
    }
  });
});

describe("CeliaTokenManager — المسارات الإدارية", () => {
  let client: Client;
  let ownerToken = "";

  beforeEach(async () => {
    client = fileClient();
    setDbClientForTest(client);
    resetDrizzleForTest();
    await runMigrations(client);
    process.env.ADMIN_SESSION_SECRET = GOOD_SECRET;
    process.env.ADMIN_PASSWORD = GOOD_PASSWORD;
    process.env.ENABLE_RBAC = "true";
    process.env.ENABLE_CELIA_TOKENS = "true";

    const { POST } = await import("../src/app/api/admin/login/route");
    const response = await POST(
      request("http://x/api/admin/login", { method: "POST", body: { username: "owner", password: GOOD_PASSWORD }, ip: "10.30.0.1" })
    );
    assert.equal(response.status, 200, "تهيئة المالك");
    ownerToken = cookieFrom(response);
  });

  afterEach(() => {
    setDbClientForTest(null);
    resetDrizzleForTest();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  async function routes() {
    const tokens = (await import("../src/app/api/admin/celia/tokens/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    const users = (await import("../src/app/api/admin/rbac/users/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    const login = (await import("../src/app/api/admin/login/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    const celia = (await import("../src/app/api/celia/chat/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    return { tokens, users, login, celia };
  }

  test("العلم مغلق ⇒ 404 على كل طرق المسار", async () => {
    delete process.env.ENABLE_CELIA_TOKENS;
    const { tokens } = await routes();
    assert.equal((await tokens.GET(request("http://x/api/admin/celia/tokens", { token: ownerToken }))).status, 404);
    assert.equal(
      (await tokens.POST(request("http://x/api/admin/celia/tokens", { method: "POST", token: ownerToken, body: { token: { label: "بوت", scopes: ["orders:read"] } } }))).status,
      404
    );
    assert.equal(
      (await tokens.PATCH(request("http://x/api/admin/celia/tokens", { method: "PATCH", token: ownerToken, body: { id: "ct_abcdef123456", action: "revoke" } }))).status,
      404
    );
  });

  test("بلا جلسة ⇒ 401، وبصلاحية عرض فقط ⇒ 200 للقراءة و403 للإنشاء", async () => {
    const { tokens, users, login } = await routes();
    assert.equal((await tokens.GET(request("http://x/api/admin/celia/tokens"))).status, 401);

    // دور مخصص: celia:read فقط — يُنشأ أولًا ثم يُسنَد للمستخدم عند إنشائه.
    const roleCreated = await (await import("../src/app/api/admin/rbac/roles/route")).POST(
      request("http://x/api/admin/rbac/roles", {
        method: "POST",
        token: ownerToken,
        body: { role: { id: "token_reader", label: "قارئ التوكنات", description: "", permissions: ["celia:read"] } },
      })
    );
    assert.equal(roleCreated.status, 200, await roleCreated.clone().text());

    const created = await users.POST(
      request("http://x/api/admin/rbac/users", {
        method: "POST",
        token: ownerToken,
        body: { user: { username: "token.reader", roleId: "token_reader", password: "reader-pass-1234" } },
      })
    );
    assert.equal(created.status, 200, await created.clone().text());

    const loginResponse = await login.POST(
      request("http://x/api/admin/login", { method: "POST", body: { username: "token.reader", password: "reader-pass-1234" }, ip: "10.30.0.9" })
    );
    assert.equal(loginResponse.status, 200, await loginResponse.clone().text());
    const readerToken = cookieFrom(loginResponse);

    const list = await tokens.GET(request("http://x/api/admin/celia/tokens", { token: readerToken }));
    assert.equal(list.status, 200, "celia:read يسمح بالعرض");
    const listBody = await body(list);
    assert.deepEqual((listBody.catalog as { scopes: string[] }).scopes, [...CELIA_KNOWN_SCOPES].sort());

    const denied = await tokens.POST(
      request("http://x/api/admin/celia/tokens", {
        method: "POST",
        token: readerToken,
        body: { token: { label: "ممنوع", scopes: ["orders:read"] } },
      })
    );
    assert.equal(denied.status, 403, "celia:read لا يكفي للإنشاء");
  });

  test("دورة كاملة عبر المسارات: إنشاء (كشف واحد) ← عرض بلا سر ← إلغاء", async () => {
    const { tokens } = await routes();
    const createdRes = await tokens.POST(
      request("http://x/api/admin/celia/tokens", {
        method: "POST",
        token: ownerToken,
        body: { token: { label: "بوت الطلبات", scopes: ["orders:read", "chat:write"], expiresInDays: 30 } },
      })
    );
    assert.equal(createdRes.status, 200, await createdRes.clone().text());
    const created = await body(createdRes);
    const plaintext = String(created.plaintext);
    assert.ok(plaintext.startsWith(TOKEN_PREFIX), "الاستجابة تحمل النص الصريح مرة واحدة");

    const listed = await body(await tokens.GET(request("http://x/api/admin/celia/tokens", { token: ownerToken })));
    const payload = JSON.stringify(listed);
    assert.equal(payload.includes(plaintext), false, "القائمة لا تحمل النص الصريح");
    assert.equal(payload.includes("token_hash"), false);
    assert.equal((listed.tokens as unknown[]).length, 1);

    const tokenId = String((created.token as { id: string }).id);
    const revoked = await tokens.PATCH(
      request("http://x/api/admin/celia/tokens", { method: "PATCH", token: ownerToken, body: { id: tokenId, action: "revoke" } })
    );
    assert.equal(revoked.status, 200, await revoked.clone().text());
    const after = await body(await tokens.GET(request("http://x/api/admin/celia/tokens", { token: ownerToken })));
    assert.equal((after.tokens as { status: string }[])[0].status, "revoked");

    const badId = await tokens.PATCH(
      request("http://x/api/admin/celia/tokens", { method: "PATCH", token: ownerToken, body: { id: "bad-id", action: "revoke" } })
    );
    assert.equal(badId.status, 422, "معرّف غير صالح يُرفض بالعقد");
  });

  test("معرّفات غير صالحة/نطاقات مجهولة تُرفض قبل أي كتابة", async () => {
    const { tokens } = await routes();
    const unknownScope = await tokens.POST(
      request("http://x/api/admin/celia/tokens", {
        method: "POST",
        token: ownerToken,
        body: { token: { label: "بوت", scopes: ["orders:delete"] } },
      })
    );
    assert.equal(unknownScope.status, 422);

    const emptyScopes = await tokens.POST(
      request("http://x/api/admin/celia/tokens", { method: "POST", token: ownerToken, body: { token: { label: "بوت", scopes: [] } } })
    );
    assert.equal(emptyScopes.status, 422);
  });

  test("مسار المحادثة: توكن مُدار بلا chat:write يُرفض 403، وبه يمرّ", async () => {
    process.env.ENABLE_CELIA_AGENT = "true";
    process.env.CELIA_ALLOWED_SCOPES = "chat:write,products:read";
    const { celia } = await routes();

    const owner = actor([], { wildcard: true });
    const withoutChat = await createToken({ label: "بلا محادثة", scopes: ["products:read"] }, actor(["products:write"]));
    const chatWriter = await createToken({ label: "كاتب المحادثة", scopes: ["chat:write"] }, owner);

    const denied = await celia.POST(
      request("http://x/api/celia/chat", {
        method: "POST",
        bearer: withoutChat.plaintext,
        body: { messages: [{ role: "user", content: "عندكم منظفات؟" }] },
      })
    );
    assert.equal(denied.status, 403, "توكن بلا chat:write لا يدخل المحادثة");

    const allowed = await celia.POST(
      request("http://x/api/celia/chat", {
        method: "POST",
        bearer: chatWriter.plaintext,
        body: { messages: [{ role: "user", content: "عندكم منظفات؟" }] },
      })
    );
    assert.notEqual(allowed.status, 401, "التوكن المُدار يتجاوز المصادقة");
    assert.notEqual(allowed.status, 403, "ومعه chat:write فلا يُرفض");
  });
});
