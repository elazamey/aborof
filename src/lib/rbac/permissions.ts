/**
 * كتالوج الصلاحيات — المصدر الوحيد للحقيقة (single source of truth).
 *
 * قاعدتان تحكمان هذا الملف:
 *
 *  1. **كل صلاحية لها نقطة فرض حقيقية.** لا تُدرج صلاحية "احتياطية" أو
 *     للمستقبل: صلاحية لا يحرسها مسار = وعد كاذب في الواجهة وخطر تضخّم
 *     صلاحيات وهمي. عند إضافة مسار محكوم يُضاف هنا مع نقطة فرضه واختباره.
 *  2. **fail-closed في القراءة والكتابة.** أي نص صلاحية غير مدرج هنا يُتجاهل
 *     عند الحساب (لا يُمنح أبدًا)، ويُرفض عند الكتابة (عقد Zod + تحقق المخزن).
 *
 * المفردات موحّدة عمدًا مع نطاقات Celia في `src/lib/celia/config.ts`
 * (`orders:read`... تُقرأ بنفس الصياغة)، فالصلاحية الواحدة لها معنى واحد في
 * الطبقتين، و`CELIA_ALLOWED_SCOPES` يبقى السقف على مستوى المتجر.
 */

export const RBAC_PERMISSIONS = [
  "orders:read",
  "orders:write",
  "products:write",
  "admin:read",
  "mcp:read",
  "diagnostics:read",
  "rbac:read",
  "rbac:write",
  "audit:read",
  "celia:use",
] as const;

export type RbacPermission = (typeof RBAC_PERMISSIONS)[number];

/** البديل الوحيد المقبول لـ"كل الصلاحيات" — محصور في الدور المدمج `owner`. */
export const PERMISSION_WILDCARD = "*" as const;

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(RBAC_PERMISSIONS);

export function isKnownPermission(value: unknown): value is RbacPermission {
  return typeof value === "string" && PERMISSION_SET.has(value);
}

/** تسميات عربية للعرض في لوحة الصلاحيات (لا تُستخدم في أي قرار أمني). */
export const PERMISSION_LABELS: Record<RbacPermission, string> = {
  "orders:read": "عرض الطلبات",
  "orders:write": "تحديث حالة الطلبات",
  "products:write": "إدارة المنتجات (إضافة/تعديل/حذف)",
  "admin:read": "عرض مانيفست أسطول الوكلاء",
  "mcp:read": "عرض أدوات MCP المسجّلة",
  "diagnostics:read": "عرض التشخيص التشغيلي",
  "rbac:read": "عرض الأدوار والمستخدمين",
  "rbac:write": "تعديل الأدوار والمستخدمين",
  "audit:read": "قراءة سجل التدقيق",
  "celia:use": "استخدام سيليا من جلسة الإدارة",
};

/**
 * نقاط الفرض الفعلية لكل صلاحية — تُعرض في الواجهة وتُفحص في الاختبارات
 * (اختبار يمنع صلاحية بلا نقطة فرض مسجّلة).
 */
export const PERMISSION_ENFORCEMENT: Record<RbacPermission, string> = {
  "orders:read": "GET /api/orders",
  "orders:write": "PATCH /api/orders",
  "products:write": "POST,DELETE /api/products",
  "admin:read": "GET /api/admin/agents",
  "mcp:read": "GET /api/admin/mcp/tools",
  "diagnostics:read": "GET /api/admin/diagnostics",
  "rbac:read": "GET /api/admin/rbac",
  "rbac:write": "POST,PATCH,DELETE /api/admin/rbac/roles|users",
  "audit:read": "GET /api/admin/rbac/audit",
  "celia:use": "POST /api/celia/chat (جلسة إدارة)",
};

export interface PermissionGroup {
  id: string;
  label: string;
  permissions: RbacPermission[];
}

/** تجميع العرض فقط — يضمن أن كل صلاحية تظهر في مجموعة واحدة على الأقل. */
export const PERMISSION_GROUPS: PermissionGroup[] = [
  { id: "catalog", label: "الكتالوج", permissions: ["products:write"] },
  { id: "orders", label: "الطلبات", permissions: ["orders:read", "orders:write"] },
  {
    id: "platform",
    label: "المنصة والتشغيل",
    permissions: ["admin:read", "mcp:read", "diagnostics:read", "celia:use"],
  },
  {
    id: "governance",
    label: "الحكم والصلاحيات",
    permissions: ["rbac:read", "rbac:write", "audit:read"],
  },
];

/**
 * يفكّ مصفوفة الصلاحيات المخزّنة إلى: ممنوح فعليًا + غير معروف (للشفافية).
 * المجهول **لا يُمنح** أبدًا — قد يظهر فقط لأن نسخة أقدم/أحدث كتبت الكتالوج.
 */
export function parseStoredPermissions(raw: unknown): { granted: string[]; unknown: string[] } {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return { granted: [], unknown: [] };
    }
  }
  if (!Array.isArray(list)) return { granted: [], unknown: [] };
  const granted: string[] = [];
  const unknown: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") {
      const label = String(entry);
      if (!unknown.includes(label)) unknown.push(label);
      continue;
    }
    if (entry === PERMISSION_WILDCARD || isKnownPermission(entry)) {
      if (!granted.includes(entry)) granted.push(entry);
    } else if (!unknown.includes(entry)) {
      unknown.push(entry);
    }
  }
  return { granted, unknown };
}

/** قائمة الصلاحيات المعروضة في العقد (بدون `*` — غير مسموح للأدوار المخصصة). */
export const RBAC_PERMISSION_VALUES = [...RBAC_PERMISSIONS] as string[];
