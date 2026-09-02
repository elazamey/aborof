import { NextResponse } from "next/server";
import { createAdminSession, ADMIN_COOKIE, isAdminConfigured, passwordMatches, sessionMaxAge } from "@/lib/auth";
import { ensureSchema } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { createSessionRecord, ensureOwner, identityRepo, policyFromEnv } from "@/lib/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const limit = rateLimit(request, "admin-login", 8, 10 * 60 * 1000);
  if (!limit.ok) {
    const response = NextResponse.json({ error: "محاولات كثيرة، حاول بعد قليل" }, { status: 429 });
    response.headers.set("Retry-After", String(limit.retryAfter));
    return response;
  }
  try {
    if (!isAdminConfigured()) {
      return NextResponse.json(
        { error: "لوحة الإدارة غير مهيأة بعد: أضف ADMIN_PASSWORD وADMIN_SESSION_SECRET في Vercel." },
        { status: 503 }
      );
    }
    const body = await request.json();
    if (typeof body?.password !== "string" || !passwordMatches(body.password)) {
      return NextResponse.json({ error: "بيانات الدخول غير صحيحة" }, { status: 401 });
    }

    // تأكد من جاهزية المخطط قبل أول استخدام (قاعدة جديدة تمامًا)
    await ensureSchema();

    // IDENTITY-HARDENING-01: تسجيل الدخول ينشئ/يحدّث حساب المالك + جلسة قابلة للإبطال
    const repo = identityRepo();
    const user = repo ? await ensureOwner(repo) : null;

    const rawToken = createAdminSession();
    if (repo && user) {
      await createSessionRecord({
        repo,
        user,
        rawToken,
        label: "admin-login",
        now: Date.now,
        policy: policyFromEnv(),
      });
      user.lastLoginAt = Date.now();
      await repo.updateUser(user);
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set(ADMIN_COOKIE, rawToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: sessionMaxAge,
    });
    return response;
  } catch {
    return NextResponse.json({ error: "طلب غير صالح" }, { status: 400 });
  }
}
