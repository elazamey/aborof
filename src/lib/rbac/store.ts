import { randomUUID } from "node:crypto";
import type { Client, Transaction } from "@libsql/client";
import { db, ensureSchema } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { PASSWORD_POLICY } from "@/lib/secrets";
import { hashPassword, verifyPassword } from "./password";
import { isBuiltinRole, normalizeCustomPermissions } from "./roles";
import { parseStoredPermissions, type RbacPermission } from "./permissions";

/**
 * طبقة الوصول لبيانات الصلاحيات (RBAC).
 *
 * قواعد هذه الطبقة — كلها مُختبرة:
 *  1. **لا بصمة كلمة مرور تغادر هذه الوحدة على الإطلاق**: كل ما يُعاد للخارج
 *     كائن `RbacUserPublic` بلا `password_hash`، والدوال التي تحتاج البصمة
 *     (`verifyLoginPassword`) لا تُعيدها بل تُعيد نتيجة التحقق فقط.
 *  2. **كل تغيير داخل معاملة واحدة مع سطر التدقيق**: لا يوجد تغيير بلا أثر
 *     (`writeAudit` يُنفَّذ على نفس المعاملة قبل `commit`).
 *  3. **حصانة الإغلاق (anti-lockout)**: لا يمكن إزالة/تعطيل/حذف آخر حائز فعّال
 *     على `rbac:write`، ولا تعديل/حذف أي دور مدمج — الأخطاء `CONFLICT` (409)
 *     برسالة عربية تشرح البديل.
 *  4. **الصلاحية المجهولة لا تُمنح** (fail-closed) لكنها لا تُسقط القراءة:
 *     تُعاد ضمن `unknownPermissions` لتظهر في اللوحة كانحراف يحتاج مراجعة.
 */

/** منفّذ استعلام: العميل أو معاملة تفاعلية — نفس الواجهة في libSQL. */
type Executor = Client | Transaction;

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_DURATION_MS = 15 * 60 * 1000;

export type RbacUserStatus = "active" | "disabled";
export type PasswordSource = "bootstrap" | "panel";

