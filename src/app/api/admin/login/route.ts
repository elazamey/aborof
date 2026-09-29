import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { apiHandler, Errors, readJson } from "@/lib/errors/handler";
import { createAdminSession, ADMIN_COOKIE, adminConfigIssues, passwordMatches, sessionMaxAge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isPasswordStrong } from "@/lib/secrets";
import {
  DUMMY_HASH,
  OWNER_ROLE_ID,
  createUser,
  isRbacEnabled,
  rbacUserCount,
  recordLoginFailure,
  recordLoginSuccess,
  resolveLogin,
  verifyPassword,
} from "@/lib/rbac";
import { adminLoginContract, adminLoginRbacContract, firstZodIssue } from "@/lib/validation/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** اسم المستخدم الوحيد المقبول في التهيئة الأولى (bootstrap). */
const BOOTSTRAP_USERNAME = "owner";

/**
 * تسجيل دخول الإدارة — وضعان متعايشان يحكمهما العلم `ENABLE_RBAC`:
 *
 *  **مغلق (السلوك القائم حرفيًا):** كلمة مرور الإدارة المشتركة `ADMIN_PASSWORD`
 *  ⇒ جلسة v1 "مشغّل مفرد" بكل الصلاحيات.
 *
 *  **مفتوح:** اسم مستخدم + كلمة مرور من جدول `rbac_users` ⇒ جلسة v2 تحمل هوية
 *  المستخدم وإصدار توكنه. وفي هذه الحالة:
 *   - **تهيئة أولى (bootstrap):** إن كان الجدول فارغًا تمامًا، يُقبل الدخول باسم
 *     `owner` وكلمة مرور `ADMIN_PASSWORD` مرة واحدة لإنشاء المالك (كلمة المرور
 *     تُخزَّن كبصمة scrypt ومصدرها `bootstrap` ليُنبَّه إلى تغييرها). البوابة
 *     تُغلق نهائيًا بمجرد وجود مستخدم واحد.
 *   - **بعد التهيئة:** لا يُقبل `ADMIN_PASSWORD` كمسار خلفي إطلاقًا — الجلسات
 *     القديمة v1 تُرفض في طبقة الفرض (401)، ولا يوجد سوى المستخدمين المُدارين.
 *   - **الرسائل موحّدة:** مستخدم غير موجود/كلمة مرور خاطئة/حساب معطّل ⇒ نفس
 *     الـ401 ونفس النص (لا تعداد حسابات)، مع تنفيذ scrypt وهمي عند غياب الحساب
 *     حتى لا يفرّق التوقيت بين الحالتين.
 */

function sessionCookie(response: NextResponse, token: string) {
  response.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: sessionMaxAge,
  });
}

/** مفتاح حدّ معدل لكل اسم مستخدم — بصمة مبتورة، فلا يُخزَّن الاسم ولا يظهر في المقاييس. */
function usernameBucket(username: string): string {
  return createHash("sha256").update(username.trim().toLowerCase()).digest("hex").slice(0, 12);
}

