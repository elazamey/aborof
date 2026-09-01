import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  createAdminSession,
  verifyAdminSession,
  ADMIN_COOKIE,
  sessionMaxAge,
  isAdminConfigured,
  passwordMatches,
  isAdminRequest,
} from "@/lib/auth";

const SECRET = "0123456789abcdef0123456789abcdef";

function sign(payload: string) {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

describe("admin session (auth.ts)", () => {
  beforeEach(() => {
    process.env.ADMIN_SESSION_SECRET = SECRET;
    process.env.ADMIN_PASSWORD = "test-admin-password";
  });
  afterEach(() => {
    delete process.env.ADMIN_SESSION_SECRET;
    delete process.env.ADMIN_PASSWORD;
  });

  it("token round-trip: create → verify", () => {
    const token = createAdminSession();
    expect(verifyAdminSession(token)).toBe(true);
  });

  it("REGRESSION: token is cookie-safe by construction — URL-encoding changes nothing (the old `:` bug)", () => {
    // التصميم الجديد: Base64URL لا يحتاج أي URL-encoding، فلا يختلف
    // الرمز بين Set-Cookie وقراءة الكوكي — ونحمي ضد أي وسيط يرمّزه رغم ذلك.
    const token = createAdminSession();
    const encoded = encodeURIComponent(token);
    expect(encoded).toBe(token); // لا حاجة للترميز أصلاً
    expect(verifyAdminSession(encoded)).toBe(true);
    expect(verifyAdminSession(decodeURIComponent(token))).toBe(true);
  });

  it("rejects tampered signature", () => {
    const token = createAdminSession();
    const [payload] = token.split(".");
    const forged = `${payload}.${"A".repeat(43)}`;
    expect(verifyAdminSession(forged)).toBe(false);
  });

  it("rejects tampered payload", () => {
    const token = createAdminSession();
    const [, sig] = token.split(".");
    const forgedPayload = Buffer.from(`${Date.now()}:attacker`).toString("base64url");
    expect(verifyAdminSession(`${forgedPayload}.${sig}`)).toBe(false);
  });

  it("rejects expired sessions", () => {
    const old = Date.now() - (sessionMaxAge * 1000 + 60_000);
    const payload = Buffer.from(`${old}:expired`).toString("base64url");
    const token = `${payload}.${sign(payload)}`;
    expect(verifyAdminSession(token)).toBe(false);
  });

  it("rejects future-dated tokens (clock skew guard)", () => {
    const future = Date.now() + 10 * 60 * 1000;
    const payload = Buffer.from(`${future}:future`).toString("base64url");
    const token = `${payload}.${sign(payload)}`;
    expect(verifyAdminSession(token)).toBe(false);
  });

  it("rejects garbage / malformed tokens", () => {
    expect(verifyAdminSession(undefined)).toBe(false);
    expect(verifyAdminSession("")).toBe(false);
    expect(verifyAdminSession("not-a-token")).toBe(false);
    expect(verifyAdminSession("a.b.c")).toBe(false);
    expect(verifyAdminSession("!!!!.!!!!")).toBe(false);
    expect(verifyAdminSession("abc%zz.def")).toBe(false); // decodeURIComponent fails
  });

  it("isAdminRequest parses the cookie header", () => {
    const token = createAdminSession();
    const req = new Request("http://x/api/orders", {
      headers: { cookie: `other=1; ${ADMIN_COOKIE}=${token}` },
    });
    expect(isAdminRequest(req)).toBe(true);
    const bad = new Request("http://x/api/orders", {
      headers: { cookie: `${ADMIN_COOKIE}=forged.${"B".repeat(43)}` },
    });
    expect(isAdminRequest(bad)).toBe(false);
  });

  it("isAdminConfigured reflects env", () => {
    expect(isAdminConfigured()).toBe(true);
    delete process.env.ADMIN_PASSWORD;
    expect(isAdminConfigured()).toBe(false);
    delete process.env.ADMIN_SESSION_SECRET;
    expect(isAdminConfigured()).toBe(false);
  });

  it("passwordMatches is constant-time and exact", () => {
    process.env.ADMIN_PASSWORD = "correct-horse";
    expect(passwordMatches("correct-horse")).toBe(true);
    expect(passwordMatches("correct-horsf")).toBe(false);
    expect(passwordMatches("")).toBe(false);
    expect(passwordMatches("correct-horse-extra")).toBe(false);
  });

  it("token format is cookie-safe by construction (no characters that need encoding)", () => {
    const token = createAdminSession();
    const needsEncoding = /[^A-Za-z0-9\-_.~]/;
    expect(needsEncoding.test(token)).toBe(false);
  });
});
