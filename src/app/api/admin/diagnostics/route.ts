import { NextResponse } from "next/server";
import { apiHandler, Errors } from "@/lib/errors/handler";
import { hasDB } from "@/lib/db";
import { auditSecretConfiguration, diagnosticsKeyMatches, isDiagnosticsEnabled } from "@/lib/secrets";
import { isAdminRequest } from "@/lib/auth";
import { snapshot } from "@/lib/observability/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * نقطة تشخيص محمية بمفتاح مستقل (DIAGNOSTICS_KEY) لا علاقة له بسر الجلسات.
 * معطلة في الإنتاج افتراضيًا (DIAGNOSTICS_ENABLED != true) — عندها تعيد 404
 * موحّدًا حتى لا يُكشف وجودها. لا تُعرض أي قيم أسرار، فقط تحذيرات ومقاييس.
 */
export const GET = apiHandler("/api/admin/diagnostics", async (request) => {
  if (!isDiagnosticsEnabled()) {
    // 404 موحّد — نفس استجابة أي مسار غير موجود، ونفس ما تفعله نقطة MCP.
    //
    // لا يجوز هنا إرجاع كود أو رسالة تخصّ التشخيص (مثل `DIAGNOSTICS_DISABLED`
    // أو «التشخيص معطل»): فذلك يُثبت للمهاجم أن المسار موجود وأنه محمي بعلم
    // بيئة، وهو نقيض المقصد المكتوب أعلاه. سبب التعطيل يُسجَّل في الخادم فقط.
    console.info("diagnostics endpoint requested while disabled; returning unified 404");
    throw Errors.notFound("هذه النقطة غير متاحة");
  }

  // نقبل جلسة إدارة أو مفتاح التشخيص المستقل.
  const authHeader = request.headers.get("x-diagnostics-key");
  const url = new URL(request.url);
  const queryKey = url.searchParams.get("key");
  if (!isAdminRequest(request) && !diagnosticsKeyMatches(authHeader ?? queryKey)) {
    throw Errors.authRequired();
  }

  const warnings = auditSecretConfiguration();
  const metricsSnapshot = snapshot();
  return NextResponse.json({
    ok: true,
    env: process.env.NODE_ENV ?? "development",
    diagnostics_enabled: true,
    db_configured: hasDB(),
    secret_warnings: warnings,
    metrics: metricsSnapshot,
  });
});
