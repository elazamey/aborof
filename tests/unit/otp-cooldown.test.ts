import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { requestIdentityChange, requestRecovery, startVerification } from "@/lib/identity";
import { createSqlIdentityRepo } from "@/lib/identity/sql";
import { applyMigrations } from "@/lib/migrations";
import type { User } from "@/lib/identity/types";
import { hashSecret, newId } from "@/lib/identity/otp";
import { normalizeEmail } from "@/lib/identity/normalize";

import { MemoryRepo } from "./helpers/memory-repo";

function makeUser(over: Partial<User> = {}): User {
  const email = normalizeEmail(over.email ?? "owner@test.local")!;
  return {
    id: newId(),
    email,
    emailNormalized: email,
    emailVerifiedAt: 1000,
    phone: "+201000000000",
    phoneNormalized: "+201000000000",
    phoneVerifiedAt: 1000,
    passwordHash: hashSecret("correct-password-123"),
    role: "owner",
    tenantId: null,
    createdAt: 0,
    updatedAt: 0,
    lastLoginAt: 1000,
    ...over,
  };
}

const noDeliver = async () => undefined;
const ctx = { ip: "10.0.0.9", requestId: "rid-cd" };

// ── P2#1: cooldown إعادة إرسال OTP — من حالة مستمرة (DB) وبشكل ذرّي ──

describe("P2#1 — acquireOtpCooldown (repo-level)", () => {
  it("يمنع ضمن النافذة ويعيد Retry-After المتبقي بدقة (ساعة محقونة)", async () => {
    const repo = new MemoryRepo();
    const r1 = await repo.acquireOtpCooldown("k", 1000, 60_000);
    expect(r1).toEqual({ ok: true, retryAfterMs: 0 });

    const r2 = await repo.acquireOtpCooldown("k", 2000, 60_000);
    expect(r2.ok).toBe(false);
    expect(r2.retryAfterMs).toBe(59_000); // 61000 - 2000
  });

  it("بعد انتهاء النافذة ينجح الإرسال من جديد", async () => {
    const repo = new MemoryRepo();
    expect((await repo.acquireOtpCooldown("k", 1000, 60_000)).ok).toBe(true);
    expect((await repo.acquireOtpCooldown("k", 61_000, 60_000)).ok).toBe(true);
    // عند حد النافذة بالضبط (expires_at <= now) مسموح
    expect((await repo.acquireOtpCooldown("k", 121_000, 60_000)).ok).toBe(true);
  });

  it("الطلبات المتزامنة → فائز واحد فقط (لا bypass للـcooldown)", async () => {
    const repo = new MemoryRepo();
    const results = await Promise.all(Array.from({ length: 50 }, () => repo.acquireOtpCooldown("k", 1000, 60_000)));
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok).length).toBe(49);
  });
});

describe("P2#1 — enforce في تدفقات الهوية (ساعة محقونة)", () => {
  it("startVerification: الثاني ضمن النافذة → 429 + Retry-After، وبعدها ينجح", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    let t = 1000;
    const call = () =>
      startVerification({
        repo,
        user,
        kind: "email",
        value: user.email,
        ctx,
        now: () => t,
        devOtpHint: true,
        deliverOtp: noDeliver,
      });

    expect((await call()).ok).toBe(true);
    t = 2000;
    const second = await call();
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(429);
      expect(second.retryAfterMs).toBe(59_000);
    }
    t = 61_000;
    expect((await call()).ok).toBe(true);
  });

  it("requestIdentityChange: cooldown لكل (مستخدم, نوع) ولا يمنع نوعًا آخر", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    let t = 1000;
    const callEmail = () =>
      requestIdentityChange({
        repo,
        user,
        kind: "email",
        newValue: "new@test.local",
        password: "correct-password-123",
        ctx,
        now: () => t,
        devOtpHint: true,
        deliverOtp: noDeliver,
      });

    expect((await callEmail()).ok).toBe(true);
    t = 2000;
    const second = await callEmail();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.status).toBe(429);

    // تغيير الهاتف نوع مختلف → لا يتأثر بـcooldown البريد
    const callPhone = () =>
      requestIdentityChange({
        repo,
        user,
        kind: "phone",
        newValue: "+201111111111",
        password: "correct-password-123",
        ctx,
        now: () => t,
        devOtpHint: true,
        deliverOtp: noDeliver,
      });
    expect((await callPhone()).ok).toBe(true);
  });

  it("requestRecovery: cooldown موحّد لكل بريد (موجود/غير موجود) دون تسريب الوجود", async () => {
    const repo = new MemoryRepo();
    const user = makeUser();
    await repo.createUser(user);
    let t = 1000;
    const call = (email: string) =>
      requestRecovery({ repo, email, ctx, now: () => t, devOtpHint: true, deliverOtp: noDeliver });

    // أول طلب لبريد موجود → نجاح (يُرسل OTP)
    expect((await call("owner@test.local")).ok).toBe(true);
    t = 2000;
    // ثاني طلب لنفس البريد → 429
    const second = await call("owner@test.local");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.status).toBe(429);

    // أول طلب لبريد غير موجود → نجاح موحّد (نفس سلوك الموجود — لا enumeration)
    expect((await call("ghost@test.local")).ok).toBe(true);
    t = 3000;
    // ثاني طلب للبريد غير الموجود → 429 موحّد أيضًا
    const ghostSecond = await call("ghost@test.local");
    expect(ghostSecond.ok).toBe(false);
    if (!ghostSecond.ok) expect(ghostSecond.status).toBe(429);

    // بعد انتهاء النافذة يعود الإرسال
    t = 62_000;
    expect((await call("owner@test.local")).ok).toBe(true);
  });
});

describe("P2#1 — SQL repo: atomicity عبر اتصالات متعددة", () => {
  it("UPSERT ذري واحد → فائز واحد حتى مع عميلين متزامنين (migration v6)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "otp-cd-"));
    const url = `file:${path.join(dir, "test.db")}`;
    const c1 = createClient({ url });
    const c2 = createClient({ url });
    try {
      await applyMigrations(c1);
      const repo1 = createSqlIdentityRepo(c1);
      const repo2 = createSqlIdentityRepo(c2);

      const results = await Promise.all([
        repo1.acquireOtpCooldown("k", 1000, 60_000),
        repo2.acquireOtpCooldown("k", 1000, 60_000),
        repo1.acquireOtpCooldown("k", 1000, 60_000),
        repo2.acquireOtpCooldown("k", 1000, 60_000),
      ]);
      expect(results.filter((r) => r.ok).length).toBe(1);

      // المتبقي في الخاسرين = 60_000 (نفس اللحظة)
      for (const r of results) if (!r.ok) expect(r.retryAfterMs).toBe(60_000);
    } finally {
      c1.close();
      c2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
