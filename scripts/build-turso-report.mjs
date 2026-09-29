#!/usr/bin/env node
/**
 * تقرير اتصال Turso داخل **سجل البناء** (يُستدعى تلقائيًا من `prebuild`).
 *
 * المشكلة: فشل Turso في الإنتاج يظهر وقت التشغيل (503) بينما البناء ينجح دائمًا،
 * فيبقى المالك أمام سجل أخضر بلا سبب، ويحرق كل «Redeploy» حصة نشر محدودة.
 * هذا السكربت يجرّب الاتصال بقيم البيئة نفسها التي سيعمل بها النشر، ويكتب في
 * السجل أسطرًا تبدأ بـ `turso-check:` تسمّي السبب والإجراء بدقة.
 *
 * ضمانات صلبة:
 *   1. **لا يفشل البناء أبدًا**: كل استيراد وشبكة داخل try، وكود الخروج 0 دائمًا.
 *   2. **لا يعلّق البناء**: مهلة 8 ثوانٍ لكل خطوة شبكة + مؤقّت حارس كلي.
 *   3. **للقراءة فقط**: `SELECT` فقط. لا هجرة ولا كتابة (التطبيق يهيّئ الجداول عند أول طلب).
 *   4. **لا أسرار في السجل**: أنواع وأطوال وأحكام فقط (انظر scripts/lib/turso-build-report.mjs).
 *
 * تشغيل يدوي لتجربته:  TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… node scripts/build-turso-report.mjs
 */
import fs from "node:fs";
import { describeDatabaseUrl, interpretProbeStatus, originForHttpProbe } from "./lib/db-url.mjs";
import { expectedMigrations, redact } from "./lib/migration-checksums.mjs";
import { classifyNetworkError, renderTursoBuildReport } from "./lib/turso-build-report.mjs";

const STEP_TIMEOUT_MS = 8_000;
const WATCHDOG_MS = 40_000;

/** مؤقّت حارس: إن علق أي مقبس مفتوح ينتهي الفحص دون أن يمسك البناء. لا `ref` فلا يطيل عمر العملية. */
const watchdog = setTimeout(() => {
  console.log("turso-check: ⚠️ انتهت المهلة الكلية للفحص — لا حكم على Turso من هذا السجل (البناء غير متأثر).");
  process.exit(0);
}, WATCHDOG_MS);
watchdog.unref();

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** وحدة الاستخراج نفسها التي يستخدمها التطبيق (TypeScript) — عبر واجهة tsx بلا أعلام تشغيل. */
async function loadTursoConfig() {
  const { tsImport } = await import("tsx/esm/api");
  const mod = await tsImport("../src/lib/db/turso-config.ts", import.meta.url);
  return typeof mod.resolveTursoCredentials === "function" ? mod : mod.default;
}

const LOCAL_URL = /^file:|^:memory:$/i;

/** نوع الفشل من رمز حالة HTTP — يختار الإجراء المناسب في التقرير. */
function failureKind(status) {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not-found";
  if (status === 400) return "bad-request";
  return undefined;
}

/** مسار ملف القاعدة من رابط `file:` (بلا استعلام)؛ `null` للذاكرة أو إن تعذّر. */
function localDbPath(url) {
  if (/^:memory:$/i.test(url) || /^file::memory:/i.test(url)) return null;
  const raw = url.replace(/^file:/i, "").replace(/^\/\/(?=\/)/, "").split("?")[0];
  return raw || null;
}

function countExpectedMigrations() {
  try {
    return expectedMigrations().length;
  } catch {
    return null;
  }
}