export interface RbacUserPublic {
  id: string;
  username: string;
  displayName: string;
  roleId: string;
  roleLabel: string;
  roleBuiltin: boolean;
  status: RbacUserStatus;
  permissions: string[];
  unknownPermissions: string[];
  passwordSource: PasswordSource;
  locked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UserJoinRow {
  id: string;
  username: string;
  display_name: string;
  role_id: string;
  role_label: string;
  role_permissions: string;
  role_builtin: number | bigint;
  status: string;
  password_source: string;
  last_login_at: string | null;
  locked_until: number | bigint;
  created_at: string;
  updated_at: string;
}

export interface RbacUserRow {
  id: string;
  username: string;
  display_name: string;
  role_id: string;
  password_hash: string;
  password_source: string;
  status: string;
  token_version: number | bigint;
  failed_attempts: number | bigint;
  locked_until: number | bigint;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

const USER_SELECT = `SELECT u.id, u.username, u.display_name, u.role_id, u.status, u.password_source,
       u.token_version, u.failed_attempts, u.locked_until, u.last_login_at, u.created_at, u.updated_at,
       r.label AS role_label, r.permissions AS role_permissions, r.builtin AS role_builtin
  FROM rbac_users u JOIN rbac_roles r ON r.id = u.role_id`;

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function client(): Promise<Client> {
  const c = db();
  if (!c) throw Errors.serviceUnavailable("لوحة الصلاحيات تحتاج قاعدة بيانات مربوطة (TURSO_DATABASE_URL).");
  await ensureSchema();
  return c;
}

function toPublicUser(row: UserJoinRow, now = Date.now()): RbacUserPublic {
  const { granted, unknown } = parseStoredPermissions(row.role_permissions);
  const lockedUntil = num(row.locked_until);
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name ?? ""),
    roleId: String(row.role_id),
    roleLabel: String(row.role_label ?? row.role_id),
    roleBuiltin: num(row.role_builtin) === 1,
    status: row.status === "disabled" ? "disabled" : "active",
    permissions: granted,
    unknownPermissions: unknown,
    passwordSource: row.password_source === "bootstrap" ? "bootstrap" : "panel",
    locked: lockedUntil > now,
    lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

/** هل الدور يمنح الصلاحية؟ (fail-closed: أي قيمة غير معروفة لا تُمنح). */
export function roleGrantsPermission(permissionsRaw: unknown, permission: RbacPermission | string): boolean {
  const { granted } = parseStoredPermissions(permissionsRaw);
  if (granted.includes("*")) return true;
  return granted.includes(String(permission));
}

// ---------------------------------------------------------------------------
// التهيئة والقراءة
// ---------------------------------------------------------------------------

export async function rbacUserCount(): Promise<number> {
  const c = await client();
  const r = await c.execute("SELECT COUNT(*) AS n FROM rbac_users");
  return num(r.rows[0]?.n);
}

export async function listRoles() {
  const c = await client();
  const r = await c.execute(
    "SELECT id, label, description, permissions, builtin, created_at, updated_at FROM rbac_roles ORDER BY builtin DESC, id ASC"
  );
  return r.rows.map((row) => {
    const { granted, unknown } = parseStoredPermissions(row.permissions);
    return {
      id: String(row.id),
      label: String(row.label),
      description: String(row.description ?? ""),
      permissions: granted,
      unknownPermissions: unknown,
      builtin: num(row.builtin) === 1,
      createdAt: String(row.created_at ?? ""),
      updatedAt: String(row.updated_at ?? ""),
    };
  });
}

export async function listUsers(): Promise<RbacUserPublic[]> {
  const c = await client();
  const r = await c.execute(`${USER_SELECT} ORDER BY u.created_at ASC`);
  return r.rows.map((row) => toPublicUser(row as unknown as UserJoinRow));
}

export async function getUserByUsername(username: string): Promise<RbacUserPublic | null> {
  const c = await client();
  const r = await c.execute(`${USER_SELECT} WHERE u.username = ? LIMIT 1`, [username.trim().toLowerCase()]);
  const row = r.rows[0];
  return row ? toPublicUser(row as unknown as UserJoinRow) : null;
}

export async function getUserById(id: string): Promise<RbacUserPublic | null> {
  const c = await client();
  const r = await c.execute(`${USER_SELECT} WHERE u.id = ? LIMIT 1`, [id]);
  const row = r.rows[0];
  return row ? toPublicUser(row as unknown as UserJoinRow) : null;
}

/**
 * حالة المستخدم اللازمة لفرض الصلاحيات على كل طلب:
 * الهوية + الدور + الصلاحيات المحلولة + إصدار التوكن.
 *
 * تُستدعى من `requirePermission` فقط، وتُعيد `null` لأي مستخدم غير موجود —
 * فلا يُبنى قرار الفرض على بيانات ناقصة (fail-closed).
 */
export async function getUserSessionState(id: string): Promise<{
  id: string;
  username: string;
  displayName: string;
  roleId: string;
  roleLabel: string;
  status: RbacUserStatus;
  tokenVersion: number;
  permissions: string[];
  wildcard: boolean;
} | null> {
  const c = await client();
  const r = await c.execute(`${USER_SELECT} WHERE u.id = ? LIMIT 1`, [id]);
  const row = r.rows[0] as unknown as (UserJoinRow & { token_version: number | bigint }) | undefined;
  if (!row) return null;
  const { granted } = parseStoredPermissions(row.role_permissions);
  const wildcard = granted.includes("*");
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name ?? ""),
    roleId: String(row.role_id),
    roleLabel: String(row.role_label ?? row.role_id),
    status: row.status === "disabled" ? "disabled" : "active",
    tokenVersion: num(row.token_version) || 1,
    permissions: granted,
    wildcard,
  };
}

/**
 * حسم بيانات الدخول: يُعيد المستخدم وحالة تحقق كلمة المرور وحالة القفل
 * في نداء واحد، بلا تسريب بصمة. تُستدعى من مسار تسجيل الدخول وحده.
 */
export async function resolveLogin(params: {
  username: string;
  password: string;
  verify: (password: string, stored: string) => Promise<boolean>;
}): Promise<
  | { outcome: "unknown_user" }
  | { outcome: "disabled" }
  | { outcome: "locked"; retryAfterSeconds: number }
  | { outcome: "bad_password"; attemptsLeft: number }
  | { outcome: "ok"; user: RbacUserPublic; rolePermissions: string[] }
