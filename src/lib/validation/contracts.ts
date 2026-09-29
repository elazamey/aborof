import { z } from "zod";
import { PASSWORD_POLICY } from "@/lib/secrets";
import { RBAC_PERMISSIONS } from "@/lib/rbac/permissions";

/**
 * سجل عقود التحقق الموحد — المصدر الوحيد لقواعد صحة المدخلات لكل مسار كتابي.
 * كل المسارات تمر عبر هذه العقود؛ الفشل يتحول إلى VALIDATION_FAILED مع request_id.
 *
 * ملاحظة: `coerce` تُستخدم لأن نماذج الويب ترسل الأرقام كنصوص. العقود الحساسة
 * تستخدم `.strict()` لرفض أي حقول غير معروفة بدل تجاهلها الصامت.
 */

const trimmed = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, { message: `الطول الأدنى ${min} أحرف` })
    .max(max, { message: `الطول الأقصى ${max} حرفًا` });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { message: `الطول الأقصى ${max} حرفًا` })
    .optional()
    .or(z.literal(""))
    .transform((v) => v ?? "");

const positiveMoney = z.coerce
  .number({ invalid_type_error: "قيمة رقمية مطلوبة" })
  .finite()
  .min(0)
  .max(1_000_000);

const nonNegativeInt = z.coerce
  .number({ invalid_type_error: "عدد صحيح مطلوب" })
  .int()
  .min(0)
  .max(1_000_000);

/** سياسة كلمة المرور الموحدة — تُفرض عند تجهيز/تغيير كلمة مرور الإدارة. */
export const passwordPolicy = z
  .string()
  .min(PASSWORD_POLICY.minLength, {
    message: `كلمة المرور يجب ألا تقل عن ${PASSWORD_POLICY.minLength} حرفًا`,
  })
  .max(PASSWORD_POLICY.maxLength);

export const adminLoginContract = z
  .object({
    password: z.string().min(1).max(PASSWORD_POLICY.maxLength),
  })
  .strict();

export const productUpsertContract = z
  .object({
    product: z
      .object({
        id: z.string().trim().max(80).optional().or(z.literal("")).transform((v) => v ?? ""),
        name: trimmed(2, 200),
        description: optionalText(5000),
        price: positiveMoney,
        old_price: z
          .union([positiveMoney, z.literal(""), z.null()])
          .optional()
          .transform((v) => (v === "" || v == null ? null : (v as number))),
        category: z.string().trim().max(100).default(""),
        image: z.string().trim().max(20).default("🧴"),
        stock: nonNegativeInt,
        featured: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional().default(false),
      })
      .strict()
      .refine(
        (p) => p.old_price == null || Number.isNaN(p.old_price) || p.old_price >= (p.price as number),
        { message: "السعر قبل الخصم يجب ألا يقل عن السعر الحالي", path: ["old_price"] }
      ),
  })
  .strict();

export const orderItemContract = z
  .object({
    id: z.string().trim().min(1).max(80),
    qty: z.coerce.number().int().min(1).max(100),
  })
  .strict();

export const createOrderContract = z
  .object({
    customer: trimmed(2, 120),
    phone: trimmed(8, 30).regex(/^[0-9+\s()-]{8,30}$/, "رقم هاتف غير صالح"),
    address: trimmed(5, 500),
    governorate: z.string().trim().min(1).max(60),
    note: optionalText(500),
    payment: z.enum(["cod", "vodafone_cash"]).default("vodafone_cash"),
    transferRef: optionalText(120),
    items: z.array(orderItemContract).min(1, "السلة فارغة").max(50, "الحد الأقصى 50 صنفًا"),
  })
  .strict();

export const ORDER_STATUSES = ["جديد", "قيد المراجعة", "مؤكد", "قيد الشحن", "مكتمل", "ملغى"] as const;

