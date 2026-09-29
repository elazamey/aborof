import { afterEach, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { db, getDbConfigDiagnosis, hasDB, setDbClientForTest } from "../src/lib/db";
import { DomainError } from "../src/lib/errors";

/**
 * سلوك `db()` مع قيم البيئة الحقيقية الشائعة الخطأ.
 *
 * السياق: بعد نشر PR #27 بقي المتجر يردّ 503 «إعداد الاتصال بقاعدة البيانات غير
 * صالح». هذه الاختبارات تثبت (١) أن القيم المزخرفة/الخفية/المتبادلة تُصلَح آليًا
 * فيعمل المتجر، (٢) أن ما لا يُصلَح يفشل مغلقًا بـ503 عام لا يكشف شيئًا للعميل،
 * و(٣) أن السجل يسمّي السبب بدقة (نوع القيمة وطولها لا القيمة) ومرة واحدة لا
 * إغراقًا — فيتحوّل اللغز إلى إجراء محدّد للمالك.
 * الرموز اصطناعية وتُبنى وقت التشغيل.
 */

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const JWT = `${b64({ alg: "EdDSA", typ: "JWT" })}.${b64({ a: "rw", id: "db-config-test" })}.${createHash("sha512")
  .update("db-config-test")
  .digest("base64url")}`;
const URL_OK = "libsql://abcde-elazamey.turso.io";

const ENV_KEYS = [
  "NODE_ENV",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "DIAGNOSTICS_ENABLED",
  "DIAGNOSTICS_KEY",
  "ADMIN_SESSION_SECRET",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
let saved: Partial<Record<EnvKey, string | undefined>> = {};

function setEnv(values: Partial<Record<EnvKey, string | undefined>>) {
  for (const key of ENV_KEYS) {
    const value = key in values ? values[key] : undefined;
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else Reflect.set(process.env, key, value);
  }
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  setDbClientForTest(null);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else Reflect.set(process.env, key, value);
  }
  setDbClientForTest(null);
  mock.restoreAll();
});

/** شظايا لا يجوز أن تظهر في أي سجل أو استجابة: الرمز بمقاطعه، اسم القاعدة، اسم المؤسسة. */
function assertNoSecrets(text: string, extra: string[] = []) {
  for (const fragment of [...JWT.split("."), "abcde", "elazamey", ...extra]) {
    assert.ok(!text.includes(fragment), `تسرّب «${fragment.slice(0, 14)}…»`);
  }
}

function lines(spy: { mock: { calls: { arguments: unknown[] }[] } }): string[] {
  return spy.mock.calls.map((call) => String(call.arguments[0]));
}

describe("db() — قيم قابلة للإصلاح تُشغّل المتجر", () => {
  test("invisible marks + quotes + KEY= prefixes are repaired; one value-free warning is logged", () => {
    setEnv({
      NODE_ENV: "production",
      TURSO_DATABASE_URL: `\u200F"${URL_OK}"\u200F`,
      TURSO_AUTH_TOKEN: `TURSO_AUTH_TOKEN=${JWT}\n`,
    });
    const warn = mock.method(console, "warn", () => {});
    const client = db();
    assert.ok(client, "يُبنى العميل بدل الفشل بـ503");
    assert.equal(db(), client, "العميل يُبنى مرة واحدة");
    assert.equal(hasDB(), true);

    const out = lines(warn);
    assert.equal(out.length, 1, "سطر واحد لا إغراق");
    const line = JSON.parse(out[0]);
    assert.equal(line.event, "db_config_repaired");
    assert.equal(line.level, "warn");
    assert.equal(line.status, "repaired");
    assert.ok(line.repairs.includes("invisible-chars-removed"));
    assert.ok(line.repairs.includes("decoration-stripped"));
    assertNoSecrets(out[0]);
  });

  test("swapped fields and a pasted .env block work", () => {
    setEnv({ NODE_ENV: "production", TURSO_DATABASE_URL: JWT, TURSO_AUTH_TOKEN: URL_OK });
    mock.method(console, "warn", () => {});
    assert.ok(db());

    setDbClientForTest(null);
    setEnv({
      NODE_ENV: "production",
      TURSO_DATABASE_URL: `TURSO_DATABASE_URL=${URL_OK}\nTURSO_AUTH_TOKEN=${JWT}`,
    });
    assert.ok(db());
    assert.deepEqual(getDbConfigDiagnosis().repairs.sort(), ["both-values-in-one-field", "token-from-url-field"]);
  });

  test("a dashboard URL with a valid token connects through the derived canonical host", () => {
    setEnv({
      NODE_ENV: "production",
      TURSO_DATABASE_URL: "https://app.turso.tech/elazamey/databases/abcde",
      TURSO_AUTH_TOKEN: JWT,
    });
    const warn = mock.method(console, "warn", () => {});
    assert.ok(db());
    const diagnosis = getDbConfigDiagnosis();
    assert.equal(diagnosis.status, "repaired");
    assert.deepEqual(diagnosis.repairs, ["dashboard-url-derived"]);
    assert.equal(JSON.parse(lines(warn)[0]).event, "db_config_repaired");
  });

  test("clean values log nothing", () => {
    setEnv({ NODE_ENV: "production", TURSO_DATABASE_URL: URL_OK, TURSO_AUTH_TOKEN: JWT });
    const warn = mock.method(console, "warn", () => {});
    const error = mock.method(console, "error", () => {});
    assert.ok(db());
    assert.equal(warn.mock.callCount() + error.mock.callCount(), 0);
    assert.equal(getDbConfigDiagnosis().status, "ok");
  });
});