> {
  const c = await client();
  const username = params.username.trim().toLowerCase();
  const r = await c.execute(
    `SELECT u.id, u.username, u.display_name, u.role_id, u.password_hash, u.password_source, u.status,
            u.token_version, u.failed_attempts, u.locked_until, u.last_login_at, u.created_at, u.updated_at
       FROM rbac_users u WHERE u.username = ? LIMIT 1`,
    [username]
  );
  const row = r.rows[0] as unknown as RbacUserRow | undefined;
  if (!row) return { outcome: "unknown_user" };

  const now = Date.now();
  const lockedUntil = num(row.locked_until);
  if (lockedUntil > now) {
    return { outcome: "locked", retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil - now) / 1000)) };
  }

  const matches = await params.verify(params.password, String(row.password_hash));
  if (!matches) {
    const attempts = num(row.failed_attempts) + 1;
    const lockNow = attempts >= MAX_FAILED_ATTEMPTS;
    const nextLockedUntil = lockNow ? Date.now() + LOCK_DURATION_MS : 0;
    await c.execute({
      sql: "UPDATE rbac_users SET failed_attempts=?, locked_until=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
      args: [lockNow ? 0 : attempts, nextLockedUntil, String(row.id)],
    });
    return {
      outcome: "bad_password",
      attemptsLeft: lockNow ? 0 : Math.max(0, MAX_FAILED_ATTEMPTS - attempts),
    };
  }

  if (row.status !== "active") return { outcome: "disabled" };

  const joined = await c.execute(`${USER_SELECT} WHERE u.id = ? LIMIT 1`, [String(row.id)]);
  const full = joined.rows[0] as unknown as UserJoinRow | undefined;
  if (!full) return { outcome: "unknown_user" };
  const user = toPublicUser(full);
  return { outcome: "ok", user, rolePermissions: user.permissions };
}

/** يُسجَّل بعد نجاح التحقق: تصفير العدّاد + آخر دخول + سطر تدقيق. */
export async function recordLoginSuccess(userId: string, actor: string, details: Record<string, unknown> = {}) {
  const c = await client();
  await c.batch(
    [
      {
        sql: "UPDATE rbac_users SET failed_attempts=0, locked_until=0, last_login_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?",
        args: [userId],
      },
      auditStatement({ action: "rbac.login_success", entity: "rbac_user", entityId: userId, details, actor }),
    ],
    "write"
  );
}

export async function recordLoginFailure(username: string, details: Record<string, unknown> = {}) {
  const c = await client();
  // اسم المستخدم يُسجَّل كمعرّف كيان لا كسر — رسائل الفشل لا تكشف وجود الحساب.
  await c.execute(auditStatement({ action: "rbac.login_failure", entity: "rbac_user", entityId: username.slice(0, 60), details, actor: "anonymous" }));
}

/**
 * التحقق من كلمة مرور مستخدم قائم (يُستخدم في تغيير كلمة المرور الذاتي).
 * لا يُعيد أي بصمة ولا يميّز بين "مستخدم غير موجود" و"كلمة مرور خاطئة".
 */
export async function verifyUserPassword(id: string, password: string): Promise<boolean> {
  const c = await client();
  const r = await c.execute("SELECT password_hash FROM rbac_users WHERE id = ? LIMIT 1", [id]);
  const row = r.rows[0] as unknown as { password_hash?: string } | undefined;
  const stored = row?.password_hash ? String(row.password_hash) : null;
  return verifyPassword(password, stored);
}

/**
 * تدقيق رفض الصلاحية (`rbac.denied`).
 *
 * ملاحظة تصميمية: فشل التدقيق **لا** يُسقط الطلب — الطلب مرفوض أصلًا بـ403،
 * وتحويله إلى 500 بسبب مشكلة كتابة سطر تدقيق يقلب الفشل المغلق إلى ضجيج.
 * لذا: نحاول الكتابة، ونكتفي بسجل خادم مُنقّى عند الفشل.
 */