export const orderStatusContract = z
  .object({
    id: trimmed(5, 100),
    status: z.enum(ORDER_STATUSES),
  })
  .strict();

/**
 * عقد تتبع الطلب للعميل — بشدّ أمني مقصود: يأخذ رقم الطلب وآخر 4 أرقام من
 * الهاتف معًا (لا يسمح بتعداد الطلبات برقم وحده). أي حالة عدم تطابق تُرجع
 * رسالة موحّدة واحدة لا تكشف وجود الطلب من عدمه.
 */
export const trackOrderContract = z
  .object({
    id: trimmed(5, 100),
    phoneLast4: z
      .string()
      .regex(/^\d{4}$/, "المطلوب آخر 4 أرقام من رقم الهاتف")
      .transform((v) => v.replace(/\D/g, ""))
      .refine((v) => v.length === 4, "المطلوب آخر 4 أرقام من رقم الهاتف"),
  })
  .strict();

export const chatMessageContract = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(2000, "الرسالة طويلة جدًا"),
  })
  .strict();

export const chatRequestContract = z
  .object({
    messages: z.array(chatMessageContract).max(30, "عدد الرسائل كبير جدًا").default([]),
  })
  .strict();

// ---------------------------------------------------------------------------
// M1 — لوحة الصلاحيات (RBAC)
// ---------------------------------------------------------------------------
/**
 * عقود لوحة الصلاحيات — كلها `.strict()` لرفض أي حقل غير معروف، وتتحقق من
 * الصلاحيات مقابل كتالوج الكود نفسه (`RBAC_PERMISSIONS`) لا نص حر، فلا يمكن
 * إدخال صلاحية غير منفَّذة. رفض `*` للأدوار المخصصة يقع في الطبقتين:
 * العقد هنا، و`normalizeCustomPermissions` في المخزن (دفاع مزدوج).
 */

/** اسم مستخدم: حروف لاتينية صغيرة/أرقام/نقطة/شرطة — مستقر في التدقيق والروابط. */
const rbacUsername = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,59}$/, "اسم المستخدم: 3–60 حرفًا لاتينيًا صغيرًا/أرقامًا/نقطة/شرطة");

/** معرّف دور مخصص — لا يقبل مسافات ولا حروفًا عربية (الدور له `label` عربي للعرض). */
const rbacRoleId = z
  .string()
  .trim()
  .regex(/^[a-z0-9_][a-z0-9_-]{1,59}$/, "معرّف الدور: حروف لاتينية صغيرة وأرقام وشرطة سفلية");

const rbacPermission = z.enum(
  [...RBAC_PERMISSIONS] as [string, ...string[]],
  { errorMap: () => ({ message: "صلاحية غير معروفة في الكتالوج" }) }
);

const rbacDisplayName = z.string().trim().max(60, "الاسم الظاهر: 60 حرفًا كحد أقصى").optional();
const rbacDescription = z.string().trim().max(300, "الوصف: 300 حرف كحد أقصى").optional();

export const rbacRoleCreateContract = z
  .object({
    role: z
      .object({
        id: rbacRoleId,
        label: trimmed(2, 60),
        description: rbacDescription,
        permissions: z.array(rbacPermission).max(RBAC_PERMISSIONS.length, "عدد الصلاحيات يتجاوز الكتالوج"),
      })
      .strict(),
  })
  .strict();

export const rbacRoleUpdateContract = z
  .object({
    role: z
      .object({
        id: rbacRoleId,
        label: trimmed(2, 60).optional(),
        description: rbacDescription,
        permissions: z.array(rbacPermission).max(RBAC_PERMISSIONS.length, "عدد الصلاحيات يتجاوز الكتالوج").optional(),
      })
      .strict()
      .refine((r) => r.label !== undefined || r.description !== undefined || r.permissions !== undefined, {
        message: "لا يوجد أي تغيير في الطلب",
      }),
  })
  .strict();

