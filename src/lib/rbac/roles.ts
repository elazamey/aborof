import {
  PERMISSION_WILDCARD,
  isKnownPermission,
  parseStoredPermissions,
  type RbacPermission,
} from "./permissions";

/**
 * نموذج الأدوار — منطق نقي بلا قاعدة بيانات وبلا بيئة (يُختبر مباشرة).
 *
 * قواعد محكمة:
 *  - `owner` دور مدمج (builtin) وغير قابل للتعديل أو الحذف — دور الكسر الزجاجي.
 *  - كل الأدوار المدمجة غير قابلة للتعديل/الحذف: مصدرها الكود لا الـ UI.
 *  - `*` مقبول فقط للدور المدمج owner؛ أي دور مخصص يطلب `*` يُرفض.
 *  - دور بلا صلاحيات معروفة = دور بلا صلاحيات (fail-closed) وليس خطأ.
 */

export const OWNER_ROLE_ID = "owner" as const;

export const BUILTIN_ROLE_IDS = ["owner", "operations", "support", "viewer"] as const;
export type BuiltinRoleId = (typeof BUILTIN_ROLE_IDS)[number];

const BUILTIN_SET: ReadonlySet<string> = new Set<string>(BUILTIN_ROLE_IDS);

export interface RoleRecord {
  id: string;
  label: string;
  description: string;
  permissions: string[];
  /** صلاحيات مخزّنة لا يعرفها الكتالوج الحالي — تُعرض ولا تُمنح. */
  unknownPermissions: string[];
  builtin: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** معرّف دور صالح: نص لاتيني صغير/أرقام/شرطة — مستقر في الروابط والتدقيق. */
export const ROLE_ID_PATTERN = /^[a-z0-9_][a-z0-9_-]{1,59}$/;

export function isBuiltinRole(roleId: string): boolean {
  return BUILTIN_SET.has(roleId);
}

export function isOwnerRole(roleId: string): boolean {
  return roleId === OWNER_ROLE_ID;
}

/**
 * الصلاحيات الفعلية لدور: `*` تعني الكل، والمجهولة تُستبعد.
 * تُعيد مجموعة نصية تُفحص بـ `hasPermission`.
 */
export function effectivePermissions(role: Pick<RoleRecord, "permissions">): Set<string> {
  const { granted } = parseStoredPermissions(role.permissions);
  return new Set(granted);
}

/** هل يمنح الدور هذه الصلاحية؟ (fail-closed: صلاحية مجهولة لا تُمنح) */
export function roleGrants(role: Pick<RoleRecord, "permissions">, permission: RbacPermission): boolean {
  const granted = effectivePermissions(role);
  if (granted.has(PERMISSION_WILDCARD)) return true;
  return granted.has(permission);
}

/** هل الدور يمنح كل الصلاحيات (wildcard)؟ */
export function roleIsWildcard(role: Pick<RoleRecord, "permissions">): boolean {
  return effectivePermissions(role).has(PERMISSION_WILDCARD);
}

/**
 * تطبيع قائمة صلاحيات مخصصة: ترفض المجهول و`*`، وتزيل التكرار.
 * تُستخدم قبل أي كتابة إلى قاعدة البيانات (بالإضافة إلى عقد Zod).
 */
export function normalizeCustomPermissions(input: string[]): { ok: true; permissions: string[] } | { ok: false; reason: string } {
  const out: string[] = [];
  for (const raw of input) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value === PERMISSION_WILDCARD) {
      return { ok: false, reason: "الرمز * محصور في دور المالك المدمج" };
    }
    if (!isKnownPermission(value)) {
      return { ok: false, reason: `صلاحية غير معروفة: ${value}` };
    }
    if (!out.includes(value)) out.push(value);
  }
  return { ok: true, permissions: out };
}

/** الأدوار المدمجة كما تُزرع في الهجرة 0003 — مرجع واحد للكود والاختبار. */
export const BUILTIN_ROLES: RoleRecord[] = [
  {
    id: "owner",
    label: "المالك",
    description: "كل الصلاحيات — دور مدمج غير قابل للتعديل أو الحذف.",
    permissions: [PERMISSION_WILDCARD],
    unknownPermissions: [],
    builtin: true,
  },
  {
    id: "operations",
    label: "عمليات المتجر",
    description: "إدارة الطلبات والمنتجات ومانيفست الإدارة مع استخدام سيليا.",
    permissions: ["orders:read", "orders:write", "products:write", "admin:read", "mcp:read", "celia:use"],
    unknownPermissions: [],
    builtin: true,
  },
  {
    id: "support",
    label: "خدمة العملاء",
    description: "متابعة الطلبات وتحديث حالتها واستخدام سيليا.",
    permissions: ["orders:read", "orders:write", "celia:use"],
    unknownPermissions: [],
    builtin: true,
  },
  {
    id: "viewer",
    label: "قراءة فقط",
    description: "عرض الطلبات ومانيفست الإدارة بلا أي تعديل.",
    permissions: ["orders:read", "admin:read", "mcp:read"],
    unknownPermissions: [],
    builtin: true,
  },
];
