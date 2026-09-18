import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateConfiguration,
  fingerprint,
  main,
  redact,
  runLiveChecks,
} from "../scripts/health-probe-dry-run.mjs";

/**
 * حراسة سياسة مجسّ الجاهزية:
 *  1) المفاتيح الاختيارية الغائبة ⇒ تحذير فقط، والفحص لا يكسر CI (exit 0).
 *  2) تكوين خاطئ (مفتاح مشوّه/رابط غير آمن/رابط بلا رمز) ⇒ فشل (exit 1).
 *  3) لا تخرج أي قيمة سرية في أي مخرج، لا نصًّا ولا في JSON.
 *  4) الوضع الحيّ لا ينادي مزودًا غير مُهيّأ أصلًا.
 */

const fakeGemini = "AIza" + "Sy" + "Z".repeat(30);
const fakeGroq = "gsk_" + "Q".repeat(30);
const fakeNim = "nvapi-" + "N".repeat(30);

describe("health probe dry-run policy", () => {
  test("an empty environment is ready with warnings only", () => {
    const report = evaluateConfiguration({});
    assert.equal(report.failures, 0);
    assert.ok(report.warnings >= 4);
    assert.ok(report.checks.every((c) => c.status === "warn" || c.status === "ok"));
  });

  test("well-formed keys pass every check", () => {
    const report = evaluateConfiguration({
      ENABLE_AI_AGENT: "true",
      ENABLE_MCP_TOOLS: "true",
      GEMINI_API_KEY: fakeGemini,
      GROQ_API_KEY: fakeGroq,
      NVIDIA_NIM_API_KEY: fakeNim,
      TURSO_DATABASE_URL: "libsql://db.turso.io",
      TURSO_AUTH_TOKEN: "t".repeat(30),
    });
    assert.equal(report.failures, 0);
    assert.equal(report.warnings, 0);
  });

  test("malformed keys and unsafe urls fail the probe", () => {
    const malformed = evaluateConfiguration({ GEMINI_API_KEY: "not-a-key", GROQ_API_KEY: "wrong" });
    assert.equal(malformed.failures, 2);

    const insecure = evaluateConfiguration({
      NVIDIA_NIM_API_KEY: fakeNim,
      NVIDIA_NIM_BASE_URL: "http://nim.internal/v1",
    });
    assert.equal(insecure.failures, 1);
    assert.match(insecure.checks.find((c) => c.name === "NVIDIA NIM")?.detail ?? "", /https/);
  });

  test("turso url without a token is a hard failure", () => {
    const report = evaluateConfiguration({ TURSO_DATABASE_URL: "libsql://db.turso.io" });
    assert.equal(report.failures, 1);
  });

  test("consistency warnings are advisory, never fatal", () => {
    const report = evaluateConfiguration({ ENABLE_MCP_TOOLS: "true", ENABLE_AI_AGENT: "false" });
    assert.equal(report.failures, 0);
    assert.ok(report.checks.some((c) => c.name === "الاتساق"));
  });

  test("suspicious allowlist names are reported as a warning", () => {
    const report = evaluateConfiguration({
      ENABLE_MCP_TOOLS: "true",
      MCP_ALLOWED_TOOLS: "search_products, DELETE; DROP",
    });
    assert.equal(report.failures, 0);
    assert.ok(report.checks.some((c) => c.name === "طبقة MCP" && c.status === "warn"));
  });
});

describe("no secret ever leaves the probe", () => {
  test("redaction and fingerprints never include the raw value", () => {
    const text = redact(`key=${fakeGemini} token=${fakeGroq} bearer=${fakeNim}`);
    for (const secret of [fakeGemini, fakeGroq, fakeNim]) {
      assert.ok(!text.includes(secret), "القيمة السرية يجب ألا تظهر");
      assert.ok(!fingerprint(secret).includes(secret), "البصمة يجب ألا تحمل القيمة");
    }
    assert.match(fingerprint(fakeNim), /nvapi-…/);
  });

  test("json output and printed report contain no raw secrets", async () => {
    const env = {
      GEMINI_API_KEY: fakeGemini,
      GROQ_API_KEY: fakeGroq,
      NVIDIA_NIM_API_KEY: fakeNim,
      TURSO_DATABASE_URL: "libsql://db.turso.io",
      TURSO_AUTH_TOKEN: "t".repeat(30),
    };
    const printed: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => printed.push(args.join(" "));
    let code = -1;
    try {
      code = await main(["--json"], env);
    } finally {
      console.log = original;
    }

    const output = printed.join("\n");
    for (const secret of [fakeGemini, fakeGroq, fakeNim]) assert.ok(!output.includes(secret));
    assert.equal(code, 0);
  });
});

describe("live checks skip unconfigured providers", () => {
  test("no provider key means no network call at all", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const results = await runLiveChecks({}, fakeFetch);
    assert.equal(calls, 0);
    assert.ok(results.every((r) => r?.status === "warn"));
  });

  test("configured providers are pinged and failures surface as errors", async () => {
    const seen: string[] = [];
    const fakeFetch = (async (url: string | URL) => {
      const target = String(url);
      seen.push(target);
      if (target.includes("api.groq.com")) return new Response("nope", { status: 401 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const results = await runLiveChecks(
      {
        GEMINI_API_KEY: fakeGemini,
        GROQ_API_KEY: fakeGroq,
        NVIDIA_NIM_API_KEY: fakeNim,
        TURSO_DATABASE_URL: "libsql://db.turso.io",
        TURSO_AUTH_TOKEN: "t".repeat(30),
      },
      fakeFetch
    );

    assert.equal(seen.length, 4);
    assert.ok(seen.some((u) => u.startsWith("https://generativelanguage.googleapis.com")));
    assert.ok(seen.some((u) => u.startsWith("https://api.groq.com")));
    assert.ok(seen.some((u) => u.startsWith("https://integrate.api.nvidia.com")));
    assert.ok(seen.some((u) => u.startsWith("https://db.turso.io")));

    const groqResult = results.find((r) => r?.name?.startsWith("Groq"));
    assert.equal(groqResult?.status, "fail");
    assert.ok(!String(groqResult?.detail).includes(fakeGroq));
  });

  test("main returns a non-zero code when configuration is broken", async () => {
    const printed: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => printed.push(args.join(" "));
    let code = -1;
    try {
      code = await main([], { TURSO_DATABASE_URL: "libsql://db.turso.io" });
    } finally {
      console.log = original;
    }
    assert.equal(code, 1);
    assert.match(printed.join("\n"), /مشكلة تكوين/);
  });
});
