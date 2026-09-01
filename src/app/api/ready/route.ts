import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readiness — هل التطبيق قادر فعلياً على خدمة الطلبات؟
 * يفحص اتصال قاعدة البيانات بـ SELECT 1.
 */
export async function GET() {
  try {
    const configured = Boolean(process.env.TURSO_DATABASE_URL);
    const c = db();
    if (!c) {
      // configured لكن فشل الاتصال = "error"؛ غير مهيأ أصلاً = "not_configured"
      return NextResponse.json(
        { status: "not_ready", database: configured ? "error" : "not_configured" },
        { status: 503 }
      );
    }
    await c.execute("SELECT 1");
    return NextResponse.json({ status: "ready", database: "ok" });
  } catch (error) {
    log("error", "readiness check failed", { route: "/api/ready", error: String(error) });
    return NextResponse.json({ status: "not_ready", database: "error" }, { status: 503 });
  }
}
