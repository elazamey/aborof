import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness — هل التطبيق حي؟ (لا يلمس قاعدة البيانات) */
export async function GET() {
  return NextResponse.json({ status: "ok", uptime: process.uptime(), ts: Date.now() });
}
