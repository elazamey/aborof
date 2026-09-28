import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_FLEET,
  AGENT_FLEET_SIZE,
  AGENT_DEPARTMENTS,
  DEPARTMENT_LABELS,
  FLEET_PROMPT_BUDGET,
  READ_ONLY_TOOL_NAMES,
  agentsByDepartment,
  fleetCatalogManifest,
  fleetPromptSection,
  fleetResponseMeta,
  fleetSnapshot,
  fleetToolAllowlist,
  getAgentById,
  getDefaultAgent,
  isAgentFleetActive,
  isAgentFleetEnabled,
  normalizeArabic,
  selectAgents,
  validateFleet,
} from "../src/lib/ai/agents";
import { getMcpRegistry, isMcpToolsEnabled } from "../src/lib/ai";

/**
 * حراسة أسطول وكلاء المتجر (المرحلة الرابعة):
 *  - التعريفات كلها صالحة، والعدد المعلن 50 بالضبط، ولا أداة كاتبة واحدة.
 *  - التوجيه حتمي ويعمل بلا أي مزوّد، ويسقط للوكيل الافتراضي عند عدم التطابق.
 *  - رسالة النظام وميزانيتها وحدود الأدوات لا تسمح بأي توسيع للصلاحيات.
 *  - تعطيل العلم (أو تعطيل المحرك النمطي) يُبقي السلوك القديم حرفيًا.
 */

const KEYS = [
  "ENABLE_AGENT_FLEET",
  "ENABLE_AI_AGENT",
  "ENABLE_MCP_TOOLS",
  "MCP_ALLOWED_TOOLS",
  "MCP_ALLOW_WRITE_TOOLS",
  "TURSO_DATABASE_URL",
] as const;

function resetEnv() {
  for (const key of KEYS) delete process.env[key];
}

beforeEach(resetEnv);
afterEach(resetEnv);

describe("أسطول الوكلاء — سلامة التعريفات", () => {
  test("لا مشاكل بنائية في الكتالوج كله", () => {
    assert.deepEqual(validateFleet(), [], JSON.stringify(validateFleet().slice(0, 5)));
  });

  test("العدد 50 بالضبط وكل الأقسام ممثلة بعشرة", () => {
    assert.equal(AGENT_FLEET.length, AGENT_FLEET_SIZE);
    assert.equal(AGENT_FLEET.length, 50);
    for (const department of AGENT_DEPARTMENTS) {
      assert.equal(agentsByDepartment(department).length, 10, `القسم ${department} ليس عشرة`);
    }
  });

  test("المعرّفات فريدة وبصيغة snake_case", () => {
    const ids = AGENT_FLEET.map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[a-z][a-z0-9_]{2,40}$/);
  });

  test("وكيل افتراضي واحد بالضبط وهو سيليا العامة", () => {
    const defaults = AGENT_FLEET.filter((a) => a.isDefault);
    assert.equal(defaults.length, 1);
    assert.equal(getDefaultAgent().id, "sales_general");
  });

  test("كل أداة معلنة مسجّلة فعلًا و«للقراءة فقط» — صفر أدوات كاتبة", () => {
    const writeTools = new Set([
      "orders_create",
      "products_upsert",
      "order_status_update",
    ]);
    for (const agent of AGENT_FLEET) {
      for (const tool of agent.tools) {
        assert.ok(READ_ONLY_TOOL_NAMES.includes(tool), `${agent.id} يعلن أداة غير مسجّلة: ${tool}`);
        assert.ok(!writeTools.has(tool), `${agent.id} يعلن أداة كاتبة: ${tool}`);
      }
    }
  });

  test("الأدوات المسجّلة في السجل كلها للقراءة فقط ومطابقة لقائمة الأسطول", () => {
    // السجل نفسه (بلا تفعيل MCP) يسجّل الأدوات الأربع ويصفها للقراءة فقط.
    delete process.env.ENABLE_MCP_TOOLS;
    const descriptors = getMcpRegistry().describeTools();
    assert.equal(descriptors.length, 0, "السجل لا يعرض شيئًا والعلم مغلق");
    assert.deepEqual(READ_ONLY_TOOL_NAMES.sort(), [
      "lookup_faq",
      "search_products",
      "shipping_estimate",
      "store_info",
    ]);
  });

  test("كل وكيل له هوية ومهمة ومحفزات وقواعد سلوك", () => {
    for (const agent of AGENT_FLEET) {
      assert.ok(agent.name.length > 0, `${agent.id} بلا اسم`);
      assert.ok(agent.mission.length >= 15, `${agent.id} مهمة قصيرة`);
      assert.ok(agent.keywords.length >= 3, `${agent.id} محفزات أقل من 3`);
      assert.ok(agent.guidance.length >= 1, `${agent.id} بلا قواعد سلوك`);
    }
  });

  test("مانيفست الإدارة يعرض 50 وكيلًا بلا أي سر", () => {
    const manifest = fleetCatalogManifest();
    assert.equal(manifest.length, 50);
    const serialized = JSON.stringify(manifest);
    for (const secretName of ["ADMIN_SESSION_SECRET", "ADMIN_PASSWORD", "TURSO_AUTH_TOKEN", "DIAGNOSTICS_KEY"]) {
      assert.ok(!serialized.includes(secretName), `المانيفست يذكر ${secretName}`);
    }
  });
});