/** اتصال فعلي للقراءة فقط. يعيد `{connection, schema}` ولا يرمي. */
async function probe(config, resolution) {
  const secrets = [resolution.url, resolution.authToken, process.env.TURSO_DATABASE_URL, process.env.TURSO_AUTH_TOKEN];
  const isFile = LOCAL_URL.test(resolution.url);
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  // قاعدة محلية: لا نُنشئ ملفًا جديدًا أثناء البناء (فتح عميل libsql على مسار غائب ينشئه).
  if (isFile) {
    const path = localDbPath(resolution.url);
    if (path === null || !fs.existsSync(path)) {
      return {
        connection: { ok: true, verdict: "قاعدة محلية (ملف/ذاكرة) — لا فحص شبكة", ms: 0 },
        schema: null,
      };
    }
  }

  // 1) نداء HTTP خام: الفارق بين 401 (الرمز) و404 (القاعدة) هو الفارق بين علاجين مختلفين
  //    يخفيهما @libsql/client خلف رسالة واحدة. مُجرَّب على Turso الحقيقي في مسبار CI.
  if (!isFile) {
    // `libsql://host:port?tls=0` (خادم ذاتي بلا TLS) يتصل به العميل عبر http لا https.
    const probeUrl = /[?&]tls=0(?:&|$)/.test(resolution.url)
      ? resolution.url.replace(/^libsql:\/\//i, "http://")
      : resolution.url;
    const origin = originForHttpProbe(probeUrl);
    if (!origin) {
      return { connection: { ok: false, verdict: "مخطط الرابط غير قابل للفحص عبر HTTP", ms: 0 }, schema: null };
    }
    try {
      const response = await fetch(`${origin}/v2/pipeline`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(resolution.authToken ? { authorization: `Bearer ${resolution.authToken}` } : {}),
        },
        body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql: "SELECT 1 AS ok" } }, { type: "close" }] }),
        signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
      });
      const body = await response.text().catch(() => "");
      const verdict = interpretProbeStatus(response.status, redact(body, secrets));
      if (!verdict.ok) {
        return { connection: { ok: false, verdict: verdict.verdict, ms: elapsed(), kind: failureKind(response.status) }, schema: null };
      }
    } catch (error) {
      return { connection: { ok: false, verdict: classifyNetworkError(error), ms: elapsed(), kind: "network" }, schema: null };
    }
  }

  // 2) العميل نفسه الذي يستخدمه التطبيق + فحص الجداول (قراءة فقط).
  let client;
  try {
    const { createClient } = await import("@libsql/client");
    client = createClient({ url: resolution.url, authToken: resolution.authToken });
    await withTimeout(client.execute("SELECT 1 AS ok"), STEP_TIMEOUT_MS);
    const connection = {
      ok: true,
      verdict: isFile ? "قاعدة ملف محلية (لا فحص شبكة)" : "نجح (HTTP 200)",
      ms: elapsed(),
    };

    const listed = await withTimeout(
      client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('products', 'schema_migrations')"),
      STEP_TIMEOUT_MS,
    );
    const names = new Set(listed.rows.map((row) => String(row.name)));
    const count = async (table) =>
      Number((await withTimeout(client.execute(`SELECT COUNT(*) AS n FROM ${table}`), STEP_TIMEOUT_MS)).rows[0].n);
    const schema = {
      hasProducts: names.has("products"),
      products: names.has("products") ? await count("products") : null,
      appliedMigrations: names.has("schema_migrations") ? await count("schema_migrations") : null,
      expectedMigrations: countExpectedMigrations(),
    };
    return { connection, schema };
  } catch (error) {
    const label = config.describeDatabaseError(error);
    return {
      connection: { ok: false, verdict: `نجح النداء الخام وفشل عميل libsql (${label})`, ms: elapsed(), kind: "client" },
      schema: null,
    };
  } finally {
    try {
      client?.close();
    } catch {
      // الإغلاق محاولة فقط.
    }
  }
}

async function main() {
  const env = process.env;
  const config = await loadTursoConfig();
  const resolution = config.resolveTursoCredentials(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN);
  const diagnosis = config.describeTursoConfig(resolution);

  const nearMissNames = Object.keys(env)
    .filter((name) => /turso|libsql/i.test(name) && name !== "TURSO_DATABASE_URL" && name !== "TURSO_AUTH_TOKEN")
    .slice(0, 10)
    .map((name) => ({ name, length: String(env[name] ?? "").length }));

  let connection = null;
  let schema = null;
  if ((resolution.status === "ok" || resolution.status === "repaired") && resolution.url) {
    ({ connection, schema } = await probe(config, resolution));
  }

  const { lines } = renderTursoBuildReport({
    vercelEnv: env.VERCEL_ENV,
    commit: env.VERCEL_GIT_COMMIT_SHA ? env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : undefined,
    nearMissNames,
    diagnosis,
    token: config.describeTursoToken(resolution.authToken),
    urlShape: resolution.url
      ? LOCAL_URL.test(resolution.url)
        ? { local: true, scheme: "file", kind: "محلي", hostMasked: "—", hostLength: 0 }
        : { local: false, ...describeDatabaseUrl(resolution.url) }
      : null,
    connection,
    schema,
  });
  for (const line of lines) console.log(line);
}

/** يفرّغ المخرجات ثم يخرج فورًا بالكود 0 — فلا ينتظر البناء مقابس keep-alive المفتوحة. */
function finish() {
  process.stdout.write("", () => process.exit(0));
}

try {
  await main();
} catch (error) {
  // أي خلل في الفحص نفسه لا يمسّ البناء: رسالة ثابتة بلا نص خام (قد يحمل مسارًا أو قيمة).
  console.log(`turso-check: ⚠️ تعذّر تشغيل الفحص (${String(error?.name ?? "Error").slice(0, 40)}) — البناء غير متأثر.`);
}
finish();
