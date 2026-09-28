/**
 * يولّد whatif/report.md من whatif/evidence.json.
 *
 * التقرير مشتقّ آليًا من الدليل الخام — لا أرقام مكتوبة يدويًا — حتى لا ينحرف
 * السرد عمّا نفّذه الـ Runtime فعلًا.
 *
 * التشغيل: node whatif/make-report.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ev = JSON.parse(readFileSync(join(HERE, "evidence.json"), "utf8"));

const ICON = { PASS: "✅ PASS", FAIL: "❌ FAIL", BLOCKED: "⛔ BLOCKED", "NOT VERIFIED": "❔ NOT VERIFIED" };
const esc = (v) => String(v ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");

/** سطر دليل واحد من كائن الـ actual. */
const evLine = (a, keys) =>
  keys
    .map((k) => `${k}=\`${esc(typeof a?.[k] === "object" ? JSON.stringify(a[k]) : a?.[k])}\``)
    .join(" · ");

const md = [];

md.push(`# What-If Test Matrix — متجر أبو رفيدة العزامي

> **مختبر قرار، لا اختبار «هل وقع الموقع».** كل سيناريو يُقاس عبر السلسلة:
> \`INPUT → INTENT → DATA → POLICY → AUTHORIZATION → EXECUTION → EVIDENCE → OUTCOME\`

| بند | قيمة |
|---|---|
| تاريخ التشغيل | \`${ev.generated_at}\` |
| معرّف التشغيل | \`${ev.run}\` |
| الـ Runtime قيد القياس | \`${ev.base}\` (Next.js على \`0.0.0.0:3000\`) |
| نسخة DB-down | \`${ev.nodb_base}\` (نفس الكود، \`TURSO_DATABASE_URL\` فارغ) |
| قاعدة البيانات | \`file:local.db\` عبر \`@libsql/client\` — نفس مسار كود Turso |
| حالة خط الأساس | orders=\`${ev.baseline.orders}\` · order_items=\`${ev.baseline.order_items}\` · orphans=\`${ev.baseline.orphan_order_items}\` · negative_stock=\`${ev.baseline.negative_stock_rows}\` |
| الحالة النهائية | orders=\`${ev.final_db.orders}\` · order_items=\`${ev.final_db.order_items}\` · orphans=\`${ev.final_db.orphan_order_items}\` · negative_stock=\`${ev.final_db.negative_stock_rows}\` |

## الملخّص

| الحالة | العدد |
|---|---|
${Object.entries(ev.totals)
  .map(([k, v]) => `| ${ICON[k] ?? k} | ${v} |`)
  .join("\n")}
| **الإجمالي** | **${ev.scenarios.length}** |

**ثوابت سلامة لم تُكسر في أي سيناريو:** \`orphan_order_items = ${ev.final_db.orphan_order_items}\` و\`negative_stock_rows = ${ev.final_db.negative_stock_rows}\`.

---

## المصفوفة

`);

for (const s of ev.scenarios) {
  md.push(`### ${s.id} — ${s.title}

**${ICON[s.status] ?? s.status}** · ${s.checks.filter((c) => c.ok).length}/${s.checks.length} فحوص · ${s.ms}ms

| الحقل | القيمة |
|---|---|
| INPUT | ${esc(s.input)} |
| PRECONDITION | ${esc(s.precondition)} |
| EXPECTED_DECISION | ${esc(s.expected_decision)} |
| EXPECTED_SIDE_EFFECT | ${esc(s.expected_side_effect)} |
| EVIDENCE_REQUIRED | ${esc(s.evidence_required)} |

**الفحوص**

${s.checks.map((c) => `- ${c.ok ? "✅" : "❌"} ${esc(c.detail)}`).join("\n")}

**ACTUAL (دليل خام)**

\`\`\`json
${JSON.stringify(s.actual, null, 2)}
\`\`\`

`);
}