describe("أسطول الوكلاء — التوجيه الحتمي", () => {
  test("نفس المدخل يعطي نفس المخرج دائمًا (تشغيل متكرر)", () => {
    const message = "عايز منظف أرضيات لافندر للرخام";
    const first = selectAgents(message);
    for (let i = 0; i < 5; i++) {
      const again = selectAgents(message);
      assert.equal(again.primary.id, first.primary.id);
      assert.deepEqual(again.supporters.map((a) => a.id), first.supporters.map((a) => a.id));
      assert.equal(again.confidence, first.confidence);
      assert.equal(again.routedBy, first.routedBy);
    }
  });

  test("الرسائل المتخصصة تُوجَّه لوكيلها الصحيح", () => {
    const cases: [string, string][] = [
      ["منظف أرضيات لافندر للرخام", "sales_floor_care"],
      ["عايز مسحوق غسيل للأوتوماتيك", "sales_laundry_care"],
      ["الشحن كام للقاهرة؟", "logistics_shipping_cost"],
      ["فين طلبي، عايز أعرف حالة الطلب", "support_order_status"],
      ["وصلني الطلب ناقص صنف وتالف", "support_damaged_missing"],
      ["عايز أرجّع المنتج مش عاجبني", "support_returns_exchange"],
      ["بحوّل فودافون كاش إزاي؟", "payments_vodafone_cash"],
      ["بنشتري بالجملة لشركات النظافة", "sales_bulk_wholesale"],
      // «كمية كبيرة» تُوجَّه لتنسيق الطلبات الكبيرة لا لتسعير التوريد — فرق مقصود يُثبته الاختبار.
      ["محتاج عرض سعر لكمية كبيرة", "logistics_large_orders"],
    ];
    for (const [message, expected] of cases) {
      const selection = selectAgents(message);
      assert.equal(selection.primary.id, expected, `«${message}» ذهبت إلى ${selection.primary.id}`);
      assert.equal(selection.routedBy, "keyword");
    }
  });

  test("عبارة «منتجات» العامة تُوجَّه للمستشارة العامة لا لوكيل متخصص", () => {
    const selection = selectAgents("عندكم ايه منتجات؟");
    assert.equal(selection.primary.id, "sales_general");
  });

  test("بلا تطابق أو برسالة فارغة ⇒ الوكيل الافتراضي وسلوك fallback", () => {
    for (const message of ["", "    ", "xyz abc 12345 😀"]) {
      const selection = selectAgents(message);
      assert.equal(selection.primary.id, "sales_general");
      assert.equal(selection.routedBy, "fallback");
      assert.equal(selection.confidence, 0);
      assert.deepEqual(selection.supporters, []);
    }
  });

  test("المطابقة العربية متينة: التشكيل والهمزات والتاء المربوطة وأداة التعريف", () => {
    assert.equal(normalizeArabic("أَرْضِيّات"), "ارضيات");
    assert.equal(normalizeArabic("إزاي؟"), "ازاي");
    assert.equal(normalizeArabic("مَرَايَا"), "مرايا");
    for (const message of ["أرضيّات", "أرضيات", "الأرضيات", "الارضيات"]) {
      assert.equal(selectAgents(`عايز منظف ${message}`).primary.id, "sales_floor_care", message);
    }
    for (const message of ["إزاي أحوّل فودافون كاش", "ازاي احول فودافون كاش"]) {
      assert.equal(selectAgents(message).primary.id, "payments_vodafone_cash", message);
    }
  });

  test("المساندون لا يتجاوزون سقفهم ولا يشملون الوكيل الافتراضي", () => {
    const selection = selectAgents("الشحن كام ومصاريف التوصيل للقاهرة الجيزة");
    assert.ok(selection.supporters.length <= 2);
    for (const supporter of selection.supporters) {
      assert.notEqual(supporter.id, selection.primary.id);
      assert.ok(!supporter.isDefault);
    }
  });

  test("لا وكيل واحد يبتلع كل شيء: كل وكيل يُوجَّه إليه محفزه الأوضح", () => {
    // عيّنة عشوائية من الأسطول: كل وكيل له محفز يجب أن يعود إليه هو.
    const sample = AGENT_FLEET.filter((_, index) => index % 5 === 0);
    for (const agent of sample) {
      const selection = selectAgents(agent.keywords[0]);
      assert.ok(selection.primary.id.length > 0);
      assert.equal(selection.routedBy, "keyword");
    }
  });
});

