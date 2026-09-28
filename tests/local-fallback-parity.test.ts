import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { buildLocalAnswer } from "../src/lib/ai/providers/local-fallback";
import { composeLocalAnswer } from "../src/lib/ai/local-answer";
import { getProducts, getFaq } from "../src/lib/db";

/**
 * انحدار: مسارا الرد الاحتياطي يجب ألا يتباعدا مرة أخرى.
 *
 * كان في المشروع تنفيذان مستقلان للمنطق نفسه:
 *  - `src/lib/ai/local-answer.ts`        → مسار الدردشة (`/api/chat` بلا مفاتيح)
 *  - `src/lib/ai/providers/local-fallback.ts` → آخر حلقة في المحرك النمطي
 *
 * فلمّا أُصلح خطف الأسئلة الشائعة (D-4) وحسم المقاس والإسقاط الصامت (D-5)
 * في الأول، بقي الثاني على السلوك القديم وأعاد «هات أرخص منظف أرضيات متاح»
 * جوابًا عن طرق الدفع. والأخطر أن الثاني هو ما سيعمل فعلًا بعد توصيل
 * Gemini/Celia، فكان سيُعيد إنتاج العيوب المُصلَحة حرفيًا.
 *
 * لذلك يثبّت هذا الاختبار أن المسارين يُنتجان نصًا واحدًا حرفيًا، فيسقط فورًا
 * لو أعاد أحد نسخة خاصة من السياسة.
 */

const QUERIES = [
  "هات أرخص منظف أرضيات متاح", // D-4: كان يخطفه FAQ
  "هات الكبير من منظف الأرضيات باللافندر", // D-5: حسم المقاس
  "عايز منظف حمامات", // D-5: صنفان متشابهان
  "ما هي طرق الدفع المتاحة؟", // سؤال FAQ حقيقي يجب أن يبقى يجاب من FAQ
  "محتاج حاجة", // أمر غامض
];

describe("local fallback parity — المساران لا يتباعدان", () => {
  before(() => {
    process.env.TURSO_DATABASE_URL = "file:local.db";
  });

  for (const q of QUERIES) {
    test(`agent path === route path for «${q}»`, async () => {
      const [agentPath, products, faq] = await Promise.all([
        buildLocalAnswer(q),
        getProducts(),
        getFaq(),
      ]);
      const routePath = composeLocalAnswer(q, products, faq);

      assert.equal(
        agentPath,
        routePath,
        "المساران أنتجا نصين مختلفين — سياسة الرد الاحتياطي متكررة وتباعدت"
      );
    });
  }

  test("the agent path is not hijacked by the payment FAQ", async () => {
    // هذا هو العيب بعينه على المسار الذي كان ما زال مصابًا.
    const reply = await buildLocalAnswer("هات أرخص منظف أرضيات متاح");

    assert.match(reply, /•/, "لا يوجد ترشيح منتج واحد في الرد");
    assert.match(reply, /\d+\s*جنيه/, "لا يوجد سعر في الرد");
    assert.ok(
      !/^الدفع عن طريق/.test(reply),
      `خُطف سؤال المنتجات بجواب عن الدفع: ${reply.slice(0, 80)}`
    );
  });

  test("a real FAQ question still reaches the FAQ on the agent path", async () => {
    // التوحيد لا يصح أن يكسر الأسئلة الشائعة الحقيقية.
    const reply = await buildLocalAnswer("ما هي طرق الدفع المتاحة؟");
    assert.match(reply, /فودافون كاش|الدفع عند الاستلام/);
    assert.ok(!/•/.test(reply), "سؤال عن الدفع لا يجب أن يُجاب بقائمة منتجات");
  });
});
