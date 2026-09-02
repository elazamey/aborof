"use client";
import { useCallback, useEffect, useState } from "react";

function Badge({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={`chip${on ? " active" : ""}`} style={{ cursor: "default", fontSize: ".8rem" }}>
      {on ? "✅ " : "⏳ "}
      {label}
    </span>
  );
}

type Status = {
  email: string;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  passwordConfigured: boolean;
  role: string;
  activeSessions: number;
  pendingChanges: {
    id: string;
    kind: string;
    status: string;
    requestedAt: number;
    expiresAt: number;
    securityDelayUntil: number | null;
  }[];
  recentEvents: { event: string; createdAt: number }[];
};

/**
 * مركز الأمان (IDENTITY-HARDENING-01) — حالة الهوية، الطلبات المعلقة،
 * تغيير كلمة المرور، وطلب تغيير البريد/الهاتف.
 */
export default function SecurityCenter() {
  const [st, setSt] = useState<Status | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [password, setPassword] = useState("");
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [code, setCode] = useState("");
  const [activeRequest, setActiveRequest] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/identity/status");
    if (r.ok) setSt(await r.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function api(path: string, body: unknown): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, error: j.error, data: j };
  }

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    setMsg("");
    const r = await fn();
    setMsg(r.ok ? "✅ تمت العملية" : "❌ " + (r.error || "خطأ"));
    await load();
    setBusy(false);
  }

  async function requestEmailChange() {
    const r = await api("/api/identity/request-change", { kind: "email", newValue: newEmail, password });
    if (r.ok) {
      setActiveRequest((r.data as { requestId: string }).requestId);
      setNewEmail("");
    }
    setMsg(r.ok ? "🔐 تحقق من الرمز المرسل إلى البريد الجديد" : "❌ " + (r.error || "خطأ"));
    await load();
  }

  async function requestPhoneChange() {
    const r = await api("/api/identity/request-change", { kind: "phone", newValue: newPhone, password });
    if (r.ok) {
      setActiveRequest((r.data as { requestId: string }).requestId);
      setNewPhone("");
    }
    setMsg(r.ok ? "🔐 تحقق من الرمز المرسل إلى الهاتف الجديد" : "❌ " + (r.error || "خطأ"));
    await load();
  }

  async function verifyCode() {
    if (!activeRequest) return;
    await run(() => api("/api/identity/verify-otp", { requestId: activeRequest, code }));
    setCode("");
  }

  async function changePw() {
    await run(() => api("/api/identity/change-password", { currentPassword: curPw, newPassword: newPw }));
    setCurPw("");
    setNewPw("");
  }

  async function changeAction(requestId: string, action: "apply" | "cancel") {
    await run(() => api("/api/identity/change-action", { requestId, action }));
  }

  const [verifyKind, setVerifyKind] = useState<"email" | "phone" | null>(null);
  const [verifyValue, setVerifyValue] = useState("");

  async function startVerify(kind: "email" | "phone") {
    const body = kind === "email" ? { mode: "start", kind } : { mode: "start", kind, value: verifyValue };
    const r = await api("/api/identity/verify", body);
    if (r.ok) setVerifyKind(kind);
    setMsg(r.ok ? "🔐 أُرسل رمز التحقق" : "❌ " + (r.error || "خطأ"));
  }

  async function confirmVerify() {
    if (!verifyKind) return;
    const ok = await run(() => api("/api/identity/verify", { mode: "confirm", kind: verifyKind, code }));
    void ok;
    setVerifyKind(null);
    setCode("");
  }

  return (
    <div className="cart-wrap">
      <div>
        <div className="panel">
          <h3>🛡️ مركز الأمان</h3>
          {!st ? (
            <div className="admin-loading">جاري تحميل حالة الأمان…</div>
          ) : (
            <>
              <p style={{ marginBottom: 10, fontSize: ".9rem" }}>
                الحساب: <b>{st.email}</b> — الدور: {st.role === "owner" ? "مالك المتجر" : st.role}
              </p>
              <div className="filters" style={{ justifyContent: "flex-start", margin: "0 0 12px" }}>
                <Badge on={st.emailVerified} label="البريد موثق" />
                <Badge on={st.phoneVerified} label="الهاتف موثق" />
                <Badge on={st.passwordConfigured} label="كلمة المرور" />
              </div>
              <p style={{ fontSize: ".86rem", color: "var(--muted)" }}>
                الجلسات النشطة: <b>{st.activeSessions}</b>
              </p>
              {st.pendingChanges.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <h4 style={{ marginBottom: 8 }}>طلبات تغيير معلقة</h4>
                  {st.pendingChanges.map((c) => (
                    <div key={c.id} className="line-item" style={{ gridTemplateColumns: "1fr auto" }}>
                      <div>
                        <b>{c.kind === "email" ? "تغيير البريد" : "تغيير الهاتف"}</b> — حالة: {c.status}
                        <div style={{ fontSize: ".8rem", color: "var(--muted)" }}>
                          {c.status === "SECURITY_REVIEW" && c.securityDelayUntil
                            ? `بانتظار انتهاء المراجعة الأمنية (${new Date(c.securityDelayUntil).toLocaleString("ar-EG")})`
                            : `يُطلب قبل ${new Date(c.expiresAt).toLocaleString("ar-EG")}`}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        {c.status === "NEW_VALUE_VERIFIED" && (
                          <button
                            className="btn btn-primary"
                            style={{ padding: "8px 12px", fontSize: ".82rem" }}
                            onClick={() => changeAction(c.id, "apply")}
                          >
                            تنفيذ
                          </button>
                        )}
                        <button
                          className="btn btn-ghost"
                          style={{ padding: "8px 12px", fontSize: ".82rem" }}
                          onClick={() => changeAction(c.id, "cancel")}
                        >
                          إلغاء
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {!st.emailVerified && (
                <div className="field" style={{ marginTop: 12 }}>
                  <label>توثيق البريد الحالي (مطلوب قبل أي تغيير)</label>
                  <button className="btn btn-ghost btn-block" disabled={busy} onClick={() => startVerify("email")}>
                    أرسل رمز توثيق إلى البريد
                  </button>
                </div>
              )}
              {!st.phoneVerified && (
                <div className="field" style={{ marginTop: 8 }}>
                  <label>توثيق الهاتف</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      dir="ltr"
                      value={verifyValue}
                      onChange={(e) => setVerifyValue(e.target.value)}
                      placeholder="01xxxxxxxxx"
                    />
                    <button
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={() => startVerify("phone")}
                      style={{ whiteSpace: "nowrap" }}
                    >
                      أرسل الرمز
                    </button>
                  </div>
                </div>
              )}
              {(verifyKind || activeRequest) && (
                <div className="field" style={{ marginTop: 12 }}>
                  <label>رمز التحقق (OTP)</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="6 أرقام"
                      inputMode="numeric"
                      maxLength={6}
                    />
                    <button
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={verifyKind ? confirmVerify : verifyCode}
                      style={{ whiteSpace: "nowrap" }}
                    >
                      تحقق
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <div className="panel" style={{ marginTop: 16 }}>
          <h3>🔑 تغيير كلمة المرور</h3>
          <div className="field">
            <label>كلمة المرور الحالية *</label>
            <input type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} />
          </div>
          <div className="field">
            <label>كلمة المرور الجديدة (10 أحرف على الأقل) *</label>
            <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          </div>
          <button className="btn btn-primary" disabled={busy} onClick={changePw}>
            تغيير كلمة المرور (تُلغى جلسات الأجهزة الأخرى)
          </button>
        </div>
      </div>
      <div>
        <div className="panel">
          <h3>✉️ طلب تغيير البريد</h3>
          <p style={{ fontSize: ".84rem", color: "var(--muted)", marginBottom: 10 }}>
            لا تغيير مباشر: طلب → OTP للبريد الجديد → (مراجعة أمنية للمالك) → تنفيذ. لا يعيد فترة التجربة.
          </p>
          <div className="field">
            <label>البريد الجديد *</label>
            <input
              dir="ltr"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="new@example.com"
            />
          </div>
          <div className="field">
            <label>كلمة المرور الحالية (إعادة مصادثة) *</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <button
            className="btn btn-ghost btn-block"
            disabled={busy || !st?.emailVerified}
            onClick={requestEmailChange}
          >
            {st && !st.emailVerified ? "وثّق البريد الحالي أولًا" : "طلب تغيير البريد"}
          </button>
        </div>
        <div className="panel" style={{ marginTop: 16 }}>
          <h3>📱 طلب تغيير الهاتف</h3>
          <div className="field">
            <label>الهاتف الجديد (مثال: 01000000000) *</label>
            <input dir="ltr" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="01xxxxxxxxx" />
          </div>
          <button className="btn btn-ghost btn-block" disabled={busy} onClick={requestPhoneChange}>
            طلب تغيير الهاتف
          </button>
        </div>
        <div className="panel" style={{ marginTop: 16 }}>
          <h3>📜 الأحداث الأخيرة</h3>
          {st?.recentEvents.length ? (
            st.recentEvents.map((e, i) => (
              <p key={i} style={{ fontSize: ".8rem", color: "var(--muted)" }}>
                {new Date(e.createdAt).toLocaleString("ar-EG")} — {e.event}
              </p>
            ))
          ) : (
            <p style={{ fontSize: ".85rem", color: "var(--muted)" }}>لا أحداث بعد.</p>
          )}
        </div>
      </div>
    </div>
  );
}
