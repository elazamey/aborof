import { createHash } from "node:crypto";
import { SCHEMA_CONTRACT_VERSION } from "./schema-contract.mjs";

/**
 * بيان الأدلة المضاد للعبث (tamper-evident) — يُرفَق بتقرير المجسّ JSON.
 *
 * حفظ `probe-result.json` وحده لا يكفي: بعد سنة يجب أن نستطيع قول «هذا
 * بالضبط هو الدليل الذي أُنتِج آنذاك». البيان يحمل: الالتزام، التشغيل،
 * النشر (إن وُجد)، الطابع الزمني، نسختي المجسّ والعقد، وبصمة SHA-256
 * للحكم+الصفوف — وأي تعديل لاحق على الصفوف يُكشَف بـ `verifyManifest`.
 * لا أسرار في البيان أبدًا (البصمة على صفوف منقّاة أصلًا).
 */

/** نسخة المجسّ — تُرفَع مع أي تغيير في منطق الصفوف/الأكواد. */
export const PROBE_VERSION = 1;

/**
 * @param {{rows: unknown[], verdict: string, env?: NodeJS.ProcessEnv|Record<string,string|undefined>, generatedAt?: string|null}} input
 */
export function buildManifest({ rows, verdict, env = process.env, generatedAt = null }) {
  const canonical = JSON.stringify({ verdict: String(verdict), rows: rows ?? [] });
  return {
    probe_version: PROBE_VERSION,
    schema_contract_version: SCHEMA_CONTRACT_VERSION,
    commit: String(env?.GITHUB_SHA ?? "local"),
    run_id: String(env?.GITHUB_RUN_ID ?? "local"),
    deployment: env?.VERCEL_DEPLOYMENT_ID != null ? String(env.VERCEL_DEPLOYMENT_ID) : null,
    generated_at: generatedAt ?? new Date().toISOString(),
    result_sha256: createHash("sha256").update(canonical).digest("hex"),
  };
}

/**
 * يتحقق أن الصفوف والحكم يطابقان البصمة المحفوظة (كشف العبث اللاحق).
 * @param {{result_sha256?: string}|null} manifest
 * @param {{rows: unknown[], verdict: string}} report
 */
export function verifyManifest(manifest, { rows, verdict }) {
  if (!manifest || typeof manifest.result_sha256 !== "string") return false;
  const canonical = JSON.stringify({ verdict: String(verdict), rows: rows ?? [] });
  return createHash("sha256").update(canonical).digest("hex") === manifest.result_sha256;
}
