import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createClient } from "@libsql/client";
import {
  describeTursoConfig,
  resolveTursoCredentials,
  type TursoCredentialResolution,
} from "../src/lib/db/turso-config";

/**
 * استخراج بيانات اتصال Turso من قيم البيئة الخام.
 *
 * الحالة الحقيقية التي بُنيت لأجلها: المتجر يسقط بـ503 «إعداد الاتصال بقاعدة
 * البيانات غير صالح» لأن قيمة الرابط أو الرمز لُصقت في Vercel بشكل يرفضه
 * `createClient` (أحرف اتجاه خفية، تنصيص، كتلة .env، حقلان متبادلان…).
 * الرموز هنا اصطناعية وتُبنى وقت التشغيل — لا نص ثابت يشبه سرًّا حقيقيًا.
 */

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const sign = (seed: string) => createHash("sha512").update(seed).digest("base64url");
const makeJwt = (seed: string, claims: Record<string, unknown> = {}) =>
  `${b64({ alg: "EdDSA", typ: "JWT" })}.${b64({ a: "rw", id: seed, ...claims })}.${sign(seed)}`;

const NOW = Date.UTC(2026, 8, 29);
const JWT = makeJwt("primary");
const OTHER_JWT = makeJwt("secondary");
const EXPIRED_JWT = makeJwt("expired", { exp: Math.floor(NOW / 1000) - 3600 });
const FUTURE_JWT = makeJwt("future", { exp: Math.floor(NOW / 1000) + 3600 });
const URL_OK = "libsql://abcde-elazamey.turso.io";
const resolve = (url: string | undefined, token: string | undefined) => resolveTursoCredentials(url, token, NOW);

function assertResolved(result: TursoCredentialResolution, repairs: string[] = []) {
  assert.equal(result.status, repairs.length ? "repaired" : "ok");
  assert.equal(result.url, URL_OK);
  assert.equal(result.authToken, JWT);
  assert.deepEqual([...result.repairs].sort(), [...repairs].sort());
}

describe("resolveTursoCredentials — قيم سليمة", () => {
  test("clean values pass through untouched", () => {
    assertResolved(resolve(URL_OK, JWT));
  });

  test("surrounding newline/space (Vercel stores the paste verbatim) is not a repair", () => {
    assertResolved(resolve(`${URL_OK}\n`, `  ${JWT}\r\n`));
  });

  test("https URL, regional host, trailing slash and scheme case are accepted as-is", () => {
    const https = resolve("https://abcde-elazamey.turso.io", JWT);
    assert.equal(https.status, "ok");
    assert.equal(https.url, "https://abcde-elazamey.turso.io");

    const regional = resolve("libsql://abcde-elazamey.aws-ap-northeast-1.turso.io", JWT);
    assert.equal(regional.status, "ok");
    assert.equal(regional.url, "libsql://abcde-elazamey.aws-ap-northeast-1.turso.io");

    assert.equal(resolve(`${URL_OK}/`, JWT).status, "ok");
    assert.equal(resolve("LIBSQL://abcde-elazamey.turso.io", JWT).url, URL_OK);
  });

  test("local/dev URLs keep working exactly as createClient accepts them", () => {
    for (const url of [":memory:", "file:./local.db", "file::memory:", "file::memory:?cache=shared", "file:///tmp/x.db"]) {
      const result = resolve(url, undefined);
      assert.equal(result.status, "ok", url);
      assert.equal(result.url, url);
    }
    // خادم sqld ذاتي الاستضافة: لا رمز، ولا مسار يُحذف، ومنفذ وtls يبقيان.
    assert.equal(resolve("http://127.0.0.1:8080", "").url, "http://127.0.0.1:8080");
    assert.equal(resolve("http://sqld:8080", "").status, "ok");
    assert.equal(resolve("libsql://localhost:8080?tls=0", "").url, "libsql://localhost:8080?tls=0");
    assert.equal(resolve("ws://127.0.0.1:8080", "").url, "ws://127.0.0.1:8080");
  });

  test("a non-JWT opaque token is passed along for self-hosted servers", () => {
    const result = resolve("http://127.0.0.1:8080", "abcdef0123456789abcdef");
    assert.equal(result.status, "ok");
    assert.equal(result.authToken, "abcdef0123456789abcdef");
  });
});

