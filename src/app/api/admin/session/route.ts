import { NextResponse } from "next/server";
import { ADMIN_COOKIE } from "@/lib/auth";
import { authenticateAdminRequest } from "@/lib/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await authenticateAdminRequest(request);
  return NextResponse.json({ authenticated: auth.ok });
}

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
