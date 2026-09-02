import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/errors/handler";
import { ADMIN_COOKIE, isAdminRequest } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = apiHandler("/api/admin/session", async (request) => {
  return NextResponse.json({ authenticated: isAdminRequest(request) });
});

export const POST = apiHandler("/api/admin/session/logout", async () => {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
});
