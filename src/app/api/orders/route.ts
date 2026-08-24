import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { db, ensureSchema, getProducts } from "@/lib/db";
import { STORE } from "@/lib/seed";
import { isAdminRequest } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32_000;

function text(value: unknown, min: number, max: number) {
  return typeof value === "string" && value.trim().length >= min && value.trim().length <= max;
}

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BODY_BYTES) return NextResponse.json({ error: "الطلب كبير جدًا" }, { status: 413 });

    const body = await request.json();
    if (!text(body?.customer, 2, 120) || !text(body?.phone, 8, 30) || !text(body?.address, 5, 500)) {
      return NextResponse.json({ error: "بيانات العميل أو العنوان غير صالحة" }, { status: 422 });
    }
    if (!Array.isArray(body?.items) || body.items.length < 1 || body.items.length > 50) {
      return NextResponse.json({ error: "السلة غير صالحة" }, { status: 422 });
    }
    if (!['cod', 'vodafone_cash'].includes(body.payment ?? "vodafone_cash")) {
      return NextResponse.json({ error: "طريقة الدفع غير صالحة" }, { status: 422 });
    }

    const requested = body.items.map((item: any) => ({ id: String(item?.id ?? ""), qty: Number(item?.qty) }));
    if (requested.some((item: { id: string; qty: number }) => !item.id || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 100)) {
      return NextResponse.json({ error: "الكمية غير صالحة" }, { status: 422 });
    }

    const products = await getProducts();
    const byId = new Map(products.map((product) => [String(product.id), product]));
    const verifiedItems = [];
    let subtotal = 0;

    for (const item of requested) {
      const product = byId.get(item.id);
      if (!product) return NextResponse.json({ error: "أحد المنتجات لم يعد متاحًا" }, { status: 409 });
      if (item.qty > product.stock) return NextResponse.json({ error: `الكمية المطلوبة من ${product.name} غير متاحة` }, { status: 409 });
      subtotal += product.price * item.qty;
      verifiedItems.push({ id: product.id, name: product.name, price: product.price, qty: item.qty });
    }

    const shipping = subtotal >= STORE.freeShippingOver ? 0 : STORE.shipping;
    const total = subtotal + shipping;
    const c = db();
    if (!c) return NextResponse.json({ error: "قاعدة البيانات غير مربوطة" }, { status: 503 });
    await ensureSchema();

    const id = `ORD-${Date.now().toString().slice(-8)}-${randomUUID().slice(0, 8)}`;
    await c.execute({
      sql: `INSERT INTO orders (id,customer,phone,address,items,total,payment,note)
            VALUES (?,?,?,?,?,?,?,?)`,
      args: [
        id,
        body.customer.trim(),
        body.phone.trim(),
        body.address.trim(),
        JSON.stringify(verifiedItems),
        total,
        body.payment ?? "vodafone_cash",
        text(body.note, 0, 500) ? body.note.trim() : "",
      ],
    });

    return NextResponse.json({ ok: true, id, subtotal, shipping, total });
  } catch {
    return NextResponse.json({ error: "تعذر تسجيل الطلب، حاول مرة أخرى" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const c = db();
  if (!c) return NextResponse.json({ orders: [] });
  try {
    await ensureSchema();
    const r = await c.execute("SELECT id,customer,phone,address,items,total,payment,status,note,created_at FROM orders ORDER BY created_at DESC LIMIT 200");
    return NextResponse.json({ orders: r.rows.map((x) => ({ ...x })) });
  } catch {
    return NextResponse.json({ error: "تعذر تحميل الطلبات" }, { status: 503 });
  }
}
