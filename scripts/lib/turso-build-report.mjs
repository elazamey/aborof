/**
 * تقرير اتصال Turso لسجل البناء — دوال نقيّة (بلا شبكة ولا بيئة ولا كتابة) كي تُختبر.
 *
 * لماذا في سجل البناء؟ لأن فشل Turso في الإنتاج **وقت التشغيل** (503)، بينما البناء
 * نفسه ينجح دائمًا؛ فيرى المالك سجلًا أخضر ولا يعرف السبب، وكل «Redeploy» يحرق
 * حصة نشر ثمينة بلا معلومة جديدة. سجل البناء هو المكان الذي يقرؤه المالك فعلًا.
 *
 * القاعدة الصلبة (نفس قاعدة `src/lib/db/turso-config.ts`): **أنواع وأطوال وأحكام
 * فقط — لا رابط ولا رمز ولا أي جزء منهما**. الاستثناء الوحيد قناع المضيف المعتمد
 * سلفًا في `describeDatabaseUrl` (أول 3 أحرف وخاتمة النطاق) وهو لا يكفي لإعادة البناء.
 */

const KIND_LABELS = {
  "libsql-url": "رابط libsql",
  "http-url": "رابط http(s)",
  "file-url": "ملف محلي",
  host: "مضيف بلا libsql://",
  "dashboard-url": "رابط لوحة Turso (ليس رابط اتصال)",
  jwt: "رمز JWT",
  opaque: "نص طويل ليس JWT",
  "bare-name": "اسم فقط",
  placeholder: "قيمة نموذجية لم تُستبدل",
  other: "نص آخر",
};

const REPAIR_LABELS = {
  "invisible-chars-removed": "أحرف خفية أُزيلت",
  "decoration-stripped": "تنصيص/زينة أُزيلت",
  "both-values-in-one-field": "القيمتان في حقل واحد",
  "url-from-token-field": "الرابط كان في حقل الرمز",
  "token-from-url-field": "الرمز كان في حقل الرابط",
  "scheme-added": "أُضيفت البادئة libsql://",
  "scheme-rewritten": "أُعيدت كتابة البادئة",
  "dashboard-url-derived": "اشتُقّ رابط الاتصال من رابط اللوحة",
  "token-from-url-query": "الرمز كان داخل الرابط (?authToken=)",
  "url-query-dropped": "أُسقط جزء الاستعلام من الرابط",
  "url-path-dropped": "أُسقط المسار من الرابط",
};

/** وصف حقل بيئة بنوعه وطوله فقط. */
export function describeField(shape) {
  if (!shape || !shape.length) return "فارغ";
  const kinds = (shape.kinds ?? []).map((kind) => KIND_LABELS[kind] ?? kind).join(" + ") || "نص";
  const lines = shape.lines > 1 ? ` · ${shape.lines} أسطر` : "";
  return `${kinds} (طول ${shape.length}${lines})`;
}

/**
 * حكم ثابت (بلا نص خام) على خطأ شبكة من `fetch`. النص الخام قد يحمل المضيف،
 * فلا يُطبع؛ نقرأ منه الرمز فقط ونعيد جملة عربية ثابتة.
 */
export function classifyNetworkError(error) {
  const code = String(error?.cause?.code ?? error?.code ?? "");
  const text = `${code} ${String(error?.name ?? "")} ${String(error?.message ?? "")}`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) {
    return "المضيف غير موجود (DNS) — الرابط خاطئ أو اسم القاعدة/المؤسسة مختلف";
  }
  if (/ECONNREFUSED/i.test(text)) return "رُفض الاتصال بالمنفذ — الرابط يشير إلى خادم لا يستمع";
  if (/abort|timeout|timed out|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(text)) {
    return "انتهت مهلة الاتصال — المضيف لا يردّ";
  }
  if (/ECONNRESET|EPIPE|socket hang up/i.test(text)) {
    return "انقطع الاتصال أثناء الفحص (شبكة أو جدار ناري أو خادم لا يتحدث بروتوكول libSQL)";
  }
  if (/cert|ssl|tls|self.signed/i.test(text)) return "فشل التحقق من شهادة TLS";
  return "تعذّر الوصول إلى الخادم";
}

