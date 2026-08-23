import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const id = "ORD-" + Date.now().toString().slice(-8);
  const c = db();
  if (c) {
    try {
      await ensureSchema();
      await c.execute({
        sql: `INSERT INTO orders (id,customer,phone,address,items,total,payment,note)
              VALUES (?,?,?,?,?,?,?,?)`,
        args: [
          id,
          body.customer ?? "",
          body.phone ?? "",
          body.address ?? "",
          JSON.stringify(body.items ?? []),
          Number(body.total ?? 0),
          body.payment ?? "vodafone_cash",
          body.note ?? "",
        ],
      });
    } catch (e) {
      console.error(e);
    }
  }
  return NextResponse.json({ ok: true, id });
}

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (!process.env.ADMIN_PASSWORD || key !== process.env.ADMIN_PASSWORD)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const c = db();
  if (!c) return NextResponse.json({ orders: [] });
  await ensureSchema();
  const r = await c.execute("SELECT * FROM orders ORDER BY created_at DESC LIMIT 200");
  return NextResponse.json({ orders: r.rows.map((x) => ({ ...x })) });
}
