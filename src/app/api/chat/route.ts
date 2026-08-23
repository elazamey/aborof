import { NextRequest, NextResponse } from "next/server";
import { getProducts, getFaq, db, ensureSchema } from "@/lib/db";
import { STORE } from "@/lib/seed";

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

شخصيتك: فتاة مصرية ودودة، مهذبة، مرحة قليلاً، سريعة ومباشرة. تتحدثين بالعربية المصرية البسيطة المفهومة. تستخدمين إيموجي بسيط أحياناً 🧼✨ بدون مبالغة. ردودك قصيرة (2-5 أسطر) إلا لو العميل طلب تفاصيل.

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

async function callGemini(sys: string, messages: Msg[], key: string) {
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
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1200,
            // إيقاف وضع التفكير حتى لا يستهلك التوكنز ويسرّع الرد
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );
    if (res.ok) {
      const j = await res.json();
      const t = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "";
      if (t.trim()) return t.trim();
      lastErr = "empty";
    } else {
      lastErr = await res.text();
    }
  }
  throw new Error("Gemini: " + lastErr.slice(0, 200));
}

async function callGroq(sys: string, messages: Msg[], key: string) {
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
  if (!res.ok) throw new Error("Groq: " + (await res.text()).slice(0, 200));
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

  const hits = products.map((p) => ({ p, s: score(p.name + " " + p.category + " " + p.description) }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 3);
  if (hits.length)
    return (
      "أهلاً بيك 👋 دي المنتجات المناسبة لطلبك:\n" +
      hits.map((h) => `• ${h.p.name} — ${h.p.price} جنيه`).join("\n") +
      `\n\nتقدر تضيفهم للسلة وتكمل الطلب، والدفع فودافون كاش على ${STORE.vodafoneCash} أو عند الاستلام.`
    );

  return `أهلاً بحضرتك في ${STORE.name} 🧼\nأنا سيليا، تحت أمرك. عندنا منظفات أرضيات ومطابخ وحمامات ومعطرات وأدوات نظافة.\nقولّي محتاج إيه بالظبط وأرشحلك الأنسب، أو كلمنا واتساب على ${STORE.phone}.`;
}

export async function POST(req: NextRequest) {
  try {
    const { messages = [] } = (await req.json()) as { messages: Msg[] };
    const clean = messages.slice(-12).filter((m) => m?.content?.trim());
    const last = clean[clean.length - 1]?.content ?? "";
    const { list, f } = await buildContext();
    const sys = systemPrompt(list, f);

    const gemini = process.env.GEMINI_API_KEY;
    const groq = process.env.GROQ_API_KEY;
    let reply = "";
    let source = "local";

    if (gemini) {
      try { reply = await callGemini(sys, clean, gemini); source = "gemini"; } catch (e) { console.error(e); }
    }
    if (!reply && groq) {
      try { reply = await callGroq(sys, clean, groq); source = "groq"; } catch (e) { console.error(e); }
    }
    if (!reply) reply = await localAnswer(last);

    const c = db();
    if (c) {
      try {
        await ensureSchema();
        await c.execute({ sql: "INSERT INTO chat_logs (question,answer) VALUES (?,?)", args: [last, reply] });
      } catch {}
    }

    return NextResponse.json({ reply, source });
  } catch (e: any) {
    return NextResponse.json(
      { reply: `حصل خطأ بسيط 😅 جرّب تاني أو كلمنا واتساب على ${STORE.phone}`, error: String(e?.message) },
      { status: 200 }
    );
  }
}