function tokenNotes(token) {
  if (!token) return "";
  const notes = [];
  if (token.access === "rw") notes.push("صلاحية Full access");
  if (token.access === "ro") notes.push("⚠️ قراءة فقط");
  if (typeof token.expires_in_days === "number") {
    notes.push(
      token.expires_in_days < 0
        ? `❌ منتهٍ منذ ${-token.expires_in_days} يومًا`
        : `ينتهي بعد ${token.expires_in_days} يومًا`,
    );
  }
  return notes.length ? ` · ${notes.join(" · ")}` : "";
}

/** إجراء محدد لكل نوع فشل اتصال (النوع يحدده السكربت من رمز الحالة). */
const CONNECTION_ACTIONS = {
  unauthorized:
    "الإجراء: Turso ← قاعدتك ← Connect ← Create token (Full access)، وضعه في TURSO_AUTH_TOKEN (سطر واحد بلا مسافات ولا تنصيص) ثم أعد النشر. يجب أن يكون الرمز من نفس القاعدة التي في TURSO_DATABASE_URL.",
  "not-found":
    "الإجراء: انسخ الرابط من Turso ← قاعدتك ← Connect (libsql://<db>-<org>.turso.io) — الاسم الحالي لا يطابق قاعدة موجودة (حُذفت أو أُعيدت تسميتها).",
  "bad-request": "الإجراء: تحقّق من صيغة TURSO_DATABASE_URL: libsql://… بلا مسار ولا معاملات بعد اسم المضيف.",
  network: "الإجراء: الرابط لا يصل إلى خادم Turso — انسخه من Connect مجددًا وتأكد من عدم وجود حرف زائد.",
};

/** ملاحظة النطاق: تخصّ القيم المفقودة/المعطوبة فقط — فشل الاتصال يعني أن القيم قُرئت فعلًا في هذه البيئة. */
const PRODUCTION_SCOPE_NOTE =
  "تأكد أن المتغيّر مفعّلٌ لبيئة Production (وليس Preview/Development فقط)، وأن اسمه حرفيًا كما هو بأحرف كبيرة وبلا مسافات.";

/**
 * يبني أسطر التقرير من بيانات بسيطة (لا كائنات حيّة).
 *
 * @param {{
 *   vercelEnv?: string,
 *   commit?: string,
 *   nearMissNames?: { name: string, length: number }[],
 *   diagnosis: { status: string, problem: string|null, repairs: string[], url_field: object, token_field: object, token_expired: boolean|null, hint: string },
 *   token?: { access: "rw"|"ro"|null, expires_in_days: number|null } | null,
 *   urlShape?: { local?: boolean, kind: string, hostMasked: string, hostLength: number, scheme: string } | null,
 *   connection?: { ok: boolean, verdict: string, ms: number, kind?: "unauthorized"|"not-found"|"bad-request"|"network"|"client" } | null,
 *   schema?: { hasProducts: boolean, products: number|null, appliedMigrations: number|null, expectedMigrations: number|null } | null,
 * }} input
 * @returns {{ lines: string[], status: "ok" | "problem" | "skipped" }}
 */
