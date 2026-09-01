"use client";
import { useEffect, useRef, useState } from "react";
import { STORE } from "@/lib/seed";

type Msg = { role: "user" | "assistant"; content: string };

const QUICK = ["إيه المنتجات المتوفرة؟", "طرق الدفع؟", "كام سعر الشحن؟", "رشحلي منظف أرضيات", "عندكم جملة؟"];

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([
    {
      role: "assistant",
      content: `أهلاً وسهلاً بيك في ${STORE.name} 🧼✨\nأنا سيليا، مساعدتك الشخصية. اسألني عن أي منتج أو سعر أو طريقة الطلب وأنا تحت أمرك 💚`,
    },
  ]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy, open]);

  async function send(t?: string) {
    const content = (t ?? text).trim();
    if (!content || busy) return;
    const next = [...msgs, { role: "user" as const, content }];
    setMsgs(next);
    setText("");
    setBusy(true);
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const j = await r.json();
      setMsgs((m) => [...m, { role: "assistant", content: j.reply }]);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", content: `النت عندي فصل شوية 😅 كلمنا واتساب على ${STORE.phone}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {open && (
        <div className="chat-win">
          <div className="chat-head">
            <div className="chat-avatar">👩‍💼</div>
            <div>
              <div className="nm">سيليا</div>
              <div className="st">● مساعدة خدمة العملاء — متاحة الآن</div>
            </div>
            <button onClick={() => setOpen(false)} aria-label="إغلاق">
              ✕
            </button>
          </div>
          <div className="chat-body">
            {msgs.map((m, i) => (
              <div key={i} className={"bubble " + (m.role === "user" ? "me" : "bot")}>
                {m.content}
              </div>
            ))}
            {busy && (
              <div className="bubble bot typing">
                <span />
                <span />
                <span />
              </div>
            )}
            <div ref={endRef} />
          </div>
          <div className="chat-quick">
            {QUICK.map((q) => (
              <button key={q} onClick={() => send(q)}>
                {q}
              </button>
            ))}
          </div>
          <div className="chat-input">
            <input
              placeholder="اكتب رسالتك لسيليا…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
            />
            <button onClick={() => send()} disabled={busy} aria-label="إرسال">
              ➤
            </button>
          </div>
        </div>
      )}

      <div className="fab-wrap">
        <button className="fab bot" onClick={() => setOpen(!open)} title="تحدث مع سيليا">
          {open ? "✕" : "💬"}
        </button>
        <a
          className="fab wa"
          href={`https://wa.me/${STORE.whatsapp}`}
          target="_blank"
          rel="noreferrer"
          title={`واتساب ${STORE.phone}`}
        >
          📱
        </a>
      </div>
    </>
  );
}
