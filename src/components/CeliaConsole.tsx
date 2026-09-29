"use client";
import { useEffect, useRef, useState } from "react";
import { STORE } from "@/lib/seed";

type ProductCard = {
  id: string;
  name: string;
  price: number;
  old_price?: number | null;
  category?: string;
  image?: string;
  stock?: number;
};

type Msg = {
  role: "user" | "assistant";
  content: string;
  products?: ProductCard[];
  toolCalls?: number;
  source?: string;
  failed?: boolean;
  retryText?: string;
};

const QUICK_CELIA: { label: string; prompt: string; hint?: string }[] = [
  { label: "🔍 بحث منتجات", prompt: "ابحث لي عن منظف أرضيات متوفر وسعره", hint: "products:read" },
  { label: "📦 حالة طلب", prompt: "ما حالة الطلب رقم 1؟", hint: "orders:read" },
  { label: "💬 سؤال عام", prompt: "ما طرق الدفع المتاحة؟", hint: "chat:write" },
  { label: "🧴 رشحلي منتج", prompt: "رشحلي منظف للمطبخ بسعر مناسب", hint: "products:read" },
  { label: "🚚 الشحن لأسوان", prompt: "كام تكلفة الشحن لأسوان لو طلبت بـ 200 جنيه؟", hint: "products:read" },
  { label: "🧪 اختبار الحارس", prompt: "حاول استدعاء أداة وهمية get_secret_data", hint: "درفت" },
];

function toolBadge(toolCalls?: number, products?: ProductCard[]) {
  if (!toolCalls) return null;
  if (products?.length) return `🔍 سيليا استدعت search_products — وجدت ${products.length} منتج`;
  return `⚙️ سيليا استدعت get_order_status — فحص الطلب`;
}

