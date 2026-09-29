import { NextResponse } from "next/server";
import { apiHandler, Errors, readJson } from "@/lib/errors/handler";
import { getProducts, db, ensureSchema } from "@/lib/db";
import { requirePermission } from "@/lib/rbac";
import { productUpsertContract, firstZodIssue } from "@/lib/validation/contracts";
import { upsertProductSearch, removeProductSearch } from "@/lib/search";
import type { Product } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = apiHandler("/api/products", async () => {
  return NextResponse.json({ products: await getProducts() });
});

export const POST = apiHandler("/api/products/admin-post", async (request) => {
  // الصلاحية تُفرض مركزيًا: في وضع RBAC الحالي صلاحية `products:write`،
  // وفي الوضع القديم (العلم مغلق) جلسة الإدارة الصالحة كما كانت.
  const actor = await requirePermission(request, "products:write");

  const raw = await readJson(request, 24_000);
  const parsed = productUpsertContract.safeParse(raw);
  if (!parsed.success) throw Errors.validationFailed(firstZodIssue(parsed.error));
  const { product: p } = parsed.data;

  const c = db();
  if (!c) throw Errors.serviceUnavailable("قاعدة البيانات غير مربوطة");
  await ensureSchema();

  const id = p.id || "p" + Date.now().toString().slice(-7);
  const featured = p.featured === true || p.featured === 1 ? 1 : 0;
  await c.execute({
    sql: `INSERT INTO products (id,name,description,price,old_price,category,image,stock,featured)
          VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,
          price=excluded.price,old_price=excluded.old_price,category=excluded.category,
          image=excluded.image,stock=excluded.stock,featured=excluded.featured`,
    args: [
      id,
      p.name.trim(),
      (p.description ?? "").trim(),
      p.price,
      p.old_price,
      (p.category ?? "").trim(),
      p.image || "🧴",
      p.stock,
      featured,
    ],
  });
  await c.execute({
    sql: "INSERT INTO admin_audit_log (action,entity,entity_id,details,actor) VALUES (?,?,?,?,?)",
    args: [
      p.id ? "product_update" : "product_create",
      "product",
      id,
      JSON.stringify({ name: p.name.trim(), price: p.price, stock: p.stock }),
      actor.username,
    ],
  });
  // مزامنة فهرس FTS5 — الفشل هنا لا يُفشل الكتابة الأساسية (سقوط آمن).
  try {
    const product: Product = {
      id,
      name: p.name.trim(),
      description: (p.description ?? "").trim(),
      price: p.price,
      old_price: p.old_price,
      category: (p.category ?? "").trim(),
      image: p.image || "🧴",
      stock: p.stock,
      featured,
    };
    await upsertProductSearch(c, product);
  } catch (e) {
    console.error("search: fts5 upsert failed (fallback to keyword matching):", String((e as Error)?.message ?? e));
  }
  return NextResponse.json({ ok: true, id });
});

export const DELETE = apiHandler("/api/products/admin-delete", async (request) => {
  const actor = await requirePermission(request, "products:write");

  const id = new URL(request.url).searchParams.get("id");
  if (!id || id.length > 80) throw Errors.validationFailed("معرف غير صالح");

  const c = db();
  if (!c) throw Errors.serviceUnavailable("قاعدة البيانات غير مربوطة");
  await ensureSchema();
  await c.execute({ sql: "DELETE FROM products WHERE id=?", args: [id] });
  await c.execute({
    sql: "INSERT INTO admin_audit_log (action,entity,entity_id,details,actor) VALUES (?,?,?,?,?)",
    args: ["product_delete", "product", id, "{}", actor.username],
  });
  // مزامنة فهرس FTS5 — الفشل هنا لا يُفشل الحذف الأساسي (سقوط آمن).
  try {
    await removeProductSearch(c, id);
  } catch (e) {
    console.error("search: fts5 remove failed (fallback to keyword matching):", String((e as Error)?.message ?? e));
  }
  return NextResponse.json({ ok: true });
});
