import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createClient } from "@libsql/client";
import {
  describeDatabaseError,
  describeTursoConfig,
  describeTursoToken,
  resolveTursoCredentials,
} from "../src/lib/db/turso-config";
import { MIGRATIONS } from "../src/lib/db/migrate";
import { migrateDbSchemaForTest } from "../src/lib/db";
import {
  classifyNetworkError,
  describeField,
  renderTursoBuildReport,
} from "../scripts/lib/turso-build-report.mjs";

/**
 * تقرير اتصال Turso في سجل البناء (`prebuild`).
 *
 * الحالة الحقيقية التي بُني لأجلها: فشل Turso في الإنتاج يظهر وقت التشغيل (503)
 * بينما سجل البناء أخضر دائمًا، فلا يرى المالك السبب ويحرق كل Redeploy حصة نشر
 * محدودة. التقرير يضع السبب في السجل نفسه، ولا يجوز أن يكسر البناء ولا أن يسرّب قيمة.
 * الرموز هنا اصطناعية وتُبنى وقت التشغيل — لا نص ثابت يشبه سرًّا حقيقيًا.
 */

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "build-turso-report.mjs");

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const makeJwt = (claims: Record<string, unknown> = {}, seed = "t") =>
  `${b64({ alg: "EdDSA", typ: "JWT" })}.${b64({ id: seed, ...claims })}.${createHash("sha512").update(seed + randomBytes(8).toString("hex")).digest("base64url")}`;
const inDays = (days: number) => Math.floor(Date.now() / 1000) + days * 86_400;

// ─────────────────────────── مطالبات الرمز ووصف الخطأ ───────────────────────────

describe("describeTursoToken — مطالبات الرمز بلا أي قيمة", () => {
  const NOW = Date.UTC(2026, 8, 29);
  const sec = (ms: number) => Math.floor(ms / 1000);

  test("read-write token with a future expiry", () => {
    const token = makeJwt({ a: "rw", exp: sec(NOW) + 30 * 86_400 + 60 });
    assert.deepEqual(describeTursoToken(token, NOW), { access: "rw", expires_in_days: 30 });
  });

  test("read-only token is identified (the app writes, so it will fail)", () => {
    assert.equal(describeTursoToken(makeJwt({ a: "ro", exp: sec(NOW) + 86_400 * 5 }), NOW).access, "ro");
  });

  test("expired token gives a negative day count", () => {
    const info = describeTursoToken(makeJwt({ a: "rw", exp: sec(NOW) - 3 * 86_400 - 10 }), NOW);
    assert.equal(info.expires_in_days, -4);
  });

  test("a token with no exp never expires (null), and unknown access is null", () => {
    assert.deepEqual(describeTursoToken(makeJwt({}), NOW), { access: null, expires_in_days: null });
    assert.equal(describeTursoToken(makeJwt({ a: "admin" }), NOW).access, null);
  });

  test("non-JWT, empty and malformed input never throw", () => {
    const none = { access: null, expires_in_days: null };
    for (const value of [undefined, "", "   ", "not-a-jwt", "a.b.c", "eyJ.@@@.sig", `${b64({})}.${Buffer.from("[1,2").toString("base64url")}.x`]) {
      assert.deepEqual(describeTursoToken(value, NOW), none, JSON.stringify(value));
    }
  });
});

describe("describeDatabaseError — اسم ورمز وHTTP وسبب الشبكة فقط", () => {
  test("extracts the HTTP status that separates a bad token (401) from a missing database (404)", () => {
    const error = Object.assign(new Error("SERVER_ERROR: Server returned HTTP status 401"), {
      name: "LibsqlError",
      code: "SERVER_ERROR",
    });
    assert.equal(describeDatabaseError(error), "LibsqlError, code=SERVER_ERROR, http=401");
  });

  test("adds the network cause code", () => {
    const error = Object.assign(new Error("fetch failed"), { name: "TypeError", cause: { code: "ENOTFOUND" } });
    assert.equal(describeDatabaseError(error), "TypeError, cause=ENOTFOUND");
  });

  test("never echoes the raw message (it can carry a URL or a credential)", () => {
    const secret = `libsql://${randomBytes(9).toString("hex")}-org.turso.io`;
    const label = describeDatabaseError(new Error(`connect failed for ${secret}`));
    assert.equal(label, "Error");
    assert.ok(!label.includes(secret));
    assert.equal(describeDatabaseError(null), "UnknownError");
    assert.equal(describeDatabaseError("boom"), "UnknownError");
  });
});

