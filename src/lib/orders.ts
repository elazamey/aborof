import { randomUUID } from "node:crypto";
import { db, ensureSchema } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { calculateShipping } from "@/lib/shipping";
import { STORE, type Product } from "@/lib/seed";
import type { CreateOrderInput, OrderStatusInput } from "@/lib/validation/contracts";

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
  const c = db();
  if (!c) return [];
  await ensureSchema();
  const r = await c.execute(
    "SELECT id,customer,phone,address,governorate,items,total,shipping_fee,payment,transfer_ref,receipt_url,status,note,created_at FROM orders ORDER BY created_at DESC LIMIT ?",
    [limit]
  );
  return r.rows.map((x) => ({ ...x }));
}

export async function updateOrderStatus(input: OrderStatusInput): Promise<void> {
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