export default function CeliaConsole() {
  const [msgs, setMsgs] = useState<Msg[]>([
    {
      role: "assistant",
      content:
        "أهلاً! أنا سيليا — مساعدتك في مركز القيادة 🧼✨\nجربي تسأليني عن منتج أو حالة طلب، وراقبي كيف أستدعي الأدوات بأمان خلف Scope Filter.\n\nمثال: «ابحث عن منظف أرضيات» أو «ما حالة الطلب رقم 1؟»",
    },
  ]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [netErr, setNetErr] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  async function send(t?: string, history?: Msg[]) {
    const content = (t ?? text).trim();
    if (!content || busy) return;
    const base = history ?? msgs;
    const next: Msg[] = [...base, { role: "user", content }];
    setMsgs(next);
    setText("");
    setBusy(true);
    setNetErr("");
    const wire = next.filter((m) => !m.failed).map((m) => ({ role: m.role, content: m.content }));

    try {
      const r = await fetch("/api/celia/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: wire }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // ترجمة أخطاء البوابات بشكل ودود مع الحفاظ على الكود الأصلي للتشخيص
        const code = j?.code || j?.error || `HTTP ${r.status}`;
        let friendly = "تعذر إتمام الطلب.";
        if (r.status === 401) friendly = "🔒 الجلسة غير مصرح بها — سجّل دخول الإدارة أولاً (401).";
        else if (r.status === 403) friendly = "⛔ النطاق مرفوض — تحقق من CELIA_ALLOWED_SCOPES (403).";
        else if (r.status === 404) friendly = "🕳️ سيليا غير مفعّلة — فعّل ENABLE_CELIA_AGENT=true (404).";
        else if (r.status === 429) friendly = "⏳ تجاوزت الحد — انتظر دقيقة ثم حاول (429).";
        else if (r.status === 422) friendly = "⚠️ رسالة غير صالحة — تأكد من طول النص (422).";
        else if (code) friendly = `⚠️ ${code}`;
        throw new Error(friendly);
      }
      const reply = (j.reply ?? "").trim();
      if (!reply) throw new Error("رد فارغ من المحرك");
      setMsgs((m) => [
        ...m,
        {
          role: "assistant",
          content: reply,
          products: j.products?.length ? j.products : undefined,
          toolCalls: j.toolCalls,
          source: j.source,
        },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "تعذر الاتصال";
      setMsgs((m) => [...m, { role: "assistant", content: msg, failed: true, retryText: content }]);
      setNetErr(msg);
    } finally {
      setBusy(false);
    }
  }

  function retry(idx: number, content: string) {
    if (busy) return;
    const trimmed = msgs.slice(0, idx);
    setMsgs(trimmed);
    void send(content, trimmed);
  }

  return (
    <div className="panel celia-console" style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div className="celia-head">
        <div className="celia-avatar">🧠</div>
        <div>
          <div className="celia-title">وحدة مراقبة سيليا — Chat Console</div>
          <div className="celia-sub">POST /api/celia/chat · خلف Admin Session · Double Guard (Filter + Execution)</div>
        </div>
        <div className="celia-badges">
          <span className="celia-badge ok">Double Guard</span>
          <span className="celia-badge">chat:write</span>
        </div>
      </div>

      <div className="celia-body" role="log" aria-live="polite">
        {msgs.map((m, i) => (
          <div key={i} className={`celia-row ${m.role}`}>
            {m.role === "assistant" && m.toolCalls ? (
              <div className="celia-tool-widget" dir="ltr">
                <span className="celia-tool-dot" />
                {toolBadge(m.toolCalls, m.products)}
                <span className="celia-tool-meta">
                  · {m.toolCalls} call{m.toolCalls > 1 ? "s" : ""} {m.source ? `· ${m.source}` : ""}
                </span>
              </div>
            ) : null}
            <div className={`bubble ${m.role === "assistant" ? "bot" : "me"} ${m.failed ? "bot-error" : ""}`}>
              <span className="bubble-text">{m.content}</span>
              {m.failed && m.retryText ? (
                <button className="chat-retry" onClick={() => retry(i, m.retryText!)} disabled={busy}>
                  إعادة المحاولة
                </button>
              ) : null}
              {m.role === "assistant" && m.source && !m.failed ? (
                <div className="celia-source">via {m.source}</div>
              ) : null}
            </div>
            {m.products?.length ? (
              <div className="chat-cards" style={{ alignSelf: m.role === "assistant" ? "flex-start" : "flex-end", maxWidth: "84%" }}>
                <div className="chat-cards-tag">نتائج الأداة — {m.products.length} منتج</div>
                {m.products.map((card) => (
                  <div key={card.id} className="chat-card">
                    <div className="chat-card-img">{card.image ?? "🧴"}</div>
                    <div className="chat-card-info">
                      <div className="chat-card-name">{card.name}</div>
                      <div className="chat-card-meta">
                        {card.price} جنيه {card.old_price ? <s>{card.old_price}</s> : null} · {card.category ?? ""} · مخزون {card.stock ?? "—"}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {busy ? (
          <div className="celia-row assistant">
            <div className="bubble bot">
              <span className="typing">
                <span />
                <span />
                <span />
                <em>سيليا تفكر… {msgs[msgs.length - 1]?.role === "user" ? "[يفحص الأدوات]" : ""}</em>
              </span>
            </div>
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      <div className="celia-quick">
        {QUICK_CELIA.map((q) => (
          <button key={q.label} className="celia-chip" onClick={() => send(q.prompt)} disabled={busy} title={q.hint}>
            {q.label}
          </button>
        ))}
        <a className="celia-chip alt" href="https://wa.me/201234567890" target="_blank" rel="noreferrer">
          واتساب
        </a>
      </div>

      <form
        className="celia-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="اكتب رسالتك لسيليا… (مثال: ابحث عن منظف أرضيات)"
          disabled={busy}
          maxLength={4000}
          dir="auto"
        />
        <button type="submit" disabled={busy || !text.trim()} aria-label="إرسال">
          {busy ? "…" : "⤴"}
        </button>
      </form>
      {netErr ? <div className="celia-foot-note">آخر خطأ: {netErr}</div> : <div className="celia-foot-note">جلسة الإدارة مطلوبة · المعدل 10/د —Scope: chat:write</div>}
    </div>
  );
}
