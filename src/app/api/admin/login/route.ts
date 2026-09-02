import { NextResponse } from "next/server";
import { apiHandler, Errors, readJson } from "@/lib/errors/handler";
import { createAdminSession, ADMIN_COOKIE, isAdminConfigured, passwordMatches, sessionMaxAge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { adminLoginContract, firstZodIssue } from "@/lib/validation/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = apiHandler("/api/admin/login", async (request) => {
  const limit = await rateLimit(request, "admin-login", 8, 10 * 60 * 1000);
  if (!limit.ok) throw Errors.rateLimited(limit.retryAfter);

  if (!isAdminConfigured()) {
    throw Errors.serviceUnavailable("لوحة الإدارة غير مهيأة بعد.");
  }

  const raw = await readJson(request, 4_000);
  const parsed = adminLoginContract.safeParse(raw);
  if (!parsed.success) throw Errors.validationFailed(firstZodIssue(parsed.error));

  if (!passwordMatches(parsed.data.password)) {
    throw Errors.authInvalid("بيانات الدخول غير صحيحة");
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE, createAdminSession(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: sessionMaxAge,
  });
  return response;
});