describe("resolveTursoCredentials — إصلاحات آلية", () => {
  test("invisible direction/zero-width marks from Arabic copy-paste are removed", () => {
    const invisible = ["\u200F", "\u200E", "\u200B", "\uFEFF", "\u00AD", "\u202B", "\u2066"];
    for (const mark of invisible) {
      assertResolved(resolve(`${mark}${URL_OK}${mark}`, `${mark}${JWT}${mark}`), ["invisible-chars-removed"]);
    }
    // داخل القيمة لا حولها.
    assertResolved(resolve(URL_OK.replace("://", `:/\u200B/`), JWT.slice(0, 30) + "\u200F" + JWT.slice(30)), [
      "invisible-chars-removed",
    ]);
  });

  test("quotes, backticks, guillemets, brackets, bold and sentence dots are stripped", () => {
    const wrappers: [string, string][] = [
      ['"', '"'], ["'", "'"], ["`", "`"], ["“", "”"], ["‘", "’"], ["«", "»"], ["<", ">"], ["(", ")"], ["**", "**"],
    ];
    for (const [open, close] of wrappers) {
      assertResolved(resolve(`${open}${URL_OK}${close}`, `${open}${JWT}${close}`), ["decoration-stripped"]);
    }
    assertResolved(resolve(`${URL_OK}.`, JWT), ["decoration-stripped"]);
    assertResolved(resolve(URL_OK, `Bearer ${JWT}`), ["decoration-stripped"]);
  });

  test("typographic dashes and Arabic punctuation copied from chat/Word do not break the host", () => {
    for (const dash of ["\u2010", "\u2011", "\u2013", "\u2014", "\u2212"]) {
      assertResolved(resolve(URL_OK.replace("abcde-elazamey", `abcde${dash}elazamey`), JWT), ["decoration-stripped"]);
    }
    for (const mark of ["\u060C", "\u061B", "\u061F", "\u06D4"]) {
      assertResolved(resolve(`${URL_OK}${mark}`, `${JWT}${mark}`), ["decoration-stripped"]);
    }
  });

  test("KEY= prefixes and export lines are stripped", () => {
    assertResolved(resolve(`TURSO_DATABASE_URL=${URL_OK}`, `TURSO_AUTH_TOKEN=${JWT}`), ["decoration-stripped"]);
    assertResolved(
      resolve(`export TURSO_DATABASE_URL="${URL_OK}"`, `export TURSO_AUTH_TOKEN='${JWT}'`),
      ["decoration-stripped"],
    );
  });

  test("a whole .env block pasted into ONE field yields both values", () => {
    const block = `TURSO_DATABASE_URL=${URL_OK}\nTURSO_AUTH_TOKEN=${JWT}`;
    assertResolved(resolve(block, undefined), ["token-from-url-field", "both-values-in-one-field"]);
    assertResolved(resolve(block.replace(/\n/g, "\r\n") + "\r\n", ""), ["token-from-url-field", "both-values-in-one-field"]);
    assertResolved(resolve("", block), ["url-from-token-field", "both-values-in-one-field"]);
    assertResolved(resolve(`${URL_OK} ${JWT}`, ""), ["token-from-url-field", "both-values-in-one-field"]);
  });

  test("swapped fields are swapped back", () => {
    assertResolved(resolve(JWT, URL_OK), ["url-from-token-field", "token-from-url-field"]);
  });

  test("a Turso dashboard URL is converted to the canonical connection URL", () => {
    const dashboard = "https://app.turso.tech/elazamey/databases/abcde";
    assertResolved(resolve(dashboard, JWT), ["dashboard-url-derived"]);
    assertResolved(resolve(`${dashboard}/settings`, JWT), ["dashboard-url-derived"]);
    // رابط اللوحة في خانة الرمز والرمز في خانة الرابط.
    assertResolved(resolve(JWT, dashboard), ["url-from-token-field", "dashboard-url-derived", "token-from-url-field"]);
    // إن وُجد رابط اتصال حقيقي فهو يُفضَّل على الاشتقاق.
    const both = resolve(dashboard, `${URL_OK}\n${JWT}`);
    assert.equal(both.url, URL_OK);
    assert.ok(!both.repairs.includes("dashboard-url-derived"));
  });

  test("a bare Turso host gets its scheme; turso:// is rewritten", () => {
    assertResolved(resolve("abcde-elazamey.turso.io", JWT), ["scheme-added"]);
    assertResolved(resolve("libsql:// abcde-elazamey.turso.io", JWT), ["scheme-added", "decoration-stripped"]);
    assert.equal(
      resolve("abcde-elazamey.aws-ap-northeast-1.turso.io", JWT).url,
      "libsql://abcde-elazamey.aws-ap-northeast-1.turso.io",
    );
    assertResolved(resolve("turso://abcde-elazamey.turso.io", JWT), ["scheme-rewritten"]);
  });

  test("path and unsupported query parameters are dropped; percent-encoding is decoded", () => {
    assertResolved(resolve(`${URL_OK}/v2/pipeline`, JWT), ["url-path-dropped"]);
    assertResolved(resolve(`${URL_OK}?secure=true#frag`, JWT), ["url-query-dropped"]);
    assertResolved(resolve("libsql%3A%2F%2Fabcde-elazamey.turso.io", JWT), ["decoration-stripped"]);
  });

  test("a token embedded in the URL query is extracted and removed from the URL", () => {
    assertResolved(resolve(`${URL_OK}?authToken=${JWT}`, ""), ["token-from-url-query"]);
    assertResolved(resolve(`${URL_OK}?authToken=${JWT}&secure=true`, undefined), ["token-from-url-query", "url-query-dropped"]);
    // رمز الحقل المخصّص يتقدّم على رمز الرابط.
    const preferred = resolve(`${URL_OK}?authToken=${OTHER_JWT}`, JWT);
    assert.equal(preferred.authToken, JWT);
  });

  test("a token hard-wrapped across lines by the copy source is rejoined", () => {
    const wrapped = JWT.replace(/(.{60})/g, "$1\n");
    assert.ok(wrapped.includes("\n"));
    assertResolved(resolve(URL_OK, wrapped), ["decoration-stripped"]);
  });

  test("hostile/pathological input is bounded and never hangs", () => {
    const started = Date.now();
    const result = resolve("a.".repeat(100_000), "b-".repeat(100_000));
    assert.equal(result.status, "invalid");
    assert.ok(Date.now() - started < 2_000, "المسح محدود بسقف طول");
  });

  test("among several tokens the first unexpired one wins", () => {
    const result = resolve(URL_OK, `${EXPIRED_JWT}\n${FUTURE_JWT}`);
    assert.equal(result.authToken, FUTURE_JWT);
    assert.equal(result.tokenExpired, false);
  });
});

