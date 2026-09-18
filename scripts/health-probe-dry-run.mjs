#!/usr/bin/env node
/**
 * مجسّ جاهزية المزودين — dry run محلي وقبل النشر.
 *
 *   node scripts/health-probe-dry-run.mjs          # فحص تكوين فقط (بلا شبكة)
 *   node scripts/health-probe-dry-run.mjs --live   # + نداءات فعلية للمزودين وTurso
 *   node scripts/health-probe-dry-run.mjs --json   # مخرج آلي للـ CI والربط
 *
 * السياسة (نفس سياسة بقية البوابات):
 *  - المفاتيح الاختيارية غائبة ⇒ ⚠️ تحذير فقط، والخروج بالرمز 0 (لا يكسر CI).
 *  - مفتاح موجود لكنه غير صالح الشكل أو غير آمن (رابط NIM بـ http) ⇒ ❌ فشل.
 *  - Turso: رابط بلا رمز ⇒ ❌ فشل. غياب الرابط ⇒ ⚠️ المتجر يعمل بكتالوج البذرة.
 *  - `--live`: أي مزود مُهيّأ يفشل نداؤه ⇒ ❌ فشل. المزود غير المُهيّأ لا يُنادى أصلًا.
 *
 * ضمانات:
 *  - لا تُطبع أي قيمة سرية إطلاقًا: بصمة مقنّعة فقط (بادئة + طول)، وكل نص
 *    يمر عبر تنقية تحجب أنماط المفاتيح المعروفة قبل الطباعة.
 *  - لا اعتماديات خارجية: node builtins + fetch فقط، فيعمل محليًا وفي CI بلا تثبيت.
 */

import { pathToFileURL } from "node:url";

/* ------------------------------- أدوات مساعدة ------------------------------ */

