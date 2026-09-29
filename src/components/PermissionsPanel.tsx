"use client";
import { useCallback, useEffect, useState } from "react";

/**
 * لوحة الصلاحيات (M1) — واجهة إدارة الأدوار والمستخدمين داخل `/admin`.
 *
 * حدود هذه الواجهة:
 *  - **لا قرار أمني هنا**: كل إجراء يمرّ عبر مسارات محكومة تفرض الصلاحية
 *    على الخادم؛ إخفاء الأزرار تجميلي فقط (وحائز الصلاحية لا يعتمد عليه).
 *  - **لا سر ولا بصمة كلمة مرور**: الخادم لا يرسل عمود البصمة أصلًا،
 *    والواجهة لا تعرض إلا الحقول العامة.
 *  - **حالة كل شيء صريحة**: تحميل/معطّل بالعلم/مرفوض بلا صلاحية/خطأ —
 *    مع رسالة عربية تشرح السبب والخطوة التالية بدل شاشة صامتة.
 */

type RoleRecord = {
  id: string;
  label: string;
  description: string;
  permissions: string[];
  unknownPermissions: string[];
  builtin: boolean;
  updatedAt?: string;
};

type UserRecord = {
  id: string;
  username: string;
  displayName: string;
  roleId: string;
  roleLabel: string;
  roleBuiltin: boolean;
  status: "active" | "disabled";
  permissions: string[];
  unknownPermissions: string[];
  passwordSource: "bootstrap" | "panel";
  locked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
};

type AuditEntry = {
  id: number;
  action: string;
  entity: string;
  entityId: string;
  actor: string;
  createdAt: string;
  details: string;
};

type Snapshot = {
  actor: { id: string; username: string; roleLabel: string; mode: string; wildcard: boolean; permissions: string[] };
  can: { write: boolean; audit: boolean; wildcard: boolean };
  catalog: {
    permissions: string[];
    labels: Record<string, string>;
    groups: { id: string; label: string; permissions: string[] }[];
    enforcement: Record<string, string>;
    wildcard: string;
  };
  counts: { roles: number; users: number; activeUsers: number; rbacWriters: number };
  roles: RoleRecord[];
  users: UserRecord[];
};