describe("db() — ما لا يُصلَح يفشل مغلقًا ويُسمّى سببه", () => {
  test("JWT in the URL field: generic 503 to callers, precise value-free reason in the log (throttled)", () => {
    setEnv({ NODE_ENV: "production", TURSO_DATABASE_URL: JWT });
    const error = mock.method(console, "error", () => {});

    let thrown: unknown;
    try {
      db();
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof DomainError);
    assert.equal(thrown.code, "SERVICE_UNAVAILABLE");
    assert.equal(thrown.status, 503);
    assert.equal(thrown.safeMessage, "إعداد الاتصال بقاعدة البيانات غير صالح.");
    assertNoSecrets(thrown.safeMessage);
    const details = thrown.internalDetails as { turso_config: { problem: string; url_field: { kinds: string[] } } };
    assert.equal(details.turso_config.problem, "URL_NOT_FOUND");
    assert.deepEqual(details.turso_config.url_field.kinds, ["jwt"]);

    assert.throws(() => db(), DomainError);
    const out = lines(error);
    assert.equal(out.length, 1, "سطر التشخيص مرة كل دقيقة لا مع كل استدعاء");
    const line = JSON.parse(out[0]);
    assert.equal(line.event, "db_config_invalid");
    assert.equal(line.level, "error");
    assert.equal(line.problem, "URL_NOT_FOUND");
    assert.deepEqual(line.url_field.kinds, ["jwt"]);
    assert.deepEqual(line.token_field.kinds, []);
    assert.match(line.hint, /TURSO_DATABASE_URL/);
    assertNoSecrets(out[0]);
    assert.equal(hasDB(), true, "مضبوط لكنه غير صالح — ليس «غير مهيأ»");
  });

  test("a Turso URL with no token fails fast instead of calling the network", () => {
    setEnv({ NODE_ENV: "production", TURSO_DATABASE_URL: URL_OK, TURSO_AUTH_TOKEN: "" });
    const error = mock.method(console, "error", () => {});
    assert.throws(() => db(), (e: unknown) => e instanceof DomainError && e.code === "SERVICE_UNAVAILABLE");
    assert.equal(JSON.parse(lines(error)[0]).problem, "TOKEN_MISSING");
  });

  test("unset stays null (not configured), exactly as before", () => {
    setEnv({ NODE_ENV: "production" });
    assert.equal(db(), null);
    assert.equal(hasDB(), false);
    setEnv({ NODE_ENV: "production", TURSO_DATABASE_URL: "\u200F  ", TURSO_AUTH_TOKEN: JWT });
    assert.equal(db(), null);
  });
});

