import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createClient, type Client } from "@libsql/client";
import { tmpdir } from "node:os";
import path from "node:path";

import { createAdminSession, readAdminSession, verifyAdminSession, ADMIN_COOKIE } from "../src/lib/auth";
import { setDbClientForTest } from "../src/lib/db";
import { resetDrizzleForTest } from "../src/lib/db/drizzle";
import { runMigrations } from "../src/lib/db/migrate";
import {
  BUILTIN_ROLES,
  DUMMY_HASH,
  PERMISSION_ENFORCEMENT,
  PERMISSION_GROUPS,
  PERMISSION_LABELS,
  RBAC_PERMISSIONS,
  actorCan,
  countActiveHolders,
  createRole,
  createUser,
  deleteRole,
  deleteUser,
  hashPassword,
  isBuiltinRole,
  isKnownPermission,
  isPasswordHash,
  listAudit,
  listRoles,
  listUsers,
  normalizeCustomPermissions,
  parseStoredPermissions,
  resolveActor,
  roleGrants,
  sanitizeAuditDetails,
  updateRole,
  updateUser,
  verifyPassword,
} from "../src/lib/rbac";

/**
 * اختبارات لوحة الصلاحيات (M1).
 *
 * تغطي ست طبقات تعمل معًا:
 *  1. الكتالوج ونموذج الأدوار (منطق نقي).
 *  2. بصمات كلمات المرور (scrypt) — بما فيها فشل الصيغ المشوّهة والحدود.
 *  3. جلسات الإدارة v1/v2 والتوقيع والمدة.
 *  4. هجرة 0003 وقيود قاعدة البيانات الحقيقية.
 *  5. مخزن RBAC CRUD + **حصانة الإغلاق** (آخر حائز لصلاحية الحكم).
 *  6. الفرض على المسارات فعليًا (401/403/404) والتدقيق وسجله.
 */

