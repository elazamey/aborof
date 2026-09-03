import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  authenticateAdminRequest,
  createSessionRecord,
  ensureOwner,
  verifyOwnerCredentials,
  hashSecret,
} from "@/lib/identity";
import { createAdminSession, ADMIN_COOKIE } from "@/lib/auth";
import type { User } from "@/lib/identity/types";
import { MemoryRepo } from "./helpers/memory-repo";

const SECRET = "0123456789abcdef0123456789abcdef";

function seedOwner(repo: MemoryRepo, password = "admin-pass"): User {
  const u: User = {
    id: "owner-1",
    email: "owner@test.local",
    emailNormalized: "owner@test.local",
    emailVerifiedAt: null,
    phone: null,
    phoneNormalized: null,
    phoneVerifiedAt: null,
    passwordHash: hashSecret(password),
    role: "owner",
    tenantId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastLoginAt: null,
  };
  repo.users.set(u.id, u);
  return u;
}

function reqWithCookie(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `${ADMIN_COOKIE}=${token}`;
  return new Request("http://x/api/orders", { headers });
}

describe("A — authenticateAdminRequest (single authority)", () => {
  beforeEach(() => {
    process.env.ADMIN_SESSION_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.ADMIN_SESSION_SECRET;
  });

  it("يقبل جلسة نشطة (سجل sessions موجود وغير مُبطَل)", async () => {
    const repo = new MemoryRepo();
    const user = seedOwner(repo);
    const rawToken = createAdminSession();
    const session = await createSessionRecord({ repo, user, rawToken, now: Date.now });

    const res = await authenticateAdminRequest(reqWithCookie(rawToken), repo);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.sessionId).toBe(session.id);
  });

  it("يرفض بعد الإبطال (revoked_at) — حتى لو كان التوكن HMAC سليمًا", async () => {
    const repo = new MemoryRepo();
    const user = seedOwner(repo);
    const rawToken = createAdminSession();
    await createSessionRecord({ repo, user, rawToken, now: Date.now });
    await repo.revokeAllSessions(user.id); // محاكاة changePassword/تغيير الهوية/الاسترداد

    const res = await authenticateAdminRequest(reqWithCookie(rawToken), repo);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it("REGRESSION A: توكن HMAC صحيح بلا صف جلسة → 401 (لا تفويض بلا سجل)", async () => {
    const repo = new MemoryRepo();
    seedOwner(repo);
    const rawToken = createAdminSession(); // سليم التوقيع لكن لا يوجد صف sessions له

    const res = await authenticateAdminRequest(reqWithCookie(rawToken), repo);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it("يرفض بدون كوكي", async () => {
    const repo = new MemoryRepo();
    seedOwner(repo);
    const res = await authenticateAdminRequest(reqWithCookie(), repo);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it("يفشل مغلقًا (503) عندما تكون قاعدة البيانات غير متاحة", async () => {
    const res = await authenticateAdminRequest(reqWithCookie("anything"), null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(503);
  });
});

describe("B — مصدر الحقيقة الوحيد لكلمة المرور", () => {
  afterEach(() => {
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_EMAIL;
  });

  it("verifyOwnerCredentials يتحقق ضد users.password_hash فقط", () => {
    const repo = new MemoryRepo();
    const user = seedOwner(repo, "real-password");
    expect(verifyOwnerCredentials(user, "real-password")).toBe(true);
    expect(verifyOwnerCredentials(user, "wrong-password")).toBe(false);
    expect(verifyOwnerCredentials(null, "real-password")).toBe(false); // لا مالك
    expect(verifyOwnerCredentials(user, "")).toBe(false);
  });

  it("REGRESSION B: ensureOwner لا يُنشئ مالكًا ثانيًا بعد تغيير البريد (يبحث بالدور)", async () => {
    process.env.ADMIN_PASSWORD = "pw1";
    process.env.ADMIN_EMAIL = "owner@test.local";
    const repo = new MemoryRepo();
    const u1 = await ensureOwner(repo);

    // محاكاة تغيير البريد عبر Security Center (email_normalized يتغيّر)
    u1.email = "new@test.local";
    u1.emailNormalized = "new@test.local";
    await repo.updateUser(u1);

    const u2 = await ensureOwner(repo); // ADMIN_EMAIL القديم لم يعد يطابق البريد
    expect(u2.id).toBe(u1.id); // نفس المالك — لا إنشاء مالك ثانٍ
    expect(repo.users.size).toBe(1);
  });

  it("REGRESSION B: ensureOwner يستخدم ADMIN_PASSWORD كـ bootstrap فقط — لا يُحدَّث الهاش لاحقًا", async () => {
    process.env.ADMIN_PASSWORD = "bootstrap-pw";
    process.env.ADMIN_EMAIL = "owner@test.local";
    const repo = new MemoryRepo();

    const u1 = await ensureOwner(repo);
    expect(u1.passwordHash).toBeTruthy();
    expect(verifyOwnerCredentials(u1, "bootstrap-pw")).toBe(true);

    // تغيير البيئة لاحقًا لا يغيّر كلمة الدخول (المصدر الوحيد = الهاش المزروع)
    process.env.ADMIN_PASSWORD = "later-pw";
    const u2 = await ensureOwner(repo);
    expect(u2.id).toBe(u1.id);
    expect(verifyOwnerCredentials(u2, "bootstrap-pw")).toBe(true);
    expect(verifyOwnerCredentials(u2, "later-pw")).toBe(false);
  });
});