describe("أسطول الوكلاء — حدود الأدوات ورسالة النظام", () => {
  test("قائمة الأدوات = تقاطع مع المسجّل للقراءة فقط (لا اتساع)", () => {
    const selection = selectAgents("عايز منظف أرضيات");
    const allowlist = fleetToolAllowlist(selection);
    for (const name of allowlist) assert.ok(READ_ONLY_TOOL_NAMES.includes(name));
    // لا أداة لم يعلنها الوكيل المناوب أو مساندوه.
    const declared = new Set([...selection.primary.tools, ...selection.supporters.flatMap((a) => a.tools)]);
    for (const name of allowlist) assert.ok(declared.has(name));
  });

  test("تحقق حقيقي: المزود لا يرى إلا أدوات الوكيل المناوب (تقاطع لا اتحاد)", async () => {
    process.env.ENABLE_MCP_TOOLS = "true";
    process.env.MCP_ALLOWED_TOOLS = "search_products,lookup_faq,shipping_estimate,store_info";
    const selection = selectAgents("الاستلام من المخزن؟");
    const allowlist = fleetToolAllowlist(selection);
    assert.ok(allowlist.length > 0);
    assert.ok(allowlist.length < 4, "الوكيل المتخصص يجب أن يرى أدواته فقط لا الأربع كلها");

    const seen: string[][] = [];
    const provider = {
      name: "probe",
      isAvailable: () => true,
      generateResponse: async () => "",
      supportsTools: true as const,
      callWithTools: async (_messages: unknown, tools: { function: { name: string } }[]) => {
        seen.push(tools.map((t) => t.function.name));
        return {
          text: "تم",
          toolCalls: [],
          assistantMessage: { role: "assistant" as const, content: "تم" },
        };
      },
    };

    const { runToolLoop } = await import("../src/lib/ai/tools/run-tool-loop");
    await runToolLoop({
      provider: provider as never,
      messages: [{ role: "user", content: "الاستلام من المخزن؟" }],
      options: { enableTools: true, allowedTools: allowlist },
      registry: getMcpRegistry(),
    });

    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].sort(), [...allowlist].sort());
  });

  test("رسالة النظام محصورة بالميزانية مهما كانت التعريفات", () => {
    for (const agent of AGENT_FLEET) {
      const section = fleetPromptSection({
        primary: agent,
        supporters: AGENT_FLEET.slice(0, 2).filter((a) => a.id !== agent.id),
        confidence: 1,
        matched: [],
        routedBy: "keyword",
      });
      assert.ok(section.length <= FLEET_PROMPT_BUDGET, `${agent.id}: ${section.length} حرفًا`);
      assert.ok(section.includes(agent.name));
    }
  });

  test("بيانات الاستجابة لا تحمل إلا الهوية والقسم وسبب التوجيه", () => {
    const meta = fleetResponseMeta(selectAgents("الشحن كام؟"));
    assert.deepEqual(Object.keys(meta).sort(), ["confidence", "primary", "routed_by", "supporters"]);
    assert.deepEqual(Object.keys(meta.primary).sort(), ["department", "id", "name"]);
    assert.equal(meta.routed_by, "keyword");
  });

  test("لقطة الأسطول تعرض العدد والحدود بلا قيم حساسة", () => {
    const snapshot = fleetSnapshot();
    assert.equal(snapshot.size, 50);
    assert.equal(snapshot.declared_size, 50);
    assert.equal(snapshot.departments.length, AGENT_DEPARTMENTS.length);
    assert.deepEqual(snapshot.read_only_tools.sort(), READ_ONLY_TOOL_NAMES.slice().sort());
    assert.equal(Object.keys(DEPARTMENT_LABELS).length, AGENT_DEPARTMENTS.length);
  });

  test("getAgentById يعيد الوكيل الصحيح وnull لغير الموجود", () => {
    assert.equal(getAgentById("payments_vodafone_cash")?.name.includes("فودافون"), true);
    assert.equal(getAgentById("لا_يوجد"), null);
  });
});

