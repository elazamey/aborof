/**
 * أدوات Celia — مصفاة بالنطاق (Scope Filter) ومحمية بالتنفيذ المزدوج.
 *
 * - `search_products` → يتطلب `products:read`
 * - `get_order_status` → يتطلب `orders:read`
 *
 * كل أداة تُسجَّل في السجل العالمي (McpToolRegistry) لكنها لا تُرى إلا
 * عبر `allowedTools` المُمرَّرة في كل طلب. حتى لو هلوس النموذج باسم أداة
 * غير مسموحة، فإن `runToolLoop` يرفضها قبل التنفيذ برسالة
 * `Tool execution denied: Scope boundary violation`.
 *
 * هذا يحقق "القفص" المطلوب: النموذج لا يرى إلا ما يسمح به النطاق.
 */

import { z } from "zod";
import { getDrizzle } from "@/lib/db/drizzle";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { orders } from "@/lib/db/schema";
import type { McpTool, McpToolPolicy } from "@/lib/ai/mcp/types";

const READ_ONLY: McpToolPolicy = {
  readOnly: true,
  timeoutMs: 4000,
  maxResultChars: 4000,
};

// ---------------------------------------------------------------------------
// get_order_status — يتطلب orders:read
// ---------------------------------------------------------------------------
const orderStatusSchema = z
  .object({
    order_id: z.string().trim().min(1, "معرّف الطلب مطلوب").max(100),
  })
  .strict();

export const getOrderStatusTool: McpTool = {
  definition: {
    name: "get_order_status",
    description:
      "يستعلم عن حالة طلب عبر order_id ويعيد الحالة والمجموع وتاريخ الإنشاء — بلا كشف لهاتف العميل أو عنوانه الكامل.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "معرّف الطلب (مثل ORD-123)" },
      },
      required: ["order_id"],
      additionalProperties: false,
    },
  },
  policy: READ_ONLY,
  validate: (raw) => {
    const parsed = orderStatusSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues[0]?.message ?? "وسائط غير صالحة" };
    }
    return { ok: true, value: parsed.data };
  },
  async run(value) {
    const { order_id } = value as { order_id: string };
    const drizzle = getDrizzle();
    const client = db();

    // Drizzle أولًا (type-safe)
    if (drizzle) {
      try {
        const rows = await drizzle.select().from(orders).where(eq(orders.id, order_id)).limit(1);
        if (rows.length === 0) return "الطلب غير موجود.";
        const o = rows[0];
        // لا نكشف الهاتف/العنوان الكامل — نعيد حقول آمنة فقط
        const safe = {
          id: o.id,
          status: o.status,
          total: Number(o.total),
          shipping_fee: Number(o.shippingFee),
          governorate: o.governorate,
          created_at: o.createdAt,
          // عدد الأصناف من حقل items JSON (لا نكشف التفاصيل الكاملة)
          items_count: (() => {
            try {
              const arr = JSON.parse(o.items || "[]");
              return Array.isArray(arr) ? arr.length : 0;
            } catch {
              return 0;
            }
          })(),
        };
        return {
          text: `الطلب ${safe.id}: الحالة ${safe.status} — المجموع ${safe.total} جنيه (شحن ${safe.shipping_fee}) — المحافظة ${safe.governorate || "—"} — ${safe.created_at} — ${safe.items_count} صنف.`,
          structured: { kind: "order_status", order: safe },
        };
      } catch {
        // سقوط آمن إلى المسار الخام
      }
    }

    // Fallback خام (إن لم يكن Drizzle جاهزًا)
    if (client) {
      try {
        const r = await client.execute({
          sql: "SELECT id, status, total, shipping_fee, governorate, created_at, items FROM orders WHERE id = ? LIMIT 1",
          args: [order_id],
        });
        if (r.rows.length === 0) return "الطلب غير موجود.";
        const o = r.rows[0] as unknown as {
          id: string;
          status: string;
          total: number;
          shipping_fee: number;
          governorate: string;
          created_at: string;
          items: string;
        };
        const itemsCount = (() => {
          try {
            const arr = JSON.parse(o.items || "[]");
            return Array.isArray(arr) ? arr.length : 0;
          } catch {
            return 0;
          }
        })();
        return {
          text: `الطلب ${o.id}: الحالة ${o.status} — المجموع ${Number(o.total)} جنيه — ${o.created_at} — ${itemsCount} صنف.`,
          structured: {
            kind: "order_status",
            order: {
              id: o.id,
              status: o.status,
              total: Number(o.total),
              shipping_fee: Number(o.shipping_fee),
              governorate: o.governorate,
              created_at: o.created_at,
              items_count: itemsCount,
            },
          },
        };
      } catch {
        return "تعذر الاستعلام عن الطلب حاليًا.";
      }
    }

    return "قاعدة البيانات غير متاحة حاليًا.";
  },
};

// ---------------------------------------------------------------------------
// خريطة النطاق → الأداة (للمصفاة)
// ---------------------------------------------------------------------------

export const CELIA_TOOL_SCOPE_MAP: Record<string, string> = {
  search_products: "products:read",
  get_order_status: "orders:read",
};

/**
 * يعيد أسماء الأدوات المسموحة بناءً على guard.allowed.
 * - products:read → search_products
 * - orders:read → get_order_status
 * - * → كلاهما
 */
export function celiaAllowedToolNames(allowed: Set<string>): string[] {
  const out: string[] = [];
  for (const [tool, scope] of Object.entries(CELIA_TOOL_SCOPE_MAP)) {
    if (allowed.has(scope) || allowed.has("*") || allowed.has(scope.split(":")[0] + ":*")) {
      out.push(tool);
    }
  }
  return out;
}

/** كل أدوات Celia (للتسجيل في السجل العالمي) */
export const CELIA_TOOLS = [getOrderStatusTool] as const;
