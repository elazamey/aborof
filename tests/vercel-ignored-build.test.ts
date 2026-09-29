import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// عقد Vercel لخطوة Ignored Build Step (من توثيق Vercel حرفيًا):
//   exit 0 ⇒ تجاهل البناء (skip) — exit 1 ⇒ المتابعة في البناء (build)
// الاختبار يبني مستودع git مؤقتًا بسلسلة التزامات مصنّفة مسبقًا ويشغّل
// scripts/vercel-ignored-build.sh على أزواج (قاعدة، رأس) حقيقية — بلا اتصال
// بـ Vercel ولا استهلاك لحصّة البناء. القاعدة: التوثيق الخالص يوقف، وكل ما
// عداه (أو أي غموض) يبني (fail-open).

const SCRIPT = path.resolve("scripts/vercel-ignored-build.sh");

function git(repo: string, ...args: string[]): string {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

// يشغّل السكربت على الزوج (base ← head): يوقّف مؤقتًا عند head ثم يقارن.
function ignoredBuildExit(repo: string, base: string | null, head: string): number {
  git(repo, "checkout", "-q", head);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.VERCEL_GIT_PREVIOUS_SHA;
  if (base !== null) env.VERCEL_GIT_PREVIOUS_SHA = base;
  const res = spawnSync("bash", [SCRIPT], { cwd: repo, encoding: "utf8", env });
  return res.status ?? -1;
}

function commitAll(repo: string, message: string): string {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

describe("vercel-ignored-build (Ignored Build Step)", () => {
  let repo: string;
  // سلسلة: A كود → B توثيق → C كود → D handoff → E مزيج → F vercel.json → G السكربت
  const h: Record<string, string> = {};

  before(() => {
    repo = mkdtempSync(path.join(tmpdir(), "aborof-ignore-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "tests@aborof.local");
    git(repo, "config", "user.name", "aborof tests");
    git(repo, "config", "commit.gpgsign", "false");

    // A: التزام أولي بكود
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "app.ts"), "export const a = 1;\n");
    writeFileSync(path.join(repo, "package.json"), "{}\n");
    h.A = commitAll(repo, "A: initial code");

    // B: توثيق خالص (docs/ + ماركداون في أي مسار)
    mkdirSync(path.join(repo, "docs"), { recursive: true });
    writeFileSync(path.join(repo, "docs", "x.md"), "# x\n");
    writeFileSync(path.join(repo, "README.md"), "# readme\n");
    h.B = commitAll(repo, "B: docs only");

    // C: كود
    appendFileSync(path.join(repo, "src", "app.ts"), "export const b = 2;\n");
    h.C = commitAll(repo, "C: code change");

    // D: handoff/ خالص (ملفات تسليم — لا تدخل مخرجات البناء)
    mkdirSync(path.join(repo, "handoff"), { recursive: true });
    writeFileSync(path.join(repo, "handoff", "f.patch"), "patch\n");
    h.D = commitAll(repo, "D: handoff only");

    // E: مزيج توثيق + كود ⇒ يجب أن يُطلق البناء
    writeFileSync(path.join(repo, "docs", "y.md"), "# y\n");
    appendFileSync(path.join(repo, "src", "app.ts"), "export const c = 3;\n");
    h.E = commitAll(repo, "E: docs + code");

    // F: إعدادات النشر نفسها ⇒ ليست خاملة ⇒ بناء
    writeFileSync(path.join(repo, "vercel.json"), "{}\n");
    h.F = commitAll(repo, "F: vercel.json");

    // G: السكربت نفسه ⇒ سلوك النشر يتغير ⇒ بناء
    mkdirSync(path.join(repo, "scripts"), { recursive: true });
    writeFileSync(path.join(repo, "scripts", "vercel-ignored-build.sh"), "# stub\n");
    h.G = commitAll(repo, "G: the script itself");
  });

  after(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("docs-only commit ⇒ exit 0 (skip the build)", () => {
    assert.equal(ignoredBuildExit(repo, h.A, h.B), 0);
  });

  test("code-only commit ⇒ exit 1 (build)", () => {
    assert.equal(ignoredBuildExit(repo, h.B, h.C), 1);
  });

  test("handoff-only commit ⇒ exit 0 (skip the build)", () => {
    assert.equal(ignoredBuildExit(repo, h.C, h.D), 0);
  });

  test("docs + code in one commit ⇒ exit 1 (build) — ملف مؤثر واحد يكفي", () => {
    assert.equal(ignoredBuildExit(repo, h.D, h.E), 1);
  });

  test("vercel.json change ⇒ exit 1 (build) — إعدادات النشر ليست خاملة", () => {
    assert.equal(ignoredBuildExit(repo, h.E, h.F), 1);
  });

  test("the ignore script itself changes ⇒ exit 1 (build)", () => {
    assert.equal(ignoredBuildExit(repo, h.F, h.G), 1);
  });

  test("no VERCEL_GIT_PREVIOUS_SHA (أول بناء على فرع) ⇒ exit 1 — fail-open", () => {
    assert.equal(ignoredBuildExit(repo, null, h.G), 1);
  });

  test("unknown base SHA (فشل git) ⇒ exit 1 — fail-open", () => {
    assert.equal(ignoredBuildExit(repo, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", h.G), 1);
  });

  test("no changes since base ⇒ exit 0 (skip) — لا داعي لبناء جديد", () => {
    assert.equal(ignoredBuildExit(repo, h.G, h.G), 0);
  });

  test("العقد حرفيًا: المخرجان الوحيدان المسموحان 0 و1", () => {
    const pairs: Array<[string | null, string]> = [
      [h.A, h.B],
      [h.B, h.C],
      [h.C, h.D],
      [h.D, h.E],
      [h.E, h.F],
      [h.F, h.G],
      [h.G, h.G],
      [null, h.G],
    ];
    for (const [base, head] of pairs) {
      const code = ignoredBuildExit(repo, base, head);
      assert.ok(code === 0 || code === 1, `unexpected exit ${code} for ${base}..${head}`);
    }
  });
});