export async function recordDenial(params: { actor: string; permission: string; route: string }) {
  try {
    const c = await client();
    await c.execute(
      auditStatement({
        action: "rbac.denied",
        entity: "permission",
        entityId: params.permission,
        details: { route: params.route, result: "forbidden" },
        actor: params.actor,
      })
    );
  } catch (error) {
    console.error("rbac: denial audit write failed:", error instanceof Error ? error.name : "UnknownError");
  }
}

// ---------------------------------------------------------------------------
// التدقيق
// ---------------------------------------------------------------------------

const FORBIDDEN_DETAIL_KEYS = /(password|passwd|hash|secret|token)/i;

/**
 * يُنقّي تفاصيل التدقيق قبل الكتابة: لا كلمة مرور ولا بصمة ولا سر — حتى لو
 * مررها منادٍ مخطئ. يُطبَّق على كل المستويات (شامل المفاتيح المتداخلة).
 */
export function sanitizeAuditDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details ?? {})) {
    if (FORBIDDEN_DETAIL_KEYS.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = sanitizeAuditDetails(value as Record<string, unknown>);
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item && typeof item === "object" ? sanitizeAuditDetails(item as Record<string, unknown>) : item
      );
      continue;
    }
    out[key] = value;
  }
  return out;
}

function auditStatement(entry: {
  action: string;
  entity: string;
  entityId: string;
  details: Record<string, unknown>;
  actor: string;
}) {
  const details = JSON.stringify(sanitizeAuditDetails(entry.details)).slice(0, 4000);
  return {
    sql: "INSERT INTO admin_audit_log (action,entity,entity_id,details,actor) VALUES (?,?,?,?,?)",
    args: [
      entry.action.slice(0, 80),
      entry.entity.slice(0, 80),
      (entry.entityId ?? "").slice(0, 120),
      details,
      (entry.actor || "admin").slice(0, 120),
    ],
  };
}

async function writeAuditTx(tx: Executor, entry: Parameters<typeof auditStatement>[0]) {
  await tx.execute(auditStatement(entry));
}

export async function listAudit(limit = 50) {
  const c = await client();
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 200);
  const r = await c.execute(
    "SELECT id, action, entity, entity_id, details, actor, created_at FROM admin_audit_log ORDER BY id DESC LIMIT ?",
    [safeLimit]
  );
  return r.rows.map((row) => ({
    id: num(row.id),
    action: String(row.action),
    entity: String(row.entity),
    entityId: String(row.entity_id ?? ""),
    actor: String(row.actor ?? ""),
    createdAt: String(row.created_at ?? ""),
    details: String(row.details ?? "{}"),
  }));
}

// ---------------------------------------------------------------------------
// حصانة الإغلاق (anti-lockout)
// ---------------------------------------------------------------------------

/**
 * عدد الحائزين الفعّالين على صلاحية معينة، باستثناء مستخدم واحد.
 * تُقرأ الصلاحيات من الأدوار وتُقيَّم في الكود (`roleGrantsPermission`) حتى
 * تتسق تمامًا مع قرار الفرض نفسه — لا استعلام JSON موازٍ يختلف عنه.
 */
export async function countActiveHolders(permission: RbacPermission | string, excludeUserId?: string) {
  const c = await client();
  const r = await c.execute(
    `SELECT u.id, u.status, r.permissions AS role_permissions
       FROM rbac_users u JOIN rbac_roles r ON r.id = u.role_id`
  );
  return r.rows.filter((row) => {
    if (excludeUserId && String(row.id) === excludeUserId) return false;
    if (String(row.status) !== "active") return false;
    return roleGrantsPermission(row.role_permissions, permission);
  }).length;
}

async function assertNotLastRbacAdminTx(tx: Executor, affectedUserId: string, permission: RbacPermission) {
  const r = await tx.execute("SELECT COUNT(*) AS n FROM rbac_users");
  if (num(r.rows[0]?.n) === 0) return;
  const rows = await tx.execute(
    `SELECT u.id, u.status, r.permissions AS role_permissions
       FROM rbac_users u JOIN rbac_roles r ON r.id = u.role_id`
  );
  const others = rows.rows.filter((row) => {
    if (String(row.id) === affectedUserId) return false;
    if (String(row.status) !== "active") return false;
    return roleGrantsPermission(row.role_permissions, permission);
  });
  if (others.length === 0) {
    throw Errors.conflict(
      "لا يمكن تنفيذ هذا التغيير: سيُترك المتجر بلا أي مستخدم فعّال يملك صلاحية «تعديل الأدوار والمستخدمين». أضف حائزًا آخر أولًا."
    );
  }
}