describe("resolveTursoCredentials — ما لا يمكن إصلاحه", () => {
  test("JWT in the URL field and nothing else is invalid with a precise reason", () => {
    for (const token of ["", undefined, JWT, OTHER_JWT]) {
      const result = resolve(JWT, token);
      assert.equal(result.status, "invalid");
      assert.equal(result.problem, "URL_NOT_FOUND");
      assert.equal(result.url, undefined);
      assert.deepEqual(result.urlField.kinds, ["jwt"]);
      assert.match(describeTursoConfig(result).hint, /TURSO_DATABASE_URL يحمل رمزًا/);
    }
  });

  test("a bare database name cannot be turned into a URL", () => {
    const result = resolve("abcde", JWT);
    assert.equal(result.status, "invalid");
    assert.equal(result.problem, "URL_NOT_FOUND");
    assert.deepEqual(result.urlField.kinds, ["bare-name"]);
    assert.match(describeTursoConfig(result).hint, /اسم القاعدة فقط/);
  });

  test("placeholders copied from docs/.env.example are rejected, not connected to", () => {
    for (const [url, token] of [
      ["libsql://your-db-name-username.turso.io", "your_turso_token"],
      ["libsql://<db>-<org>.turso.io", JWT],
      ["<your-database-url>", JWT],
    ] as const) {
      const result = resolve(url, token);
      assert.equal(result.status, "invalid", url);
      assert.equal(result.problem, "URL_PLACEHOLDER", url);
    }
  });

  test("a Turso cloud URL without any token fails fast (no network call would succeed)", () => {
    for (const token of [undefined, "", "   "]) {
      const result = resolve(URL_OK, token);
      assert.equal(result.status, "invalid");
      assert.equal(result.problem, "TOKEN_MISSING");
    }
    // رابط لوحة + رابط اتصال بلا رمز (حالة tests/routes.test.ts).
    const routes = resolve("https://app.turso.tech/elazamey/databases/example", "libsql://example-elazamey.turso.io");
    assert.equal(routes.problem, "TOKEN_MISSING");
  });

  test("dashboard URLs without a database name, and unsupported schemes, are classified", () => {
    assert.equal(resolve("https://app.turso.tech/elazamey", JWT).problem, "URL_DASHBOARD_INCOMPLETE");
    assert.equal(resolve("https://app.turso.tech/elazamey/databases", JWT).problem, "URL_DASHBOARD_INCOMPLETE");
    assert.equal(resolve("postgres://user@host/db", JWT).problem, "URL_UNPARSEABLE");
  });
});

