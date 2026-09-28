import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  composeLocalAnswer,
  packSizeMl,
  MAX_RECOMMENDATIONS,
} from "../src/lib/ai/local-answer";
import type { Product } from "../src/lib/seed";

/**
 * انحدار D-4 وD-5 — محرّك الرد الاحتياطي.
 *
 * هذا هو المسار الذي يخدم العميل فعلًا حين لا توجد مفاتيح API، لذلك أخطاؤه
 * أخطاء إنتاج لا أخطاء اختبار. كل اختبار هنا يقابل قياسًا في مختبر What-If:
 *
 *  - D-4 (WF-013): سؤال عن المنتجات كان يخطفه جواب عن الدفع، لأن الأسئلة
 *    الشائعة كانت تُفحص *قبل* المنتجات وتُقبل عند درجة ≥ 1، و«متاح» جزء من
 *    «المتاحة» في سؤال طرق الدفع.
 *  - D-5 (WF-012): «هات الكبير» كان يُعيد المقاسين معًا بلا حسم.
 *  - D-5 (WF-014): صنفان متطابقان كانا يُستبعدان صامتًا لأن الترتيب يقطع عند
 *    أول 3 والتعادل يُحسم بترتيب الكتالوج لا بشيء معلن.
 */

function product(p: Partial<Product> & { id: string; name: string; price: number }): Product {
  return {
    description: "",
    category: "",
    image: "🧴",
    stock: 10,
    ...p,
  };
}

// نفس أسئلة المتجر الفعلية — «المتاحة» هي مصدر الخطف.
const FAQ = [
  { question: "ما هي طرق الدفع المتاحة؟", answer: "فودافون كاش أو الدفع عند الاستلام." },
  { question: "كم تكلفة الشحن؟", answer: "50 جنيه، ومجاني فوق 1000 جنيه." },
];

describe("local answer — pack size parsing", () => {
  test("reads litres and millilitres into a comparable unit", () => {
    assert.equal(packSizeMl("منظف أرضيات 5 لتر"), 5000);
    assert.equal(packSizeMl("منظف أرضيات 1 لتر"), 1000);
    assert.equal(packSizeMl("مزيل دهون 750 مل"), 750);
    assert.equal(packSizeMl("منظف 1.5 لتر"), 1500);
  });

  test("refuses to compare incompatible units instead of guessing", () => {
    // الخلط بين كجم وعبوات ولترات أسوأ من الامتناع عن الحسم.
    assert.equal(packSizeMl("مسحوق غسيل 5 كجم"), null);
    assert.equal(packSizeMl("فوط ميكروفايبر (عبوة 6 قطع)"), null);
    assert.equal(packSizeMl("طقم مساحة أرضيات"), null);
  });
});

describe("local answer — D-4: FAQ must not hijack a product question", () => {
  const catalog = [
    product({ id: "a", name: "منظف أرضيات مركز 1 لتر", price: 45, category: "منظفات أرضيات", description: "تركيز عالٍ" }),
    product({ id: "b", name: "منظف أرضيات فاخر 5 لتر", price: 180, category: "منظفات أرضيات" }),
  ];

  test("a product question containing «متاح» gets products, not payment info", () => {
    const reply = composeLocalAnswer("هات أرخص منظف أرضيات متاح", catalog, FAQ);

    assert.ok(!/فودافون كاش أو الدفع عند الاستلام/.test(reply), `خُطف بواسطة FAQ: ${reply}`);
    assert.match(reply, /45 جنيه/);
  });

  test("the old rule (FAQ wins on a single shared word) is gone", () => {
    // «متاح» ⊂ «المتاحة» ⇒ درجة FAQ = 1، ودرجة المنتج = 2. المنتج يجب أن يفوز.
    const reply = composeLocalAnswer("منظف أرضيات متاح", catalog, FAQ);
    assert.match(reply, /•/);
    assert.ok(!/^فودافون كاش/.test(reply));
  });

  test("a genuine FAQ question is still answered from the FAQ", () => {
    // لا يصح أن نُصلح الخطف بكسر الأسئلة الشائعة الحقيقية.
    const reply = composeLocalAnswer("ما هي طرق الدفع المتاحة؟", catalog, FAQ);
    assert.equal(reply, "فودافون كاش أو الدفع عند الاستلام.");
  });

  test("an unrelated FAQ question does not win over a weak product match", () => {
    const reply = composeLocalAnswer("عايز منظف", catalog, FAQ);
    assert.match(reply, /منظف أرضيات/);
  });
});

describe("local answer — D-5: size is resolved, not listed", () => {
  const catalog = [
    product({ id: "s", name: "منظف أرضيات برائحة اللافندر 1 لتر", price: 60, category: "منظفات أرضيات" }),
    product({ id: "l", name: "منظف أرضيات برائحة اللافندر 5 لتر", price: 180, category: "منظفات أرضيات" }),
  ];

  test("«هات الكبير» resolves to the 5L pack alone", () => {
    const reply = composeLocalAnswer("هات الكبير من منظف الأرضيات باللافندر", catalog, FAQ);

    assert.match(reply, /5\s*لتر/);
    assert.doesNotMatch(reply, /1\s*لتر/, "عرض المقاسين معًا = لا حسم");
    assert.match(reply, /180 جنيه/);
    assert.ok(!/60 جنيه/.test(reply));
  });

  test("«هات الصغير» resolves to the 1L pack alone", () => {
    const reply = composeLocalAnswer("هات الصغير من منظف الأرضيات", catalog, FAQ);

    assert.match(reply, /1\s*لتر/);
    assert.doesNotMatch(reply, /5\s*لتر/);
    assert.match(reply, /60 جنيه/);
  });

  test("with no size word, both sizes stay on offer", () => {
    const reply = composeLocalAnswer("عايز منظف أرضيات", catalog, FAQ);
    assert.match(reply, /1\s*لتر/);
    assert.match(reply, /5\s*لتر/);
  });

  test("size resolution never invents a winner when no pack size is parseable", () => {
    const unmeasurable = [
      product({ id: "x", name: "طقم مساحة أرضيات", price: 320, category: "أدوات" }),
      product({ id: "y", name: "فوط ميكروفايبر", price: 90, category: "أدوات" }),
    ];
    const reply = composeLocalAnswer("هات الكبير من أدوات النظافة", unmeasurable, FAQ);
    // لا أحجام قابلة للمقارنة ⇒ لا حسم مصطنع؛ يُعرض المتاح.
    assert.match(reply, /طقم مساحة|فوط ميكروفايبر/);
  });
});