describe("GET /api/products — الاستجابة العامة لا تكشف شيئًا والسجل يسمّي السبب", () => {
  test("misconfigured production: 503 body/headers carry no value; the log carries kinds and reason", async () => {
    setEnv({ NODE_ENV: "production", TURSO_DATABASE_URL: JWT, TURSO_AUTH_TOKEN: JWT });
    const error = mock.method(console, "error", () => {});
    const { GET } = await import("../src/app/api/products/route");
    const res = await GET(new Request("http://x/api/products"));

    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string; code: string; request_id: string };
    assert.equal(body.code, "SERVICE_UNAVAILABLE");
    assert.equal(body.error, "إعداد الاتصال بقاعدة البيانات غير صالح.");
    assert.ok(body.request_id);
    assert.deepEqual(Object.keys(body).sort(), ["code", "error", "request_id"], "لا حقل تشخيص في الاستجابة العامة");
    assertNoSecrets(JSON.stringify(body) + [...res.headers].join(";"));

    const out = lines(error);
    assertNoSecrets(out.join("\n"));
    const apiLine = out.map((l) => JSON.parse(l)).find((l) => l.code === "SERVICE_UNAVAILABLE");
    assert.ok(apiLine, "سطر الخطأ المركزي موجود");
    assert.equal(apiLine.request_id, body.request_id, "الربط بالسجل عبر request_id");
    assert.equal(apiLine.details.turso_config.problem, "URL_NOT_FOUND");
    assert.deepEqual(apiLine.details.turso_config.url_field.kinds, ["jwt"]);
    assert.deepEqual(apiLine.details.turso_config.token_field.kinds, ["jwt"]);
  });

  test("repairable production config serves the catalog path without a config error", async () => {
    // خادم صوري يردّ 401: يثبت أن الإعداد المُصلَح وصل فعلًا إلى الشبكة بالرمز الصحيح،
    // وأن السجل يسمّي حالة HTTP (401 = رمز) دون أن يكتب الرمز أو العنوان.
    const seenAuth: string[] = [];
    const server = http.createServer((req, res) => {
      seenAuth.push(String(req.headers.authorization ?? ""));
      res.statusCode = 401;
      res.end("unauthorized");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      setEnv({
        NODE_ENV: "production",
        TURSO_DATABASE_URL: `\u200F'http://127.0.0.1:${port}'`,
        TURSO_AUTH_TOKEN: `Bearer ${JWT}`,
      });
      const error = mock.method(console, "error", () => {});
      mock.method(console, "warn", () => {});
      const { GET } = await import("../src/app/api/products/route");
      const res = await GET(new Request("http://x/api/products"));

      assert.equal(res.status, 503);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "قاعدة بيانات المتجر غير متاحة حاليًا.", "الإعداد سليم؛ الفشل من الخادم لا من الضبط");
      assert.ok(seenAuth.length > 0, "وصل الطلب إلى الخادم");
      assert.ok(seenAuth.every((h) => h === `Bearer ${JWT}`), "الرمز نُظِّف من الزخارف قبل الإرسال");

      const out = lines(error);
      assert.ok(out.some((l) => /db: products query failed \(LibsqlError.*http=401\)/.test(l)), out.join("\n"));
      assertNoSecrets(out.join("\n"), [String(port)]);
      assert.ok(!out.some((l) => l.includes("db_config_invalid")));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("/api/admin/diagnostics — وصف الإعداد لمن يملك مفتاح التشخيص فقط", () => {
  test("db_config exposes kinds/lengths/reason, never values", async () => {
    setEnv({
      NODE_ENV: "production",
      TURSO_DATABASE_URL: JWT,
      TURSO_AUTH_TOKEN: URL_OK,
      DIAGNOSTICS_ENABLED: "true",
      DIAGNOSTICS_KEY: "independent-diagnostics-key-0123456789",
    });
    mock.method(console, "warn", () => {});
    mock.method(console, "error", () => {});
    const { GET } = await import("../src/app/api/admin/diagnostics/route");

    const denied = await GET(new Request("http://x/api/admin/diagnostics"));
    assert.ok(denied.status === 401 || denied.status === 403, "بلا مفتاح لا تشخيص");
    assertNoSecrets(await denied.text());

    const res = await GET(
      new Request("http://x/api/admin/diagnostics", {
        headers: { "x-diagnostics-key": "independent-diagnostics-key-0123456789" },
      }),
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    const json = JSON.parse(text) as { db_configured: boolean; db_config: { status: string; repairs: string[]; hint: string } };
    assert.equal(json.db_configured, true);
    assert.equal(json.db_config.status, "repaired");
    assert.deepEqual(json.db_config.repairs.sort(), ["token-from-url-field", "url-from-token-field"]);
    assertNoSecrets(text);
  });
});
