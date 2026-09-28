import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  isDiagnosticsEnabled,
  diagnosticsKeyMatches,
  isPasswordStrong,
  PASSWORD_POLICY,
  auditSecretConfiguration,
} from "../src/lib/secrets";

const KEYS = [
  "ADMIN_SESSION_SECRET",
  "ADMIN_PASSWORD",
  "DIAGNOSTICS_KEY",
  "DIAGNOSTICS_ENABLED",
  "NODE_ENV",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
];

function resetEnv() {
  for (const k of KEYS) delete process.env[k];
}

beforeEach(() => {
  resetEnv();
});

describe("secrets separation", () => {
  test("diagnostics disabled in production unless explicitly enabled", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.DIAGNOSTICS_KEY = "independent-diag-key-1234567890";
    assert.equal(isDiagnosticsEnabled(), false);

    process.env.DIAGNOSTICS_ENABLED = "true";
    assert.equal(isDiagnosticsEnabled(), true);
  });

  test("diagnostics key must be independent from session secret", () => {
    process.env.DIAGNOSTICS_ENABLED = "true";
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    const shared = "a".repeat(40);
    process.env.ADMIN_SESSION_SECRET = shared;
    process.env.DIAGNOSTICS_KEY = shared;
    // نفس المفتاح للغرضين يجب أن يُرفض.
    assert.equal(diagnosticsKeyMatches(shared), false);

    process.env.DIAGNOSTICS_KEY = "b".repeat(40);
    assert.equal(diagnosticsKeyMatches("b".repeat(40)), true);
    // محاولة استخدام سر الجلسة كمفتاح تشخيص تُرفض حتى لو كان مختلفًا عن المفتاح المضبوط.
    assert.equal(diagnosticsKeyMatches(shared), false);
  });

  test("password policy minimum is 12 and testable", () => {
    assert.equal(PASSWORD_POLICY.minLength, 12);
    assert.equal(isPasswordStrong("short"), false);
    assert.equal(isPasswordStrong("12345678901"), false);
    assert.equal(isPasswordStrong("correct-horse-battery"), true);
  });

  test("audit warns on weak password and shared diagnostics secret", () => {
    process.env.ADMIN_SESSION_SECRET = "x".repeat(40);
    process.env.ADMIN_PASSWORD = "weak";
    process.env.DIAGNOSTICS_ENABLED = "true";
    process.env.DIAGNOSTICS_KEY = "x".repeat(40); // shared with session
    const warnings = auditSecretConfiguration().map((w) => w.code);
    assert.ok(warnings.includes("ADMIN_PASSWORD_WEAK"));
    assert.ok(warnings.includes("DIAGNOSTICS_SHARED_WITH_SESSION"));
  });

  test("audit is clean for a correctly separated, strong configuration", () => {
    process.env.ADMIN_SESSION_SECRET = "session-secret-".padEnd(40, "s");
    process.env.ADMIN_PASSWORD = "a-strong-admin-password-123";
    process.env.DIAGNOSTICS_ENABLED = "true";
    process.env.DIAGNOSTICS_KEY = "diag-key-".padEnd(36, "d");
    process.env.TURSO_DATABASE_URL = "libsql://my-db-my-org.turso.io";
    process.env.TURSO_AUTH_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const warnings = auditSecretConfiguration();
    assert.deepEqual(warnings, []);
  });
});