export const rbacUserCreateContract = z
  .object({
    user: z
      .object({
        username: rbacUsername,
        displayName: rbacDisplayName,
        roleId: rbacRoleId,
        password: passwordPolicy,
      })
      .strict(),
  })
  .strict();

export const rbacUserUpdateContract = z
  .object({
    user: z
      .object({
        id: trimmed(1, 60),
        displayName: rbacDisplayName,
        roleId: rbacRoleId.optional(),
        status: z.enum(["active", "disabled"]).optional(),
        /** تُستخدم من حائز `rbac:write`، أو من صاحب الحساب مع `currentPassword`. */
        password: passwordPolicy.optional(),
        /** إلزامية لتغيير كلمة مرور النفس بلا صلاحية `rbac:write`. */
        currentPassword: z.string().min(1).max(PASSWORD_POLICY.maxLength).optional(),
      })
      .strict()
      .refine(
        (u) =>
          u.password !== undefined ||
          u.displayName !== undefined ||
          u.roleId !== undefined ||
          u.status !== undefined,
        { message: "لا يوجد أي تغيير في الطلب" }
      ),
  })
  .strict();

/** عقد دخول وضع RBAC: اسم مستخدم + كلمة مرور (لا كلمة مرور مشتركة). */
export const adminLoginRbacContract = z
  .object({
    username: rbacUsername,
    password: z.string().min(1).max(PASSWORD_POLICY.maxLength),
  })
  .strict();

/**
 * عقود توكنات سيليا المُدارة (CeliaTokenManager).
 *
 * النطاقات تُقيَّد هنا بالشكل فقط (نص قصير لاتيني)، والتحقق من **العضوية** في
 * كتالوج `CELIA_KNOWN_SCOPES` يقع في طبقة المخزن (`src/lib/celia/tokens.ts`)
 * عمدًا: العقود لا تستورد إعداد Celia (وحدة تُقرأ في الخادم) كي تبقى قابلة
 * للاستخدام في أي سياق بلا سحب بيئة إلى الطبقة العليا.
 */
export const celiaTokenCreateContract = z
  .object({
    token: z
      .object({
        label: trimmed(2, 60),
        scopes: z
          .array(z.string().trim().regex(/^[a-z]+:[a-z]+$/, "صيغة النطاق غير صحيحة").max(40))
          .min(1, "اختر نطاقًا واحدًا على الأقل")
          .max(20, "عدد النطاقات يتجاوز الحد"),
        /** 0 = بلا انتهاء (الافتراضي). */
        expiresInDays: z.coerce.number().int().min(0).max(365).optional(),
      })
      .strict(),
  })
  .strict();

export const celiaTokenActionContract = z
  .object({
    id: z.string().trim().regex(/^ct_[0-9a-f]{6,32}$/, "معرّف توكن غير صالح"),
    action: z.enum(["revoke", "rotate"]),
  })
  .strict();

export type CeliaTokenCreateInput = z.infer<typeof celiaTokenCreateContract>;
export type CeliaTokenActionInput = z.infer<typeof celiaTokenActionContract>;

export type RbacRoleCreateInput = z.infer<typeof rbacRoleCreateContract>;
export type RbacRoleUpdateInput = z.infer<typeof rbacRoleUpdateContract>;
export type RbacUserCreateInput = z.infer<typeof rbacUserCreateContract>;
export type RbacUserUpdateInput = z.infer<typeof rbacUserUpdateContract>;

export type ProductUpsertInput = z.infer<typeof productUpsertContract>;
export type CreateOrderInput = z.infer<typeof createOrderContract>;
export type OrderStatusInput = z.infer<typeof orderStatusContract>;
export type TrackOrderInput = z.infer<typeof trackOrderContract>;
export type ChatRequestInput = z.infer<typeof chatRequestContract>;

/** أول رسالة خطأ من zod بشكل مقروء عربيًا. */
export function firstZodIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "البيانات غير صالحة";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}