describe("resolveTursoCredentials — غير مضبوط", () => {
  test("empty, whitespace-only and invisible-only values mean unset", () => {
    for (const value of [undefined, "", "  \n\t ", "\u200F\u200F", "\uFEFF"]) {
      const result = resolve(value, undefined);
      assert.equal(result.status, "unset");
      assert.equal(result.url, undefined);
      assert.equal(result.problem, undefined);
    }
  });

  test("a token alone (URL var empty) stays unset, as before", () => {
    assert.equal(resolve("", JWT).status, "unset");
    assert.equal(resolve(undefined, JWT).status, "unset");
  });

  test("a connection URL sitting only in the token field is still found", () => {
    const result = resolve("", `${URL_OK}\n${JWT}`);
    assert.equal(result.status, "repaired");
    assert.equal(result.url, URL_OK);
  });
});

describe("JWT expiry", () => {
  test("an expired token is flagged but still returned (the server decides)", () => {
    const result = resolve(URL_OK, EXPIRED_JWT);
    assert.equal(result.status, "ok");
    assert.equal(result.authToken, EXPIRED_JWT);
    assert.equal(result.tokenExpired, true);
    assert.match(describeTursoConfig(result).hint, /منتهي الصلاحية/);
  });

  test("no exp claim, or no JWT at all, means unknown (null)", () => {
    assert.equal(resolve(URL_OK, JWT).tokenExpired, null);
    assert.equal(resolve("http://127.0.0.1:8080", "").tokenExpired, null);
    assert.equal(resolve(URL_OK, FUTURE_JWT).tokenExpired, false);
  });
});

describe("the description never carries a value", () => {
  const inputs: [string | undefined, string | undefined][] = [
    [URL_OK, JWT],
    [`\u200F"${URL_OK}"`, `'${JWT}'`],
    [`TURSO_DATABASE_URL=${URL_OK}\nTURSO_AUTH_TOKEN=${JWT}`, undefined],
    [JWT, URL_OK],
    [JWT, JWT],
    ["abcde", JWT],
    ["https://app.turso.tech/elazamey/databases/abcde", JWT],
    [`${URL_OK}?authToken=${JWT}`, ""],
    [URL_OK, ""],
    ["libsql://your-db-name-username.turso.io", "your_turso_token"],
  ];
  // شظايا لا يجوز أن تظهر في أي وصف: الرمز (مقاطعه) واسم القاعدة واسم المؤسسة.
  // (نصوص التعليمات نفسها تذكر `turso.io` و`<db>` بوصفها صيغة لا قيمة، فلا تدخل القائمة.)
  const forbidden = [...JWT.split("."), "abcde", "elazamey"];

  test("diagnosis JSON contains only kinds, lengths, counts and fixed codes", () => {
    for (const [url, token] of inputs) {
      const text = JSON.stringify(describeTursoConfig(resolve(url, token)));
      for (const fragment of forbidden) {
        assert.ok(!text.includes(fragment), `تسرّب «${fragment.slice(0, 12)}…» في وصف الإعداد`);
      }
    }
  });

  test("every problem has an actionable Arabic hint naming the variable to fix", () => {
    const seen = new Set<string>();
    for (const [url, token] of inputs) {
      const diagnosis = describeTursoConfig(resolve(url, token));
      if (diagnosis.problem) {
        seen.add(diagnosis.problem);
        assert.match(diagnosis.hint, /TURSO_(DATABASE_URL|AUTH_TOKEN)/);
        assert.match(diagnosis.hint, /[\u0600-\u06FF]/);
      }
    }
    assert.ok(seen.has("URL_NOT_FOUND") && seen.has("URL_PLACEHOLDER") && seen.has("TOKEN_MISSING"));
  });
});

