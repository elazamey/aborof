import { NextResponse } from "next/server";
import { clientIp } from "@/lib/client-ip";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

/**
 * عنوان العميل للتدقيق — من المصدر الموثوق فقط (انظر src/lib/client-ip.ts).
 * خارج حدود الثقة (Vercel) يعيد null — لا نثق بـ x-forwarded-for/x-real-ip
 * المُرسلة من العميل ولا نُنشئ هوية IP وهمية.
 */
export function ipOf(request: Request): string | null {
  return clientIp(request);
}
