import { NextResponse } from "next/server";
import { createAdminSession, ADMIN_COOKIE, isAdminConfigured, sessionMaxAge } from "@/lib/auth";
import { ensureSchema } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { createSessionRecord, ensureOwner, identityRepo, policyFromEnv, verifyOwnerCredentials } from "@/lib/identity";

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
    if (typeof body?.password !== "string" || body.password.length === 0) {
      return NextResponse.json({ error: "بيانات الدخول غير صحيحة" }, { status: 401 });
    }

    // تأكد من جاهزية المخطط قبل أول استخدام (قاعدة جديدة تمامًا)
    await ensureSchema();

    // مصدر الحقيقة الوحيد: users.password_hash (البيئة ADMIN_PASSWORD = bootstrap فقط).
    // لا مالك/لا hash → فشل مغلق (401) — لا إنشاء حالة تلقائية غير متوقعة أثناء الدخول.
    const repo = identityRepo();
    if (!repo) return NextResponse.json({ error: "قاعدة البيانات غير متاحة" }, { status: 503 });
    const user = await ensureOwner(repo);
    if (!verifyOwnerCredentials(user, body.password)) {
      return NextResponse.json({ error: "بيانات الدخول غير صحيحة" }, { status: 401 });
    }

    const rawToken = createAdminSession();
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
