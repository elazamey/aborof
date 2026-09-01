import { NextResponse } from "next/server";
import { db, ensureSchema, getProducts } from "@/lib/db";
import { isAdminRequest } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT = 5000;

function validText(value: unknown, max = MAX_TEXT) {
  return typeof value === "string" && value.trim().length <= max;
}

function validProduct(product: any) {
  return (
    product &&
    typeof product.id === "string" &&
    product.id.length <= 80 &&
    typeof product.name === "string" &&
    product.name.trim().length >= 2 &&
    product.name.length <= 200 &&
    validText(product.description) &&
    Number.isFinite(Number(product.price)) &&
    Number(product.price) >= 0 &&
    Number(product.price) <= 1_000_000 &&
    (product.old_price === "" ||
      product.old_price == null ||
      (Number.isFinite(Number(product.old_price)) && Number(product.old_price) >= 0)) &&
    validText(product.category, 100) &&
    validText(product.image, 20) &&
    Number.isInteger(Number(product.stock)) &&
    Number(product.stock) >= 0 &&
    Number(product.stock) <= 1_000_000
  );
}

export async function GET() {
  return NextResponse.json({ products: await getProducts() });
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const body = await request.json();
    const p = body?.product;
    if (!validProduct(p)) return NextResponse.json({ error: "بيانات المنتج غير صالحة" }, { status: 422 });

    const c = db();
    if (!c) return NextResponse.json({ error: "قاعدة البيانات غير مربوطة" }, { status: 503 });
    await ensureSchema();
    const id = p.id || "p" + Date.now().toString().slice(-7);
    await c.execute({
      sql: `INSERT INTO products (id,name,description,price,old_price,category,image,stock,featured)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,
            price=excluded.price,old_price=excluded.old_price,category=excluded.category,
            image=excluded.image,stock=excluded.stock,featured=excluded.featured`,
      args: [
        id,
        p.name.trim(),
        p.description?.trim() ?? "",
        Number(p.price),
        p.old_price === "" || p.old_price == null ? null : Number(p.old_price),
        p.category?.trim() ?? "",
        p.image || "🧴",
        Number(p.stock),
        p.featured ? 1 : 0,
      ],
    });
    await c.execute({
      sql: "INSERT INTO admin_audit_log (action,entity,entity_id,details) VALUES (?,?,?,?)",
      args: [
        p.id ? "product_update" : "product_create",
        "product",
        id,
        JSON.stringify({ name: p.name.trim(), price: Number(p.price), stock: Number(p.stock) }),
      ],
    });
    return NextResponse.json({ ok: true, id });
  } catch {
    return NextResponse.json({ error: "تعذر حفظ المنتج" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (!isAdminRequest(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id || id.length > 80) return NextResponse.json({ error: "معرف غير صالح" }, { status: 422 });

  const c = db();
  if (!c) return NextResponse.json({ error: "قاعدة البيانات غير مربوطة" }, { status: 503 });
  try {
    await ensureSchema();
    await c.execute({ sql: "DELETE FROM products WHERE id=?", args: [id] });
    await c.execute({
      sql: "INSERT INTO admin_audit_log (action,entity,entity_id,details) VALUES (?,?,?,?)",
      args: ["product_delete", "product", id, "{}"],
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "تعذر حذف المنتج" }, { status: 500 });
  }
}
