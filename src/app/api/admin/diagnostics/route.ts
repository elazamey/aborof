import { NextResponse } from "next/server";
import { apiHandler, Errors } from "@/lib/errors/handler";
import { getDbConfigDiagnosis, hasDB } from "@/lib/db";
import { auditSecretConfiguration, diagnosticsKeyMatches, isDiagnosticsEnabled } from "@/lib/secrets";
import { actorCan, resolveActor } from "@/lib/rbac";
import { snapshot } from "@/lib/observability/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * نقطة تشخيص محمية بمفتاح مستقل (DIAGNOSTICS_KEY) لا علاقة له بسر الجلسات.
 * معطلة في الإنتاج افتراضيًا (DIAGNOSTICS_ENABLED != true) — عندها تعيد 404
 * موحّدًا حتى لا يُكشف وجودها. لا تُعرض أي قيم أسرار، فقط تحذيرات ومقاييس
 * ووصف شكلي لإعداد قاعدة البيانات (نوع القيمة وطولها بلا القيمة).
 */
export const GET = apiHandler("/api/admin/diagnostics", async (request) => {
  if (!isDiagnosticsEnabled()) throw Errors.diagnosticsDisabled();

  // نقبل مفتاح التشخيص المستقل، أو جلسة إدارة تحمل صلاحية التشخيص.
  const authHeader = request.headers.get("x-diagnostics-key");
  const url = new URL(request.url);
  const queryKey = url.searchParams.get("key");
  if (!diagnosticsKeyMatches(authHeader ?? queryKey)) {
    const actor = await resolveActor(request);
    // في وضع RBAC تُفرض `diagnostics:read`؛ ومع غياب العلم تبقى أي جلسة إدارة
    // صالحة كافية (سلوك اليوم حرفيًا) — الفرق كله في `actorCan`.
    if (!actor || !actorCan(actor, "diagnostics:read")) throw Errors.authRequired();
  }

  const warnings = auditSecretConfiguration();
  const metricsSnapshot = snapshot();
  return NextResponse.json({
    ok: true,
    env: process.env.NODE_ENV ?? "development",
    diagnostics_enabled: true,
    db_configured: hasDB(),
    // أنواع وأطوال وأسباب فقط (لا قيم): يسمّي بدقة ما يمنع الاتصال بـTurso.
    db_config: getDbConfigDiagnosis(),
    secret_warnings: warnings,
    metrics: metricsSnapshot,
  });
});
