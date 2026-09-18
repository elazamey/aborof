import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  InMemoryRateLimitStore,
  TursoRateLimitStore,
} from "../src/lib/rate-limit";

// قاعدة بيانات ملف مشتركة: نسختا المخزن تتشاركان نفس الملف كما تتشارك
// نسخ Serverless نفس قاعدة Turso في الإنتاج.
const SHARED_DB = `file:${path.join(tmpdir(), `aborof-rl-${process.pid}-${Date.now()}.db`)}`;

describe("in-memory rate limit store", () => {
  test("enforces limit within a window and reports retry-after", async () => {
    const store = new InMemoryRateLimitStore();
    const ok = [];
    for (let i = 0; i < 5; i++) ok.push(await store.hit("k1", 3, 60_000));
    assert.equal(ok.filter((r) => r.ok).length, 3);
    assert.equal(ok[4].ok, false);
    assert.ok(ok[4].retryAfter >= 1);
  });

  test("window resets after expiry", async () => {
    // وقت وهمي قابل للتحكم بدل الاعتماد على ساعة النظام: نافذة 1 مللي ثانية
    // الحقيقية تتقلب بين تنفيذين (اختلاف التوقيت بين استدعاءين متتاليين)،
    // فجعلنا الزمن صريحًا حتى يكون الاختبار حتميًا على أي جهاز أو في CI.
    const store = new InMemoryRateLimitStore();
    const realNow = Date.now;
    let fakeTime = 1_000_000;
    Date.now = () => fakeTime;
    try {
      await store.hit("k2", 1, 1_000);
      const blocked = await store.hit("k2", 1, 1_000);
      assert.equal(blocked.ok, false, "ثاني طلب داخل النافذة نفسها يجب أن يُحجب");
      fakeTime += 1_001; // نتجاوز نهاية النافذة (resetAt) صراحة
      const allowed = await store.hit("k2", 1, 1_000);
      assert.equal(allowed.ok, true, "انتهاء النافذة يجب أن يبدأ عدّادًا جديدًا");
      assert.equal(allowed.count, 1);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("distributed (Turso) rate limit store", () => {
  before(() => {
    process.env.TURSO_DATABASE_URL = SHARED_DB;
    delete process.env.TURSO_AUTH_TOKEN;
  });

  test("atomic upsert: concurrent hits across two store instances cannot exceed the limit", async () => {
    // نسختان منطقيتان (محاكاة نسختي Serverless) تتشاركان نفس قاعدة البيانات.
    const instanceA = new TursoRateLimitStore();
    const instanceB = new TursoRateLimitStore();

    const LIMIT = 5;
    const WINDOW = 60_000;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? instanceA : instanceB).hit("login:1.2.3.4", LIMIT, WINDOW)
      )
    );
    const allowed = results.filter((r) => r.ok);
    assert.equal(allowed.length, LIMIT, "exactly the limit must pass across instances");
    assert.equal(results.every((r) => typeof r.count === "number"), true);
    // أول طلب بعد الحد يجب أن يعطي Retry-After موجبًا.
    const firstBlocked = results.find((r) => !r.ok);
    assert.ok(firstBlocked && firstBlocked.retryAfter > 0);
  });

  test("distinct bucket keys are isolated", async () => {
    const store = new TursoRateLimitStore();
    const r1 = await store.hit("chat:9.9.9.9", 1, 60_000);
    const r2 = await store.hit("chat:8.8.8.8", 1, 60_000);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true, "different bucket must start fresh");
  });
});
