import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PROVIDER_ORDER,
  resolveProviderOrder,
  PROVIDER_ORDER_ENV,
} from "../src/lib/ai/chain-order";

/**
 * ترتيب سلسلة التراجع — حراسة صارمة fail-closed:
 *  - غياب `AI_PROVIDER_ORDER` ⇒ الترتيب التاريخي الافتراضي كما هو.
 *  - الأسماء غير المعروفة تُتجاهل، ولا تُمنح أي ترقية ضمنية.
 *  - `local` مضمون دائمًا في النهاية مهما كانت القائمة (لا مسار يصل فيه خطأ
 *    500 إلى المستخدم).
 *  - قائمة فارغة أو فاسدة بالكامل ⇒ العودة للترتيب الافتراضي حرفيًا.
 */

beforeEach(() => {
  delete process.env[PROVIDER_ORDER_ENV];
});
afterEach(() => {
  delete process.env[PROVIDER_ORDER_ENV];
});

describe("provider chain order resolution", () => {
  test("absent env → historical default order", () => {
    assert.deepEqual(resolveProviderOrder(undefined), [...DEFAULT_PROVIDER_ORDER]);
    assert.ok(DEFAULT_PROVIDER_ORDER[0] === "gemini");
    assert.ok(DEFAULT_PROVIDER_ORDER[DEFAULT_PROVIDER_ORDER.length - 1] === "local");
  });

  test("known names reorder; local always stays last", () => {
    const order = resolveProviderOrder("groq,gemini");
    assert.deepEqual(order, ["groq", "gemini", "local"]);
  });

  test("unknown names are ignored (fail-closed)", () => {
    process.env[PROVIDER_ORDER_ENV] = "vendor-locked,gemini,xyz";
    assert.deepEqual(resolveProviderOrder(), ["gemini", "local"]);
  });

  test("all-invalid list falls back to the default order", () => {
    process.env[PROVIDER_ORDER_ENV] = "bad-one,another-bad";
    assert.deepEqual(resolveProviderOrder(), [...DEFAULT_PROVIDER_ORDER]);
  });

  test("local can never be dropped from the tail", () => {
    process.env[PROVIDER_ORDER_ENV] = "gemini,groq,nvidia-nim";
    const order = resolveProviderOrder();
    assert.equal(order[order.length - 1], "local");
  });
});