// ─────────────────────────── المُصيِّر النقيّ ───────────────────────────

const URL_OK = "libsql://abcde-elazamey.turso.io";
const diagnose = (url: string | undefined, token: string | undefined) =>
  describeTursoConfig(resolveTursoCredentials(url, token));
const text = (lines: string[]) => lines.join("\n");

describe("renderTursoBuildReport — ما يراه المالك في سجل البناء", () => {
  test("every line is greppable by the turso-check prefix", () => {
    const { lines } = renderTursoBuildReport({ diagnosis: diagnose(undefined, undefined), vercelEnv: "production" });
    assert.ok(lines.length >= 3);
    for (const line of lines) assert.ok(line.startsWith("turso-check: "), line);
  });

  test("unset outside production is a quiet skip, not an alarm", () => {
    for (const vercelEnv of [undefined, "preview", "development"]) {
      const { lines, status } = renderTursoBuildReport({ diagnosis: diagnose(undefined, undefined), vercelEnv });
      assert.equal(status, "skipped");
      assert.ok(!text(lines).includes("❌"), `${vercelEnv}`);
    }
  });

  test("unset in production is a problem that names both variables and the fix", () => {
    const { lines, status } = renderTursoBuildReport({ diagnosis: diagnose(undefined, undefined), vercelEnv: "production" });
    assert.equal(status, "problem");
    const out = text(lines);
    assert.match(out, /❌/);
    assert.match(out, /TURSO_DATABASE_URL/);
    assert.match(out, /TURSO_AUTH_TOKEN/);
    assert.match(out, /Production/);
    assert.match(out, /أعد النشر/);
  });

  test("a valid URL with a blank token reports TOKEN_MISSING, the hint, and the production-scope note", () => {
    const { lines, status } = renderTursoBuildReport({
      diagnosis: diagnose(URL_OK, "   \n"),
      vercelEnv: "production",
    });
    assert.equal(status, "problem");
    const out = text(lines);
    assert.match(out, /TOKEN_MISSING/);
    assert.match(out, /Full access/);
    assert.match(out, /مفعّلٌ لبيئة Production/);
    assert.match(out, /TURSO_AUTH_TOKEN: فارغ/);
  });

  test("near-miss variable names are listed with lengths, JSON-quoted so stray spaces are visible", () => {
    const { lines } = renderTursoBuildReport({
      diagnosis: diagnose(URL_OK, ""),
      vercelEnv: "production",
      nearMissNames: [
        { name: "TURSO_TOKEN", length: 300 },
        { name: "TURSO_AUTH_TOKEN ", length: 280 },
      ],
    });
    const out = text(lines);
    assert.match(out, /"TURSO_TOKEN" \(طول 300\)/);
    assert.match(out, /"TURSO_AUTH_TOKEN " \(طول 280\)/);
  });

  test("healthy: connection ok + schema ⇒ ok with the counts and a ✅ result", () => {
    const resolution = resolveTursoCredentials(URL_OK, makeJwt({ a: "rw", exp: inDays(90) }));
    const { lines, status } = renderTursoBuildReport({
      vercelEnv: "production",
      commit: "79fcd4a",
      diagnosis: describeTursoConfig(resolution),
      token: describeTursoToken(resolution.authToken),
      urlShape: { local: false, scheme: "libsql", kind: "Turso", hostMasked: "abc…turso.io", hostLength: 28 },
      connection: { ok: true, verdict: "نجح (HTTP 200)", ms: 120 },
      schema: { hasProducts: true, products: 12, appliedMigrations: 4, expectedMigrations: 4 },
    });
    assert.equal(status, "ok");
    const out = text(lines);
    assert.match(out, /الالتزام: 79fcd4a/);
    assert.match(out, /صلاحية Full access/);
    assert.match(out, /ينتهي بعد (89|90) يومًا/);
    assert.match(out, /الاتصال: ✅ نجح \(HTTP 200\) \(120ms\)/);
    assert.match(out, /products ✓ \(12 صفًا\) · الهجرات المطبقة 4 من 4/);
    assert.match(out, /النتيجة: ✅/);
    assert.ok(!out.includes("❌"));
  });

  test("a fresh database (no tables yet) is explained, not treated as a failure", () => {
    const resolution = resolveTursoCredentials(URL_OK, makeJwt({ a: "rw" }));
    const { lines, status } = renderTursoBuildReport({
      diagnosis: describeTursoConfig(resolution),
      connection: { ok: true, verdict: "نجح (HTTP 200)", ms: 5 },
      schema: { hasProducts: false, products: null, appliedMigrations: null, expectedMigrations: 4 },
    });
    assert.equal(status, "ok");
    assert.match(text(lines), /لم تُنشأ بعد — سيُنشئها التطبيق/);
  });

  test("each connection failure kind gets its own concrete action (and no misleading scope note)", () => {
    const resolution = resolveTursoCredentials(URL_OK, makeJwt({ a: "rw" }));
    const cases: [string, RegExp][] = [
      ["unauthorized", /Create token \(Full access\)/],
      ["not-found", /حُذفت أو أُعيدت تسميتها/],
      ["bad-request", /بلا مسار ولا معاملات/],
      ["network", /لا يصل إلى خادم Turso/],
    ];
    for (const [kind, expected] of cases) {
      const { lines, status } = renderTursoBuildReport({
        vercelEnv: "production",
        diagnosis: describeTursoConfig(resolution),
        connection: { ok: false, verdict: "فشل", ms: 1, kind: kind as "unauthorized" },
      });
      assert.equal(status, "problem", kind);
      const out = text(lines);
      assert.match(out, expected, kind);
      assert.ok(!out.includes("مفعّلٌ لبيئة Production"), `scope note must not appear for a connection failure (${kind})`);
    }
  });

  test("automatic repairs are listed in Arabic so the owner fixes the pasted value", () => {
    const resolution = resolveTursoCredentials(`"${URL_OK}"`, makeJwt({ a: "rw" }));
    const diagnosis = describeTursoConfig(resolution);
    assert.equal(diagnosis.status, "repaired");
    const { lines } = renderTursoBuildReport({
      diagnosis,
      connection: { ok: true, verdict: "نجح (HTTP 200)", ms: 1 },
    });
    assert.match(text(lines), /إصلاح آلي طُبّق.*تنصيص\/زينة أُزيلت/);
  });

  test("a read-only or expired token is a problem even though the connection works", () => {
    const readOnly = resolveTursoCredentials(URL_OK, makeJwt({ a: "ro", exp: inDays(30) }));
    const a = renderTursoBuildReport({
      diagnosis: describeTursoConfig(readOnly),
      token: describeTursoToken(readOnly.authToken),
      connection: { ok: true, verdict: "نجح (HTTP 200)", ms: 1 },
    });
    assert.equal(a.status, "problem");
    assert.match(text(a.lines), /الرمز للقراءة فقط/);

    const expired = resolveTursoCredentials(URL_OK, makeJwt({ a: "rw", exp: inDays(-2) }));
    const b = renderTursoBuildReport({
      diagnosis: describeTursoConfig(expired),
      token: describeTursoToken(expired.authToken),
      connection: { ok: true, verdict: "نجح (HTTP 200)", ms: 1 },
    });
    assert.equal(b.status, "problem");
    assert.match(text(b.lines), /منتهي الصلاحية/);
  });

  test("a local file database is fine for dev, a problem in production (ephemeral filesystem)", () => {
    const diagnosis = diagnose("file:/tmp/dev.db", undefined);
    const input = {
      diagnosis,
      urlShape: { local: true, scheme: "file", kind: "محلي", hostMasked: "—", hostLength: 0 },
      connection: { ok: true, verdict: "قاعدة محلية", ms: 0 },
    };
    const dev = renderTursoBuildReport({ ...input, vercelEnv: undefined });
    assert.equal(dev.status, "ok");
    assert.match(text(dev.lines), /ℹ️ قاعدة محلية/);

    const prod = renderTursoBuildReport({ ...input, vercelEnv: "production" });
    assert.equal(prod.status, "problem");
    assert.match(text(prod.lines), /لن تُحفظ الطلبات/);
  });

  test("missing connection data is reported as 'not judged', never as success", () => {
    const { lines, status } = renderTursoBuildReport({ diagnosis: diagnose(URL_OK, makeJwt()), connection: null });
    assert.equal(status, "skipped");
    assert.ok(!text(lines).includes("✅ Turso يستجيب"));
  });

  test("the renderer only ever sees shapes: field descriptions carry kind and length, never values", () => {
    const token = makeJwt({ a: "rw" });
    const resolution = resolveTursoCredentials(URL_OK, token);
    const described = `${describeField(resolution.urlField)} | ${describeField(resolution.tokenField)}`;
    assert.match(described, /رابط libsql \(طول 32\)/);
    assert.match(described, /رمز JWT \(طول \d+\)/);
    assert.ok(!described.includes(token) && !described.includes("abcde"));
    assert.equal(describeField(undefined), "فارغ");
    assert.equal(describeField({ length: 0, lines: 0, kinds: [] }), "فارغ");
  });
});

