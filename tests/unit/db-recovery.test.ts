import { describe, it, expect, vi, beforeEach } from "vitest";

// محاكاة عميل libsql: يفشل أولاً ثم ينجح — لمحاكاة انقطاع DB عابر ثم استعادتها
let shouldFail = true;
const mockClient = {
  batch: vi.fn(async () => {
    if (shouldFail) throw new Error("simulated db failure");
    return { rows: [] };
  }),
  execute: vi.fn(async () => {
    if (shouldFail) throw new Error("simulated db failure");
    // الصفوف تخدم استعلامات COUNT و version في مسار الإقلاع
    return { rows: [{ n: 0 }] };
  }),
  transaction: vi.fn(),
};

vi.mock("@libsql/client", () => ({
  createClient: vi.fn(() => mockClient),
}));

describe("db recovery (db.ts ensureSchema)", () => {
  beforeEach(() => {
    vi.resetModules();
    shouldFail = true;
    process.env.TURSO_DATABASE_URL = "file:/tmp/smoke-never-created.db";
    process.env.TURSO_AUTH_TOKEN = "unused-for-file";
  });

  it("REGRESSION: after a failure the next call retries instead of being poisoned forever", async () => {
    const { ensureSchema } = await import("@/lib/db");

    // أول فشل (انقطاع عابر)
    await expect(ensureSchema()).rejects.toThrow("simulated db failure");

    // استعادة DB — المحاولة التالية يجب أن تنجح (لا وعد مرفوض مخزّن)
    shouldFail = false;
    let recovered = false;
    try {
      await ensureSchema();
      recovered = true;
    } catch {
      recovered = false;
    }
    expect(recovered).toBe(true);
  });

  it("hasDB() reflects the configuration", async () => {
    const { hasDB } = await import("@/lib/db");
    expect(hasDB()).toBe(true);
    delete process.env.TURSO_DATABASE_URL;
    expect(hasDB()).toBe(false);
  });
});