// ---------------------------------------------------------------------------
// الأدوار — كتابة
// ---------------------------------------------------------------------------

export interface RoleInput {
  id: string;
  label: string;
  description?: string;
  permissions: string[];
}

export async function createRole(input: RoleInput, actor: string) {
  const c = await client();
  const normalized = normalizeCustomPermissions(input.permissions);
  if (!normalized.ok) throw Errors.validationFailed(normalized.reason);
  if (isBuiltinRole(input.id)) {
    throw Errors.conflict("معرّف محجوز لدور مدمج — اختر معرّفًا آخر.");
  }

  const tx = await c.transaction("write");
  try {
    const existing = await tx.execute({ sql: "SELECT id FROM rbac_roles WHERE id = ?", args: [input.id] });
    if (existing.rows.length > 0) {
      await tx.rollback();
      throw Errors.conflict("يوجد دور بهذا المعرّف بالفعل.");
    }
    await tx.execute({
      sql: "INSERT INTO rbac_roles (id,label,description,permissions,builtin) VALUES (?,?,?,?,0)",
      args: [input.id, input.label.trim(), (input.description ?? "").trim(), JSON.stringify(normalized.permissions)],
    });
    await writeAuditTx(tx, {
      action: "rbac.role_create",
      entity: "rbac_role",
      entityId: input.id,
      details: { label: input.label.trim(), permissions: normalized.permissions },
      actor,
    });
    await tx.commit();
  } catch (error) {
    await safeRollback(tx);
    throw error;
  }
  return { id: input.id };
}

export async function updateRole(
  input: { id: string; label?: string; description?: string; permissions?: string[] },
  actor: string
) {
  const c = await client();
  if (isBuiltinRole(input.id)) {
    throw Errors.conflict("الأدوار المدمجة غير قابلة للتعديل — أنشئ دورًا مخصصًا وانسخ صلاحياته.");
  }

  const tx = await c.transaction("write");
  try {
    const current = await tx.execute({ sql: "SELECT id, label, description, permissions FROM rbac_roles WHERE id = ?", args: [input.id] });
    const row = current.rows[0];
    if (!row) {
      await tx.rollback();
      throw Errors.notFound("الدور غير موجود.");
    }

    let permissions: string[] | null = null;
    if (input.permissions) {
      const normalized = normalizeCustomPermissions(input.permissions);
      if (!normalized.ok) {
        await tx.rollback();
        throw Errors.validationFailed(normalized.reason);
      }
      permissions = normalized.permissions;
    }

    // حصانة الإغلاق: إن كان هذا الدور هو مصدر صلاحية الحكم لآخر حائز فعّال،
    // فلا نقبل نزع الصلاحية منه.
    if (permissions && roleGrantsPermission(row.permissions, "rbac:write") && !permissions.includes("rbac:write")) {
      const holders = await tx.execute({ sql: `SELECT u.id FROM rbac_users u WHERE u.role_id = ? AND u.status = 'active'`, args: [input.id] });
      for (const holder of holders.rows) {
        await assertNotLastRbacAdminTx(tx, String(holder.id), "rbac:write");
      }
    }

    const label = (input.label ?? String(row.label)).trim();
    const description = (input.description ?? String(row.description ?? "")).trim();
    await tx.execute({
      sql: "UPDATE rbac_roles SET label=?, description=?, permissions=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
      args: [label, description, JSON.stringify(permissions ?? parseList(row.permissions)), input.id],
    });
    await writeAuditTx(tx, {
      action: "rbac.role_update",
      entity: "rbac_role",
      entityId: input.id,
      details: {
        label,
        permissions: permissions ?? undefined,
        changed: [
          input.label !== undefined ? "label" : null,
          input.description !== undefined ? "description" : null,
          permissions ? "permissions" : null,
        ].filter(Boolean),
      },
      actor,
    });
    await tx.commit();
  } catch (error) {
    await safeRollback(tx);
    throw error;
  }
  return { id: input.id };
}

