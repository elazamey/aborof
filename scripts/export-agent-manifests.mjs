#!/usr/bin/env node
/**
 * مُصدِّر مانيفست الأسطول — يُولّد JSON و YAML من **مصدر الحقيقة الوحيد**
 * (`src/lib/ai/agents/catalog/`)، فلا يوجد ملف يُحرَّر يدويًا يتفرّق عن الكود.
 *
 * الغرض: تسليم تعاريف الوكلاء لأي فريق أو أداة خارجية (لوحة إدارة، مراجعة،
 * ترجمة) بصيغة محمولة — مع ضمانة CI أن الملف المولَّد مطابق للكود دائمًا.
 *
 * الاستخدام:
 *   node scripts/export-agent-manifests.mjs            # كتابة الملفات
 *   node scripts/export-agent-manifests.mjs --check     # يفشل إن كان هناك انحراف (يُشغَّل في CI)
 *   node scripts/export-agent-manifests.mjs --stdout    # طباعة JSON فقط
 *
 * المخرجات: `docs/ai/agents.manifest.json` و`docs/ai/agents.manifest.yaml`
 * (مُولَّدة — لا تُحرَّر يدويًا؛ أي تعديل يُدهس في التوليد التالي ويفشل فحص CI).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OUT_JSON = path.join("docs", "ai", "agents.manifest.json");
const OUT_YAML = path.join("docs", "ai", "agents.manifest.yaml");
const GENERATED_BANNER = "مُولَّد آليًا — لا تُحرَّر يدويًا: npm run agents:export";

const args = process.argv.slice(2);

/**
 * مُصدِّر YAML أدنى ومحدود: يكفي الأشكال التي نُنتجها (كائنات/مصفوفات/سلاسل/
 * أرقام/منطقيات) — بلا اعتمادية خارجية، وبلا أي حالة غير حتمية.
 * مُصدَّر للاختبار في tests/deploy-tools.test.ts.
 */
export function toYaml(value, indent = 0) {
  const pad = "  ".repeat(indent);
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return quoteYaml(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        const rendered = toYaml(item, indent + 1);
        if (rendered.includes("\n")) {
          // عنصر متعدد الأسطر: نضعه بعد شرطة في سطر مستقل مع محاذاة صحيحة.
          return `${pad}- ${rendered.split("\n").join("\n" + "  ".repeat(indent + 1))}`;
        }
        return `${pad}- ${rendered}`;
      })
      .join("\n");
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return "{}";
  return entries
    .map(([key, item]) => {
      const rendered = toYaml(item, indent + 1);
      if (rendered.includes("\n")) return `${pad}${key}:\n${rendered}`;
      return `${pad}${key}: ${rendered}`;
    })
    .join("\n");
}

function quoteYaml(text) {
  // نُصدّر السلاسل دائمًا بين علامتي تنصيص مزدوجة مع تهريب صحيح — النص عربي
  // ومنه ما يبدأ برموز خاصة، فالتنصيص الصريح أسلم من الاعتماد على قواعد YAML.
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** المانيفست المحمول — كل ما يحتاجه فريق خارجي، وبلا أي سر. */
export function buildManifest(fleetSnapshot, manifest, policy) {
  return {
    generated_by: GENERATED_BANNER,
    format_version: 1,
    fleet: fleetSnapshot,
    mcp_policy: policy,
    agents: manifest.map((agent) => ({
      id: agent.id,
      name: agent.name,
      department: agent.department,
      mission: agent.mission,
      tools: agent.tools,
      read_only_only: true,
      escalate_to_human: agent.escalate_to_human,
      is_default: agent.is_default,
      disabled: agent.disabled,
      examples: agent.examples,
    })),
  };
}

/** حمولة منقّاة للتصدير من مصادر الحقيقة في الكود. */
async function loadSources() {
  const agents = await import("../src/lib/ai/agents/index.ts");
  const mcp = await import("../src/lib/ai/mcp/policy.ts");
  const manifest = agents.fleetCatalogManifest();
  const fleet = agents.fleetSnapshot();
  const catalogWithExamples = agents.AGENT_FLEET.map((agent) => ({
    ...manifest.find((entry) => entry.id === agent.id),
    examples: agent.examples.map((example) => ({ input: example.input, expected: example.expected })),
  }));
  return {
    fleet,
    manifest: catalogWithExamples,
    policy: mcp.mcpPolicySnapshot(agents.READ_ONLY_TOOL_NAMES),
    readOnlyTools: agents.READ_ONLY_TOOL_NAMES,
  };
}

async function main() {
  const { fleet, manifest, policy, readOnlyTools } = await loadSources();
  const payload = buildManifest(fleet, manifest, policy);

  // حارس التصدير: كل أداة معلنة لأي وكيل يجب أن تكون في قائمة القراءة فقط المسجّلة.
  // أي انحراف يعني أن المانيفست المحمول سيُعلن قدرة غير موجودة — فيُرفض التصدير كله.
  const readOnly = new Set(readOnlyTools);
  const offenders = manifest.flatMap((agent) =>
    agent.tools.filter((tool) => !readOnly.has(tool)).map((tool) => `${agent.id}:${tool}`)
  );
  if (offenders.length > 0) {
    console.error(`❌ أدوات غير للقراءة فقط في المانيفست: ${offenders.join(", ")}`);
    process.exit(1);
  }

  const json = JSON.stringify(payload, null, 2) + "\n";
  const yaml = toYaml(payload) + "\n";

  if (args.includes("--stdout")) {
    process.stdout.write(json);
    return;
  }

  if (args.includes("--check")) {
    let drift = false;
    for (const [file, expected] of [
      [OUT_JSON, json],
      [OUT_YAML, yaml],
    ]) {
      const actual = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      if (actual !== expected) {
        console.error(`❌ انحراف في ${file} — شغّل: npm run agents:export`);
        drift = true;
      }
    }
    if (drift) process.exit(1);
    console.log(`✅ مانيفست الأسطول مطابق للكود (${manifest.length} وكيلًا، JSON + YAML).`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, json);
  fs.writeFileSync(OUT_YAML, yaml);
  console.log(`✅ كُتب ${OUT_JSON} و ${OUT_YAML} (${manifest.length} وكيلًا).`);
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`❌ تعذّر التصدير: ${String(error?.message ?? error)}`);
    process.exit(1);
  });
}
