import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema, getProducts } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function auth(req: NextRequest, key?: string) {
  const k = key ?? req.nextUrl.searchParams.get("key");
  return Boolean(process.env.ADMIN_PASSWORD) && k === process.env.ADMIN_PASSWORD;
}

export async function GET() {
  return NextResponse.json({ products: await getProducts() });
}

export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!auth(req, b.key)) return NextResponse.json({ error: "كلمة المرور غير صحيحة" }, { status: 401 });
  const c = db();
  if (!c) return NextResponse.json({ error: "قاعدة البيانات غير مربوطة (Turso)" }, { status: 400 });
  await ensureSchema();
  const p = b.product;
  const id = p.id || "p" + Date.now().toString().slice(-7);
  await c.execute({
    sql: `INSERT INTO products (id,name,description,price,old_price,category,image,stock,featured)
          VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,
          price=excluded.price,old_price=excluded.old_price,category=excluded.category,
          image=excluded.image,stock=excluded.stock,featured=excluded.featured`,
    args: [
      id, p.name, p.description ?? "", Number(p.price), p.old_price ? Number(p.old_price) : null,
      p.category ?? "", p.image || "🧴", Number(p.stock ?? 0), p.featured ? 1 : 0,
    ],
  });
  return NextResponse.json({ ok: true, id });
}

export async function DELETE(req: NextRequest) {
  if (!auth(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  const c = db();
  if (!c) return NextResponse.json({ error: "no db" }, { status: 400 });
  await ensureSchema();
  await c.execute({ sql: "DELETE FROM products WHERE id=?", args: [id] });
  return NextResponse.json({ ok: true });
}