const ENV_KEYS = ["ENABLE_RBAC", "ADMIN_PASSWORD", "ADMIN_SESSION_SECRET", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"] as const;
const GOOD_SECRET = "s".repeat(32);
const GOOD_PASSWORD = "correct-horse-battery";

function fileClient(): Client {
  const file = path.join(tmpdir(), `aborof-rbac-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return createClient({ url: `file:${file}` });
}

function cookieHeader(token: string) {
  return { cookie: `${ADMIN_COOKIE}=${token}` };
}

/** طلب بسيط مع رأس كوكي اختياري + IP مميز (لعزل حدود المعدل بين السيناريوهات). */
function request(url: string, init: { method?: string; body?: unknown; token?: string; ip?: string } = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-forwarded-for": init.ip ?? `10.0.0.${Math.floor(Math.random() * 250) + 1}`,
  };
  if (init.token) headers.cookie = `${ADMIN_COOKIE}=${init.token}`;
  return new Request(url, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function body(res: Response) {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

describe("كتالوج الصلاحيات ونموذج الأدوار", () => {
  test("كل صلاحية لها تسمية عربية ونقطة فرض حقيقية ومجموعة عرض واحدة", () => {
    assert.equal(RBAC_PERMISSIONS.length, 10);
    assert.equal(new Set(RBAC_PERMISSIONS).size, RBAC_PERMISSIONS.length, "لا تكرار في الكتالوج");
    for (const permission of RBAC_PERMISSIONS) {
      assert.ok(PERMISSION_LABELS[permission], `تسمية مفقودة: ${permission}`);
      // نقطة الفرض يجب أن تكون مسارًا فعليًا لا وصفًا عامًا.
      assert.match(PERMISSION_ENFORCEMENT[permission], /\/(api|admin)/, `نقطة فرض غير محددة: ${permission}`);
      const groups = PERMISSION_GROUPS.filter((g) => g.permissions.includes(permission));
      assert.equal(groups.length, 1, `الصلاحية ${permission} يجب أن تظهر في مجموعة واحدة`);
    }
    // كل ما في المجموعات مُدرج في الكتالوج (لا صلاحية "يتيمة" في الواجهة).
    const grouped = PERMISSION_GROUPS.flatMap((g) => g.permissions);
    assert.equal(new Set(grouped).size, RBAC_PERMISSIONS.length);
  });

  test("isKnownPermission ترفض أي نص خارج الكتالوج (fail-closed)", () => {
    assert.equal(isKnownPermission("orders:read"), true);
    assert.equal(isKnownPermission("orders:delete"), false);
    assert.equal(isKnownPermission("*"), false, "النجمة ليست صلاحية عادية — تُدار في الدور المدمج فقط");
    assert.equal(isKnownPermission(42), false);
  });

  test("parseStoredPermissions يمنح المعروف فقط ويعرض المجهول بلا منحه", () => {
    const parsed = parseStoredPermissions('["orders:read","orders:delete","*","orders:delete"]');
    assert.deepEqual(parsed.granted.sort(), ["*", "orders:read"].sort());
    assert.deepEqual(parsed.unknown, ["orders:delete"]);
    assert.deepEqual(parseStoredPermissions("not json").granted, []);
    assert.deepEqual(parseStoredPermissions(null).granted, []);
  });

  test("normalizeCustomPermissions يرفض النجمة وغير المعروف ويزيل التكرار", () => {
    const ok = normalizeCustomPermissions(["orders:read", "orders:read", "admin:read"]);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.ok && ok.permissions, ["orders:read", "admin:read"]);

    const star = normalizeCustomPermissions(["*"]);
    assert.equal(star.ok, false);
    const unknown = normalizeCustomPermissions(["orders:delete"]);
    assert.equal(unknown.ok, false);
  });

  test("الأدوار المدمجة: owner فقط يمنح كل شيء، والمجهول لا يُمنح", () => {
    assert.equal(BUILTIN_ROLES.length, 4);
    const owner = BUILTIN_ROLES.find((r) => r.id === "owner")!;
    for (const permission of RBAC_PERMISSIONS) {
      assert.equal(roleGrants(owner, permission), true, `owner يجب أن يمنح ${permission}`);
    }
    assert.equal(isBuiltinRole("owner"), true);
    assert.equal(isBuiltinRole("custom"), false);
    const viewer = BUILTIN_ROLES.find((r) => r.id === "viewer")!;
    assert.equal(roleGrants(viewer, "orders:read"), true);
    assert.equal(roleGrants(viewer, "rbac:write"), false);
    assert.equal(roleGrants({ permissions: ["not:a:permission"] }, "orders:read"), false);
  });

  test("sanitizeAuditDetails يحجب أي مفتاح يشبه سرًا ولو متداخلًا", () => {
    const sanitized = sanitizeAuditDetails({
      roleId: "support",
      password: "plain-text",
      password_hash: "scrypt$...",
      nested: { currentPassword: "x", token: "y", ok: 1 },
      list: [{ tokenVersion: 3, secretThing: "z" }],
    });
    const serialized = JSON.stringify(sanitized);
    assert.ok(!serialized.includes("plain-text"));
    assert.ok(!serialized.includes("scrypt$"));
    assert.equal(sanitized.roleId, "support");
    assert.equal((sanitized.nested as Record<string, unknown>).ok, 1);
  });
});

describe("بصمات كلمات المرور (scrypt)", () => {
  test("التجزئة لا تحوي النص الأصلي، والتحقق يميز الصحيح من الخاطئ", async () => {
    const stored = await hashPassword("a-very-secret-passphrase");
    assert.equal(isPasswordHash(stored), true);
    assert.ok(!stored.includes("a-very-secret-passphrase"), "لا نص صريح داخل البصمة");
    assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/);
    assert.equal(await verifyPassword("a-very-secret-passphrase", stored), true);
    assert.equal(await verifyPassword("a-very-secret-passphras", stored), false);
    assert.equal(await verifyPassword("", stored), false);
  });

  test("ملح مختلف لكل بصمة: نفس كلمة المرور تنتج بصمتين مختلفتين", async () => {
    const a = await hashPassword("same-password-twice");
    const b = await hashPassword("same-password-twice");
    assert.notEqual(a, b);
    assert.equal(await verifyPassword("same-password-twice", a), true);
    assert.equal(await verifyPassword("same-password-twice", b), true);
  });

  test("أي بصمة مشوّهة أو معاملات ضخمة تُرفض بلا استثناء", async () => {
    assert.equal(await verifyPassword("x", undefined), false);
    assert.equal(await verifyPassword("x", "short"), false);
    assert.equal(await verifyPassword("x", "scrypt$16384$8$1$onlyfourparts"), false);
    assert.equal(await verifyPassword("x", "md5$16384$8$1$c2FsdA$aGFzaA"), false);
    // N ضخم = محاولة استنزاف ذاكرة/وقت ⇒ رفض فوري قبل أي حساب.
    assert.equal(await verifyPassword("x", "scrypt$99999999$8$1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA"), false);
    assert.equal(isPasswordHash("scrypt$16384$8$1$c2FsdA"), false);
  });

  test("DUMMY_HASH صالح الشكل (يُستخدم لتحييد فرق التوقيت عند غياب الحساب)", async () => {
    assert.equal(isPasswordHash(DUMMY_HASH), true);
    assert.equal(await verifyPassword("anything", DUMMY_HASH), false);
  });
});

describe("جلسات الإدارة v1 و v2", () => {
  beforeEach(() => {
    process.env.ADMIN_SESSION_SECRET = GOOD_SECRET;
  });
  afterEach(() => {
    delete process.env.ADMIN_SESSION_SECRET;
  });

  test("الجلسة القديمة (بلا هوية) تبقى v1 وصالحة كما كانت", () => {
    const token = createAdminSession();
    const record = readAdminSession(token);
    assert.equal(record?.version, 1);
    assert.equal(record?.userId, undefined);
    assert.equal(verifyAdminSession(token), true);
  });

  test("جلسة v2 تحمل هوية المستخدم وإصدار التوكن", () => {
    const token = createAdminSession({ userId: "user-1", tokenVersion: 4 });
    const record = readAdminSession(token);
    assert.equal(record?.version, 2);
    assert.equal(record?.userId, "user-1");
    assert.equal(record?.tokenVersion, 4);
  });

  test("التلاعب بالحمولة أو التوقيع يُبطل الجلسة (مع بقاء الصيغة سليمة)", () => {
    const token = createAdminSession({ userId: "user-1", tokenVersion: 1 });
    const [payload, signature] = token.split(".");
    const tampered = `${payload.replace("user-1", "user-2")}.${signature}`;
    assert.equal(readAdminSession(tampered), null, "تغيير الهوية يبطل التوقيع");
    assert.equal(readAdminSession(`${payload}.deadbeef`), null);
    assert.equal(readAdminSession("v2:user-1:1:1:nonce"), null, "بلا توقيع لا جلسة");
    assert.equal(readAdminSession(undefined), null);
    assert.equal(readAdminSession("garbage"), null);
  });

  test("معرّف مستخدم غير صالح يُرفض عند الإصدار (منع حقن الفواصل)", () => {
    assert.throws(() => createAdminSession({ userId: "bad:id", tokenVersion: 1 }));
    assert.throws(() => createAdminSession({ userId: "ok-id", tokenVersion: 0 }));
  });

  test("جلسة منتهية المدة تُرفض، والسر الغائب يُفشل مغلقًا بلا استثناء", () => {
    const issued = Date.now() - 9 * 60 * 60 * 1000; // أقدم من 8 ساعات
    const payload = `v2:user-1:1:${issued}:nonce`;
    const forged = `${payload}.${createHmac("sha256", GOOD_SECRET).update(payload).digest("base64url")}`;
    assert.equal(readAdminSession(forged), null);

    delete process.env.ADMIN_SESSION_SECRET;
    assert.doesNotThrow(() => readAdminSession(createAdminSessionLikeWithoutSecret()));
    assert.equal(readAdminSession(createAdminSessionLikeWithoutSecret()), null);
  });
});

/** يبني نص جلسة صالح الشكل بلا توقيع — لاختبار مسار «السر غير مهيأ». */
function createAdminSessionLikeWithoutSecret() {
  return `v2:user-1:1:${Date.now()}:nonce.deadbeef`;
}

describe("هجرة 0003_rbac وقيود قاعدة البيانات", () => {
  let client: Client;

  beforeEach(async () => {
    client = fileClient();
    setDbClientForTest(client);
    await runMigrations(client);
  });
  afterEach(() => {
    setDbClientForTest(null);
    resetDrizzleForTest();
  });

  test("تُنشئ الجدولين وتزرع أربعة أدوار مدمجة (idempotent)", async () => {
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('rbac_roles','rbac_users')"
    );
    assert.equal(tables.rows.length, 2);
    const roles = await client.execute("SELECT id, builtin FROM rbac_roles ORDER BY id");
    assert.deepEqual(
      roles.rows.map((r) => String(r.id)).sort(),
      ["operations", "owner", "support", "viewer"].sort()
    );
    assert.equal(roles.rows.every((r) => Number(r.builtin) === 1), true);
    assert.deepEqual((await runMigrations(client)).applied, [], "إعادة التشغيل لا تطبّق شيئًا");
  });

  test("قيود الصلاحيات: JSON صالح ومصفوفة فقط", async () => {
    await assert.rejects(
      () => client.execute({ sql: "INSERT INTO rbac_roles (id,label,permissions) VALUES (?,?,?)", args: ["bad", "دور", "{oops"] }),
      /CHECK|constraint/i
    );
    await assert.rejects(
      () => client.execute({ sql: "INSERT INTO rbac_roles (id,label,permissions) VALUES (?,?,?)", args: ["bad2", "دور", '{"a":1}'] }),
      /CHECK|constraint/i
    );
  });

  test("قيود المستخدم: اسم صالح، حالة محصورة، بصمة بطول معقول، ودور موجود", async () => {
    const valid = { sql: "INSERT INTO rbac_users (id,username,role_id,password_hash,status) VALUES (?,?,?,?,?)" };
    await assert.rejects(
      () => client.execute({ ...valid, args: ["u1", "Upper_Case", "owner", "x".repeat(80), "active"] }),
      /CHECK|constraint/i
    );
    await assert.rejects(
      () => client.execute({ ...valid, args: ["u2", "good_user", "owner", "x".repeat(80), "pending"] }),
      /CHECK|constraint/i
    );
    await assert.rejects(
      () => client.execute({ ...valid, args: ["u3", "good_user", "owner", "too-short", "active"] }),
      /CHECK|constraint/i
    );
    await assert.rejects(
      () => client.execute({ ...valid, args: ["u4", "good_user", "ghost_role", "x".repeat(80), "active"] }),
      /FOREIGN KEY|constraint/i
    );
    await client.execute({ ...valid, args: ["u5", "good_user", "owner", "x".repeat(80), "active"] });
    // اسم المستخدم فريد
    await assert.rejects(
      () => client.execute({ ...valid, args: ["u6", "good_user", "owner", "y".repeat(80), "active"] }),
      /UNIQUE|constraint/i
    );
  });
});

describe("مخزن RBAC: الأدوار والمستخدمون وحصانة الإغلاق", () => {
  let client: Client;

  beforeEach(async () => {
    client = fileClient();
    setDbClientForTest(client);
    await runMigrations(client);
    process.env.ENABLE_RBAC = "true";
    process.env.ADMIN_SESSION_SECRET = GOOD_SECRET;
  });
  afterEach(() => {
    setDbClientForTest(null);
    resetDrizzleForTest();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  test("إنشاء دور مخصص ثم تعديله ثم حذفه يمر بسلام مع تدقيق كامل", async () => {
    await createRole({ id: "warehouse", label: "أمين المخزن", description: "جرد", permissions: ["orders:read"] }, "owner");
    const roles = await listRoles();
    const created = roles.find((r) => r.id === "warehouse")!;
    assert.equal(created.builtin, false);
    assert.deepEqual(created.permissions, ["orders:read"]);

    await updateRole({ id: "warehouse", label: "أمين المخزن الرئيسي", permissions: ["orders:read", "products:write"] }, "owner");
    const updated = (await listRoles()).find((r) => r.id === "warehouse")!;
    assert.equal(updated.label, "أمين المخزن الرئيسي");
    assert.deepEqual(updated.permissions.sort(), ["orders:read", "products:write"].sort());

    await deleteRole("warehouse", "owner");
    assert.equal((await listRoles()).some((r) => r.id === "warehouse"), false);
    const actions = (await listAudit(20)).map((e) => e.action);
    assert.ok(actions.includes("rbac.role_create"));
    assert.ok(actions.includes("rbac.role_update"));
    assert.ok(actions.includes("rbac.role_delete"));
  });

  test("الأدوار المدمجة محصّنة: لا تعديل ولا حذف، والمعرّف المحجوز لا يُنشأ", async () => {
    await assert.rejects(() => updateRole({ id: "owner", label: "مخترع" }, "owner"), /CONFLICT|مدمجة/i);
    await assert.rejects(() => deleteRole("viewer", "owner"), /CONFLICT|مدمجة/i);
    await assert.rejects(() => createRole({ id: "owner", label: "مالك مزيف", permissions: [] }, "owner"), /CONFLICT|محجوز/i);
    await assert.rejects(() => createRole({ id: "bad_role", label: "دور", permissions: ["orders:delete"] }, "owner"), /VALIDATION|معروفة/i);
    await assert.rejects(() => createRole({ id: "star_role", label: "دور", permissions: ["*"] }, "owner"), /VALIDATION|محصور/i);
    await assert.rejects(() => createRole({ id: "dup_role", label: "دور", permissions: [] }, "owner").then(() => createRole({ id: "dup_role", label: "دور", permissions: [] }, "owner")), /CONFLICT|بالفعل/i);
  });

  test("لا حذف لدور مُسنَد لمستخدمين (لا مستخدم يتيم)", async () => {
    await createRole({ id: "temp_role", label: "مؤقت", permissions: ["orders:read"] }, "owner");
    await createUser({ username: "temp_user", roleId: "temp_role", password: GOOD_PASSWORD }, "owner");
    await assert.rejects(() => deleteRole("temp_role", "owner"), /CONFLICT|مُسنَد/i);
  });

  test("كتابة المستخدمين: بصمة واحدة فقط، ولا بصمة في أي كائن يُعاد للخارج", async () => {
    const created = await createUser({ username: "Sara.Ali", displayName: "سارة", roleId: "support", password: GOOD_PASSWORD }, "owner");
    assert.equal(created.username, "sara.ali", "اسم المستخدم يُطبَّع لصغيره");

    const users = await listUsers();
    const user = users.find((u) => u.username === "sara.ali")!;
    assert.equal(user.roleLabel, "خدمة العملاء");
    assert.deepEqual(user.permissions.sort(), ["celia:use", "orders:read", "orders:write"].sort());
    assert.ok(!JSON.stringify(user).toLowerCase().includes("password_hash"), "لا بصمة في الكائن العام");
    assert.ok(!JSON.stringify(user).includes("scrypt"), "لا بصمة في الكائن العام");

    const raw = await client.execute("SELECT password_hash FROM rbac_users WHERE username='sara.ali'");
    assert.match(String(raw.rows[0].password_hash), /^scrypt\$/, "البصمة مخزّنة كـ scrypt فقط");

    await assert.rejects(() => createUser({ username: "sara.ali", roleId: "support", password: GOOD_PASSWORD }, "owner"), /CONFLICT|مستخدم/i);
    await assert.rejects(() => createUser({ username: "other", roleId: "ghost", password: GOOD_PASSWORD }, "owner"), /VALIDATION|غير موجود/i);
    await assert.rejects(() => createUser({ username: "weakuser", roleId: "support", password: "short" }, "owner"), /VALIDATION|كلمة المرور/i);
  });

  test("تغيير الدور/الحالة/كلمة المرور يُبطل الجلسات فورًا (رفع إصدار التوكن)", async () => {
    const created = await createUser({ username: "ops.user", roleId: "operations", password: GOOD_PASSWORD }, "owner");
    const before = await resolveActor(new Request("http://x/api/admin/rbac", { headers: cookieHeader(createAdminSession({ userId: created.id, tokenVersion: 1 })) }));
    assert.equal(before?.username, "ops.user");
    assert.equal(before && actorCan(before, "products:write"), true);

    await updateUser({ id: created.id, roleId: "support" }, "owner");

    const stale = await resolveActor(new Request("http://x/api/admin/rbac", { headers: cookieHeader(createAdminSession({ userId: created.id, tokenVersion: 1 })) }));
    assert.equal(stale, null, "الجلسة القديمة (إصدار 1) تُرفض بعد التغيير");

    const fresh = (await client.execute("SELECT token_version FROM rbac_users WHERE id=?", [created.id])).rows[0];
    const current = await resolveActor(new Request("http://x/api/admin/rbac", { headers: cookieHeader(createAdminSession({ userId: created.id, tokenVersion: Number(fresh.token_version) })) }));
    assert.equal(current?.roleId, "support");
    assert.equal(current && actorCan(current, "products:write"), false);
  });

  test("التعطيل يمنع الاستخدام والتحقق من كلمة المرور يعمل للذات فقط", async () => {
    const created = await createUser({ username: "disabled.user", roleId: "operations", password: GOOD_PASSWORD }, "owner");
    await updateUser({ id: created.id, status: "disabled" }, "owner");
    const actor = await resolveActor(
      new Request("http://x/api/admin/rbac", { headers: cookieHeader(createAdminSession({ userId: created.id, tokenVersion: 2 })) })
    );
    assert.equal(actor, null, "مستخدم معطّل لا يُبنى منه فاعل");

    const { verifyUserPassword } = await import("../src/lib/rbac");
    assert.equal(await verifyUserPassword(created.id, GOOD_PASSWORD), true);
    assert.equal(await verifyUserPassword(created.id, "wrong-password-here"), false);
    assert.equal(await verifyUserPassword("ghost-id", GOOD_PASSWORD), false);
  });

  test("حصانة الإغلاق: لا نزع/تعطيل/حذف آخر حائز لصلاحية الحكم", async () => {
    const owner = await createUser({ username: "the.owner", roleId: "owner", password: GOOD_PASSWORD }, "system:bootstrap");
    assert.equal(await countActiveHolders("rbac:write"), 1);

    await assert.rejects(() => updateUser({ id: owner.id, roleId: "viewer" }, "the.owner"), /CONFLICT|بلا أي مستخدم/i);
    await assert.rejects(() => updateUser({ id: owner.id, status: "disabled" }, "the.owner"), /CONFLICT|بلا أي مستخدم/i);
    await assert.rejects(() => deleteUser(owner.id, "the.owner"), /CONFLICT|بلا أي مستخدم/i);

    // بعد إضافة حائز ثانٍ يصبح التغيير ممكنًا — القاعدة تمنع الإغلاق لا التعديل.
    const second = await createUser({ username: "second.owner", roleId: "owner", password: GOOD_PASSWORD }, "the.owner");
    assert.equal(await countActiveHolders("rbac:write"), 2);
    await updateUser({ id: owner.id, roleId: "viewer" }, "second.owner");
    assert.equal(await countActiveHolders("rbac:write"), 1);

    // الدور المخصص الذي يمنح الحكم محمي أيضًا عند نزع الصلاحية منه.
    await createRole({ id: "governance", label: "حكم", permissions: ["rbac:read", "rbac:write"] }, "second.owner");
    await updateUser({ id: second.id, roleId: "governance" }, "second.owner");
    await assert.rejects(() => updateRole({ id: "governance", permissions: ["rbac:read"] }, "second.owner"), /CONFLICT|بلا أي مستخدم/i);
    await assert.rejects(() => deleteUser(second.id, "second.owner"), /CONFLICT|بلا أي مستخدم/i);
  });

  test("حذف المستخدم يكتب سطر تدقيق بهوية الفاعل ويسقط صلاحياته", async () => {
    const created = await createUser({ username: "temp.owner", roleId: "owner", password: GOOD_PASSWORD }, "system:bootstrap");
    await createUser({ username: "keeper", roleId: "owner", password: GOOD_PASSWORD }, "temp.owner");
    await deleteUser(created.id, "keeper");
    const entry = (await listAudit(10)).find((e) => e.action === "rbac.user_delete")!;
    assert.equal(entry.actor, "keeper");
    assert.equal(entry.entityId, created.id);
    assert.equal(await resolveActor(new Request("http://x/api/admin/rbac", { headers: cookieHeader(createAdminSession({ userId: created.id, tokenVersion: 1 })) })), null);
  });

  test("حصانة الأدوار: دور بلا صلاحيات معروفة لا يمنح شيئًا", async () => {
    const created = await createUser({ username: "ghost.perm", roleId: "viewer", password: GOOD_PASSWORD }, "owner");
    // محاكاة انحراف تخزين: صلاحية كتبتها نسخة أحدث/أقدم.
    await client.execute({ sql: "UPDATE rbac_roles SET permissions=? WHERE id=?", args: ['["future:permission"]', "viewer"] });
    const actor = await resolveActor(
      new Request("http://x/api/admin/rbac", { headers: cookieHeader(createAdminSession({ userId: created.id, tokenVersion: 1 })) })
    );
    assert.equal(actor && actorCan(actor, "orders:read"), false);
    assert.deepEqual(actor?.permissions.size, 0);
  });
});

describe("مسارات لوحة الصلاحيات — الفرض الفعلي على HTTP", () => {
  let client: Client;
  let ownerToken = "";
  let ownerId = "";

  /** يستخرج قيمة كوكي الجلسة من رأس set-cookie كما يفعل المتصفح. */
  function cookieFrom(response: Response): string {
    const header = response.headers.get("set-cookie") ?? "";
    const first = header.split(";")[0];
    const value = first.slice(first.indexOf("=") + 1);
    return value ? decodeURIComponent(value) : "";
  }

  beforeEach(async () => {
    client = fileClient();
    setDbClientForTest(client);
    resetDrizzleForTest();
    await client.execute("PRAGMA foreign_keys = ON");
    await runMigrations(client);
    process.env.ADMIN_SESSION_SECRET = GOOD_SECRET;
    process.env.ADMIN_PASSWORD = GOOD_PASSWORD;
    process.env.ENABLE_RBAC = "true";

    // التهيئة الأولى تمرّ عبر مسار الدخول الحقيقي (bootstrap) لا عبر الاستدعاء المباشر.
    const { POST } = await import("../src/app/api/admin/login/route");
    const response = await POST(
      request("http://x/api/admin/login", { method: "POST", body: { username: "owner", password: GOOD_PASSWORD }, ip: "10.10.0.1" })
    );
    assert.equal(response.status, 200, "التهيئة الأولى يجب أن تنجح بكلمة مرور الإدارة");
    const data = await body(response);
    assert.equal(data.bootstrap, true);
    assert.equal(data.must_change_password, true);
    ownerToken = cookieFrom(response);
    ownerId = String((data.user as Record<string, unknown>).id);
    assert.ok(ownerToken.length > 20, "كوكي الجلسة يُصدر عند التهيئة");
  });

  afterEach(() => {
    setDbClientForTest(null);
    resetDrizzleForTest();
    for (const key of ENV_KEYS) delete process.env[key];
    delete process.env.ENABLE_CELIA_AGENT;
    delete process.env.CELIA_ALLOWED_SCOPES;
    delete process.env.CELIA_AGENT_TOKEN;
  });

  test("العلم مغلق ⇒ 404 موحّد على كل مسارات اللوحة (ولا كشف لوجودها)", async () => {
    delete process.env.ENABLE_RBAC;
    for (const [file, method, url] of [
      ["../src/app/api/admin/rbac/route", "GET", "http://x/api/admin/rbac"],
      ["../src/app/api/admin/rbac/roles/route", "POST", "http://x/api/admin/rbac/roles"],
      ["../src/app/api/admin/rbac/users/route", "DELETE", "http://x/api/admin/rbac/users?id=u1"],
      ["../src/app/api/admin/rbac/audit/route", "GET", "http://x/api/admin/rbac/audit"],
    ] as const) {
      const mod = (await import(file)) as unknown as Record<string, (req: Request) => Promise<Response>>;
      const handler = mod[method];
      const response = await handler(request(url, { method, token: ownerToken, body: method === "POST" ? {} : undefined }));
      assert.equal(response.status, 404, `${url} يجب أن يعيد 404 والعلم مغلق`);
    }
  });

  test("بوابة التهيئة تُغلق بمجرد وجود مستخدم: لا دخول بكلمة المرور المشتركة", async () => {
    const { POST } = await import("../src/app/api/admin/login/route");
    const response = await POST(
      request("http://x/api/admin/login", { method: "POST", body: { username: "someone.else", password: GOOD_PASSWORD }, ip: "10.10.0.2" })
    );
    assert.equal(response.status, 401);
    const data = await body(response);
    assert.equal(data.code, "AUTH_INVALID");
    assert.ok(!String(data.error).includes("owner"), "الرسالة موحّدة ولا تسمّي حسابات");
  });

  test("اللوحة تعيد الأدوار والمستخدمين بلا أي بصمة أو سر", async () => {
    const { GET } = await import("../src/app/api/admin/rbac/route");
    const response = await GET(request("http://x/api/admin/rbac", { token: ownerToken }));
    assert.equal(response.status, 200);
    const data = await body(response);
    assert.equal(data.enabled, true);
    assert.equal((data.roles as unknown[]).length, 4, "الأدوار المدمجة الأربعة");
    assert.equal((data.users as unknown[]).length, 1);
    assert.equal((data.counts as Record<string, number>).rbacWriters, 1);
    const serialized = JSON.stringify(data);
    assert.ok(!serialized.includes("scrypt"), "لا بصمة كلمة مرور في الاستجابة");
    assert.ok(!serialized.includes("password_hash"), "لا اسم عمود بصمة في الاستجابة");
    assert.ok(!serialized.includes(GOOD_PASSWORD), "كلمة مرور الإدارة لا تظهر أبدًا");
    assert.equal((data.actor as Record<string, unknown>).mode, "rbac");
    // كل صلاحية معروضة لها نقطة فرض معلنة (شفافية الفرض للمشرف)
    assert.equal(Object.keys((data.catalog as Record<string, Record<string, string>>).enforcement).length, RBAC_PERMISSIONS.length);
  });

  test("مصفوفة الفرض: مستخدم orders:read فقط يُمنع من كل ما عدا قراءة الطلبات", async () => {
    const roles = (await import("../src/app/api/admin/rbac/roles/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    const users = (await import("../src/app/api/admin/rbac/users/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    const login = (await import("../src/app/api/admin/login/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;

    const roleResponse = await roles.POST(
      request("http://x/api/admin/rbac/roles", {
        method: "POST",
        token: ownerToken,
        body: { role: { id: "orders_reader", label: "قارئ الطلبات", description: "قراءة فقط", permissions: ["orders:read"] } },
      })
    );
    assert.equal(roleResponse.status, 200);

    const userResponse = await users.POST(
      request("http://x/api/admin/rbac/users", {
        method: "POST",
        token: ownerToken,
        body: { user: { username: "reader", roleId: "orders_reader", password: "reader-password-12" } },
      })
    );
    assert.equal(userResponse.status, 200);

    const loginResponse = await login.POST(
      request("http://x/api/admin/login", { method: "POST", body: { username: "reader", password: "reader-password-12" }, ip: "10.10.0.3" })
    );
    assert.equal(loginResponse.status, 200);
    const readerToken = cookieFrom(loginResponse);

    const orders = (await import("../src/app/api/orders/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    const products = (await import("../src/app/api/products/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    const rbacRoute = (await import("../src/app/api/admin/rbac/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    const audit = (await import("../src/app/api/admin/rbac/audit/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;

    // مسموح
    assert.equal((await orders.GET(request("http://x/api/orders", { token: readerToken }))).status, 200);

    // مرفوض بالصلاحية (403) — وكل رفض يحمل request_id
    const denied = [
      await orders.PATCH(request("http://x/api/orders", { method: "PATCH", token: readerToken, body: { id: "ORD-12345678-abcd1234", status: "مؤكد" } })),
      await products.POST(request("http://x/api/products", { method: "POST", token: readerToken, body: { product: { name: "منتج", price: 10, stock: 1 } } })),
      await rbacRoute.GET(request("http://x/api/admin/rbac", { token: readerToken })),
      await audit.GET(request("http://x/api/admin/rbac/audit", { token: readerToken })),
      await roles.POST(request("http://x/api/admin/rbac/roles", { method: "POST", token: readerToken, body: { role: { id: "sneaky", label: "دور", permissions: [] } } })),
    ];
    for (const response of denied) {
      assert.equal(response.status, 403, "الفاعل مصرَّح لكنه بلا الصلاحية المطلوبة");
      const data = await body(response);
      assert.equal(data.code, "FORBIDDEN");
      assert.ok(data.request_id, "كل رفض يحمل request_id للتتبع");
      assert.ok(!JSON.stringify(data).includes("scrypt"));
    }

    // حائز الصلاحية نفسه لا يتأثر
    assert.equal((await rbacRoute.GET(request("http://x/api/admin/rbac", { token: ownerToken }))).status, 200);
  });

  test("كل رفض يُقيَّد في سجل التدقيق بهوية الفاعل والصلاحية الناقصة", async () => {
    const { createRole: _unusedRole } = await import("../src/lib/rbac");
    const users = (await import("../src/app/api/admin/rbac/users/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    await users.POST(
      request("http://x/api/admin/rbac/users", {
        method: "POST",
        token: ownerToken,
        body: { user: { username: "denied.user", roleId: "viewer", password: "denied-password-12" } },
      })
    );
    const audit = (await import("../src/app/api/admin/rbac/audit/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    const rbacRoute = (await import("../src/app/api/admin/rbac/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;

    const denied = await rbacRoute.GET(request("http://x/api/admin/rbac", { token: ADMIN_COOKIE })); // بلا كوكي ⇒ 401
    assert.equal(denied.status, 401);

    // رفض بصلاحية: viewer لا يملك rbac:read
    const login = (await import("../src/app/api/admin/login/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    const loginResponse = await login.POST(
      request("http://x/api/admin/login", { method: "POST", body: { username: "denied.user", password: "denied-password-12" }, ip: "10.10.0.4" })
    );
    const viewerToken = cookieFrom(loginResponse);
    assert.equal((await rbacRoute.GET(request("http://x/api/admin/rbac", { token: viewerToken }))).status, 403);

    const auditResponse = await audit.GET(request("http://x/api/admin/rbac/audit?limit=50", { token: ownerToken }));
    assert.equal(auditResponse.status, 200);
    const entries = (await body(auditResponse)).entries as { action: string; actor: string; entityId: string }[];
    const denial = entries.find((e) => e.action === "rbac.denied");
    assert.ok(denial, "الرفض يجب أن يُقيَّد");
    assert.equal(denial.actor, "denied.user");
    assert.equal(denial.entityId, "rbac:read");

    const limit = await audit.GET(request("http://x/api/admin/rbac/audit?limit=0", { token: ownerToken }));
    assert.equal(limit.status, 422, "حد غير صالح يُرفض بعقد صريح");
  });

  test("الجلسة القديمة (v1) لا تعمل مع RBAC: 401 على اللوحة و authenticated=false", async () => {
    const legacy = createAdminSession();
    const rbacRoute = (await import("../src/app/api/admin/rbac/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    const session = (await import("../src/app/api/admin/session/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;

    assert.equal((await rbacRoute.GET(request("http://x/api/admin/rbac", { token: legacy }))).status, 401);
    const sessionResponse = await session.GET(request("http://x/api/admin/session", { token: legacy }));
    const data = await body(sessionResponse);
    assert.equal(data.authenticated, false);
    assert.equal(data.rbac, true);

    // وجلسة v2 صحيحة تُعرَّف بهويتها ودورها
    const ownerSession = await session.GET(request("http://x/api/admin/session", { token: ownerToken }));
    const ownerData = await body(ownerSession);
    assert.equal(ownerData.authenticated, true);
    assert.equal((ownerData.actor as Record<string, unknown>).username, "owner");
    assert.equal((ownerData.actor as Record<string, unknown>).wildcard, true);
  });

  test("بدون العلم: السلوك القديم حرفيًا (جلسة v1 مقبولة، والنقطة الوحيدة غائبة)", async () => {
    delete process.env.ENABLE_RBAC;
    const legacy = createAdminSession();
    const orders = (await import("../src/app/api/orders/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    const session = (await import("../src/app/api/admin/session/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;

    const list = await orders.GET(request("http://x/api/orders", { token: legacy }));
    assert.equal(list.status, 200, "أي جلسة صالحة تعمل كما قبل RBAC");
    const data = await body(await session.GET(request("http://x/api/admin/session", { token: legacy })));
    assert.equal(data.authenticated, true);
    assert.equal(data.rbac, false);
    assert.equal((data.actor as Record<string, unknown>).mode, "legacy");
  });

  test("العقود الصارمة ترفض الحقول الزائدة والصلاحيات المجهولة (422)", async () => {
    const roles = (await import("../src/app/api/admin/rbac/roles/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    const users = (await import("../src/app/api/admin/rbac/users/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;

    const unknownPermission = await roles.POST(
      request("http://x/api/admin/rbac/roles", {
        method: "POST",
        token: ownerToken,
        body: { role: { id: "weird", label: "غريب", permissions: ["orders:destroy"] } },
      })
    );
    assert.equal(unknownPermission.status, 422);

    const extraField = await roles.POST(
      request("http://x/api/admin/rbac/roles", {
        method: "POST",
        token: ownerToken,
        body: { role: { id: "extra", label: "زائد", permissions: [], tenantId: "spoof" } },
      })
    );
    assert.equal(extraField.status, 422);

    const weakPassword = await users.POST(
      request("http://x/api/admin/rbac/users", {
        method: "POST",
        token: ownerToken,
        body: { user: { username: "weak.user", roleId: "viewer", password: "short" } },
      })
    );
    assert.equal(weakPassword.status, 422);

    const builtinEdit = await roles.PATCH(
      request("http://x/api/admin/rbac/roles", { method: "PATCH", token: ownerToken, body: { role: { id: "owner", label: "مخترع" } } })
    );
    assert.equal(builtinEdit.status, 409, "الدور المدمج محصّن حتى عبر الـ HTTP");

    const builtinDelete = await roles.DELETE(request("http://x/api/admin/rbac/roles?id=viewer", { method: "DELETE", token: ownerToken }));
    assert.equal(builtinDelete.status, 409);

    const impostor = await users.DELETE(request(`http://x/api/admin/rbac/users?id=${encodeURIComponent(ownerId)}`, { method: "DELETE", token: ownerToken }));
    assert.equal(impostor.status, 409, "لا حذف لآخر حائز لصلاحية الحكم");
  });

  test("تغيير كلمة المرور الذاتي: يحتاج الحالية، ويُبطل الجلسة، ولا يمسّ الدور", async () => {
    const users = (await import("../src/app/api/admin/rbac/users/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    const login = (await import("../src/app/api/admin/login/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    const rbacRoute = (await import("../src/app/api/admin/rbac/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;

    await users.POST(
      request("http://x/api/admin/rbac/users", {
        method: "POST",
        token: ownerToken,
        body: { user: { username: "self.user", roleId: "viewer", password: "original-pass-12" } },
      })
    );
    const loginResponse = await login.POST(
      request("http://x/api/admin/login", { method: "POST", body: { username: "self.user", password: "original-pass-12" }, ip: "10.10.0.5" })
    );
    const token = cookieFrom(loginResponse);
    assert.equal(loginResponse.status, 200);

    // طلب بلا أي تغيير فعلي ⇒ 422 (عقد صريح لا يمرر طلبًا فارغًا)
    const noChange = await users.PATCH(
      request("http://x/api/admin/rbac/users", { method: "PATCH", token, body: { user: { id: "00000000-0000-0000-0000-000000000000" } } })
    );
    assert.equal(noChange.status, 422);

    // محاولة تغيير دور النفس ⇒ 403 (منع تصعيد الصلاحيات الذاتي)
    const self = await import("../src/lib/rbac");
    const me = (await self.listUsers()).find((u) => u.username === "self.user")!;
    const escalate = await users.PATCH(
      request("http://x/api/admin/rbac/users", { method: "PATCH", token, body: { user: { id: me.id, roleId: "owner" } } }),
    );
    assert.equal(escalate.status, 403, "تصعيد الدور الذاتي مرفوض بالصلاحية قبل أي شيء");

    const forbiddenEscalation = await users.PATCH(
      request("http://x/api/admin/rbac/users", { method: "PATCH", token, body: { user: { id: me.id, status: "active", currentPassword: "original-pass-12" } } }),
    );
    assert.equal(forbiddenEscalation.status, 403, "الحالة/الدور يحتاجان rbac:write");

    // كلمة المرور الحالية الخاطئة ⇒ 401
    const badCurrent = await users.PATCH(
      request("http://x/api/admin/rbac/users", {
        method: "PATCH",
        token,
        body: { user: { id: me.id, password: "brand-new-pass-12", currentPassword: "wrong-current-12" } },
      })
    );
    assert.equal(badCurrent.status, 401);

    // التغيير الصحيح ⇒ 200 + مطلوب إعادة الدخول، والجلسة القديمة تُبطل
    const changed = await users.PATCH(
      request("http://x/api/admin/rbac/users", {
        method: "PATCH",
        token,
        body: { user: { id: me.id, password: "brand-new-pass-12", currentPassword: "original-pass-12" } },
      })
    );
    assert.equal(changed.status, 200);
    assert.equal((await body(changed)).reauth_required, true);
    assert.equal((await rbacRoute.GET(request("http://x/api/admin/rbac", { token }))).status, 401, "الجلسة القديمة أُبطلت");

    const reLogin = await login.POST(
      request("http://x/api/admin/login", { method: "POST", body: { username: "self.user", password: "brand-new-pass-12" }, ip: "10.10.0.6" })
    );
    assert.equal(reLogin.status, 200, "الدخول بكلمة المرور الجديدة يعمل");
  });

  test("الدخول: رسالة موحّدة للحساب المجهول والخاطئ، وقفل مؤقت بعد المحاولات الفاشلة", async () => {
    const login = (await import("../src/app/api/admin/login/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    const ip = "10.10.9.9";

    const unknown = await login.POST(request("http://x/api/admin/login", { method: "POST", body: { username: "ghost.user", password: "whatever-12345" }, ip }));
    const wrong = await login.POST(request("http://x/api/admin/login", { method: "POST", body: { username: "owner", password: "wrong-password-1" }, ip }));
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal((await body(unknown)).error, (await body(wrong)).error, "لا تفريق بين حساب مجهول وكلمة مرور خاطئة");

    // إكمال حدّ المحاولات الفاشلة (5) على نفس الحساب
    for (let i = 0; i < 4; i++) {
      const attempt = await login.POST(request("http://x/api/admin/login", { method: "POST", body: { username: "owner", password: `wrong-password-${i}` }, ip }));
      assert.equal(attempt.status, 401, `المحاولة الفاشلة ${i + 2} تعود 401 موحّدًا`);
    }
    // المحاولة التالية (وإن كانت كلمة المرور صحيحة) ⇒ مقفل مؤقتًا 429
    const locked = await login.POST(request("http://x/api/admin/login", { method: "POST", body: { username: "owner", password: GOOD_PASSWORD }, ip }));
    assert.equal(locked.status, 429);
    const lockedBody = await body(locked);
    assert.equal(lockedBody.code, "RATE_LIMITED");
    assert.ok(Number(lockedBody.retry_after_seconds) > 0, "رسالة القفل تحمل مدة إعادة المحاولة بالثواني");
  });

  test("سيليا: جلسة الإدارة تحتاج صلاحية celia:use في وضع RBAC", async () => {
    process.env.ENABLE_CELIA_AGENT = "true";
    process.env.CELIA_ALLOWED_SCOPES = "chat:write";
    const users = (await import("../src/app/api/admin/rbac/users/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    const login = (await import("../src/app/api/admin/login/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;
    const celia = (await import("../src/app/api/celia/chat/route")) as unknown as Record<string, (req: Request) => Promise<Response>>;

    await users.POST(
      request("http://x/api/admin/rbac/users", {
        method: "POST",
        token: ownerToken,
        body: { user: { username: "no.celia", roleId: "viewer", password: "no-celia-pass-12" } },
      })
    );
    const loginResponse = await login.POST(
      request("http://x/api/admin/login", { method: "POST", body: { username: "no.celia", password: "no-celia-pass-12" }, ip: "10.10.0.7" })
    );
    const viewerToken = cookieFrom(loginResponse);

    const denied = await celia.POST(
      request("http://x/api/celia/chat", { method: "POST", token: viewerToken, body: { messages: [{ role: "user", content: "منتجات؟" }] } })
    );
    assert.equal(denied.status, 403, "viewer بلا celia:use");

    // ومالك الحساب (wildcard) يمرّ من بوابة الصلاحية (بقية السلسلة خارج نطاق هذا الاختبار)
    const allowed = await celia.POST(
      request("http://x/api/celia/chat", { method: "POST", token: ownerToken, body: { messages: [{ role: "user", content: "عندكم منظفات؟" }] } })
    );
    assert.notEqual(allowed.status, 403, "المالك يملك celia:use");
  });
});
