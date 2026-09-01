import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { validateEnv } from "@/lib/env";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("environment contract (env.ts)", () => {
  beforeEach(() => {
    vi.stubEnv("TURSO_DATABASE_URL", "file:local.db");
    vi.stubEnv("ADMIN_SESSION_SECRET", SECRET);
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.TURSO_AUTH_TOKEN;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a valid file: configuration without a token", () => {
    expect(validateEnv()).toEqual([]);
  });

  it("requires TURSO_AUTH_TOKEN for remote Turso URLs", () => {
    process.env.TURSO_DATABASE_URL = "libsql://demo.turso.io";
    expect(validateEnv()).toContain("TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL is a remote Turso database");
    process.env.TURSO_AUTH_TOKEN = "secret-token";
    expect(validateEnv()).toEqual([]);
  });

  it("requires ADMIN_SESSION_SECRET of at least 32 chars", () => {
    delete process.env.ADMIN_SESSION_SECRET;
    expect(validateEnv().join("; ")).toContain("ADMIN_SESSION_SECRET");
    process.env.ADMIN_SESSION_SECRET = "too-short";
    expect(validateEnv().join("; ")).toContain("ADMIN_SESSION_SECRET");
  });

  it("fails startup (throws) in production when the contract is violated", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.TURSO_DATABASE_URL;
    expect(() => validateEnv()).toThrow(/Environment contract violated/);
  });

  it("only warns (no throw) in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.TURSO_DATABASE_URL;
    expect(() => validateEnv()).not.toThrow();
  });
});
