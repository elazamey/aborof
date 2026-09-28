import { NextResponse } from "next/server";
import { apiHandler, Errors } from "@/lib/errors/handler";
import { isAdminRequest } from "@/lib/auth";
import { fleetCatalogManifest, fleetSnapshot, isAgentFleetEnabled } from "@/lib/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * مانيفست أسطول الوكلاء — للعرض الإداري فقط، ولا ينفّذ أي وكيل ولا أي أداة.
 *
 *  - الأسطول معطّل (`ENABLE_AGENT_FLEET != "true"`) ⇒ 404 موحّد لا يكشف وجود
 *    النقطة، بنفس مبدأ `/api/admin/mcp/tools`.
 *  - مفعّل ⇒ جلسة إدارة إلزامية (401 بدونها)، وتُعاد الهويات والأقسام
 *    والأدوات المعلنة لكل وكيل (كلها للقراءة فقط) بلا أي سر.
 */
export const GET = apiHandler("/api/admin/agents", async (request) => {
  if (!isAgentFleetEnabled()) throw Errors.notFound("هذه النقطة غير متاحة");
  if (!isAdminRequest(request)) throw Errors.authRequired();

  return NextResponse.json({
    ok: true,
    ...fleetSnapshot(),
    agents: fleetCatalogManifest(),
  });
});
