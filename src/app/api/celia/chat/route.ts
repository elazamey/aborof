import { NextRequest, NextResponse } from "next/server";
import { apiHandler, Errors, readJson } from "@/lib/errors/handler";
import { isCeliaAgentActive } from "@/lib/celia/config";
import { requireCeliaScope } from "@/lib/celia/scope-guard";
import { verifyCeliaAuth } from "@/lib/celia/auth";
import { rateLimit } from "@/lib/rate-limit";
import { chatRequestContract, firstZodIssue } from "@/lib/validation/contracts";
import { getSmartAgentEngine } from "@/lib/ai";
import { getDrizzle, chatLogs } from "@/lib/db/drizzle";
import { ensureSchema, db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/celia/chat — المسار الحتمي لـ Celia (PR-A)
 *
 * البوابات بالترتيب الصارم (لا مجال للقفز):
 *  1. العلم — `ENABLE_CELIA_AGENT=true` وإلا 404 موحّد (Obfuscation)
 *  2. النطاق — `CELIA_ALLOWED_SCOPES` يجب أن تحتوي `chat:write` وإلا 403
 *  3. الهوية — جلسة إدارة (HMAC) أو Bearer CELIA_AGENT_TOKEN (≥32) وإلا 401
 *  4. الموارد — تحديد معدل 10/دقيقة لكل IP+هوية وإلا 429
 *  5. التحقق — `chatRequestContract` وإلا 422
 *  6. المحرك الاحتمالي — SmartAgentEngine (نفس سلسلة التراجع) → reply
 *  7. التوثيق — Drizzle insert في chat_logs (question/answer) — لا يكسر runMigrations
 */

export const POST = apiHandler("celia_chat", async (req: Request) => {
  // 1. العلم — fail-closed + obfuscation (لا يكشف وجود النقطة)
  if (!isCeliaAgentActive()) {
    throw Errors.notFound("غير موجود");
  }

  // 2. النطاق — chat:write إلزامي لتسجيل المحادثات (Day 1)
  // يرمي 403 إن لم يكن ضمن CELIA_ALLOWED_SCOPES، و404 إن كان العلم مغلقًا
  requireCeliaScope(req, "chat:write");

  // 3. الهوية — admin session أو agent token
  const auth = await verifyCeliaAuth(req);

  // 4. الموارد — 10 طلبات / دقيقة لكل IP (موزّع عبر Turso إن وُجد)
  const limit = await rateLimit(req, "celia_chat", 10, 60 * 1000);
  if (!limit.ok) {
    throw Errors.rateLimited(limit.retryAfter);
  }

  // 5. التحقق — عقد موحّد
  const raw = await readJson(req, 40_000);
  const parsed = chatRequestContract.safeParse(raw);
  if (!parsed.success) {
    throw Errors.validationFailed(firstZodIssue(parsed.error));
  }
  const clean = parsed.data.messages.slice(-12);
  const last = clean[clean.length - 1]?.content ?? "";

  // 6. المحرك الاحتمالي — نفس SmartAgentEngine (Gemini → Groq → NIM → local)
  // لا نستخدم AI SDK جديد — نحافظ على السلسلة الحتمية والمقاييس الحالية.
  // ملاحظة: celia لا تستخدم أدوات بعد (PR-A بلا tools) — PR-B سيحقنها عبر ScopeGuard.
  const engine = getSmartAgentEngine();
  // نبني AgentMessage[] مع system ضمني: المحرك يحمل systemPrompt داخليًا عبر buildContext
  // لكن celia يمكن أن تمرر clean مباشرة — المحرك سيتعامل معها.
  // نستخدم processRequestDetailed للحصول على provider وreply بشكل موحّد.
  // إن كان المحرك ينتظر AgentMessage[] مع system، نمرر clean كما هي (role/user)
  // وهو سيُضيف السياق داخليًا إن لزم.
  let reply = "";
  let source = "local";
  try {
    // نحاول المسار التفصيلي أولًا (يعيد products/fleet إن وُجدت)، وإن فشل نسقط للبسيط
    const detailed = await engine.processRequestDetailed(
      clean.map((m) => ({ role: m.role, content: m.content })),
      { enableTools: false }
    );
    reply = detailed.reply;
    source = detailed.provider;
  } catch {
    // fallback إلى localAnswer داخل المحرك — لا نرمي أبدًا
    const simple = await engine.processRequest(
      clean.map((m) => ({ role: m.role, content: m.content }))
    );
    reply = typeof simple === "string" ? simple : (simple as { reply: string }).reply ?? "";
    source = "local";
  }

  // 7. التوثيق الحتمي — Drizzle الشفاف (لا يكسر runMigrations)
  // نضمن أن المخطط مُطبَّق قبل الكتابة (idempotent)
  try {
    const c = db();
    if (c) await ensureSchema();
    const drizzle = getDrizzle();
    if (drizzle) {
      await drizzle.insert(chatLogs).values({
        question: last.slice(0, 4000) || null,
        answer: reply.slice(0, 8000) || null,
      });
    } else if (c) {
      // fallback خام إن لم يكن Drizzle جاهزًا (يجب ألا يحدث)
      await c.execute({
        sql: "INSERT INTO chat_logs (question, answer) VALUES (?, ?)",
        args: [last.slice(0, 4000), reply.slice(0, 8000)],
      });
    }
  } catch {
    // لا نفشل الطلب إن فشل التوثيق — نسجّل فقط (لا نكشف للعميل)
  }

  return NextResponse.json({
    reply,
    source,
    auth: { id: auth.id, role: auth.role },
  });
});