export function renderTursoBuildReport(input) {
  const lines = [];
  const say = (text) => lines.push(`turso-check: ${text}`);
  const d = input.diagnosis;
  const production = input.vercelEnv === "production";

  say("───── فحص اتصال Turso (للعلم فقط — لا يوقف البناء) ─────");
  say(
    [input.vercelEnv ? `البيئة: ${input.vercelEnv}` : "البيئة: محلية/CI", input.commit ? `الالتزام: ${input.commit}` : null]
      .filter(Boolean)
      .join(" · "),
  );

  const near = input.nearMissNames ?? [];
  const sayNearMisses = () => {
    if (!near.length) return;
    say(
      `متغيّرات بأسماء قريبة (هل كتبت الاسم خطأً؟): ${near
        .map((n) => `${JSON.stringify(n.name)} (طول ${n.length})`)
        .join("، ")}`,
    );
  };

  if (d.status === "unset") {
    if (!production) {
      say("ℹ️ لا قيم Turso في هذه البيئة (طبيعي في CI والمعاينات) — تخطّي الفحص.");
      sayNearMisses();
      return { lines, status: "skipped" };
    }
    say(`TURSO_DATABASE_URL: ${describeField(d.url_field)}`);
    say(`TURSO_AUTH_TOKEN: ${describeField(d.token_field)}`);
    say("النتيجة: ❌ لا رابط Turso في بيئة Production — سيُرجع المتجر 503 (غير مهيأة).");
    say("الإجراء: Vercel ← المشروع ← Settings ← Environment Variables: أضف TURSO_DATABASE_URL وTURSO_AUTH_TOKEN لبيئة Production ثم أعد النشر.");
    sayNearMisses();
    return { lines, status: "problem" };
  }

  say(`TURSO_DATABASE_URL: ${describeField(d.url_field)}`);
  say(`TURSO_AUTH_TOKEN: ${describeField(d.token_field)}${tokenNotes(input.token)}`);
  if (input.urlShape && d.status !== "invalid") {
    if (input.urlShape.local) {
      say("وجهة الاتصال: قاعدة محلية (ملف/ذاكرة)");
    } else {
      say(`وجهة الاتصال: ${input.urlShape.scheme} · ${input.urlShape.kind} · المضيف ${input.urlShape.hostMasked} (طول ${input.urlShape.hostLength})`);
    }
  }
  if (d.repairs?.length) {
    say(`إصلاح آلي طُبّق (المتجر يعمل به، لكن صحّح القيم في Vercel): ${d.repairs.map((r) => REPAIR_LABELS[r] ?? r).join("، ")}`);
  }

  if (d.status === "invalid") {
    say(`النتيجة: ❌ ${d.problem ?? "إعداد غير صالح"}`);
    say(`الإجراء: ${d.hint}`);
    sayNearMisses();
    if (production) say(PRODUCTION_SCOPE_NOTE);
    return { lines, status: "problem" };
  }

  const reasons = [];
  if (input.urlShape?.local && production) {
    say("⚠️ قاعدة محلية في بيئة Production: نظام ملفات Vercel مؤقّت فلن تُحفظ الطلبات — استخدم Turso (libsql://…).");
    reasons.push("قاعدة محلية في Production");
  }
  if (d.token_expired === true) {
    say(`❌ ${d.hint}`);
    reasons.push("الرمز منتهي الصلاحية");
  }
  if (input.token?.access === "ro") {
    say("⚠️ الرمز للقراءة فقط بينما يكتب التطبيق (هجرات وطلبات) — أنشئ رمزًا Full access.");
    reasons.push("الرمز للقراءة فقط");
  }

  const c = input.connection;
  if (!c) {
    say("⚠️ لم يُجرَ اختبار الاتصال (تعذّر تشغيله في هذه البيئة) — لا حكم على Turso من هذا السجل.");
    return { lines, status: reasons.length ? "problem" : "skipped" };
  }
  say(c.ok ? `الاتصال: ✅ ${c.verdict} (${c.ms}ms)` : `الاتصال: ❌ ${c.verdict}`);
  if (!c.ok) {
    const action = CONNECTION_ACTIONS[c.kind ?? ""];
    if (action) say(action);
    return { lines, status: "problem" };
  }

  const s = input.schema;
  if (s) {
    if (!s.hasProducts) {
      say("الجداول: لم تُنشأ بعد — سيُنشئها التطبيق عند أول طلب عبر الهجرات (يحتاج رمزًا Full access).");
    } else {
      const of = s.expectedMigrations == null ? "" : ` من ${s.expectedMigrations}`;
      say(`الجداول: products ✓ (${s.products ?? "؟"} صفًا) · الهجرات المطبقة ${s.appliedMigrations ?? "؟"}${of}`);
    }
  }

  if (reasons.length) {
    say(`النتيجة: ❌ ${reasons.join(" · ")} — راجع السطور أعلاه.`);
    return { lines, status: "problem" };
  }
  if (input.urlShape?.local) {
    say("النتيجة: ℹ️ قاعدة محلية — لا فحص شبكة (مناسبة للتطوير والاختبار فقط).");
    return { lines, status: "ok" };
  }
  say("النتيجة: ✅ Turso يستجيب بهذه القيم — يجب أن يعمل المتجر بعد هذا النشر (تحقق من /api/products = 200).");
  return { lines, status: "ok" };
}