export const POST = apiHandler("/api/admin/login", async (request) => {
  const limit = await rateLimit(request, "admin-login", 8, 10 * 60 * 1000);
  if (!limit.ok) throw Errors.rateLimited(limit.retryAfter);

  const configIssues = adminConfigIssues();
  if (configIssues.length > 0) {
    throw Errors.serviceUnavailable(`لوحة الإدارة غير مهيأة بعد: ${configIssues.join("، ")}.`);
  }

  const raw = await readJson(request, 4_000);

  // ---------------------------------------------------------------------
  // الوضع القائم (RBAC مغلق): كلمة مرور مشتركة ⇒ جلسة v1 — لا تغيير سلوكي.
  // ---------------------------------------------------------------------
  if (!isRbacEnabled()) {
    const parsed = adminLoginContract.safeParse(raw);
    if (!parsed.success) throw Errors.validationFailed(firstZodIssue(parsed.error));

    if (!passwordMatches(parsed.data.password)) {
      throw Errors.authInvalid("بيانات الدخول غير صحيحة");
    }

    const response = NextResponse.json({ ok: true });
    sessionCookie(response, createAdminSession());
    return response;
  }

  // ---------------------------------------------------------------------
  // وضع RBAC: اسم مستخدم + كلمة مرور.
  // ---------------------------------------------------------------------
  const parsed = adminLoginRbacContract.safeParse(raw);
  if (!parsed.success) throw Errors.validationFailed(firstZodIssue(parsed.error));
  const { username, password } = parsed.data;

  const userLimit = await rateLimit(request, `admin-login-user:${usernameBucket(username)}`, 10, 10 * 60 * 1000);
  if (!userLimit.ok) throw Errors.rateLimited(userLimit.retryAfter);

  if ((await rbacUserCount()) === 0) {
    return bootstrapOwner(username, password);
  }

  const outcome = await resolveLogin({ username, password, verify: verifyPassword });
  switch (outcome.outcome) {
    case "unknown_user": {
      // تنفيذ تكلفة scrypt مع بصمة وهمية: لا فرق زمني بين «غير موجود» و«كلمة خاطئة».
      await verifyPassword(password, DUMMY_HASH);
      await recordLoginFailure(username, { reason: "unknown_user" });
      throw Errors.authInvalid("بيانات الدخول غير صحيحة");
    }
    case "bad_password": {
      await recordLoginFailure(username, { reason: "bad_password", attempts_left: outcome.attemptsLeft });
      throw Errors.authInvalid("بيانات الدخول غير صحيحة");
    }
    case "disabled": {
      await recordLoginFailure(username, { reason: "disabled" });
      throw Errors.authInvalid("بيانات الدخول غير صحيحة");
    }
    case "locked": {
      // رسالة صريحة عن القفل: قرار مقصود (حماية التوفر) ومنع تخمين لا نهائي،
      // ويُقابله حدّان: لكل IP ولكل اسم مستخدم على حدة.
      await recordLoginFailure(username, { reason: "locked" });
      throw Errors.rateLimited(outcome.retryAfterSeconds, "الحساب مقفل مؤقتًا بعد محاولات فاشلة — أعد المحاولة بعد قليل");
    }
    case "ok": {
      const token = createAdminSession({ userId: outcome.user.id, tokenVersion: 1 });
      await recordLoginSuccess(outcome.user.id, outcome.user.username, { role: outcome.user.roleId });
      const response = NextResponse.json({
        ok: true,
        user: {
          id: outcome.user.id,
          username: outcome.user.username,
          roleId: outcome.user.roleId,
          roleLabel: outcome.user.roleLabel,
          permissions: outcome.rolePermissions,
        },
      });
      sessionCookie(response, token);
      return response;
    }
  }
});

/**
 * التهيئة الأولى: إنشاء المالك بكلمة مرور الإدارة المشتركة (مرة واحدة، وبوابة
 * تُقفل بمجرد وجود مستخدم). كلمة المرور تُجزَّأ فورًا ولا تُسجَّل ولا تُعاد.
 */
async function bootstrapOwner(username: string, password: string) {
  if (username !== BOOTSTRAP_USERNAME || !passwordMatches(password)) {
    throw Errors.authInvalid("بيانات الدخول غير صحيحة");
  }
  if (!isPasswordStrong(password)) {
    throw Errors.serviceUnavailable(
      "ADMIN_PASSWORD لا يستوفي سياسة كلمة المرور (12 حرفًا على الأقل) — حدّثه في البيئة ثم أعد المحاولة."
    );
  }

  const created = await createUser(
    {
      username,
      displayName: "المالك",
      roleId: OWNER_ROLE_ID,
      password,
      passwordSource: "bootstrap",
    },
    "system:bootstrap"
  );

  const response = NextResponse.json({
    ok: true,
    bootstrap: true,
    must_change_password: true,
    user: { id: created.id, username: created.username, roleId: OWNER_ROLE_ID, roleLabel: "المالك" },
  });
  sessionCookie(response, createAdminSession({ userId: created.id, tokenVersion: 1 }));
  return response;
}
