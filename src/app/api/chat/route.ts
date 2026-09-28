import { NextResponse } from "next/server";
import { apiHandler, Errors, readJson } from "@/lib/errors/handler";
import { getProducts, getFaq, db, ensureSchema } from "@/lib/db";
import { STORE } from "@/lib/seed";
import { rateLimit } from "@/lib/rate-limit";
import { redactSecrets } from "@/lib/errors";
import { metrics } from "@/lib/observability/metrics";
import { chatRequestContract, firstZodIssue } from "@/lib/validation/contracts";
import {
  fleetAuditRecord,
  fleetPromptSection,
  fleetResponseMeta,
  fleetToolAllowlist,
  getSmartAgentEngine,
  isAgentFleetActive,
  isMcpToolsEnabled,
  selectAgents,
} from "@/lib/ai";
import type { AgentMessage, FleetResponseMeta } from "@/lib/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Msg = { role: "user" | "assistant"; content: string };

async function buildContext() {
  const [products, faq] = await Promise.all([getProducts(), getFaq()]);
  const list = products
    .map(
      (p) =>
        `- ${p.name} | السعر: ${p.price} جنيه${p.old_price ? ` (بدل ${p.old_price})` : ""} | القسم: ${p.category} | المتاح: ${p.stock} | الوصف: ${p.description}`
    )
    .join("\n");
  const f = faq.map((x) => `س: ${x.question}\nج: ${x.answer}`).join("\n");
  return { list, f };
}

function systemPrompt(list: string, f: string) {
  return `أنتِ "سيليا"، مساعدة خدمة العملاء الرسمية لمتجر "${STORE.name}" ${STORE.tagline} في مصر.

شخصيتك: فتاة مصرية ودودة، مهذبة، مرحة قليلاً، سريعة ومباشرة. تتحدثين بالعربية المصرية البسيطة المفهومة. تستخدمين إيموجي بسيط أحيانًا 🧼✨ بدون مبالغة. ردودك قصيرة (2-5 أسطر) إلا لو العميل طلب تفاصيل.

مهامك: تعريف العملاء بالمنتجات والأسعار، ترشيح المنتج المناسب، شرح طريقة الطلب والدفع، والرد على الاستفسارات.

قواعد مهمة جداً:
1. اعتمدي حصرياً على بيانات المنتجات بالأسفل (من قاعدة بيانات المتجر). لا تخترعي منتجات أو أسعار غير موجودة.
2. لو المنتج مش موجود في القائمة قولي إنه غير متوفر حالياً واقترحي بديل من القائمة، ووجّهي العميل للواتساب ${STORE.phone}.
3. الدفع: فودافون كاش على الرقم ${STORE.vodafoneCash} أو الدفع عند الاستلام. الشحن ${STORE.shipping} جنيه ومجاني فوق ${STORE.freeShippingOver} جنيه.
4. للطلب: العميل يضيف المنتجات للسلة ويكمل الطلب من صفحة السلة، أو يراسلنا واتساب على ${STORE.phone}.
5. اذكري الأسعار بالجنيه المصري دائماً.
6. لا تتحدثي في مواضيع خارج المتجر، وأعيدي الحديث بلطف لمنتجات النظافة.

== منتجات المتجر (قاعدة البيانات) ==
${list}

== أسئلة شائعة ==
${f}`;
}

async function callGemini(sys: string, messages: Msg[], key: string): Promise<string> {
  const models = process.env.GEMINI_MODEL
    ? [process.env.GEMINI_MODEL]
    : ["gemini-flash-latest", "gemini-3.5-flash", "gemini-flash-lite-latest"];
  let lastErr = "";
  for (const model of models) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: sys }] },
          contents: messages.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
          generationConfig: { temperature: 0.7, maxOutputTokens: 1200, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    if (res.ok) {
      const j = await res.json();
      const t = j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text).join("") ?? "";
      if (t.trim()) return t.trim();
      lastErr = "empty response";
    } else {
      lastErr = await res.text();
    }
  }
  throw new Error("Gemini: " + redactSecrets(lastErr.slice(0, 200)));
}

async function callGroq(sys: string, messages: Msg[], key: string): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      temperature: 0.7,
      max_tokens: 700,
      messages: [{ role: "system", content: sys }, ...messages],
    }),
  });
  if (!res.ok) throw new Error("Groq: " + redactSecrets((await res.text()).slice(0, 200)));
  const j = await res.json();
  return (j?.choices?.[0]?.message?.content ?? "").trim();
}

