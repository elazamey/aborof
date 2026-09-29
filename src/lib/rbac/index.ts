/**
 * الواجهة العامة لطبقة الصلاحيات (M1 — لوحة الصلاحيات).
 *
 * التصدير صريح لا `export *` — ليبقى السطح العام مقصودًا ومراجعًا، ولأي إضافة
 * مستقبلية أثر واضح في المراجعة.
 *
 * وحدات هذه الحزمة **خادم فقط**: تلمس قاعدة البيانات (store) وكلمات المرور
 * (password). استيرادها من مكوّن عميل تفشل عليه بوابة `security:gates`.
 */
export {
  PERMISSION_ENFORCEMENT,
  PERMISSION_GROUPS,
  PERMISSION_LABELS,
  PERMISSION_WILDCARD,
  RBAC_PERMISSIONS,
  RBAC_PERMISSION_VALUES,
  isKnownPermission,
  parseStoredPermissions,
} from "./permissions";
export type { PermissionGroup, RbacPermission } from "./permissions";

export {
  DUMMY_HASH,
  MIN_HASH_LENGTH,
  SCRYPT_PARAMS,
  hashPassword,
  isPasswordHash,
  verifyPassword,
} from "./password";

export {
  BUILTIN_ROLES,
  BUILTIN_ROLE_IDS,
  OWNER_ROLE_ID,
  ROLE_ID_PATTERN,
  effectivePermissions,
  isBuiltinRole,
  isOwnerRole,
  normalizeCustomPermissions,
  roleGrants,
  roleIsWildcard,
} from "./roles";
export type { BuiltinRoleId, RoleRecord } from "./roles";

export {
  MAX_FAILED_ATTEMPTS,
  LOCK_DURATION_MS,
  countActiveHolders,
  createRole,
  createUser,
  deleteRole,
  deleteUser,
  getUserById,
  getUserByUsername,
  getUserSessionState,
  listAudit,
  listRoles,
  listUsers,
  rbacUserCount,
  recordDenial,
  recordLoginFailure,
  recordLoginSuccess,
  resolveLogin,
  roleGrantsPermission,
  sanitizeAuditDetails,
  updateRole,
  updateUser,
  verifyUserPassword,
} from "./store";
export type { PasswordSource, RbacUserPublic, RbacUserStatus, UserCreateInput, UserUpdateInput } from "./store";

export { RBAC_FLAG, actorCan, actorHas, describeActor, isRbacEnabled, requirePermission, resolveActor } from "./guard";
export type { RbacActor } from "./guard";
