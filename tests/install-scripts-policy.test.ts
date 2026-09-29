import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * سياسة سكربتات التثبيت (npm ≥ 11.16 / 12).
 *
 * npm الحديث (وهو ما تستخدمه حاويات بناء Vercel) يطبع في نهاية كل تثبيت:
 *   npm warn install-scripts 4 packages have install scripts not yet covered by allowScripts
 * وفي npm 12 تُحجب سكربتات التبعيات افتراضيًا ما لم يرد اسم الحزمة في حقل
 * `allowScripts` داخل package.json. هذا الاختبار يجعل القائمة صادقة بالاتجاهين:
 *   - كل حزمة في package-lock.json لها سكربت تثبيت (`hasInstallScript`) مغطّاة
 *     بقرار صريح (true/false) — فلا تعود التحذيرات، ولا تصل حزمة جديدة بسكربت
 *     إلى الإنتاج دون مراجعة؛
 *   - لا مدخل بلا حزمة مقابلة (قائمة متقادمة تُوهم بمراجعة لم تعد تعني شيئًا).
 */

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  allowScripts?: Record<string, unknown>;
};
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")) as {
  packages: Record<string, { version?: string; hasInstallScript?: boolean }>;
};

const nameOf = (lockPath: string) => lockPath.slice(lockPath.lastIndexOf("node_modules/") + "node_modules/".length);
const withScripts = Object.entries(lock.packages)
  .filter(([lockPath, meta]) => lockPath && meta.hasInstallScript)
  .map(([lockPath, meta]) => ({ name: nameOf(lockPath), version: String(meta.version) }));

describe("package.json allowScripts ↔ package-lock.json hasInstallScript", () => {
  const allow = pkg.allowScripts ?? {};

  test("allowScripts exists and holds only booleans", () => {
    assert.ok(pkg.allowScripts && Object.keys(allow).length > 0, "حقل allowScripts مفقود");
    for (const [key, value] of Object.entries(allow)) {
      assert.equal(typeof value, "boolean", `${key} يجب أن يكون true أو false`);
    }
  });

  test("every installed package with an install script has an explicit decision", () => {
    assert.ok(withScripts.length > 0, "لا حزم بسكربت تثبيت — تحقق من قراءة القفل");
    const undecided = withScripts.filter(
      ({ name, version }) => typeof allow[name] !== "boolean" && typeof allow[`${name}@${version}`] !== "boolean",
    );
    assert.deepEqual(
      undecided.map(({ name, version }) => `${name}@${version}`),
      [],
      "حزم بسكربت تثبيت بلا قرار في allowScripts: راجعها ثم `npm install-scripts approve <pkg>` أو `deny <pkg>`",
    );
  });

  test("no stale entry: each allowScripts key still matches an installed package with a script", () => {
    const known = new Set(withScripts.flatMap(({ name, version }) => [name, `${name}@${version}`]));
    const stale = Object.keys(allow).filter((key) => !known.has(key));
    assert.deepEqual(stale, [], "مداخل allowScripts بلا حزمة مقابلة (احذفها أو حدّث الإصدار): npm install-scripts prune");
  });

  test("the approved set stays the reviewed one (build tooling only, no runtime dependency)", () => {
    const approved = Object.entries(allow).filter(([, value]) => value === true).map(([key]) => key).sort();
    // esbuild (tsx/drizzle-kit)، fsevents (macOS فقط، اختياري)، unrs-resolver (محلّل ESLint الأصلي).
    assert.deepEqual(approved, ["esbuild", "fsevents", "unrs-resolver"]);
    const production = new Set(
      Object.keys((JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { dependencies: object }).dependencies),
    );
    for (const name of approved) assert.ok(!production.has(name), `${name} تبعية إنتاج — لا تُعتمد بلا مراجعة أمنية صريحة`);
  });
});
