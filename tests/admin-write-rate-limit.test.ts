import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

/**
 * D-9 — كتابة إدارة المنتجات بلا حدّ معدّل.
 *
 * كان كل مسار كتابة آخر مُقنَّنًا (chat 30، orders 8، track 5، login 8،
 * orders PATCH 30) ومسارا كتابة الإدارة في /api/products ليسا كذلك. قيس ذلك
 * على بناء الإنتاج: 32 طلبًا على /api/chat → 429، وعلى /api/products → صفر حدّ.
 *
 * الاختبار يرسل **حمولة غير صالحة** عمدًا، فلا يتغيّر شيء في الكتالوج، لكن
 * `enforceRateLimit` يعمل قبل التحقق من المخطط فيستهلك الحصة — وهذا بالضبط ما
 * يجعل القياس آمنًا وقابلًا للتكرار.
 *
 * ويغطي أيضًا الخطر الذي أدخله الإصلاح نفسه: `enforceRateLimit` كانت معرَّفة
 * محليًا داخل `orders/route.ts` ورُفعت إلى `@/lib/rate-limit` حتى لا تُنسخ.
 * فالرفع قد يكسر حدّ orders صامتًا، ولذلك يُقاس هنا لا يُفترض.
 */

const SECRET = "x".repeat(40);

const KEYS = ["ADMIN_SESSION_SECRET", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"] as const;

function resetEnv() {
  for (const key of KEYS) delete process.env[key];
  // بلا TURSO_DATABASE_URL تسقط rate-limit إلى المخزن في الذاكرة، فلا نلمس
  // قاعدة البيانات الحيّة ولا نتأثر بحالة اختبار آخر.
}

/** كل اختبار يأخذ IP مستقلًا: مفتاح العدّاد هو `scope:ip`، فالعزل يمنع تداخل العدّ. */
let ipSeq = 0;
function freshIp() {
  ipSeq += 1;
  return `198.51.100.${ipSeq}`;
}

async function adminCookie() {
  const { ADMIN_COOKIE, createAdminSession } = await import("../src/lib/auth");
  return `${ADMIN_COOKIE}=${createAdminSession()}`;
}

beforeEach(() => {
  resetEnv();
  process.env.ADMIN_SESSION_SECRET = SECRET;
});
afterEach(resetEnv);

describe("D-9: admin product writes are rate limited", () => {
  test("POST /api/products returns 429 after the limit instead of running unbounded", async () => {
    const { POST } = await import("../src/app/api/products/route");
    const cookie = await adminCookie();
    const ip = freshIp();

    const codes: number[] = [];
    for (let i = 0; i < 34; i++) {
      const res = await POST(
        new Request("http://x/api/products", {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie, "x-forwarded-for": ip },
          // حمولة غير صالحة → 422، فلا تُكتب أي سلعة
          body: JSON.stringify({ __probe: i }),
        })
      );
      codes.push(res.status);
    }

    assert.ok(
      codes.includes(429),
      `كتابة إدارة المنتجات يجب أن تبلغ حد المعدل؛ الأكواد الفعلية: ${JSON.stringify(codes)}`
    );
    assert.equal(codes[0], 422, "أول طلب يجب أن يصل إلى التحقق من المخطط (422) لا أن يُحجب");
    assert.equal(
      codes.indexOf(429),
      30,
      "الحدّ 30 / 10 د، فالطلب رقم 31 هو أول محجوب"
    );
    assert.equal(
      codes.filter((c) => c === 429).length,
      4,
      "الطلبات الأربعة بعد الحدّ كلها 429"
    );
  });

  test("DELETE /api/products is limited on the same admin bucket", async () => {
    const { DELETE } = await import("../src/app/api/products/route");
    const cookie = await adminCookie();
    const ip = freshIp();

    const codes: number[] = [];
    for (let i = 0; i < 34; i++) {
      // id غير موجود → لا حذف فعلي، لكن الحصة تُستهلك
      const res = await DELETE(
        new Request(`http://x/api/products?id=__nope_${i}`, {
          method: "DELETE",
          headers: { cookie, "x-forwarded-for": ip },
        })
      );
      codes.push(res.status);
    }

    assert.ok(
      codes.includes(429),
      `حذف إدارة المنتجات يجب أن يبلغ حد المعدل؛ الأكواد: ${JSON.stringify(codes)}`
    );
    assert.equal(codes.indexOf(429), 30);
  });

  test("POST and DELETE share one admin bucket (one limit, not two)", async () => {
    const { POST, DELETE } = await import("../src/app/api/products/route");
    const cookie = await adminCookie();
    const ip = freshIp();
    const headers = () => ({
      "Content-Type": "application/json",
      cookie,
      "x-forwarded-for": ip,
    });

    // 15 POST ثم 15 DELETE = 30 على نفس المفتاح، فالواحد والثلاثون محجوب
    for (let i = 0; i < 15; i++) {
      await POST(
        new Request("http://x/api/products", {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ __probe: i }),
        })
      );
    }
    for (let i = 0; i < 15; i++) {
      await DELETE(
        new Request(`http://x/api/products?id=__nope_${i}`, { method: "DELETE", headers: headers() })
      );
    }

    const after = await POST(
      new Request("http://x/api/products", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ __probe: "over" }),
      })
    );
    assert.equal(after.status, 429, "المساران يتقاسمان حصة واحدة — لا يضاعفان الحدّ");
  });

  test("the limit is per client, not global", async () => {
    const { POST } = await import("../src/app/api/products/route");
    const cookie = await adminCookie();

    // عميل يستهلك حصته كاملة
    const spent = freshIp();
    for (let i = 0; i < 31; i++) {
      await POST(
        new Request("http://x/api/products", {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie, "x-forwarded-for": spent },
          body: JSON.stringify({ __probe: i }),
        })
      );
    }

    // عميل آخر لا يتأثر — وإلا صار الحدّ أداة حجب خدمة على الإدارة كلها
    const other = freshIp();
    const res = await POST(
      new Request("http://x/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie, "x-forwarded-for": other },
        body: JSON.stringify({ __probe: "fresh" }),
      })
    );
    assert.equal(res.status, 422, "عميل جديد يجب أن يمرّ إلى التحقق لا أن يُحجب بذنب غيره");
  });

  test("unauthenticated callers are rejected before consuming any quota", async () => {
    const { POST } = await import("../src/app/api/products/route");
    const ip = freshIp();

    for (let i = 0; i < 5; i++) {
      const res = await POST(
        new Request("http://x/api/products", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify({ __probe: i }),
        })
      );
      assert.equal(res.status, 401, "بلا جلسة إدارة يجب أن يكون 401 دائمًا");
    }
  });
});