describe("property: whatever is accepted is accepted by createClient, whatever is rejected is explained", () => {
  // مولّد شبه عشوائي حتمي (mulberry32): نفس التشغيل دائمًا، فلا اختبار متقلّب.
  function prng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const fragments = [
    URL_OK, JWT, OTHER_JWT, EXPIRED_JWT, "abcde-elazamey.turso.io", "https://app.turso.tech/elazamey/databases/abcde",
    "https://abcde-elazamey.turso.io/v2/pipeline?authToken=x&secure=1#f", "turso://abcde-elazamey.turso.io",
    "libsql://<db>-<org>.turso.io", "your-db-name-username", "abcde", "TURSO_DATABASE_URL=", "TURSO_AUTH_TOKEN=", "export ",
    '"', "'", "`", "“", "”", "«", "»", "<", ">", "(", ")", "**", ",", ";", ".", "،", "\n", "\r\n", " ", "\t",
    "\u200F", "\u200E", "\u200B", "\uFEFF", "–", "libsql://", "https://", "eyJ", "%3A%2F%2F", "http://127.0.0.1:8080",
    "Bearer ", "postgres://u@h/db", "libsql://exa", "ws://localhost:8080", ":memory:", "\u0627\u0644\u0631\u0627\u0628\u0637",
  ];
  const secretFragments = [...JWT.split("."), ...OTHER_JWT.split("."), "abcde", "elazamey"];

  test("600 deterministic random pastes: never throws, accepted ⇒ createClient ok, rejected ⇒ reason, never a value in the description", () => {
    const rand = prng(20260929);
    const pick = () => fragments[Math.floor(rand() * fragments.length)];
    const compose = () => Array.from({ length: Math.floor(rand() * 6) }, pick).join(rand() < 0.3 ? "" : " ");
    const counts = { unset: 0, ok: 0, repaired: 0, invalid: 0 };

    for (let i = 0; i < 600; i++) {
      const rawUrl = rand() < 0.1 ? undefined : compose();
      const rawToken = rand() < 0.1 ? undefined : compose();
      const result = resolve(rawUrl, rawToken);
      counts[result.status]++;

      if (result.status === "ok" || result.status === "repaired") {
        assert.equal(typeof result.url, "string", JSON.stringify([rawUrl, rawToken]));
        assert.doesNotThrow(() => createClient({ url: result.url as string, authToken: result.authToken }).close(), `createClient رفض ناتج الاستخراج لـ ${JSON.stringify([rawUrl, rawToken])}`);
        assert.equal(result.problem, undefined);
      } else {
        assert.equal(result.url, undefined);
        assert.equal(result.authToken, undefined);
        if (result.status === "invalid") assert.ok(result.problem, "فشل بلا سبب");
      }

      const text = JSON.stringify(describeTursoConfig(result));
      for (const fragment of secretFragments) assert.ok(!text.includes(fragment), `تسرّب «${fragment.slice(0, 10)}…»`);
    }
    // المولّد يغطي الحالات الأربع فعلًا (لا اختبار أجوف).
    assert.ok(counts.unset > 0 && counts.ok > 0 && counts.repaired > 0 && counts.invalid > 0, JSON.stringify(counts));
  });
});