export async function deleteRole(id: string, actor: string) {
  const c = await client();
  if (isBuiltinRole(id)) {
    throw Errors.conflict("الأدوار المدمجة غير قابلة للحذف.");
  }
  const tx = await c.transaction("write");
  try {
    const used = await tx.execute({ sql: "SELECT COUNT(*) AS n FROM rbac_users WHERE role_id = ?", args: [id] });
    if (num(used.rows[0]?.n) > 0) {
      await tx.rollback();
      throw Errors.conflict("لا يمكن حذف دور مُسنَد لمستخدمين — انقل المستخدمين إلى دور آخر أولًا.");
    }
    const deleted = await tx.execute({ sql: "DELETE FROM rbac_roles WHERE id = ?", args: [id] });
    if (deleted.rowsAffected !== 1) {
      await tx.rollback();
      throw Errors.notFound("الدور غير موجود.");
    }
    await writeAuditTx(tx, {
      action: "rbac.role_delete",
      entity: "rbac_role",
      entityId: id,
      details: {},
      actor,
    });
    await tx.commit();
  } catch (error) {
    await safeRollback(tx);
    throw error;
  }
  return { id };
}

// ---------------------------------------------------------------------------
// المستخدمون — كتابة
// ---------------------------------------------------------------------------

export interface UserCreateInput {
  username: string;
  displayName?: string;
  roleId: string;
  password: string;
  passwordSource?: PasswordSource;
}

function assertPasswordPolicy(password: string) {
  if (password.length < PASSWORD_POLICY.minLength || password.length > PASSWORD_POLICY.maxLength) {
    throw Errors.validationFailed(`كلمة المرور يجب أن تكون بين ${PASSWORD_POLICY.minLength} و${PASSWORD_POLICY.maxLength} حرفًا.`);
  }
}

export async function createUser(input: UserCreateInput, actor: string) {
  const c = await client();
  assertPasswordPolicy(input.password);
  const username = input.username.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);

  const tx = await c.transaction("write");
  try {
    const role = await tx.execute({ sql: "SELECT id FROM rbac_roles WHERE id = ?", args: [input.roleId] });
    if (role.rows.length === 0) {
      await tx.rollback();
      throw Errors.validationFailed("الدور المطلوب غير موجود.");
    }
    const clash = await tx.execute({ sql: "SELECT id FROM rbac_users WHERE username = ?", args: [username] });
    if (clash.rows.length > 0) {
      await tx.rollback();
      throw Errors.conflict("اسم المستخدم مستخدم بالفعل.");
    }
    const id = randomUUID();
    await tx.execute({
      sql: `INSERT INTO rbac_users (id, username, display_name, role_id, password_hash, password_source, status)
            VALUES (?,?,?,?,?,?, 'active')`,
      args: [
        id,
        username,
        (input.displayName ?? "").trim(),
        input.roleId,
        passwordHash,
        input.passwordSource === "bootstrap" ? "bootstrap" : "panel",
      ],
    });
    await writeAuditTx(tx, {
      action: "rbac.user_create",
      entity: "rbac_user",
      entityId: id,
      details: { username, roleId: input.roleId, origin: input.passwordSource ?? "panel" },
      actor,
    });
    await tx.commit();
    return { id, username };
  } catch (error) {
    await safeRollback(tx);
    throw error;
  }
}

export interface UserUpdateInput {
  id: string;
  displayName?: string;
  roleId?: string;
  status?: RbacUserStatus;
  password?: string;
}

/**
 * تعديل مستخدم مع ثلاث حمايات إغلاق:
 *  - تعطيل/نزع صلاحية الحكم عن آخر حائز فعّال ⇒ 409.
 *  - تغيير الدور/الحالة/كلمة المرور يرفع `token_version` ⇒ كل جلسات المستخدم
 *    القائمة تُبطل فورًا (سرقة الكوكيز لا تنفع بعد التغيير).
 */
