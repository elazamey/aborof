import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { db, ensureSchema, getProducts } from "@/lib/db";
import { STORE } from "@/lib/seed";
import { authenticateAdminRequest } from "@/lib/identity";
import { calculateShipping, GOVERNORATES } from "@/lib/shipping";
import { rateLimit } from "@/lib/rate-limit";
import { log } from "@/lib/log";

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

function requestId(request: Request) {
  return request.headers.get("x-request-id") ?? null;
}

/** إعادة بناء ردّ الطلب نفسه من سجل موجود (idempotency) */
function orderResponse(existing: { id: unknown; total: unknown; shipping_fee: unknown }, duplicate: boolean) {
  const total = Number(existing.total);
  const shipping = Number(existing.shipping_fee);
  return NextResponse.json({
    ok: true,
    id: String(existing.id),
    subtotal: total - shipping,
    shipping,
    total,
    duplicate,
  });
}

export async function POST(request: Request) {
  const started = Date.now();
  const limit = rateLimit(request, "orders", 8, 10 * 60 * 1000);
  if (!limit.ok) return responseError("محاولات كثيرة، حاول بعد قليل", 429, limit.retryAfter);
  let body: any;
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BODY_BYTES) return responseError("الطلب كبير جدًا", 413);
    body = await request.json();
  } catch {
    return responseError("طلب غير صالح (JSON)", 400);
  }

  const governorate = typeof body?.governorate === "string" ? body.governorate.trim() : "";
  if (!text(body?.customer, 2, 120) || !text(body?.phone, 8, 30) || !text(body?.address, 5, 500)) {
    return responseError("بيانات العميل أو العنوان غير صالحة", 422);
  }
  if (!GOVERNORATES.includes(governorate)) return responseError("اختر المحافظة من القائمة", 422);
  if (!Array.isArray(body?.items) || body.items.length < 1 || body.items.length > 50)
    return responseError("السلة غير صالحة", 422);
  if (!VALID_PAYMENTS.includes(body.payment ?? "vodafone_cash")) return responseError("طريقة الدفع غير صالحة", 422);
  if (body.transferRef != null && !text(body.transferRef, 0, 120)) return responseError("رقم التحويل غير صالح", 422);

  const idempotencyKey =
    typeof body?.idempotencyKey === "string" && body.idempotencyKey.trim().length > 0
      ? body.idempotencyKey.trim().slice(0, 100)
      : null;

  const requested = body.items.map((item: unknown) => ({
    id: String((item as { id?: unknown })?.id ?? ""),
    qty: Number((item as { qty?: unknown })?.qty),
  }));
  if (
    requested.some(
      (item: { id: string; qty: number }) => !item.id || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 100
    )
  ) {
    return responseError("الكمية غير صالحة", 422);
  }

  const c = db();
  if (!c) return responseError("قاعدة البيانات غير مربوطة", 503);
  await ensureSchema();

  // Idempotency: نفس مفتاح العملية = نفس الطلب (يمنع التكرار عند إعادة المحاولة)
  if (idempotencyKey) {
    try {
      const existing = await c.execute({
        sql: "SELECT id, total, shipping_fee FROM orders WHERE idempotency_key=?",
        args: [idempotencyKey],
      });
      if (existing.rows.length > 0) {
        log("info", "duplicate order request returned existing order", {
          request_id: requestId(request),
          order_id: String(existing.rows[0].id),
          idempotent: true,
        });
        return orderResponse(
          existing.rows[0] as unknown as { id: unknown; total: unknown; shipping_fee: unknown },
          true
        );
      }
    } catch (error) {
      log("error", "orders: idempotency lookup failed", { request_id: requestId(request), error: String(error) });
    }
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
  const id = `ORD-${Date.now().toString().slice(-8)}-${randomUUID().slice(0, 8)}`;
  const tx = await c.transaction("write");
  try {
    for (const item of verifiedItems) {
      // invariant: المخزون لا ينخفض تحت الصفر (شرط stock>=? داخل المعاملة)
      const reserved = await tx.execute({
        sql: "UPDATE products SET stock=stock-? WHERE id=? AND stock>=?",
        args: [item.qty, item.id, item.qty],
      });
      if (reserved.rowsAffected !== 1) {
        await tx.rollback();
        return responseError(`الكمية المطلوبة من ${item.name} لم تعد متاحة`, 409);
      }
    }
    await tx.execute({
      sql: `INSERT INTO orders (id,customer,phone,address,governorate,items,total,shipping_fee,payment,transfer_ref,note,idempotency_key)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id,
        body.customer.trim(),
        body.phone.trim(),
        body.address.trim(),
        governorate,
        JSON.stringify(verifiedItems),
        total,
        shipping,
        body.payment ?? "vodafone_cash",
        typeof body.transferRef === "string" ? body.transferRef.trim() : "",
        text(body.note, 0, 500) ? body.note.trim() : "",
        idempotencyKey,
      ],
    });
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    // تعارض متزامن على نفس مفتاح idempotency: أعد الطلب الموجود بدل إنشاء طلب ثانٍ
    if (idempotencyKey && String(error).includes("UNIQUE")) {
      try {
        const existing = await c.execute({
          sql: "SELECT id, total, shipping_fee FROM orders WHERE idempotency_key=?",
          args: [idempotencyKey],
        });
        if (existing.rows.length > 0) {
          log("info", "concurrent duplicate order resolved", {
            request_id: requestId(request),
            order_id: String(existing.rows[0].id),
          });
          return orderResponse(
            existing.rows[0] as unknown as { id: unknown; total: unknown; shipping_fee: unknown },
            true
          );
        }
      } catch (lookupError) {
        log("error", "orders: duplicate lookup after conflict failed", {
          request_id: requestId(request),
          error: String(lookupError),
        });
      }
    }
    log("error", "orders: create failed", {
      request_id: requestId(request),
      route: "/api/orders",
      error: String(error),
      durationMs: Date.now() - started,
    });
    return responseError("تعذر تسجيل الطلب، حاول مرة أخرى", 500);
  }
  log("info", "order created", {
    request_id: requestId(request),
    order_id: id,
    total,
    durationMs: Date.now() - started,
  });
  return NextResponse.json({ ok: true, id, subtotal, shipping, total });
}

export async function GET(request: Request) {
  const auth = await authenticateAdminRequest(request);
  if (!auth.ok) return responseError(auth.status === 503 ? auth.error : "unauthorized", auth.status);
  const c = db();
  if (!c) return responseError("قاعدة البيانات غير مربوطة", 503);
  try {
    await ensureSchema();
    const r = await c.execute(
      "SELECT id,customer,phone,address,governorate,items,total,shipping_fee,payment,transfer_ref,receipt_url,status,note,created_at FROM orders ORDER BY created_at DESC LIMIT 200"
    );
    return NextResponse.json({ orders: r.rows.map((x) => ({ ...x })) });
  } catch (error) {
    log("error", "orders: list failed", { request_id: requestId(request), route: "/api/orders", error: String(error) });
    return responseError("تعذر تحميل الطلبات", 503);
  }
}

export async function PATCH(request: Request) {
  const started = Date.now();
  const auth = await authenticateAdminRequest(request);
  if (!auth.ok) return responseError(auth.status === 503 ? auth.error : "unauthorized", auth.status);
  const limit = rateLimit(request, "admin-order-update", 30, 10 * 60 * 1000);
  if (!limit.ok) return responseError("محاولات كثيرة، حاول بعد قليل", 429, limit.retryAfter);
  let body: any;
  try {
    body = await request.json();
  } catch {
    return responseError("طلب غير صالح (JSON)", 400);
  }
  if (!text(body?.id, 5, 100) || !VALID_STATUSES.includes(body.status))
    return responseError("حالة الطلب غير صالحة", 422);
  const c = db();
  if (!c) return responseError("قاعدة البيانات غير مربوطة", 503);
  try {
    await ensureSchema();
    const existing = await c.execute({ sql: "SELECT status, items FROM orders WHERE id=?", args: [body.id.trim()] });
    if (existing.rows.length === 0) return responseError("الطلب غير موجود", 404);
    const previousStatus = String(existing.rows[0].status ?? "");
    const orderId = body.id.trim();

    // Business invariant: إلغاء الطلب يعيد الكميات للمخزون — مرة واحدة فقط
    if (body.status === "ملغى" && previousStatus !== "ملغى") {
      let items: { id?: unknown; qty?: unknown }[] = [];
      try {
        items = JSON.parse(String(existing.rows[0].items ?? "[]"));
      } catch {
        items = [];
      }
      for (const item of items) {
        const qty = Number(item?.qty);
        const productId = String(item?.id ?? "");
        if (qty > 0 && productId) {
          await c.execute({ sql: "UPDATE products SET stock=stock+? WHERE id=?", args: [qty, productId] });
        }
      }
      log("info", "order cancelled, stock restored", { request_id: requestId(request), order_id: orderId });
    }

    await c.execute({ sql: "UPDATE orders SET status=? WHERE id=?", args: [body.status, orderId] });
    await c.execute({
      sql: "INSERT INTO admin_audit_log (action,entity,entity_id,details) VALUES (?,?,?,?)",
      args: ["status_change", "order", orderId, JSON.stringify({ status: body.status, from: previousStatus })],
    });
    log("info", "order status changed", {
      request_id: requestId(request),
      order_id: orderId,
      status: body.status,
      durationMs: Date.now() - started,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    log("error", "orders: status change failed", {
      request_id: requestId(request),
      route: "/api/orders",
      error: String(error),
      durationMs: Date.now() - started,
    });
    return responseError("تعذر تحديث حالة الطلب", 500);
  }
}
