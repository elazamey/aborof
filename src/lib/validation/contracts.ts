import { z } from "zod";
import { PASSWORD_POLICY } from "@/lib/secrets";

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

export type ProductUpsertInput = z.infer<typeof productUpsertContract>;
export type CreateOrderInput = z.infer<typeof createOrderContract>;
export type OrderStatusInput = z.infer<typeof orderStatusContract>;
export type ChatRequestInput = z.infer<typeof chatRequestContract>;

/** أول رسالة خطأ من zod بشكل مقروء عربيًا. */
export function firstZodIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "البيانات غير صالحة";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}