const SECRET_PATTERNS = [
  [/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_GEMINI_KEY]"],
  [/gsk_[0-9A-Za-z_-]{20,}/g, "[REDACTED_GROQ_KEY]"],
  [/nvapi-[0-9A-Za-z_-]{16,}/g, "[REDACTED_NVIDIA_KEY]"],
  [/(key|token|secret|password)[=:]\s*[^\s"&]+/gi, "$1=[REDACTED]"],
];

/** يحجب أي نمط سري معروف من نص قبل طباعته أو إخراجه. */
export function redact(text) {
  let out = String(text ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** بصمة مقنّعة: البادئة والنوع والطول فقط — لا تكشف قيمة صالحة للنسخ. */
export function fingerprint(value) {
  const text = String(value ?? "");
  if (text === "") return "(غير معيّن)";
  const prefix = /^nvapi-/.test(text) ? "nvapi-…" : /^gsk_/.test(text) ? "gsk_…" : /^AIza/.test(text) ? "AIza…" : "…";
  return `${prefix} (${text.length} حرفًا)`;
}

const geminiKeyRe = /^AIza[0-9A-Za-z_-]{20,}$/;
const groqKeyRe = /^gsk_[0-9A-Za-z_-]{20,}$/;
const nimKeyRe = /^nvapi-[0-9A-Za-z_-]{16,}$/;

/* -------------------------------- الفحص الجاف ------------------------------- */

/**
 * فحص التكوين بلا أي نداء شبكي. دالة نقية تُقرأ منها البيئة كوسيط
 * حتى يمكن اختبار السياسة نفسها بلا لمس بيئة التشغيل.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ checks: Array<{name:string, status:"ok"|"warn"|"fail", detail:string, hint?:string}>, failures: number, warnings: number }}
 */
export function evaluateConfiguration(env = process.env) {
  /** @type {Array<{name:string, status:"ok"|"warn"|"fail", detail:string, hint?:string}>} */
  const checks = [];
  const add = (name, status, detail, hint) => checks.push({ name, status, detail, hint });

  const agentEnabled = env.ENABLE_AI_AGENT === "true";
  const mcpEnabled = env.ENABLE_MCP_TOOLS === "true";
  const ragEnabled = env.ENABLE_RAG === "true";

  /* ---- الأعلام: ملخص التشغيل الفعلي ---- */
  add(
    "الأعلام",
    "ok",
    `AI_AGENT=${agentEnabled ? "on" : "off"} · MCP_TOOLS=${mcpEnabled ? "on" : "off"} · RAG=${ragEnabled ? "on" : "off"}`
  );

  /* ---- Gemini ---- */
  const gemini = env.GEMINI_API_KEY ?? "";
  if (!gemini) {
    add("Gemini", "warn", "المفتاح غير معيّن — المزود اختياري ويُتخطى في السلسلة");
  } else if (!geminiKeyRe.test(gemini)) {
    add("Gemini", "fail", `شكل المفتاح غير متوقع ${fingerprint(gemini)}`, "تحقق من نسخ المفتاح كاملًا من AI Studio");
  } else {
    add("Gemini", "ok", `مهيّأ ${fingerprint(gemini)}${env.GEMINI_MODEL ? ` · نموذج محدد: ${env.GEMINI_MODEL}` : " · سلسلة النماذج الافتراضية"}`);
  }

  /* ---- Groq ---- */
  const groq = env.GROQ_API_KEY ?? "";
  if (!groq) {
    add("Groq", "warn", "المفتاح غير معيّن — المزود اختياري ويُتخطى في السلسلة");
  } else if (!groqKeyRe.test(groq)) {
    add("Groq", "fail", `شكل المفتاح غير متوقع ${fingerprint(groq)}`, "مفاتيح Groq تبدأ بـ gsk_");
  } else {
    add("Groq", "ok", `مهيّأ ${fingerprint(groq)} · نموذج: ${env.GROQ_MODEL || "llama-3.3-70b-versatile"}`);
  }

  /* ---- NVIDIA NIM ---- */
  const nimKey = env.NVIDIA_NIM_API_KEY ?? env.NVIDIA_API_KEY ?? "";
  const nimBase = (env.NVIDIA_NIM_BASE_URL ?? "").trim();
  if (!nimKey) {
    add("NVIDIA NIM", "warn", "المفتاح غير معيّن — المزود اختياري ويُخرج نفسه من السلسلة");
  } else {
    const keyOk = nimKeyRe.test(nimKey);
    const baseOk = nimBase === "" || /^https:\/\//i.test(nimBase);
    if (!keyOk) {
      add("NVIDIA NIM", "fail", `شكل المفتاح غير متوقع ${fingerprint(nimKey)}`, "مفاتيح NIM تبدأ بـ nvapi-");
    } else if (!baseOk) {
      add("NVIDIA NIM", "fail", "NVIDIA_NIM_BASE_URL يجب أن يبدأ بـ https:// حتى لا يمر المفتاح على قناة غير مشفّرة");
    } else {
      add("NVIDIA NIM", "ok", `مهيّأ ${fingerprint(nimKey)} · الرابط: ${nimBase || "https://integrate.api.nvidia.com/v1"} · نموذج: ${env.NVIDIA_NIM_MODEL || "meta/llama-3.3-70b-instruct"}`);
    }
  }

  /* ---- طبقة MCP ---- */
  if (mcpEnabled) {
    const allowed = (env.MCP_ALLOWED_TOOLS ?? "").trim();
    add("طبقة MCP", "ok", allowed ? `قائمة سماح صريحة: ${allowed}` : "المجموعة الافتراضية للقراءة فقط");
    if (allowed) {
      const names = allowed.split(",").map((n) => n.trim()).filter(Boolean);
      const suspicious = names.filter((n) => !/^[a-z][a-z0-9_]{2,40}$/.test(n));
      if (suspicious.length > 0) {
        add("طبقة MCP", "warn", `أسماء لا تطابق نمط الأدوات (ستُتجاهل): ${suspicious.join(", ")}`);
      }
    }
  }

  /* ---- Turso ---- */
  const tursoUrl = (env.TURSO_DATABASE_URL ?? "").trim();
  const tursoToken = (env.TURSO_AUTH_TOKEN ?? "").trim();
  if (!tursoUrl) {
    add("Turso", "warn", "الرابط غير معيّن — المتجر يعمل بكتالوج البذرة والسلة تعمل كالمعتاد");
  } else if (!/^(libsql|https|http):\/\//i.test(tursoUrl)) {
    add("Turso", "fail", "TURSO_DATABASE_URL يجب أن يبدأ بـ libsql:// أو https://");
  } else if (!tursoToken) {
    add("Turso", "fail", "TURSO_DATABASE_URL معيّن بلا TURSO_AUTH_TOKEN — الاتصال سيفشل");
  } else {
    add("Turso", "ok", `مهيّأ (${tursoUrl.replace(/\/\/[^/]+/, "//…")} · رمز ${fingerprint(tursoToken)})`);
  }

  /* ---- اتساق تعريفي ---- */
  const anyProvider = Boolean(gemini || groq || nimKey);
  if (agentEnabled && !anyProvider) {
    add("الاتساق", "warn", "ENABLE_AI_AGENT=true بلا أي مفتاح مزود — سيليا سترد بالرد المحلي الذكي فقط");
  }
  if (mcpEnabled && !agentEnabled) {
    add("الاتساق", "warn", "ENABLE_MCP_TOOLS=true بينما ENABLE_AI_AGENT غير مفعّل — لا مسار يستدعي الأدوات حاليًا");
  }
  if (ragEnabled && !mcpEnabled && !agentEnabled) {
    add("الاتساق", "warn", "ENABLE_RAG=true بلا وكيل ولا أدوات مفعّلة — ذاكرة الاسترجاع لن تُستدعى بعد");
  }

  const failures = checks.filter((c) => c.status === "fail").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  return { checks, failures, warnings };
}

/* --------------------------------- الفحص الحيّ ------------------------------- */

const LIVE_TIMEOUT_MS = 15_000;

/**
 * @typedef {{ name: string, status: "ok" | "warn" | "fail", detail: string }} Check
 */

/**
 * @param {string} name
 * @param {string} url
 * @param {RequestInit} init
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Check>}
 */
async function ping(name, url, init, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    const body = res.ok ? "" : redact(await res.text().catch(() => "")).slice(0, 120);
    return res.ok
      ? { name, status: "ok", detail: `الرد ${res.status} — الخدمة تستجيب` }
      : { name, status: "fail", detail: `الرد ${res.status}${body ? ` — ${body}` : ""}` };
  } catch (error) {
    return { name, status: "fail", detail: redact(String(error?.message ?? error)).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * نداءات فعلية للمزودين المُهيّئين فقط. غير المُهيّأ يُعلَّم ⚠️ ولا يُنادى،
 * فلا يعتمد نجاح الفحص على مزود غير مستخدم أصلًا.
 *
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Check[]>}
 */
export async function runLiveChecks(env = process.env, fetchImpl = globalThis.fetch) {
  /** @type {Check[]} */
  const results = [];

  const gemini = env.GEMINI_API_KEY ?? "";
  if (gemini && geminiKeyRe.test(gemini)) {
    const models = env.GEMINI_MODEL
      ? [env.GEMINI_MODEL]
      : ["gemini-flash-latest", "gemini-3.5-flash", "gemini-flash-lite-latest"];
    /** @type {Check} */
    let last = { name: "Gemini (live)", status: "warn", detail: "لم يُجرَّب أي نموذج" };
    for (const model of models) {
      last = await ping(
        "Gemini (live)",
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": gemini },
          body: JSON.stringify({ contents: [{ parts: [{ text: "ping" }] }] }),
        },
        fetchImpl
      );
      if (last.status === "ok") {
        last.detail = `${model}: ${last.detail}`;
        break;
      }
    }
    results.push(last);
  } else {
    results.push({ name: "Gemini (live)", status: "warn", detail: "غير مُهيّأ — لا نداء" });
  }

  const groq = env.GROQ_API_KEY ?? "";
  results.push(
    groq && groqKeyRe.test(groq)
      ? await ping("Groq (live)", "https://api.groq.com/openai/v1/models", {
          method: "GET",
          headers: { Authorization: `Bearer ${groq}` },
        }, fetchImpl)
      : { name: "Groq (live)", status: "warn", detail: "غير مُهيّأ — لا نداء" }
  );

  const nimKey = env.NVIDIA_NIM_API_KEY ?? env.NVIDIA_API_KEY ?? "";
  const nimBase = (env.NVIDIA_NIM_BASE_URL ?? "").trim() || "https://integrate.api.nvidia.com/v1";
  results.push(
    nimKey && nimKeyRe.test(nimKey) && /^https:\/\//i.test(nimBase)
      ? await ping("NVIDIA NIM (live)", `${nimBase.replace(/\/+$/, "")}/models`, {
          method: "GET",
          headers: { Authorization: `Bearer ${nimKey}` },
        }, fetchImpl)
      : { name: "NVIDIA NIM (live)", status: "warn", detail: "غير مُهيّأ أو رابط غير آمن — لا نداء" }
  );

  const tursoUrl = (env.TURSO_DATABASE_URL ?? "").trim();
  const tursoToken = (env.TURSO_AUTH_TOKEN ?? "").trim();
  if (tursoUrl && tursoToken) {
    const httpUrl = tursoUrl.startsWith("libsql://")
      ? `https://${tursoUrl.slice("libsql://".length)}`
      : tursoUrl.replace(/^http:\/\//i, "https://");
    results.push(
      await ping(`${httpUrl.replace(/\/\/[^/]+/, "//…")} (live)`, `${httpUrl.replace(/\/+$/, "")}/v2/pipeline`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tursoToken}` },
        body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql: "SELECT 1" } }] }),
      }, fetchImpl)
    );
  } else {
    results.push({ name: "Turso (live)", status: "warn", detail: "غير مُهيّأ — لا نداء" });
  }

  return results;
}

/* ---------------------------------- العرض ---------------------------------- */

const MARKS = { ok: "✅", warn: "⚠️", fail: "❌" };

/**
 * @param {string} title
 * @param {Check[]} checks
 */
function printChecks(title, checks) {
  if (checks.length === 0) return;
  console.log(`\n${title}`);
  console.log("─".repeat(72));
  for (const check of checks) {
    console.log(`${MARKS[check.status]} ${check.name}: ${redact(check.detail)}`);
    if (check.hint) console.log(`   ↳ ${redact(check.hint)}`);
  }
}

/* ---------------------------------- التشغيل --------------------------------- */

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<number>} رمز الخروج (0 جاهز/تحذيرات، 1 مشكلة تكوين)
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const live = argv.includes("--live");
  const json = argv.includes("--json");

  const config = evaluateConfiguration(env);
  const liveChecks = live ? await runLiveChecks(env, globalThis.fetch) : [];
  const failures = config.failures + liveChecks.filter((c) => c.status === "fail").length;

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: failures === 0,
          live,
          failures,
          warnings: config.warnings + liveChecks.filter((c) => c.status === "warn").length,
          configuration: config.checks.map((c) => ({ ...c, detail: redact(c.detail) })),
          live_checks: liveChecks.map((c) => ({ ...c, detail: redact(c.detail) })),
        },
        null,
        2
      )
    );
  } else {
    printChecks("تكوين المزودين والأعلام (dry run)", config.checks);
    if (live) printChecks("نداءات مباشرة للمزودين المُهيّئين", liveChecks);
    console.log("\n" + "─".repeat(72));
    if (failures > 0) {
      console.log(`❌ النتيجة: ${failures} مشكلة تكوين يجب إصلاحها قبل النشر.`);
    } else if (config.warnings > 0 || liveChecks.some((c) => c.status === "warn")) {
      console.log("✅ النتيجة: جاهز مع تحذيرات (المفاتيح الاختيارية الغائبة لا توقف التشغيل).");
    } else {
      console.log("✅ النتيجة: كل المزودين المُعلنين مهيّئون وسليمون.");
    }
    console.log("ℹ️  لم تُطبع أي قيمة سرية — بصمات مقنّعة فقط.");
  }

  return failures === 0 ? 0 : 1;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error("health-probe: فشل غير متوقع:", redact(String(error?.message ?? error)));
      process.exit(1);
    });
}