describe("classifyNetworkError — جمل ثابتة لا نص خام", () => {
  const make = (code: string | undefined, message: string, name = "TypeError") =>
    Object.assign(new Error(message), { name, cause: code ? { code } : undefined });

  test("maps the common causes to fixed Arabic sentences", () => {
    assert.match(classifyNetworkError(make("ENOTFOUND", "fetch failed")), /DNS/);
    assert.match(classifyNetworkError(make("ECONNREFUSED", "fetch failed")), /رُفض الاتصال/);
    assert.match(classifyNetworkError(make(undefined, "The operation was aborted due to timeout", "TimeoutError")), /انتهت مهلة/);
    assert.match(classifyNetworkError(make("ECONNRESET", "fetch failed")), /انقطع الاتصال/);
    assert.match(classifyNetworkError(make("DEPTH_ZERO_SELF_SIGNED_CERT", "self signed certificate")), /TLS/);
    assert.match(classifyNetworkError(new Error("???")), /تعذّر الوصول/);
  });

  test("never echoes the raw message (it can carry the host)", () => {
    const host = `${randomBytes(8).toString("hex")}-org.turso.io`;
    const out = classifyNetworkError(make("ENOTFOUND", `getaddrinfo ENOTFOUND ${host}`));
    assert.ok(!out.includes(host));
  });
});

