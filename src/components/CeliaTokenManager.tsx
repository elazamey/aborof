"use client";
import { useCallback, useEffect, useState } from "react";

/**
 * CeliaTokenManager — واجهة توكنات وكلاء سيليا داخل `/admin`.
 *
 * حدود هذه الواجهة (نفس مبادئ لوحة الصلاحيات):
 *  - **لا قرار أمني هنا**: كل إجراء يُفرض على الخادم (علم + صلاحية + نطاقات).
 *  - **لا بصمة ولا نص صريح في القائمة**: الخادم لا يرسل إلا البادئة والحالة؛
 *    والنص الصريح يظهر **مرة واحدة** بعد الإنشاء/التدوير فقط.
 *  - **مصفوفة نطاقات مُجمَّعة** بقوالب جاهزة، فلا يمنح المشغّل نطاقًا بالخطأ.
 *  - **حالة صريحة** لكل شيء: تحميل/معطّل بالعلم/مرفوض/خطأ — برسالة عربية.
 */

type TokenRecord = {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  status: "active" | "revoked";
  createdBy: string;
  useCount: number;
  expiresAt: number;
  expired: boolean;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  createdAt: string;
};

type Snapshot = {
  tokens: TokenRecord[];
  catalog: { scopes: string[] };
};

const SCOPE_GROUPS: { id: string; label: string; scopes: string[] }[] = [
  { id: "catalog", label: "الكتالوج", scopes: ["products:read", "products:write"] },
  { id: "orders", label: "الطلبات", scopes: ["orders:read", "orders:write"] },
  { id: "faq", label: "الأسئلة الشائعة", scopes: ["faq:read", "faq:write"] },
  { id: "chat", label: "المحادثات", scopes: ["chat:read", "chat:write"] },
  { id: "platform", label: "المنصة والأدوات", scopes: ["admin:read", "mcp:read", "mcp:write"] },
];

const SCOPE_LABELS: Record<string, string> = {
  "products:read": "قراءة المنتجات",
  "products:write": "تعديل المنتجات",
  "orders:read": "قراءة الطلبات",
  "orders:write": "تعديل الطلبات",
  "faq:read": "قراءة الأسئلة",
  "faq:write": "تعديل الأسئلة",
  "chat:read": "قراءة المحادثات",
  "chat:write": "إرسال المحادثات",
  "admin:read": "عرض الإدارة",
  "mcp:read": "قراءة أدوات MCP",
  "mcp:write": "تشغيل أدوات MCP",
};

const PRESETS: { id: string; label: string; scopes: string[] }[] = [
  { id: "reader", label: "قراءة فقط", scopes: ["products:read", "orders:read", "faq:read"] },
  { id: "support", label: "دعم المحادثات", scopes: ["chat:write", "orders:read", "faq:read", "products:read"] },
  { id: "full", label: "تشغيل كامل", scopes: ["products:read", "orders:read", "orders:write", "faq:read", "chat:write"] },
];