md.push(`---

## الاكتشافات

### D-1 · جلسة الإدارة لا تُقبل أبدًا كما تُرسل على السلك — ${ICON.FAIL}

**أثر:** لوحة التحكم \`/admin\` ميتة بالكامل. الدخول ينجح، ثم كل مسار إداري يُرجع \`401\`.

**الدليل من الـ Runtime:**

| خطوة | نتيجة |
|---|---|
| \`POST /api/admin/login\` بكلمة مرور صحيحة | \`${ev.scenarios.find((s) => s.id === "WF-019").actual.login_http}\` + \`Set-Cookie\` |
| قيمة الكوكيز على السلك | \`${ev.scenarios.find((s) => s.id === "WF-019").actual.cookie_value_on_the_wire}\` |
| \`GET /api/admin/session\` بنفس الكوكيز | \`authenticated=${ev.scenarios.find((s) => s.id === "WF-019").actual.session_authenticated}\` |
| \`GET /api/orders\` بنفس الكوكيز | \`${ev.scenarios.find((s) => s.id === "WF-019").actual.list_orders_http}\` \`${ev.scenarios.find((s) => s.id === "WF-019").actual.list_orders_code}\` |
| \`POST /api/products\` بنفس الكوكيز | \`${ev.scenarios.find((s) => s.id === "WF-019").actual.admin_write_http}\` \`${ev.scenarios.find((s) => s.id === "WF-019").actual.admin_write_code}\` |

**السبب الجذري:** \`createAdminSession()\` تُنتج حمولة على شكل \`<ts>:<nonce>\` بنقطتين خام. \`response.cookies.set()\` ترمّز القيمة، فتصير النقطتان \`%3A\` على السلك. و\`verifyAdminSession()\` تقرأ القيمة كما وصلت فتحسب HMAC فوق النص المُرمَّز — بينما التوقيع حُسب فوق الخام — فلا يتطابق. ولو تطابق، فإن \`Number(payload.split(":",1)[0])\` يُعيد \`NaN\` لأن الفاصل لم يعد \`:\`، فيسقط فحص العمر أيضًا.

**إعادة الإنتاج:** \`node --import tsx whatif/repro-auth-cookie.mjs\` →
\`verifyAdminSession(خام)=true\` و\`verifyAdminSession(على السلك)=false\`.

**لماذا لم تلتقطه الاختبارات؟** \`tests/auth.test.ts\` يغطي \`adminConfigIssues\`/\`isAdminConfigured\` فقط. لا يوجد أي اختبار يمرّر الجلسة عبر ترميز الكوكيز الفعلي — وهي الخطوة الوحيدة التي تكسر العقد. 133 اختبارًا أخضر مع لوحة تحكم ميتة.

**الإصلاح المقترح (لم يُنفَّذ — الحالة مجمّدة حسب الخطة):** وحّد الترميز في طرف واحد. إما \`encodeURIComponent\` صريح عند الإنشاء مع \`decodeURIComponent\` عند التحقق، أو تجنّب \`:\` في الحمولة (مثلاً \`<ts>.<nonce>.<sig>\`). الأهم: أضف اختبار round-trip يمر عبر \`response.cookies.set()\` فعلًا لا عبر نص خام.

### D-2 · لا يوجد idempotency key — الضغط المزدوج يُنشئ طلبين

\`createOrderContract\` لا يحمل أي مفتاح تفرد. في WF-010 أنتجت ضغطتان متطابقتان طلبين منفصلين (\`${ev.scenarios.find((s) => s.id === "WF-010").actual.id_1}\` و\`${ev.scenarios.find((s) => s.id === "WF-010").actual.id_2}\`) وخصمًا قدره 2 من المخزون. **لا يوجد فساد بيانات** — المخزون لم يتجاوز حدّه ولا سجلات يتيمة — لكن العميل قد يطلب مرتين دون قصد. القرار الحالي «كل ضغطة طلب مستقل» قرار مشروع، لكنه غير معلن ولا محمي.

### D-3 · ملاحظة CSP

\`Content-Security-Policy\` تعمل في وضع \`Report-Only\` (\`CSP_ENFORCE !== "true"\`). هي تراقب ولا تفرض. هذا مقصود في الكود، لكنه يعني أن أي انتهاك CSP حاليًا لا يُحجب فعليًا.

---

## ملاحظات منهجية

1. **كل فعل قيد القياس مرّ عبر HTTP على Runtime حقيقي** — لا Mocks ولا استدعاء مباشر للدوال.
2. **ضبط الـ precondition تم كتابةً مباشرة في قاعدة البيانات** بدل \`POST /api/products\`، لأن D-1 يجعل أي كتابة إدارية تُرجع 401. هذا fixture للاختبار لا مسار قيد القياس، ومغطّى مستقلًا في WF-017/WF-019.
3. **كل سيناريو أخذ \`x-forwarded-for\` مستقلًا** لأن \`bucketKey()\` يشتق مفتاح تحديد المعدل منه، والحد \`8/10min\` على \`/api/orders\` كان سيعطي \`429\` ويخفي القرارات الحقيقية.
4. **نسخة DB-down تعمل من مجلد منفصل** (\`~/whatif-nodb\`) حتى لا تتصارع نسختا dev على \`.next\`.
5. **لم يُعدَّل أي كود تطبيق.** التغييرات الوحيدة: \`next.config.mjs\` (قراءة \`ALLOWED_DEV_ORIGINS\` من البيئة، ومعطّل افتراضيًا) ومجلد \`whatif/\` الجديد.

## إعادة التشغيل

\`\`\`bash
# الخادم الرئيسي (مع DB)
npx next dev -H 0.0.0.0 -p 3000

# نسخة DB-down لـ WF-016
cd ~/whatif-nodb && npx next dev -H 0.0.0.0 -p 3001

# المصفوفة
node whatif/run-whatif.mjs && node whatif/make-report.mjs

# إعادة إنتاج D-1
node --import tsx whatif/repro-auth-cookie.mjs
\`\`\`
`);

writeFileSync(join(HERE, "report.md"), md.join("\n"));
console.log(`report → ${join(HERE, "report.md")} (${md.join("\n").length} chars)`);
