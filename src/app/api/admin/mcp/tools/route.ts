import { NextResponse } from "next/server";
import { apiHandler, Errors } from "@/lib/errors/handler";
import { isAdminRequest } from "@/lib/auth";
import { getMcpRegistry, isMcpToolsEnabled } from "@/lib/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * مانيفست أدوات MCP — للعرض الإداري فقط، ولا ينفّذ أي أداة.
 *
 *  - الطبقة معطلة (`ENABLE_MCP_TOOLS != "true"`) ⇒ 404 موحّد لا يكشف وجود النقطة،
 *    بنفس مبدأ نقطة التشخيص.
 *  - الطبقة مفعّلة ⇒ جلسة إدارة إلزامية (401 بدونها)، وتُرجع الأسماء والوصف
 *    والسياسة الفعلية للحدود: أي أداة مرئية، وما سقف استدعائها ومهلتها.
 *  - لا يوجد أي مسار HTTP لتنفيذ أداة: التنفيذ يحدث فقط داخل دورة الوكيل،
 *    فلا يُضاف سطح هجوم قابل للاستدعاء من الخارج.
 */
export const GET = apiHandler("/api/admin/mcp/tools", async (request) => {
  if (!isMcpToolsEnabled()) throw Errors.notFound("هذه النقطة غير متاحة");
  if (!isAdminRequest(request)) throw Errors.authRequired();

  const registry = getMcpRegistry();
  return NextResponse.json({
    ok: true,
    enabled: true,
    execution: "agent_only",
    policy: registry.policy(),
    tools: registry.describeTools(),
  });
});