export async function updateUser(input: UserUpdateInput, actor: string) {
  const c = await client();
  if (input.password !== undefined) assertPasswordPolicy(input.password);

  const tx = await c.transaction("write");
  try {
    const current = await tx.execute({ sql: `SELECT u.id, u.username, u.display_name, u.role_id, u.status, u.token_version,
              r.permissions AS role_permissions
         FROM rbac_users u JOIN rbac_roles r ON r.id = u.role_id WHERE u.id = ? LIMIT 1`, args: [input.id] });
    const row = current.rows[0];
    if (!row) {
      await tx.rollback();
      throw Errors.notFound("المستخدم غير موجود.");
    }

    const nextRoleId = input.roleId ?? String(row.role_id);
    const nextStatus: RbacUserStatus = input.status ?? (String(row.status) === "disabled" ? "disabled" : "active");

    let nextRolePermissions = row.role_permissions;
    if (nextRoleId !== String(row.role_id)) {
      const role = await tx.execute({ sql: "SELECT permissions FROM rbac_roles WHERE id = ?", args: [nextRoleId] });
      const roleRow = role.rows[0];
      if (!roleRow) {
        await tx.rollback();
        throw Errors.validationFailed("الدور المطلوب غير موجود.");
      }
      nextRolePermissions = roleRow.permissions;
    }

    const heldBefore = String(row.status) === "active" && roleGrantsPermission(row.role_permissions, "rbac:write");
    const holdsAfter = nextStatus === "active" && roleGrantsPermission(nextRolePermissions, "rbac:write");
    if (heldBefore && !holdsAfter) {
      await assertNotLastRbacAdminTx(tx, input.id, "rbac:write");
    }

    const passwordHash = input.password !== undefined ? await hashPassword(input.password) : null;
    const displayName = (input.displayName ?? String(row.display_name ?? "")).trim();
    const bump = input.password !== undefined || nextRoleId !== String(row.role_id) || nextStatus !== String(row.status);

    await tx.execute({
      sql: `UPDATE rbac_users
               SET display_name=?, role_id=?, status=?,
                   password_hash=COALESCE(?, password_hash),
                   password_source=CASE WHEN ? IS NULL THEN password_source ELSE 'panel' END,
                   token_version=token_version + ?,
                   updated_at=CURRENT_TIMESTAMP
             WHERE id=?`,
      args: [
        displayName,
        nextRoleId,
        nextStatus,
        passwordHash,
        passwordHash,
        bump ? 1 : 0,
        input.id,
      ],
    });
    await writeAuditTx(tx, {
      action: "rbac.user_update",
      entity: "rbac_user",
      entityId: input.id,
      details: {
        username: String(row.username),
        roleId: nextRoleId,
        status: nextStatus,
        changed: [
          input.displayName !== undefined ? "displayName" : null,
          input.roleId !== undefined ? "role" : null,
          input.status !== undefined ? "status" : null,
          passwordHash ? "password" : null,
        ].filter(Boolean),
      },
      actor,
    });
    await tx.commit();
  } catch (error) {
    await safeRollback(tx);
    throw error;
  }
  return { id: input.id };
}

export async function deleteUser(id: string, actor: string) {
  const c = await client();
  const tx = await c.transaction("write");
  try {
    const current = await tx.execute({ sql: `SELECT u.id, u.username, u.status, r.permissions AS role_permissions
         FROM rbac_users u JOIN rbac_roles r ON r.id = u.role_id WHERE u.id = ? LIMIT 1`, args: [id] });
    const row = current.rows[0];
    if (!row) {
      await tx.rollback();
      throw Errors.notFound("المستخدم غير موجود.");
    }
    if (String(row.status) === "active" && roleGrantsPermission(row.role_permissions, "rbac:write")) {
      await assertNotLastRbacAdminTx(tx, id, "rbac:write");
    }
    await tx.execute({ sql: "DELETE FROM rbac_users WHERE id = ?", args: [id] });
    await writeAuditTx(tx, {
      action: "rbac.user_delete",
      entity: "rbac_user",
      entityId: id,
      details: { username: String(row.username) },
      actor,
    });
    await tx.commit();
  } catch (error) {
    await safeRollback(tx);
    throw error;
  }
  return { id };
}

// ---------------------------------------------------------------------------
// أدوات داخلية
// ---------------------------------------------------------------------------

function parseList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

async function safeRollback(tx: Transaction) {
  try {
    await tx.rollback();
  } catch {
    // المعاملة قد تكون انتهت بالفعل (rollback مزدوج أو فشل اتصال).
  }
}