async function jsonFetch(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

function stamp(value: string | null) {
  if (!value) return "—";
  return String(value).slice(0, 16).replace("T", " ");
}

export default function CeliaTokenManager() {
  const [state, setState] = useState<"loading" | "disabled" | "forbidden" | "error" | "ready">("loading");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ label: "", scopes: [] as string[], expiresInDays: 0 });
  const [revealed, setRevealed] = useState<{ label: string; plaintext: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const { ok, status, data } = await jsonFetch("/api/admin/celia/tokens");
    if (status === 404) {
      setState("disabled");
      return;
    }
    if (status === 401) {
      setState("forbidden");
      setMsg("الجلسة غير صالحة — سجّل الدخول من جديد.");
      return;
    }
    if (status === 403) {
      setState("forbidden");
      setMsg(data?.error ?? "لا تملك صلاحية «عرض توكنات وكلاء سيليا».");
      return;
    }
    if (!ok) {
      setState("error");
      setMsg(data?.error ?? "تعذر تحميل التوكنات.");
      return;
    }
    setSnapshot(data as Snapshot);
    setState("ready");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleScope(scope: string) {
    setDraft((d) => ({
      ...d,
      scopes: d.scopes.includes(scope) ? d.scopes.filter((s) => s !== scope) : [...d.scopes, scope],
    }));
  }

  async function create() {
    setBusy(true);
    setMsg("");
    setRevealed(null);
    try {
      const { ok, data } = await jsonFetch("/api/admin/celia/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: { label: draft.label, scopes: draft.scopes, expiresInDays: draft.expiresInDays } }),
      });
      if (!ok) {
        setMsg(`❌ ${data?.error ?? "تعذر إنشاء التوكن"}`);
        return;
      }
      setRevealed({ label: data.token.label as string, plaintext: data.plaintext as string });
      setDraft({ label: "", scopes: [], expiresInDays: 0 });
      setMsg("✅ أُنشئ التوكن — انسخ القيمة الآن، لن تُعرض مرة أخرى.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function act(id: string, action: "revoke" | "rotate") {
    const verb = action === "revoke" ? "إلغاء" : "تدوير";
    if (!window.confirm(`تأكيد ${verb} هذا التوكن؟`)) return;
    setBusy(true);
    setMsg("");
    if (action === "revoke") setRevealed(null);
    try {
      const { ok, data } = await jsonFetch("/api/admin/celia/tokens", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      if (!ok) {
        setMsg(`❌ ${data?.error ?? `تعذر ${verb} التوكن`}`);
        return;
      }
      if (action === "rotate" && data?.plaintext) {
        setRevealed({ label: data.token.label as string, plaintext: data.plaintext as string });
        setMsg("✅ تم التدوير — انسخ القيمة الجديدة الآن، والقديمة صارت ملغاة.");
      } else {
        setMsg("✅ تم إلغاء التوكن.");
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function copyRevealed() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.plaintext);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setMsg("تعذّر النسخ التلقائي — انسخ القيمة يدويًا.");
    }
  }

  if (state === "loading") return <div className="panel admin-loading">جارٍ تحميل التوكنات…</div>;

  if (state === "disabled") {
    return (
      <div className="panel">
        <div className="admin-kicker">توكنات سيليا</div>
        <h3>الميزة معطّلة</h3>
        <p className="admin-muted">
          توكنات الوكيل المُدارة خلف علم <code>ENABLE_CELIA_TOKENS</code> وغير مفعّلة على هذا النشر. حتى تفعيلها يبقى
          توكن الوكيل الوحيد في متغيّرات البيئة هو المسار المتاح.
        </p>
      </div>
    );
  }

  if (state === "forbidden") {
    return (
      <div className="panel">
        <div className="admin-kicker">توكنات سيليا</div>
        <div className="alert">{msg}</div>
        <p className="admin-muted">تحتاج صلاحية «عرض توكنات وكلاء سيليا» (celia:read) — اطلبها من مالك الحساب.</p>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="panel">
        <div className="admin-kicker">توكنات سيليا</div>
        <div className="alert">{msg || "تعذر تحميل التوكنات."}</div>
        <button className="btn btn-ghost" onClick={() => void load()}>إعادة المحاولة</button>
      </div>
    );
  }

  const tokens = snapshot?.tokens ?? [];

  return (
    <div className="cart-wrap">
      <div className="panel">
        <div className="admin-kicker">CeliaTokenManager</div>
        <h3>توكنات وكلاء سيليا ({tokens.length})</h3>
        <p className="admin-muted" style={{ marginTop: 6 }}>
          كل توكن يحمل نطاقاته الخاصة، ويُخزَّن كبصمة فقط. القيمة الصريحة تُعرض <b>مرة واحدة</b> عند الإنشاء أو
          التدوير — لا يمكن استرجاعها لاحقًا بأي طريق.
        </p>
        {msg && <div className="alert" style={{ marginTop: 10 }}>{msg}</div>}

        {revealed && (
          <div className="panel" style={{ border: "2px solid var(--accent, #0a7)", marginTop: 12 }}>
            <div className="admin-kicker">كشف واحد — «{revealed.label}»</div>
            <p style={{ margin: "8px 0" }}>انسخ القيمة الآن. لن تُعرض مرة أخرى ولن تجدها في أي شاشة بعد اليوم.</p>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <code dir="ltr" style={{ padding: "8px 10px", background: "rgba(0,0,0,.06)", borderRadius: 8, wordBreak: "break-all" }}>
                {revealed.plaintext}
              </code>
              <button className="btn btn-primary" onClick={() => void copyRevealed()}>
                {copied ? "تم النسخ ✅" : "نسخ"}
              </button>
              <button className="btn btn-ghost" onClick={() => setRevealed(null)}>إخفاء</button>
            </div>
          </div>
        )}

        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>البادئة</th>
                <th>الاسم</th>
                <th>النطاقات</th>
                <th>الحالة</th>
                <th>آخر استخدام</th>
                <th>أُنشئ بواسطة</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td><code dir="ltr">{t.prefix}…</code></td>
                  <td>{t.label}</td>
                  <td style={{ maxWidth: 320, whiteSpace: "normal" }}>
                    {t.scopes.map((s) => (
                      <span key={s} className="chip" style={{ marginInlineEnd: 4 }} title={s}>
                        {SCOPE_LABELS[s] ?? s}
                      </span>
                    ))}
                  </td>
                  <td>
                    {t.status === "revoked" ? (
                      <span className="chip">ملغى {t.revokedBy ? `— ${t.revokedBy}` : ""}</span>
                    ) : t.expired ? (
                      <span className="chip">منتهٍ</span>
                    ) : (
                      <span className="chip">فعّال · {t.useCount} استخدام</span>
                    )}
                    {t.expiresAt > 0 && !t.expired && (
                      <div className="admin-muted" style={{ fontSize: ".75rem" }}>
                        ينتهي: {stamp(new Date(t.expiresAt).toISOString())}
                      </div>
                    )}
                  </td>
                  <td>{stamp(t.lastUsedAt)}</td>
                  <td>{t.createdBy}</td>
                  <td>
                    {t.status === "active" && (
                      <>
                        <button className="chip" disabled={busy} onClick={() => void act(t.id, "rotate")}>تدوير</button>{" "}
                        <button className="chip" disabled={busy} onClick={() => void act(t.id, "revoke")}>إلغاء</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {tokens.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: 12, color: "var(--muted)" }}>
                    لا توجد توكنات مُدارة بعد — أنشئ أول توكن من النموذج المجاور.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <h3>إنشاء توكن جديد</h3>

        <div className="field">
          <label>الاسم (يظهر في السجل والتدقيق)</label>
          <input required value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="مثال: بوت الطلبات" />
        </div>

        <div className="field">
          <label>قوالب سريعة</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {PRESETS.map((p) => (
              <button
                type="button"
                key={p.id}
                className="chip"
                onClick={() => setDraft({ ...draft, scopes: [...p.scopes] })}
                title={p.scopes.join(", ")}
              >
                {p.label}
              </button>
            ))}
            <button type="button" className="chip" onClick={() => setDraft({ ...draft, scopes: [] })}>تفريغ</button>
          </div>
        </div>

        <div className="field">
          <label>مصفوفة النطاقات (لا يمنح الخادم نطاقًا يزيد عن صلاحياتك)</label>
          {(snapshot?.catalog.scopes ?? []).length === 0 && <div className="admin-muted">لا كتالوج — أعد التحميل.</div>}
          {SCOPE_GROUPS.map((group) => (
            <div key={group.id} style={{ marginBottom: 8 }}>
              <div className="admin-kicker">{group.label}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                {group.scopes.map((scope) => (
                  <label
                    key={scope}
                    className="chip"
                    style={{ display: "inline-flex", gap: 6, cursor: "pointer" }}
                    title={scope}
                  >
                    <input type="checkbox" checked={draft.scopes.includes(scope)} onChange={() => toggleScope(scope)} />
                    {SCOPE_LABELS[scope] ?? scope}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="field">
          <label>الانتهاء بعد (أيام — 0 = بلا انتهاء)</label>
          <input
            type="number"
            min={0}
            max={365}
            value={draft.expiresInDays}
            onChange={(e) => setDraft({ ...draft, expiresInDays: Number(e.target.value || 0) })}
          />
        </div>

        <button className="btn btn-primary btn-block" disabled={busy || draft.scopes.length === 0}>
          إنشاء التوكن
        </button>
        <p className="admin-muted" style={{ marginTop: 8 }}>
          النطاق الفعلي وقت الاستخدام = نطاقات التوكن <b>متقاطعة مع</b> سقف المتجر في متغيّر
          <code> CELIA_ALLOWED_SCOPES</code> — لا يرفع التوكن السقف.
        </p>
      </form>
    </div>
  );
}