async function jsonFetch(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

function permissionLabel(catalog: Snapshot["catalog"], permission: string) {
  if (permission === catalog.wildcard) return "كل الصلاحيات (*)";
  return catalog.labels[permission] ?? permission;
}

function togglePermission(list: string[], permission: string) {
  return list.includes(permission) ? list.filter((p) => p !== permission) : [...list, permission];
}

function PermissionPicker({
  catalog,
  value,
  onChange,
}: {
  catalog: Snapshot["catalog"];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {catalog.groups.map((group) => (
        <div key={group.id}>
          <div className="admin-kicker">{group.label}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
            {group.permissions.map((permission) => (
              <label key={permission} className="chip" style={{ display: "inline-flex", gap: 6, cursor: "pointer" }} title={catalog.enforcement[permission] ?? ""}>
                <input type="checkbox" checked={value.includes(permission)} onChange={() => onChange(togglePermission(value, permission))} />
                {permissionLabel(catalog, permission)}
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PermissionChips({ catalog, permissions }: { catalog: Snapshot["catalog"]; permissions: string[] }) {
  if (!permissions.length) return <span className="admin-muted">بلا صلاحيات</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {permissions.map((p) => (
        <span key={p} className="chip" title={catalog.enforcement[p] ?? ""}>
          {permissionLabel(catalog, p)}
        </span>
      ))}
    </div>
  );
}

export default function PermissionsPanel() {
  const [state, setState] = useState<"loading" | "disabled" | "forbidden" | "error" | "ready">("loading");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [showAudit, setShowAudit] = useState(false);

  const [newRole, setNewRole] = useState({ id: "", label: "", description: "", permissions: [] as string[] });
  const [editingRole, setEditingRole] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState({ label: "", description: "", permissions: [] as string[] });

  const [newUser, setNewUser] = useState({ username: "", displayName: "", roleId: "support", password: "" });
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [userDraft, setUserDraft] = useState({ roleId: "", status: "active" as "active" | "disabled", password: "" });

  const [selfPassword, setSelfPassword] = useState({ current: "", next: "" });

  const load = useCallback(async () => {
    const { ok, status, data } = await jsonFetch("/api/admin/rbac");
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
      setMsg(data?.error ?? "لا تملك صلاحية «عرض الأدوار والمستخدمين».");
      return;
    }
    if (!ok) {
      setState("error");
      setMsg(data?.error ?? "تعذر تحميل لوحة الصلاحيات.");
      return;
    }
    setSnapshot(data as Snapshot);
    setState("ready");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(url: string, init: RequestInit, successMsg: string) {
    setBusy(true);
    setMsg("");
    try {
      const { ok, data } = await jsonFetch(url, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
      });
      if (!ok) {
        setMsg(`❌ ${data?.error ?? "تعذر تنفيذ العملية"}`);
        return false;
      }
      setMsg(data?.reauth_required ? "✅ تم التغيير — أعد تسجيل الدخول بكلمة المرور الجديدة." : successMsg);
      await load();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function loadAudit() {
    const { ok, data } = await jsonFetch("/api/admin/rbac/audit?limit=50");
    if (ok) setAudit(data.entries as AuditEntry[]);
    setShowAudit(true);
  }

  if (state === "loading") return <div className="panel admin-loading">جارٍ تحميل لوحة الصلاحيات…</div>;

  if (state === "disabled") {
    return (
      <div className="panel">
        <div className="admin-kicker">لوحة الصلاحيات</div>
        <h3>الميزة مغلقة حاليًا</h3>
        <p className="admin-muted">
          النظام يعمل الآن بالوضع القديم: كلمة مرور إدارة مشتركة وجلسة واحدة بكل الصلاحيات. لوحة الصلاحيات
          (أدوار + مستخدمون + سجل تدقيق) تُفتح بعلم صريح:
        </p>
        <pre style={{ direction: "ltr", textAlign: "left", overflowX: "auto" }}>ENABLE_RBAC=true</pre>
        <p className="admin-muted">
          بعد تفعيل العلم وإعادة النشر، سجّل الدخول باسم <b dir="ltr">owner</b> وكلمة مرور الإدارة المشتركة (المعرّفة في
          متغيّرات بيئة الخادم) مرة واحدة لإنشاء المالك — تُغلق بوابة التهيئة نهائيًا بمجرد وجود مستخدم واحد — ثم غيّر
          كلمة المرور من هذه اللوحة وأنشئ بقية الحسابات.
        </p>
      </div>
    );
  }

  if (state === "forbidden") {
    return (
      <div className="panel">
        <div className="admin-kicker">لوحة الصلاحيات</div>
        <h3>لا تملك صلاحية العرض</h3>
        <div className="alert">{msg}</div>
        <p className="admin-muted">تحتاج صلاحية «عرض الأدوار والمستخدمين» (rbac:read) — اطلبها من مالك الحساب.</p>
      </div>
    );
  }

  if (state === "error" || !snapshot) {
    return (
      <div className="panel">
        <div className="admin-kicker">لوحة الصلاحيات</div>
        <div className="alert">{msg || "تعذر تحميل البيانات."}</div>
        <button className="btn btn-ghost" onClick={() => void load()}>إعادة المحاولة</button>
      </div>
    );
  }

  const self = snapshot.users.find((u) => u.id === snapshot.actor.id);
  const needsPasswordChange = self?.passwordSource === "bootstrap";

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="panel">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div className="admin-kicker">هويتك الحالية</div>
            <h3 style={{ marginBottom: 4 }}>
              {snapshot.actor.username} — {snapshot.actor.roleLabel}
            </h3>
            <div className="admin-muted">
              {snapshot.actor.wildcard ? "كل الصلاحيات (*)" : `${snapshot.actor.permissions.length} صلاحية`} · الوضع: {snapshot.actor.mode}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="chip">المستخدمون: {snapshot.counts.users}</span>
            <span className="chip">الفاعلون: {snapshot.counts.activeUsers}</span>
            <span className="chip">حائزو الحكم: {snapshot.counts.rbacWriters}</span>
            {snapshot.can.audit && <button className="chip" onClick={() => void loadAudit()}>سجل التدقيق</button>}
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <PermissionChips catalog={snapshot.catalog} permissions={snapshot.actor.wildcard ? [snapshot.catalog.wildcard] : snapshot.actor.permissions} />
        </div>
        {needsPasswordChange && (
          <div className="alert" style={{ marginTop: 12 }}>
            ⚠️ كلمة مرور هذا الحساب أُنشئت من كلمة مرور الإدارة المشتركة عند التهيئة — غيّرها من الأسفل، ثم حدّث متغيّر البيئة في الخادم.
          </div>
        )}
      </div>

      {msg && <div className="alert">{msg}</div>}

      <div className="panel">
        <div className="admin-kicker">الأدوار</div>
        <h3>الأدوار المدمجة والمخصصة</h3>
        <p className="admin-muted">
          الأدوار المدمجة (المالك/عمليات المتجر/خدمة العملاء/قراءة فقط) مصدرها الكود: غير قابلة للتعديل أو الحذف.
          الأدوار المخصصة قابلة للتعديل بالكامل، ولا يمكن حذف دور مُسنَد لمستخدمين.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>الدور</th>
                <th>الصلاحيات</th>
                <th>النوع</th>
                {snapshot.can.write && <th></th>}
              </tr>
            </thead>
            <tbody>
              {snapshot.roles.map((role) => (
                <tr key={role.id}>
                  <td>
                    <b>{role.label}</b>
                    <div className="admin-muted" dir="ltr" style={{ fontSize: ".78rem" }}>{role.id}</div>
                    {role.description && <div className="admin-muted" style={{ maxWidth: 260, whiteSpace: "normal", fontSize: ".82rem" }}>{role.description}</div>}
                  </td>
                  <td style={{ maxWidth: 420 }}>
                    <PermissionChips catalog={snapshot.catalog} permissions={role.permissions} />
                    {role.unknownPermissions.length > 0 && (
                      <div className="admin-muted" style={{ marginTop: 4, fontSize: ".78rem" }}>
                        ⚠️ صلاحيات غير معروفة في الكتالوج (لا تُمنح): <span dir="ltr">{role.unknownPermissions.join(", ")}</span>
                      </div>
                    )}
                  </td>
                  <td>{role.builtin ? "مدمج (محصّن)" : "مخصص"}</td>
                  {snapshot.can.write && (
                    <td>
                      {role.builtin ? (
                        <span className="admin-muted">—</span>
                      ) : editingRole === role.id ? (
                        <div style={{ display: "grid", gap: 6, minWidth: 220 }}>
                          <input value={roleDraft.label} onChange={(e) => setRoleDraft({ ...roleDraft, label: e.target.value })} placeholder="اسم الدور" />
                          <textarea rows={2} value={roleDraft.description} onChange={(e) => setRoleDraft({ ...roleDraft, description: e.target.value })} placeholder="الوصف" />
                          <PermissionPicker catalog={snapshot.catalog} value={roleDraft.permissions} onChange={(next) => setRoleDraft({ ...roleDraft, permissions: next })} />
                          <div style={{ display: "flex", gap: 6 }}>
                            <button
                              className="chip"
                              disabled={busy}
                              onClick={() =>
                                void act(
                                  "/api/admin/rbac/roles",
                                  { method: "PATCH", body: JSON.stringify({ role: { id: role.id, label: roleDraft.label, description: roleDraft.description, permissions: roleDraft.permissions } }) },
                                  "✅ تم تحديث الدور"
                                ).then(() => setEditingRole(null))
                              }
                            >
                              حفظ
                            </button>
                            <button className="chip" onClick={() => setEditingRole(null)}>إلغاء</button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            className="chip"
                            onClick={() => {
                              setEditingRole(role.id);
                              setRoleDraft({ label: role.label, description: role.description, permissions: role.permissions });
                            }}
                          >
                            تعديل
                          </button>
                          <button
                            className="chip"
                            disabled={busy}
                            onClick={() => {
                              if (!confirm(`حذف الدور ${role.label}؟`)) return;
                              void act(`/api/admin/rbac/roles?id=${encodeURIComponent(role.id)}`, { method: "DELETE" }, "✅ تم حذف الدور");
                            }}
                          >
                            حذف
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {snapshot.can.write && (
          <div style={{ marginTop: 14, borderTop: "1px solid var(--border, #e5e7eb)", paddingTop: 12 }}>
            <h4>إنشاء دور مخصص</h4>
            <div className="field">
              <label>المعرّف (لاتيني صغير — يُستخدم في الروابط والتدقيق)</label>
              <input dir="ltr" value={newRole.id} onChange={(e) => setNewRole({ ...newRole, id: e.target.value })} placeholder="warehouse" />
            </div>
            <div className="field">
              <label>الاسم المعروض</label>
              <input value={newRole.label} onChange={(e) => setNewRole({ ...newRole, label: e.target.value })} placeholder="أمين المخزن" />
            </div>
            <div className="field">
              <label>الوصف</label>
              <input value={newRole.description} onChange={(e) => setNewRole({ ...newRole, description: e.target.value })} />
            </div>
            <PermissionPicker catalog={snapshot.catalog} value={newRole.permissions} onChange={(next) => setNewRole({ ...newRole, permissions: next })} />
            <button
              className="btn btn-primary btn-block"
              disabled={busy || !newRole.id || !newRole.label}
              style={{ marginTop: 12 }}
              onClick={() =>
                void act(
                  "/api/admin/rbac/roles",
                  { method: "POST", body: JSON.stringify({ role: { id: newRole.id, label: newRole.label, description: newRole.description, permissions: newRole.permissions } }) },
                  "✅ تم إنشاء الدور"
                ).then((ok) => ok && setNewRole({ id: "", label: "", description: "", permissions: [] }))
              }
            >
              إنشاء الدور
            </button>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="admin-kicker">المستخدمون</div>
        <h3>حسابات لوحة التحكم</h3>
        <p className="admin-muted">
          لا يُخزَّن ولا يُعاد أي نص لكلمة المرور أو بصمتها. تغيير الدور أو الحالة أو كلمة المرور يُبطل كل جلسات
          المستخدم فورًا (رفع إصدار التوكن).
        </p>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>المستخدم</th>
                <th>الدور</th>
                <th>الحالة</th>
                <th>آخر دخول</th>
                {snapshot.can.write && <th></th>}
              </tr>
            </thead>
            <tbody>
              {snapshot.users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <b dir="ltr">{user.username}</b>
                    <div className="admin-muted" style={{ fontSize: ".8rem" }}>{user.displayName || "—"}</div>
                    {user.passwordSource === "bootstrap" && <div className="admin-muted" style={{ fontSize: ".78rem" }}>كلمة المرور من التهيئة — يُستحسن تغييرها</div>}
                    {user.unknownPermissions.length > 0 && <div className="admin-muted" style={{ fontSize: ".78rem" }}>⚠️ صلاحيات غير معروفة في دوره</div>}
                  </td>
                  <td>
                    {editingUser === user.id ? (
                      <select value={userDraft.roleId} onChange={(e) => setUserDraft({ ...userDraft, roleId: e.target.value })}>
                        {snapshot.roles.map((r) => (
                          <option key={r.id} value={r.id}>{r.label}</option>
                        ))}
                      </select>
                    ) : (
                      <>
                        <b>{user.roleLabel}</b>
                        <div className="admin-muted" dir="ltr" style={{ fontSize: ".78rem" }}>{user.roleId}</div>
                      </>
                    )}
                  </td>
                  <td>
                    {editingUser === user.id ? (
                      <select value={userDraft.status} onChange={(e) => setUserDraft({ ...userDraft, status: e.target.value as "active" | "disabled" })}>
                        <option value="active">فعّال</option>
                        <option value="disabled">معطّل</option>
                      </select>
                    ) : (
                      <>
                        {user.status === "active" ? "فعّال" : "معطّل"}
                        {user.locked && <div className="admin-muted" style={{ fontSize: ".78rem" }}>مقفل مؤقتًا بعد محاولات فاشلة</div>}
                      </>
                    )}
                  </td>
                  <td>{user.lastLoginAt ? String(user.lastLoginAt).slice(0, 16) : "—"}</td>
                  {snapshot.can.write && (
                    <td>
                      {editingUser === user.id ? (
                        <div style={{ display: "grid", gap: 6, minWidth: 200 }}>
                          <input type="password" placeholder="كلمة مرور جديدة (اختياري)" value={userDraft.password} onChange={(e) => setUserDraft({ ...userDraft, password: e.target.value })} autoComplete="new-password" />
                          <div style={{ display: "flex", gap: 6 }}>
                            <button
                              className="chip"
                              disabled={busy}
                              onClick={() =>
                                void act(
                                  "/api/admin/rbac/users",
                                  {
                                    method: "PATCH",
                                    body: JSON.stringify({
                                      user: {
                                        id: user.id,
                                        roleId: userDraft.roleId,
                                        status: userDraft.status,
                                        ...(userDraft.password ? { password: userDraft.password } : {}),
                                      },
                                    }),
                                  },
                                  "✅ تم تحديث المستخدم"
                                ).then((ok) => {
                                  if (ok) {
                                    setEditingUser(null);
                                    setUserDraft({ roleId: "", status: "active", password: "" });
                                  }
                                })
                              }
                            >
                              حفظ
                            </button>
                            <button className="chip" onClick={() => setEditingUser(null)}>إلغاء</button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            className="chip"
                            onClick={() => {
                              setEditingUser(user.id);
                              setUserDraft({ roleId: user.roleId, status: user.status, password: "" });
                            }}
                          >
                            تعديل
                          </button>
                          <button
                            className="chip"
                            disabled={busy}
                            onClick={() => {
                              if (!confirm(`حذف المستخدم ${user.username}؟`)) return;
                              void act(`/api/admin/rbac/users?id=${encodeURIComponent(user.id)}`, { method: "DELETE" }, "✅ تم حذف المستخدم");
                            }}
                          >
                            حذف
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {snapshot.can.write && (
          <div style={{ marginTop: 14, borderTop: "1px solid var(--border, #e5e7eb)", paddingTop: 12 }}>
            <h4>إضافة مستخدم</h4>
            <div className="field">
              <label>اسم المستخدم (لاتيني صغير)</label>
              <input dir="ltr" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} autoComplete="off" />
            </div>
            <div className="field">
              <label>الاسم المعروض</label>
              <input value={newUser.displayName} onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })} />
            </div>
            <div className="field">
              <label>الدور</label>
              <select value={newUser.roleId} onChange={(e) => setNewUser({ ...newUser, roleId: e.target.value })}>
                {snapshot.roles.map((r) => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>كلمة مرور مبدئية (12 حرفًا على الأقل)</label>
              <input type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} autoComplete="new-password" />
            </div>
            <button
              className="btn btn-primary btn-block"
              disabled={busy || !newUser.username || newUser.password.length < 12}
              onClick={() =>
                void act(
                  "/api/admin/rbac/users",
                  { method: "POST", body: JSON.stringify({ user: { ...newUser } }) },
                  "✅ تم إنشاء المستخدم"
                ).then((ok) => ok && setNewUser({ username: "", displayName: "", roleId: "support", password: "" }))
              }
            >
              إنشاء المستخدم
            </button>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="admin-kicker">أمان الحساب</div>
        <h3>تغيير كلمة مروري</h3>
        <p className="admin-muted">
          متاح لكل مستخدم بلا حاجة لصلاحية الحكم، وبشرط إدخال كلمة المرور الحالية. بعد التغيير تُبطل كل الجلسات
          وتحتاج إعادة الدخول.
        </p>
        <div className="field">
          <label>كلمة المرور الحالية</label>
          <input type="password" value={selfPassword.current} onChange={(e) => setSelfPassword({ ...selfPassword, current: e.target.value })} autoComplete="current-password" />
        </div>
        <div className="field">
          <label>كلمة المرور الجديدة (12 حرفًا على الأقل)</label>
          <input type="password" value={selfPassword.next} onChange={(e) => setSelfPassword({ ...selfPassword, next: e.target.value })} autoComplete="new-password" />
        </div>
        <button
          className="btn btn-ghost btn-block"
          disabled={busy || selfPassword.next.length < 12 || !selfPassword.current}
          onClick={() =>
            void act(
              "/api/admin/rbac/users",
              { method: "PATCH", body: JSON.stringify({ user: { id: snapshot.actor.id, password: selfPassword.next, currentPassword: selfPassword.current } }) },
              "✅ تم تغيير كلمة المرور"
            ).then((ok) => ok && setSelfPassword({ current: "", next: "" }))
          }
        >
          تغيير كلمة المرور
        </button>
      </div>

      {showAudit && (
        <div className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3>سجل التدقيق (آخر 50 عملية)</h3>
            <button className="chip" onClick={() => setShowAudit(false)}>إغلاق</button>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>الوقت</th>
                  <th>الفاعل</th>
                  <th>العملية</th>
                  <th>الكيان</th>
                  <th>التفاصيل</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.createdAt.slice(0, 16)}</td>
                    <td dir="ltr">{entry.actor}</td>
                    <td dir="ltr">{entry.action}</td>
                    <td>
                      <span dir="ltr">{entry.entity}</span>
                      {entry.entityId && <div className="admin-muted" dir="ltr" style={{ fontSize: ".78rem" }}>{entry.entityId}</div>}
                    </td>
                    <td style={{ maxWidth: 320, whiteSpace: "normal", fontSize: ".82rem" }} dir="ltr">{entry.details}</td>
                  </tr>
                ))}
                {audit.length === 0 && <tr><td colSpan={5} className="admin-muted">لا توجد عمليات مسجّلة بعد.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