describe("local answer — D-5: availability and silent drops", () => {
  test("the cheapest out-of-stock item is never recommended", () => {
    const catalog = [
      product({ id: "c", name: "منظف أرضيات اقتصادي 1 لتر", price: 30, stock: 0, category: "منظفات أرضيات" }),
      product({ id: "m", name: "منظف أرضيات مركز 1 لتر", price: 45, stock: 10, category: "منظفات أرضيات" }),
    ];
    const reply = composeLocalAnswer("أرخص منظف أرضيات", catalog, FAQ);

    assert.ok(!/اقتصادي/.test(reply), "رشّح الصنف النافد");
    assert.ok(!/30 جنيه/.test(reply));
    assert.match(reply, /45 جنيه/);
  });

  test("cheapest first among equal relevance", () => {
    const catalog = [
      product({ id: "p", name: "منظف أرضيات فاخر 5 لتر", price: 180, category: "منظفات أرضيات" }),
      product({ id: "q", name: "منظف أرضيات مركز 1 لتر", price: 45, category: "منظفات أرضيات" }),
    ];
    const reply = composeLocalAnswer("عايز منظف أرضيات", catalog, FAQ);
    const lines = reply.split("\n").filter((l) => l.includes("•"));
    assert.match(lines[0], /45 جنيه/);
  });

  test("when everything matching is sold out, it says so instead of recommending", () => {
    const catalog = [product({ id: "z", name: "منظف أرضيات 1 لتر", price: 45, stock: 0, category: "منظفات أرضيات" })];
    const reply = composeLocalAnswer("عايز منظف أرضيات", catalog, FAQ);

    assert.match(reply, /نفدت/);
    assert.ok(!/•/.test(reply), "لا يجوز عرض أصناف نافدة كترشيح");
  });

  test("two near-identical products are both shown, not one silently", () => {
    const catalog = [
      product({ id: "lemon", name: "منظف حمامات برائحة الليمون 1 لتر", price: 72, category: "منظفات حمامات" }),
      product({ id: "lav", name: "منظف حمامات برائحة اللافندر 1 لتر", price: 74, category: "منظفات حمامات" }),
    ];
    const reply = composeLocalAnswer("عايز منظف حمامات", catalog, FAQ);

    assert.match(reply, /ليمون/);
    assert.match(reply, /لافندر/);
  });

  test("ties are ordered by price then name, not by catalog order", () => {
    // لو كان الترتيب بترتيب الكتالوج لفاز الأغلى المُدرَج أولًا.
    const catalog = [
      product({ id: "dear", name: "منظف حمامات ألف 1 لتر", price: 99, category: "منظفات حمامات" }),
      product({ id: "cheap", name: "منظف حمامات باء 1 لتر", price: 50, category: "منظفات حمامات" }),
    ];
    const reply = composeLocalAnswer("عايز منظف حمامات", catalog, FAQ);
    const lines = reply.split("\n").filter((l) => l.includes("•"));
    assert.match(lines[0], /50 جنيه/);
  });

  test("overflow is announced, never dropped silently", () => {
    const many = Array.from({ length: MAX_RECOMMENDATIONS + 4 }, (_, i) =>
      product({ id: `m${i}`, name: `منظف حمامات رقم ${i} 1 لتر`, price: 50 + i, category: "منظفات حمامات" })
    );
    const reply = composeLocalAnswer("عايز منظف حمامات", many, FAQ);

    const shown = reply.split("\n").filter((l) => l.includes("•")).length;
    assert.equal(shown, MAX_RECOMMENDATIONS);
    assert.match(reply, /وفيه كمان 4 صنف تاني مطابق/);
  });
});

describe("local answer — safety", () => {
  test("no match yields a greeting, never an invented product or price", () => {
    const catalog = [product({ id: "a", name: "منظف أرضيات 1 لتر", price: 45, category: "منظفات أرضيات" })];
    const reply = composeLocalAnswer("محتاج حاجة", catalog, FAQ);

    assert.ok(reply.length > 20);
    assert.ok(!/ORD-/.test(reply));
    assert.ok(!/45 جنيه/.test(reply), "لا يجوز اختلاق سعر لطلب غامض");
  });

  test("a query for a nonexistent product does not confirm availability", () => {
    const catalog = [product({ id: "a", name: "منظف أرضيات 1 لتر", price: 45, category: "منظفات أرضيات" })];
    const reply = composeLocalAnswer("عندكم منظف زئبق للقمر؟", catalog, FAQ);
    assert.ok(!/زئبق للقمر/.test(reply));
  });
});
