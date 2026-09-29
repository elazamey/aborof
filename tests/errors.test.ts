import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DomainError,
  Errors,
  toErrorResponse,
  redactSecrets,
  type ErrorCode,
} from "../src/lib/errors/index";
import { getRequestId } from "../src/lib/errors/request-context";

describe("errors layer", () => {
  test("DomainError carries stable code and HTTP status", () => {
    const cases: [DomainError, ErrorCode, number][] = [
      [Errors.validationFailed(), "VALIDATION_FAILED", 422],
      [Errors.authInvalid(), "AUTH_INVALID", 401],
      [Errors.authRequired(), "AUTH_REQUIRED", 401],
      [Errors.rateLimited(30), "RATE_LIMITED", 429],
      [Errors.notFound(), "NOT_FOUND", 404],
      [Errors.conflict(), "CONFLICT", 409],
      [Errors.payloadTooLarge(), "PAYLOAD_TOO_LARGE", 413],
      [Errors.serviceUnavailable(), "SERVICE_UNAVAILABLE", 503],
      [Errors.internal(), "INTERNAL_ERROR", 500],
    ];
    for (const [err, code, status] of cases) {
      assert.equal(err.code, code);
      assert.equal(err.status, status);
    }
  });

  test("rate limit error includes Retry-After header and retry_after_seconds", () => {
    const { status, body, headers } = toErrorResponse(Errors.rateLimited(42), "req_test");
    assert.equal(status, 429);
    assert.equal(body.code, "RATE_LIMITED");
    assert.equal(body.retry_after_seconds, 42);
    assert.equal(headers?.["Retry-After"], "42");
    assert.equal(body.request_id, "req_test");
  });

  test("unknown error becomes generic 500 without leaking message or stack", () => {
    const leak = new Error("Turso connection failed: token=abc123secret at /secret/path");
    const { status, body } = toErrorResponse(leak, "req_x");
    assert.equal(status, 500);
    assert.equal(body.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(body).includes("Turso"), "must not leak provider message");
    assert.ok(!JSON.stringify(body).includes("abc123secret"), "must not leak token");
    assert.ok(!JSON.stringify(body).includes("/secret/path"), "must not leak stack path");
  });

  test("redactSecrets masks tokens and bearer credentials", () => {
    // تُبنى القيم في وقت التشغيل حتى لا تظهر أنماط أسرار حرفية في الملف
    // (الماسح الثابت يرفض وجود شكل مفتاح حقيقي حتى داخل اختبار).
    const geminiLike = "AIza" + "Sy" + "A".repeat(32) + "0";
    const groqLike = "gsk" + "_" + "a".repeat(32);
    const bearerLike = "Bearer " + "super.secret.token";
    const masked = redactSecrets(`key=${geminiLike} token=${groqLike} Authorization: ${bearerLike}`);
    assert.ok(!masked.includes(geminiLike));
    assert.ok(!masked.includes(groqLike));
    assert.ok(!masked.includes("super.secret.token"));
    // تأكد أن الإخفاء حدث فعلًا.
    assert.ok(masked.includes("[REDACTED"));
  });

  test("redactSecrets masks Vercel AI Gateway keys outside an Authorization header", () => {
    // البوابة قد ترد بالمفتاح داخل جسم الخطأ، فلا يكفي الاعتماد على نمط Bearer.
    const gatewayKey = "vck" + "_" + "a".repeat(40);
    const masked = redactSecrets(`upstream said: invalid key ${gatewayKey} for model openai/gpt-5.5`);
    assert.ok(!masked.includes(gatewayKey), "مفتاح vck_ يجب ألا يظهر في السجل");
    assert.ok(masked.includes("[REDACTED_VERCEL_KEY]"));
  });

  test("request id prefers incoming header, otherwise generates one", () => {
    const withHeader = getRequestId(new Request("http://x", { headers: { "x-request-id": "abc-123" } }));
    assert.equal(withHeader, "abc-123");
    const generated = getRequestId(new Request("http://x"));
    assert.match(generated, /^req_/);
  });

  test("safe response never contains a stack trace", () => {
    const { body } = toErrorResponse(new Error("boom\n    at /internal/file.ts:1:1"), "req_y");
    assert.doesNotMatch(JSON.stringify(body), /at \//);
  });
});
