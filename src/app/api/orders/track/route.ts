import { NextResponse } from "next/server";
import type { Client } from "@libsql/client";
import { apiHandler, Errors, readJson } from "@/lib/errors/handler";
import { db } from "@/lib/db";
import { trackOrder } from "@/lib/orders";
import { rateLimit } from "@/lib/rate-limit";
import { trackOrderContract, firstZodIssue } from "@/lib/validation/contracts";
import { redactSecrets } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8_000;

/** تتبع الطلبات للعملاء خلف علم ميزة مغلق افتراضيًا (ENABLE_ORDER_TRACKING). */
export function isOrderTrackingEnabled(): boolean {
  return process.env.ENABLE_ORDER_TRACKING === "true";
}

async function recordFailedAttempt(orderId: string): Promise<void> {
  // تدقيق بأفضل جهد: رمي `db()` هنا (إعداد معطوب) كان يقنّع رسالة 404 الموحّدة
  // بـ 500 — فيُكسر عقد «لا كشف لوجود الطلب». أي عطل هنا = تخطٍّ صامت.
  let c: Client | null = null;
  try {
    c = db();
  } catch {
    return;
  }
  if (!c) return;
  try {
    await c.execute({
      sql: "INSERT INTO admin_audit_log (action,entity,entity_id,details) VALUES (?,?,?,?)",
      args: ["track_failed", "order", orderId, JSON.stringify({ reason: "mismatch" })],
    });
  } catch (e) {
    console.error("track audit failed:", redactSecrets(String((e as Error)?.message ?? e)));
  }
}

export const POST = apiHandler("/api/orders/track", async (request) => {
  // حد معدل صارم مستقل لمنع تخمين أرقام الطلبات (5 محاولات / 10 دقائق).
  const limit = await rateLimit(request, "order-tracking", 5, 10 * 60 * 1000);
  if (!limit.ok) throw Errors.rateLimited(limit.retryAfter);

  if (!isOrderTrackingEnabled()) throw Errors.notFound("تعذر العثور على الطلب");

  const raw = await readJson(request, MAX_BODY_BYTES);
  const parsed = trackOrderContract.safeParse(raw);
  if (!parsed.success) throw Errors.validationFailed(firstZodIssue(parsed.error));

  try {
    const result = await trackOrder(parsed.data, true);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    // رسالة الفشل واحدة دائمًا — لا يُكشف وجود الطلب من عدمه.
    await recordFailedAttempt(parsed.data.id.trim());
    throw Errors.notFound("تعذر العثور على الطلب");
  }
});
