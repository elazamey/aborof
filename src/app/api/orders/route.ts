import { NextResponse } from "next/server";
import { apiHandler, Errors, readJson } from "@/lib/errors/handler";
import { getProducts, db } from "@/lib/db";
import { createOrder, listOrders, updateOrderStatus } from "@/lib/orders";
import { isAdminRequest } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { GOVERNORATES } from "@/lib/shipping";
import { createOrderContract, orderStatusContract, firstZodIssue } from "@/lib/validation/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32_000;

async function enforceRateLimit(request: Request, scope: string, limit: number, windowMs: number) {
  const result = await rateLimit(request, scope, limit, windowMs);
  if (!result.ok) throw Errors.rateLimited(result.retryAfter);
}

export const POST = apiHandler("/api/orders", async (request) => {
  await enforceRateLimit(request, "orders", 8, 10 * 60 * 1000);

  const raw = await readJson(request, MAX_BODY_BYTES);
  const parsed = createOrderContract.safeParse(raw);
  if (!parsed.success) throw Errors.validationFailed(firstZodIssue(parsed.error));
  const input = parsed.data;

  if (!GOVERNORATES.includes(input.governorate)) {
    throw Errors.validationFailed("اختر المحافظة من القائمة");
  }

  const products = await getProducts();
  const result = await createOrder(input, products);
  return NextResponse.json({ ok: true, ...result });
});

export const GET = apiHandler("/api/orders/admin-list", async (request) => {
  if (!isAdminRequest(request)) throw Errors.authRequired();
  if (!db()) return NextResponse.json({ orders: [] });
  const orders = await listOrders(200);
  return NextResponse.json({ orders });
});

export const PATCH = apiHandler("/api/orders/admin-patch", async (request) => {
  if (!isAdminRequest(request)) throw Errors.authRequired();
  await enforceRateLimit(request, "admin-order-update", 30, 10 * 60 * 1000);

  const raw = await readJson(request, 8_000);
  const parsed = orderStatusContract.safeParse(raw);
  if (!parsed.success) throw Errors.validationFailed(firstZodIssue(parsed.error));

  await updateOrderStatus(parsed.data);
  return NextResponse.json({ ok: true });
});
