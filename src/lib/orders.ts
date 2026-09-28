import { randomUUID } from "node:crypto";
import { db, ensureSchema, mapDatabaseWriteError } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { calculateShipping } from "@/lib/shipping";
import { STORE, type Product } from "@/lib/seed";
import type { CreateOrderInput, OrderStatusInput, TrackOrderInput } from "@/lib/validation/contracts";

export interface VerifiedItem {
  id: string;
  name: string;
  price: number;
  qty: number;
}

/**
 * طبقة وصول موحّدة لبيانات الطلبات. كل عملية كتابية تمر عبر كائن الإدخال
 * المتحقق منه بالفعل (عقد Zod) وتُنفَّذ داخل معاملة، بحيث لا تبقى سجلات
 * يتيمة: الأصناف والمخزون والطلب تتحرك معًا أو لا تحدث إطلاقًا.
 */
export async function createOrder(
  input: CreateOrderInput,
  products: Product[]
): Promise<{ id: string; subtotal: number; shipping: number; total: number }> {
  try {
    return await createOrderInner(input, products);
  } catch (error) {
    mapDatabaseWriteError("create order", error);
  }
}

async function createOrderInner(
  input: CreateOrderInput,
  products: Product[]
): Promise<{ id: string; subtotal: number; shipping: number; total: number }> {
  const c = db();
  if (!c) throw Errors.serviceUnavailable("قاعدة البيانات غير مربوطة");
  await ensureSchema();

  const byId = new Map(products.map((p) => [String(p.id), p]));
  const verified: VerifiedItem[] = [];
  let subtotal = 0;
  for (const item of input.items) {
    const product = byId.get(item.id);
    if (!product) throw Errors.conflict("أحد المنتجات لم يعد متاحًا");
    if (item.qty > product.stock) {
      throw Errors.conflict(`الكمية المطلوبة من ${product.name} غير متاحة`);
    }
    subtotal += product.price * item.qty;
    verified.push({ id: String(product.id), name: product.name, price: product.price, qty: item.qty });
  }

  const governorate = input.governorate.trim();
  const shipping = calculateShipping(governorate, subtotal, STORE.freeShippingOver);
  const total = subtotal + shipping;
  const id = `ORD-${Date.now().toString().slice(-8)}-${randomUUID().slice(0, 8)}`;
  const tx = await c.transaction("write");
  try {
    await tx.execute("PRAGMA foreign_keys = ON");
    for (const item of verified) {
      const reserved = await tx.execute({
        sql: "UPDATE products SET stock=stock-? WHERE id=? AND stock>=?",
        args: [item.qty, item.id, item.qty],
      });
      if (reserved.rowsAffected !== 1) {
        await tx.rollback();
        throw Errors.conflict(`الكمية المطلوبة من ${item.name} لم تعد متاحة`);
      }
    }
    await tx.execute({
      sql: `INSERT INTO orders (id,customer,phone,address,governorate,items,total,shipping_fee,payment,transfer_ref,note)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id,
        input.customer.trim(),
        input.phone.trim(),
        input.address.trim(),
        governorate,
        JSON.stringify(verified),
        total,
        shipping,
        input.payment,
        input.transferRef?.trim() ?? "",
        input.note?.trim() ?? "",
      ],
    });
    for (const item of verified) {
      await tx.execute({
        sql: `INSERT INTO order_items (order_id,product_id,name,price,qty) VALUES (?,?,?,?,?)`,
        args: [id, item.id, item.name, item.price, item.qty],
      });
    }
    await tx.commit();
  } catch (error) {
    try {
      await tx.rollback();
    } catch {
      // المعاملة قد تكون انتهت بالفعل.
    }
    throw error;
  }

  // الشحن والإجمالي حُسبا مركزيًا من بيانات المنتجات الموثوقة داخل المعاملة.
  return { id, subtotal, shipping, total };
}

export async function listOrders(limit = 200) {
  // قراءة إدارية بلا بديل بذرة: الفشل هنا 503 صريح لا 500 خام ولا قائمة فارغة
  // صامتة تُخفي العطل عن الإدارة.
  try {
    const c = db();
    if (!c) return [];
    await ensureSchema();
    const r = await c.execute(
      "SELECT id,customer,phone,address,governorate,items,total,shipping_fee,payment,transfer_ref,receipt_url,status,note,created_at FROM orders ORDER BY created_at DESC LIMIT ?",
      [limit]
    );
    return r.rows.map((x) => ({ ...x }));
  } catch (error) {
    mapDatabaseWriteError("list orders", error);
  }
}

export async function updateOrderStatus(input: OrderStatusInput): Promise<void> {
  try {
    return await updateOrderStatusInner(input);
  } catch (error) {
    mapDatabaseWriteError("update order status", error);
  }
}

async function updateOrderStatusInner(input: OrderStatusInput): Promise<void> {
  const c = db();
  if (!c) throw Errors.serviceUnavailable("قاعدة البيانات غير مربوطة");
  await ensureSchema();
  const id = input.id.trim();
  const tx = await c.transaction("write");
  try {
    const updated = await tx.execute({ sql: "UPDATE orders SET status=? WHERE id=?", args: [input.status, id] });
    if (updated.rowsAffected !== 1) {
      await tx.rollback();
      throw Errors.notFound("الطلب غير موجود");
    }
    await tx.execute({
      sql: "INSERT INTO admin_audit_log (action,entity,entity_id,details) VALUES (?,?,?,?)",
      args: ["status_change", "order", id, JSON.stringify({ status: input.status })],
    });
    await tx.commit();
  } catch (error) {
    try {
      await tx.rollback();
    } catch {
      // ignore
    }
    throw error;
  }
}

/**
 * تتبع طلب للعميل — بشدّ أمني مقصود (docs/ai/phase-3-ux-roadmap.md):
 *  - يعمل فقط بعاملين معًا: رقم الطلب + آخر 4 أرقام من الهاتف.
 *  - الإخراج مبهم: الحالة + ملخص أصناف بلا هاتف كامل ولا عنوان ولا أسعار مفصلة.
 *  - رسالة الفشل واحدة لا تكشف وجود الطلب من عدمه (يمنع تعداد الطلبات).
 *
 * يرمي `Errors.notFound` في كل حالات عدم التطابق برسالة موحّدة.
 */
export async function trackOrder(
  input: TrackOrderInput & { phoneLast4: string },
  isEnabled: boolean
): Promise<{ id: string; status: string; items: { name: string; qty: number }[]; created_at: string }> {
  if (!isEnabled) throw Errors.notFound("تعذر العثور على الطلب");

  const c = db();
  if (!c) throw Errors.notFound("تعذر العثور على الطلب");
  await ensureSchema();

  const r = await c.execute({
    sql: "SELECT id, phone, items, status, created_at FROM orders WHERE id=?",
    args: [input.id.trim()],
  });
  const row = r.rows[0] as
    | { id?: unknown; phone?: unknown; items?: unknown; status?: unknown; created_at?: unknown }
    | undefined;

  // مقارنة زمنية ثابتة لآخر 4 أرقام — القيمة المتوقعة تُبنى بلا تمييز للوجود.
  const actual = String(row?.phone ?? "");
  const ok = row != null && actual.replace(/\D/g, "").slice(-4) === input.phoneLast4;
  if (!ok) throw Errors.notFound("تعذر العثور على الطلب");

  let items: { name: string; qty: number }[] = [];
  try {
    const parsed = JSON.parse(String(row?.items ?? "[]")) as unknown;
    if (Array.isArray(parsed)) {
      items = parsed
        .filter((it): it is { name?: unknown; qty?: unknown } => Boolean(it) && typeof it === "object")
        .map((it) => ({ name: String(it.name ?? "—"), qty: Number(it.qty ?? 1) }))
        .slice(0, 10);
    }
  } catch {
    items = [];
  }

  return {
    id: String(row?.id ?? input.id.trim()),
    status: String(row?.status ?? "جديد"),
    items,
    created_at: String(row?.created_at ?? ""),
  };
}