// ─────────────────────────── السكربت نفسه (عملية فرعية) ───────────────────────────

interface Run {
  code: number | null;
  out: string;
}

/** بيئة نظيفة كليًا: لا تسرّب قيم Turso الحقيقية إن وُجدت في بيئة الاختبار. */
const cleanEnv = (extra: Record<string, string> = {}) =>
  ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...extra }) as unknown as NodeJS.ProcessEnv;

/** يشغّل السكربت ببيئة نظيفة كليًا. */
function runScript(env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { cwd: ROOT, env: cleanEnv(env) });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
  });
}

/** خادم يحاكي libSQL (Hrana عبر HTTP): يردّ بحالة ثابتة على كل طلب. */
async function fakeLibsql(status: number, body: string) {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url} auth=${req.headers.authorization ? "yes" : "no"}`);
    req.resume();
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function assertClean(out: string, secrets: string[]) {
  for (const secret of secrets) assert.ok(!out.includes(secret), "the report leaked a secret value");
  for (const line of out.split("\n").filter(Boolean)) assert.ok(line.startsWith("turso-check: "), line);
}

describe("scripts/build-turso-report — لا يكسر البناء ولا يسرّب", () => {
  test("no Turso values (CI, previews): exit 0 and a single quiet line", async () => {
    const { code, out } = await runScript({ FOO: "1" });
    assert.equal(code, 0);
    assert.match(out, /لا قيم Turso في هذه البيئة/);
    assert.ok(!out.includes("❌"));
  });

  test("production with nothing configured: exit 0 (never fails the build) but says so loudly", async () => {
    const { code, out } = await runScript({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: "bdd7376d1da7496721a7b1465e69266c0f61066f" });
    assert.equal(code, 0);
    assert.match(out, /البيئة: production · الالتزام: bdd7376/);
    assert.match(out, /❌ لا رابط Turso في بيئة Production/);
  });

  test("the real production symptom: valid URL + blank token ⇒ TOKEN_MISSING, no network, no leak", async () => {
    const host = `${randomBytes(6).toString("hex")}-${randomBytes(4).toString("hex")}`;
    const url = `libsql://${host}.turso.io`;
    const stray = makeJwt({ a: "rw" }, "stray");
    const { code, out } = await runScript({
      VERCEL_ENV: "production",
      TURSO_DATABASE_URL: url,
      TURSO_AUTH_TOKEN: "   ",
      TURSO_TOKEN: stray,
    });
    assert.equal(code, 0);
    assert.match(out, /TOKEN_MISSING/);
    assert.match(out, /"TURSO_TOKEN" \(طول \d+\)/);
    assertClean(out, [url, host, stray]);
  });

  test("the server answers 401: the verdict names the token and the action, without leaking it", async () => {
    const server = await fakeLibsql(401, '{"error":"empty JWT token"}');
    const token = makeJwt({ a: "rw", exp: inDays(60) }, "rejected");
    try {
      const { code, out } = await runScript({ VERCEL_ENV: "production", TURSO_DATABASE_URL: server.url, TURSO_AUTH_TOKEN: token });
      assert.equal(code, 0);
      assert.match(out, /الاتصال: ❌ الرمز مرفوض أو غير كافٍ \(HTTP 401\)/);
      assert.match(out, /Create token \(Full access\)/);
      assert.match(out, /صلاحية Full access/);
      assert.deepEqual(server.requests, ["POST /v2/pipeline auth=yes"]);
      assertClean(out, [token, server.url]);
    } finally {
      await server.close();
    }
  });

  test("the server answers 404: the verdict says the database name is wrong", async () => {
    const server = await fakeLibsql(404, '{"error":"database not found"}');
    const token = makeJwt({ a: "rw" }, "nf");
    try {
      const { code, out } = await runScript({ TURSO_DATABASE_URL: server.url, TURSO_AUTH_TOKEN: token });
      assert.equal(code, 0);
      assert.match(out, /HTTP 404/);
      assert.match(out, /انسخ الرابط من Turso/);
      assertClean(out, [token, server.url]);
    } finally {
      await server.close();
    }
  });

  test("a self-hosted libsql:// URL with ?tls=0 is probed over http, not https", async () => {
    const server = await fakeLibsql(401, '{"error":"unauthorized"}');
    const token = makeJwt({ a: "rw" }, "tls0");
    const url = `libsql://127.0.0.1:${new URL(server.url).port}?tls=0`;
    try {
      const { code, out } = await runScript({ TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: token });
      assert.equal(code, 0);
      assert.match(out, /HTTP 401/, "a TLS handshake error here would be a false alarm");
      assert.deepEqual(server.requests, ["POST /v2/pipeline auth=yes"]);
      assertClean(out, [token, url]);
    } finally {
      await server.close();
    }
  });

  test("an error body that echoes the token is redacted before it reaches the log", async () => {
    const token = makeJwt({ a: "rw" }, "echo");
    const server = await fakeLibsql(400, `bad request for ${token}`);
    try {
      const { code, out } = await runScript({ TURSO_DATABASE_URL: server.url, TURSO_AUTH_TOKEN: token });
      assert.equal(code, 0);
      assert.match(out, /HTTP 400/);
      assertClean(out, [token, server.url]);
    } finally {
      await server.close();
    }
  });

  test("raw call ok but the libsql client fails: reported with class/code only", async () => {
    const server = await fakeLibsql(200, "this is not hrana json");
    const token = makeJwt({ a: "rw" }, "garbage");
    try {
      const { code, out } = await runScript({ TURSO_DATABASE_URL: server.url, TURSO_AUTH_TOKEN: token });
      assert.equal(code, 0);
      assert.match(out, /نجح النداء الخام وفشل عميل libsql \(/);
      assertClean(out, [token, server.url]);
    } finally {
      await server.close();
    }
  });

  test("nothing is listening: a fixed 'connection refused' sentence, exit 0", async () => {
    const probe = await fakeLibsql(200, "{}");
    const { url } = probe;
    await probe.close();
    const { code, out } = await runScript({ TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: makeJwt({ a: "rw" }, "refused") });
    assert.equal(code, 0);
    assert.match(out, /رُفض الاتصال/);
  });

  test("a migrated local database: counts products and applied migrations (read-only)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turso-report-"));
    const file = path.join(dir, "app.db");
    const client = createClient({ url: `file:${file}` });
    try {
      await migrateDbSchemaForTest(client);
      for (const id of ["p1", "p2"]) {
        await client.execute({
          sql: "INSERT INTO products (id,name,description,price,category,image,stock) VALUES (?,?,?,?,?,?,?)",
          args: [id, `n-${id}`, "d", 10, "c", "i", 5],
        });
      }
    } finally {
      client.close();
    }
    const before = fs.statSync(file).mtimeMs;
    const { code, out } = await runScript({ TURSO_DATABASE_URL: `file:${file}` });
    assert.equal(code, 0);
    assert.match(out, new RegExp(`products ✓ \\(2 صفًا\\) · الهجرات المطبقة ${MIGRATIONS.length} من ${MIGRATIONS.length}`));
    assert.equal(fs.statSync(file).mtimeMs, before, "the report must not write to the database");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a local path that does not exist is never created by the check", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turso-report-"));
    const file = path.join(dir, "ghost.db");
    const { code } = await runScript({ TURSO_DATABASE_URL: `file:${file}` });
    assert.equal(code, 0);
    assert.equal(fs.existsSync(file), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("hostile values (garbage, huge, invisible characters) still exit 0 and stay prefixed", async () => {
    const { code, out } = await runScript({
      VERCEL_ENV: "production",
      TURSO_DATABASE_URL: `\u200f"${"x".repeat(50_000)}"\u200b`,
      TURSO_AUTH_TOKEN: "<your-token>\n\n\t",
    });
    assert.equal(code, 0);
    assert.ok(out.includes("turso-check:"));
  });
});

describe("package.json prebuild — الفحص يُستدعى قبل البناء ولا يستطيع إسقاطه", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };

  test("prebuild runs the report, and `build` is still plain next build", () => {
    assert.match(pkg.scripts.prebuild, /scripts\/build-turso-report\.mjs/);
    assert.equal(pkg.scripts.build, "next build");
  });

  test("even if node itself cannot start the script, prebuild exits 0", () => {
    const result = spawnSync("sh", ["-c", pkg.scripts.prebuild], {
      cwd: ROOT,
      env: cleanEnv({ NODE_OPTIONS: "--require=/definitely/not/here.cjs" }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
  });
});