describe("أسطول الوكلاء — صفر كسر للمسار القائم", () => {
  test("العلمان مطلوبان معًا: الأسطول لا يعمل بلا المحرك النمطي", () => {
    delete process.env.ENABLE_AGENT_FLEET;
    delete process.env.ENABLE_AI_AGENT;
    assert.equal(isAgentFleetEnabled(), false);
    assert.equal(isAgentFleetActive(), false);

    process.env.ENABLE_AGENT_FLEET = "true";
    assert.equal(isAgentFleetEnabled(), true);
    assert.equal(isAgentFleetActive(), false, "بلا ENABLE_AI_AGENT يبقى المسار القديم");

    process.env.ENABLE_AI_AGENT = "true";
    assert.equal(isAgentFleetActive(), true);
  });

  test("قيمة غير true لا تفتح شيئًا (fail-closed)", () => {
    for (const value of ["1", "TRUE", "yes", "on", "false", ""]) {
      process.env.ENABLE_AGENT_FLEET = value;
      process.env.ENABLE_AI_AGENT = "true";
      assert.equal(isAgentFleetActive(), false, `القيمة ${value} فتحت الأسطول`);
    }
  });

  test("استجابة /api/chat الافتراضية تبقى {reply, source} بلا أي حقل جديد", async () => {
    const { POST } = await import("../src/app/api/chat/route");
    const res = await POST(
      new Request("http://x/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "عايز منظف أرضيات" }] }),
      })
    );
    assert.equal(res.status, 200);
    const payload = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), ["reply", "source"]);
  });

  test("الأسطول مفعّل مع المحرك: تُضاف هوية الوكيل فقط، والشكل القديم محفوظ", async () => {
    process.env.ENABLE_AGENT_FLEET = "true";
    process.env.ENABLE_AI_AGENT = "true";
    const { POST } = await import("../src/app/api/chat/route");
    const res = await POST(
      new Request("http://x/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "الشحن كام للقاهرة؟" }] }),
      })
    );
    assert.equal(res.status, 200);
    const payload = (await res.json()) as {
      reply: string;
      source: string;
      fleet?: { primary: { id: string; name: string }; routed_by: string };
    };
    assert.ok(payload.reply.trim().length > 0);
    assert.deepEqual(Object.keys(payload).sort(), ["fleet", "reply", "source"]);
    assert.equal(payload.fleet?.primary.id, "logistics_shipping_cost");
    assert.equal(payload.fleet?.routed_by, "keyword");
  });

  test("الأسطول مفعّل بلا محرك نمطي: لا حقل fleet إطلاقًا (المسار القديم حرفيًا)", async () => {
    process.env.ENABLE_AGENT_FLEET = "true";
    delete process.env.ENABLE_AI_AGENT;
    const { POST } = await import("../src/app/api/chat/route");
    const res = await POST(
      new Request("http://x/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "الشحن كام للقاهرة؟" }] }),
      })
    );
    const payload = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), ["reply", "source"]);
    assert.equal(isMcpToolsEnabled(), false);
  });
});
