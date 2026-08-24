import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { db, ensureSchema, getProducts } from "@/lib/db";
import { STORE } from "@/lib/seed";
import { isAdminRequest } from "@/lib/auth";
import { calculateShipping, GOVERNORATES } from "@/lib/shipping";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32_000;
const VALID_PAYMENTS = ["cod", "vodafone_cash"] as const;
const VALID_STATUSES = ["جديد", "قيد المراجعة", "مؤكد", "قيد الشحن", "مكتمل", "ملغى"] as const;

function text(value: unknown, min: number, max: number) {
  return typeof value === "string" && value.trim().length >= min && value.trim().length <= max;
}

function responseError(error: string, status: number, retryAfter?: number) {
  const response = NextResponse.json({ error }, { status });
  if (retryAfter) response.headers.set("Retry-After", String(retryAfter));
  return response;
}

export async function POST(request: Request) {
  const limit = rateLimit(request, "orders", 8, 10 * 60 * 1000);
  if (!limit.ok) return responseError("محاولات كثيرة، حاول بعد قليل", 429, limit.retryAfter);
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BODY_BYTES) return responseError("الطلب كبير جدًا", 413);
    const body = await request.json();
    const governorate = typeof body?.governorate === "string" ? body.governorate.trim() : "";
    if (!text(body?.customer, 2, 120) || !text(body?.phone, 8, 30) || !text(body?.address, 5, 500)) {
      return responseError("بيانات العميل أو العنوان غير صالحة", 422);
    }
    if (!GOVERNORATES.includes(governorate)) return responseError("اختر المحافظة من القائمة", 422);
    if (!Array.isArray(body?.items) || body.items.length < 1 || body.items.length > 50) return responseError("السلة غير صالحة", 422);
    if (!VALID_PAYMENTS.includes(body.payment ?? "vodafone_cash")) return responseError("طريقة الدفع غير صالحة", 422);
    if (body.transferRef != null && !text(body.transferRef, 0, 120)) return responseError("رقم التحويل غير صالح", 422);

    const requested = body.items.map((item: unknown) => ({
      id: String((item as { id?: unknown })?.id ?? ""),
      qty: Number((item as { qty?: unknown })?.qty),
    }));
    if (requested.some((item: { id: string; qty: number }) => !item.id || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 100)) {
      return responseError("الكمية غير صالحة", 422);
    }

    const products = await getProducts();
    const byId = new Map(products.map((product) => [String(product.id), product]));
    const verifiedItems: { id: string; name: string; price: number; qty: number }[] = [];
    let subtotal = 0;
    for (const item of requested) {
      const product = byId.get(item.id);
      if (!product) return responseError("أحد المنتجات لم يعد متاحًا", 409);
      if (item.qty > product.stock) return responseError(`الكمية المطلوبة من ${product.name} غير متاحة`, 409);
      subtotal += product.price * item.qty;
      verifiedItems.push({ id: String(product.id), name: product.name, price: product.price, qty: item.qty });
    }

    const shipping = calculateShipping(governorate, subtotal, STORE.freeShippingOver);
    const total = subtotal + shipping;
    const c = db();
    if (!c) return responseError("قاعدة البيانات غير مربوطة", 503);
    await ensureSchema();
    const id = `ORD-${Date.now().toString().slice(-8)}-${randomUUID().slice(0, 8)}`;
    const tx = await c.transaction("write");
    try {
      for (const item of verifiedItems) {
        const reserved = await tx.execute({ sql: "UPDATE products SET stock=stock-? WHERE id=? AND stock>=?", args: [item.qty, item.id, item.qty] });
        if (reserved.rowsAffected !== 1) {
          await tx.rollback();
          return responseError(`الكمية المطلوبة من ${item.name} لم تعد متاحة`, 409);
        }
      }
      await tx.execute({
        sql: `INSERT INTO orders (id,customer,phone,address,governorate,items,total,shipping_fee,payment,transfer_ref,note)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        args: [id, body.customer.trim(), body.phone.trim(), body.address.trim(), governorate, JSON.stringify(verifiedItems), total, shipping, body.payment ?? "vodafone_cash", typeof body.transferRef === "string" ? body.transferRef.trim() : "", text(body.note, 0, 500) ? body.note.trim() : ""],
      });
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
    return NextResponse.json({ ok: true, id, subtotal, shipping, total });
  } catch {
    return responseError("تعذر تسجيل الطلب، حاول مرة أخرى", 500);
  }
}

export async function GET(request: Request) {
  if (!isAdminRequest(request)) return responseError("unauthorized", 401);
  const c = db();
  if (!c) return NextResponse.json({ orders: [] });
  try {
    await ensureSchema();
    const r = await c.execute("SELECT id,customer,phone,address,governorate,items,total,shipping_fee,payment,transfer_ref,receipt_url,status,note,created_at FROM orders ORDER BY created_at DESC LIMIT 200");
    return NextResponse.json({ orders: r.rows.map((x) => ({ ...x })) });
  } catch {
    return responseError("تعذر تحميل الطلبات", 503);
  }
}

export async function PATCH(request: Request) {
  if (!isAdminRequest(request)) return responseError("unauthorized", 401);
  const limit = rateLimit(request, "admin-order-update", 30, 10 * 60 * 1000);
  if (!limit.ok) return responseError("محاولات كثيرة، حاول بعد قليل", 429, limit.retryAfter);
  try {
    const body = await request.json();
    if (!text(body?.id, 5, 100) || !VALID_STATUSES.includes(body.status)) return responseError("حالة الطلب غير صالحة", 422);
    const c = db();
    if (!c) return responseError("قاعدة البيانات غير مربوطة", 503);
    await ensureSchema();
    await c.execute({ sql: "UPDATE orders SET status=? WHERE id=?", args: [body.status, body.id.trim()] });
    await c.execute({ sql: "INSERT INTO admin_audit_log (action,entity,entity_id,details) VALUES (?,?,?,?)", args: ["status_change", "order", body.id.trim(), JSON.stringify({ status: body.status })] });
    return NextResponse.json({ ok: true });
  } catch {
    return responseError("تعذر تحديث حالة الطلب", 500);
  }
}