describe("D-9 refactor: lifting enforceRateLimit did not break existing limits", () => {
  test("POST /api/orders still returns 429 after 8", async () => {
    const { POST } = await import("../src/app/api/orders/route");
    const ip = freshIp();

    const codes: number[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await POST(
        new Request("http://x/api/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify({ __probe: i }),
        })
      );
      codes.push(res.status);
    }

    assert.ok(codes.includes(429), `حدّ الطلبات يجب أن يبقى عاملًا؛ الأكواد: ${JSON.stringify(codes)}`);
    assert.equal(codes.indexOf(429), 8, "حدّ الطلبات 8 / 10 د");
  });

  test("enforceRateLimit is exported once from the shared module", async () => {
    const mod = await import("../src/lib/rate-limit");
    assert.equal(typeof mod.enforceRateLimit, "function");

    // الحارس البنيوي: لا نسخة ثانية. هذا هو درس D-8 — عيب المنطق المكرَّر أن
    // الإصلاح يصل إلى نسخة وتبقى الأخرى.
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts") && p.endsWith("src/lib/rate-limit.ts") === false) {
          if (/^\s*(?:async\s+)?function\s+enforceRateLimit\b/m.test(readFileSync(p, "utf8"))) {
            offenders.push(p);
          }
        }
      }
    };
    walk(new URL("../src", import.meta.url).pathname);
    assert.deepEqual(offenders, [], `نسخ مكررة من enforceRateLimit: ${offenders.join("، ")}`);
  });
});