/** رد احتياطي ذكي من قاعدة البيانات لو مفيش مفتاح API */
async function localAnswer(q: string) {
  const [products, faq] = await Promise.all([getProducts(), getFaq()]);
  const t = q.toLowerCase();
  const words = t.split(/\s+/).filter((w) => w.length > 2);
  const score = (s: string) => words.reduce((n, w) => n + (s.toLowerCase().includes(w) ? 1 : 0), 0);

  const bestFaq = faq.map((f) => ({ f, s: score(f.question) })).sort((a, b) => b.s - a.s)[0];
  if (bestFaq && bestFaq.s >= 1) return bestFaq.f.answer;

  const hits = products
    .map((p) => ({ p, s: score(p.name + " " + p.category + " " + p.description) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  if (hits.length)
    return (
      "أهلاً بيك 👋 دي المنتجات المناسبة لطلبك:\n" +
      hits.map((h) => `• ${h.p.name} — ${h.p.price} جنيه`).join("\n") +
      `\n\nتقدر تضيفهم للسلة وتكمل الطلب، والدفع فودافون كاش على ${STORE.vodafoneCash} أو عند الاستلام.`
    );

  return `أهلاً بحضرتك في ${STORE.name} 🧼\nأنا سيليا، تحت أمرك. عندنا منظفات أرضيات ومطابخ وحمامات ومعطرات وأدوات نظافة.\nقولّي محتاج إيه بالظبط وأرشحلك الأنسب، أو كلمنا واتساب على ${STORE.phone}.`;
}

export const POST = apiHandler("/api/chat", async (req) => {
  const limit = await rateLimit(req, "chat", 30, 10 * 60 * 1000);
  if (!limit.ok) throw Errors.rateLimited(limit.retryAfter);

  const raw = await readJson(req, 40_000);
  const parsed = chatRequestContract.safeParse(raw);
  if (!parsed.success) throw Errors.validationFailed(firstZodIssue(parsed.error));

  // آخر 12 رسالة فقط، مع التأكد أنها ضمن الحد الأقصى للطول.
  const clean = parsed.data.messages.slice(-12);
  const last = clean[clean.length - 1]?.content ?? "";

  const { list, f } = await buildContext();
  const sys = systemPrompt(list, f);

  const gemini = process.env.GEMINI_API_KEY;
  const groq = process.env.GROQ_API_KEY;
  let reply = "";
  let source = "local";
  // بطاقات المنتجات اختيارية تمامًا: تُضاف للاستجابة فقط إن أنتجتها أداة محكومة.
  let products: unknown[] | undefined;
  // هوية الوكيل المناوب — تُضاف فقط حين يكون الأسطول مفعّلًا فعلًا (علمان معًا).
  let fleet: FleetResponseMeta | undefined;

  if (process.env.ENABLE_AI_AGENT === "true") {
    // المحرك النمطي الموحّد (المرحلة الأولى) — نفس السلسلة التراجعية
    // خلف علم الميزة؛ غياب العلم يُبقي المسار القديم المستقر كما هو حرفيًا.
    let engineSy = sys;
    let agentAllowlist: string[] | undefined;

    // المرحلة الرابعة: أسطول الوكلاء — يرتكز على المحرك النمطي، ويُوجَّه حتميًا
    // بلا موديل. تضييق الأدوات تقاطعٌ مع طبقة MCP لا توسيع لها، وتعطيل العلم
    // يُبقي كل ما سبق حرفيًا كما هو.
    if (isAgentFleetActive()) {
      const selection = selectAgents(last);
      engineSy = `${sys}\n\n${fleetPromptSection(selection)}`;
      agentAllowlist = fleetToolAllowlist(selection);
      fleet = fleetResponseMeta(selection);
      // سجل تدقيقي لقرار التوجيه — بلا نص رسالة العميل ولا أي بيانات شخصية.
      // نفس نمط mcp_tool_call: سطر JSON واحد قابل للتجميع في Vercel Logs.
      console.log(
        JSON.stringify({
          level: "info",
          event: "fleet_routing",
          ...fleetAuditRecord(selection, agentAllowlist),
          message_chars: last.length,
        })
      );
    }

    const agentMessages: AgentMessage[] = [
      { role: "system", content: engineSy },
      ...clean.map((m) => ({ role: m.role, content: m.content })),
    ];
    // بوابة ثانية عند نقطة الاستدعاء لطبقة MCP (المرحلة الثانية)؛ الطبقة
    // تعيد الفحص داخليًا. تعطيلها يُبقي المسار نصيًا مطابقًا للمرحلة الأولى.
    const result = await getSmartAgentEngine().processRequestDetailed(agentMessages, {
      enableTools: isMcpToolsEnabled(),
      ...(agentAllowlist ? { allowedTools: agentAllowlist } : {}),
    });
    reply = result.reply;
    source = result.provider;
    if (result.products && result.products.length > 0) products = result.products;
  } else {
    if (gemini) {
      try {
        reply = await callGemini(sys, clean, gemini);
        source = "gemini";
      } catch (e) {
        metrics.recordAiFailure("gemini");
        console.error("chat gemini failed:", redactSecrets(String((e as Error)?.message ?? e)));
      }
    }
    if (!reply && groq) {
      try {
        reply = await callGroq(sys, clean, groq);
        source = "groq";
      } catch (e) {
        metrics.recordAiFailure("groq");
        console.error("chat groq failed:", redactSecrets(String((e as Error)?.message ?? e)));
      }
    }
    if (!reply) reply = await localAnswer(last);
  }

  const c = db();
  if (c) {
    try {
      await ensureSchema();
      await c.execute({ sql: "INSERT INTO chat_logs (question,answer) VALUES (?,?)", args: [last, reply] });
    } catch (e) {
      console.error("chat log failed:", redactSecrets(String((e as Error)?.message ?? e)));
    }
  }

  // النجاح فقط هو ما يعيد 200؛ أي فشل غير متوقع يمر عبر الغلاف المركزي.
  // شكل الاستجابة القديم `{ reply, source }` كما هو؛ `products` و`fleet` حقلان
  // إضافيان يظهران فقط عند تفعيل ميزتيهما، فلا ينكسر أي عميل قديم.
  const payload: Record<string, unknown> = { reply, source };
  if (products) payload.products = products;
  if (fleet) payload.fleet = fleet;
  return NextResponse.json(payload);
});
