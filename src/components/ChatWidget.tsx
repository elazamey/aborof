"use client";
import { useEffect, useRef, useState } from "react";
import { STORE, type Product } from "@/lib/seed";
import { addToCart } from "@/lib/cart";

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
  /** اسم الوكيل المناوب من أسطول الوكلاء — يظهر فقط عندما يرسله الخادم. */
  agent?: string;
  /** رسالة فشل قابلة لإعادة الإرسال بدل الرسالة التقنية الجافة. */
  failed?: boolean;
  /** نص رسالة المستخدم التي نُعيد إرسالها عند الضغط على «إعادة المحاولة». */
  retryText?: string;
};

const QUICK = [
  "إيه المنتجات المتوفرة؟",
  "الأكثر مبيعًا",
  "طرق الدفع؟",
  "كام سعر الشحن؟",
  "رشحلي منظف أرضيات",
  "عندكم جملة؟",
];

const FRIENDLY_ERROR = "معلش، حصل بطء بسيط في الشبكة 🙏 جرّب تاني أو كلمنا واتساب.";

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

/** التعرف على الكلام متاح في المتصفحات الداعمة فقط، وإلا يختفي الزر تمامًا. */
function getRecognition(): SpeechRecognitionLike | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) return null;
  const recognition = new Ctor();
  recognition.lang = "ar-EG";
  recognition.interimResults = false;
  recognition.continuous = false;
  return recognition;
}

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [added, setAdded] = useState<string | null>(null);
  const [voiceReady, setVoiceReady] = useState(false);
  const [listening, setListening] = useState(false);
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

  useEffect(() => {
    setVoiceReady(getRecognition() !== null);
  }, []);

  async function send(t?: string, conversation?: Msg[]) {
    const content = (t ?? text).trim();
    if (!content || busy) return;

    const history = conversation ?? msgs;
    const next: Msg[] = [...history, { role: "user", content }];
    setMsgs(next);
    setText("");
    setBusy(true);

    // نرسل للمخدم دور المحادثة نفسه كما كان (نفس العقد) بلا أي حقول جديدة.
    const wire = next
      .filter((m) => !m.failed)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: wire }),
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
      const j = (await r.json()) as {
        reply?: string;
        products?: ProductCard[];
        fleet?: { primary?: { name?: string } };
      };
      const reply = (j.reply ?? "").trim();
      if (!reply) throw new Error("empty reply");
      setMsgs((m) => [
        ...m,
        {
          role: "assistant",
          content: reply,
          products: j.products?.length ? j.products : undefined,
          agent: j.fleet?.primary?.name || undefined,
        },
      ]);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", content: FRIENDLY_ERROR, failed: true, retryText: content }]);
    } finally {
      setBusy(false);
    }
  }

  /** إعادة المحاولة: نحذف رسالة الفشل ونعيد إرسال نص المستخدم نفسه. */
  function retry(index: number, content: string) {
    if (busy) return;
    const trimmed = msgs.slice(0, index);
    setMsgs(trimmed);
    void send(content, trimmed);
  }

  function addCard(card: ProductCard) {
    const product: Product = {
      id: card.id,
      name: card.name,
      description: "",
      price: card.price,
      old_price: card.old_price ?? null,
      category: card.category ?? "",
      image: card.image ?? "🧴",
      stock: card.stock ?? 1,
    };
    addToCart(product, 1);
    setAdded(card.id);
    window.setTimeout(() => setAdded((current) => (current === card.id ? null : current)), 2000);
  }

  function startVoice() {
    const recognition = getRecognition();
    if (!recognition) return;
    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript ?? "";
      if (transcript.trim()) setText(transcript.trim());
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    setListening(true);
    try {
      recognition.start();
    } catch {
      setListening(false);
    }
  }

  /** مشاركة الموقع للتوصيل: تُرسل الإحداثيات للواتساب (لا تُخزَّن ولا تُسجَّل عندنا). */
  function shareLocation() {
    const fallback = () => window.open(`https://wa.me/${STORE.whatsapp}`, "_blank", "noreferrer");
    if (typeof navigator === "undefined" || !navigator.geolocation) return fallback();
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        const link = `https://maps.google.com/?q=${latitude.toFixed(5)},${longitude.toFixed(5)}`;
        window.open(
          `https://wa.me/${STORE.whatsapp}?text=${encodeURIComponent(`موقعي للتوصيل: ${link}`)}`,
          "_blank",
          "noreferrer"
        );
      },
      fallback,
      { timeout: 8000, maximumAge: 60000 }
    );
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
            <button onClick={() => setOpen(false)} aria-label="إغلاق">✕</button>
          </div>

          <div className="chat-body">
            {msgs.map((m, i) => (
              <div key={i} className={"bubble " + (m.role === "user" ? "me" : "bot") + (m.failed ? " bot-error" : "")}>
                {m.agent && <div className="chat-agent-tag">🤖 {m.agent}</div>}
                <span className="bubble-text">{m.content}</span>

                {m.products && (
                  <div className="chat-cards">
                    <div className="chat-cards-tag">🧴 من كتالوج المتجر</div>
                    {m.products.map((card) => (
                      <div className="chat-card" key={card.id}>
                        <div className="chat-card-img">{card.image || "🧴"}</div>
                        <div className="chat-card-info">
                          <div className="chat-card-name">{card.name}</div>
                          <div className="chat-card-meta">
                            <b>{card.price} جنيه</b>
                            {card.old_price ? <s>{card.old_price}</s> : null}
                            {typeof card.stock === "number" && card.stock <= 0 ? <em>غير متوفر</em> : null}
                          </div>
                        </div>
                        <button
                          className="chat-card-add"
                          onClick={() => addCard(card)}
                          disabled={typeof card.stock === "number" && card.stock <= 0}
                        >
                          {added === card.id ? "تمت الإضافة ✓" : "أضف للسلة"}
                        </button>
                      </div>
                    ))}
                    <a className="chat-cards-link" href="/cart">إتمام الطلب ←</a>
                  </div>
                )}

                {m.failed && m.retryText && (
                  <button className="chat-retry" onClick={() => retry(i, m.retryText as string)} disabled={busy}>
                    ↻ إعادة المحاولة
                  </button>
                )}
              </div>
            ))}

            {busy && (
              <div className="bubble bot typing">
                <span /><span /><span />
                <em>سيليا تكتب الآن…</em>
              </div>
            )}
            <div ref={endRef} />
          </div>

          <div className="chat-quick">
            {QUICK.map((q) => (
              <button key={q} onClick={() => send(q)} disabled={busy}>{q}</button>
            ))}
            <button className="chat-quick-alt" onClick={shareLocation} type="button">📍 شارك موقعك للتوصيل</button>
            <a className="chat-quick-alt" href={`https://wa.me/${STORE.whatsapp}?text=${encodeURIComponent("عايز أتابع حالة طلبي رقم: ")}`} target="_blank" rel="noreferrer">
              📦 تابع طلبك
            </a>
          </div>

          <div className="chat-input">
            <input
              placeholder="اكتب رسالتك لسيليا…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
            />
            {voiceReady && (
              <button
                className={"chat-mic" + (listening ? " on" : "")}
                onClick={startVoice}
                type="button"
                aria-label="إملاء صوتي"
                title="اكتب بالصوت"
              >
                🎤
              </button>
            )}
            <button onClick={() => send()} disabled={busy} aria-label="إرسال">➤</button>
          </div>
        </div>
      )}

      <div className="fab-wrap">
        <button className="fab bot" onClick={() => setOpen(!open)} title="تحدث مع سيليا">
          {open ? "✕" : "💬"}
        </button>
        <a className="fab wa" href={`https://wa.me/${STORE.whatsapp}`} target="_blank" rel="noreferrer" title={`واتساب ${STORE.phone}`}>
          📱
        </a>
      </div>
    </>
  );
}
