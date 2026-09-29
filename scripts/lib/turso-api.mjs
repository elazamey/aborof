/**
 * طبقة Turso Platform API — حلّ الهدف (المنظمة/القاعدة)، سكّ رمز القاعدة، وأوصاف
 * بلا أسرار. تُستخدم من `scripts/mint-turso-token.sh` ومن الاختبارات.
 *
 * قاعدتان تحكمان كل سطر هنا (وهما نفسهما في `apply-turso-secrets.sh`):
 *   1. **لا تُطبع أي قيمة سرية**: لا رمز المنصة ولا الرمز المسكوك. المعروض وصف
 *      شكلي (النوع/الطول/تاريخ الانتهاء/مستوى الصلاحية) ومعرّفات مقنّعة.
 *   2. **لا تمرّ الأسرار عبر argv**: رمز المنصة يُقرأ من بيئة العملية
 *      (`TURSO_PLATFORM_TOKEN`) حصراً، لأن وسائط سطر الأوامر مرئية في `ps`.
 *
 * المرجع (Platform API · قاعدة `https://api.turso.tech/v1`):
 *   GET  /organizations                                              ← قائمة المنظمات
 *   GET  /organizations/{org}/databases                              ← قائمة القواعد
 *   GET  /organizations/{org}/databases/{db}                         ← الهدف المفرد
 *   POST /organizations/{org}/databases/{db}/auth/tokens?expiration&authorization
 *                                                                    ← سكّ الرمز ⇒ { jwt }
 *
 * العمر الافتراضي للرمز المسكوك `90d` (لا `never` كما في افتراضي API) — انظر
 * `DEFAULT_EXPIRATION`؛ والهروب الصريح `--expiration never`.
 *
 * ضبط إضافي من البيئة: `TURSO_API_TIMEOUT_MS` (مهلة النداء بالمللي ثانية، افتراضي
 * 20000) — لشبكة بطيئة أو لفشل سريع في الاختبارات.
 *
 * ملاحظة دقيقة تفسّر `pickField`: ردّ قائمة القواعد يعيد المفاتيح بأحرف كبيرة
 * (`Name`/`Hostname`/`DbId`) — وهذا بالضبط ما يفعله SDK الرسمي حين يطبّعها —
 * بينما مواضع أخرى تعيدها صغيرة. القراءة هنا بلا حساسية لحالة الأحرف كي لا
 * ينتهي الاشتقاق إلى هدف خاطئ بسبب حرف.
 */
import { pathToFileURL } from "node:url";
import { describeDatabaseUrl, maskHost } from "./db-url.mjs";
import { redact } from "./migration-checksums.mjs";

/** قاعدة Platform API الافتراضية (نفسها في `@tursodatabase/api`). */
export const DEFAULT_API_BASE = "https://api.turso.tech/v1";

/** مستويا الصلاحية المقبولة لرمز القاعدة (توثيق Turso). */
export const AUTHORIZATION_LEVELS = ["full-access", "read-only"];

/**
 * العمر الافتراضي للرمز المسكوك: **90 يومًا** لا `never`.
 *
 * `never` هو افتراضي Platform API نفسه، وهو ممارسة شائعة لأنها تُنسي صاحبها
 * الرمز — لكن رموز Turso لا تُسترجع بعد إنشائها ولا تُلغى فرديًا (الإلغاء
 * تدوير يُبطل كل الرموز)، فأي نسخة مسرَّبة من رمز أبدي تبقى صالحة إلى الأبد.
 * العمر المحدود يجعل التسريب حادثًا مؤقّتًا، وإعادة السكّ أمر واحد:
 * `bash scripts/mint-turso-token.sh` (يُسلّم الرمز الجديد إلى نفس الوجهات).
 * الهروب صريح: `--expiration never`.
 */
export const DEFAULT_EXPIRATION = "90d";

/** `never` أو مدة بأسلوب Go: `2w1d30m` (وحدات s/m/h/d/w/y). */
const EXPIRATION_RE = /^(?:never|\d+[smhdwy](?:\d+[smhdwy])*)$/i;

/** ترجمة مطالبات الوصول المعروفة إلى وصف — وغير المعروف لا يُطبع خامًا. */
const ACCESS_LABELS = {
  ro: "قراءة فقط",
  read_only: "قراءة فقط",
  "read-only": "قراءة فقط",
  read: "قراءة",
  write: "كتابة",
  readwrite: "قراءة وكتابة",
  full: "وصول كامل",
  full_access: "وصول كامل",
  "full-access": "وصول كامل",
};

/* ------------------------------------------------------------------ */
/* تحقق شكلي نقّي (بلا شبكة)                                            */
/* ------------------------------------------------------------------ */

export function isValidExpiration(spec) {
  return EXPIRATION_RE.test(String(spec ?? "").trim());
}

export function isValidAuthorization(level) {
  return AUTHORIZATION_LEVELS.includes(String(level ?? "").trim());
}

/**
 * قاعدة API مقبولة: `https://` فقط. الاستثناء الوحيد اختباري وصريح
 * (`TURSO_API_ALLOW_INSECURE_BASE=true`) لتشغيل خادم وهمي محلي في الاختبارات،
 * ويُعلَن تحذير في stderr حتى لا يمرّ بصمت.
 */
export function resolveApiBase(value, { allowInsecure = false } = {}) {
  const base = String(value || DEFAULT_API_BASE).trim().replace(/\/+$/, "");
  if (/^https:\/\//i.test(base)) return { ok: true, base, insecure: false };
  if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(base) && allowInsecure) {
    return { ok: true, base, insecure: true };
  }
  return {
    ok: false,
    base,
    insecure: false,
    error: allowInsecure
      ? `قاعدة API غير مقبولة (${base}) — يُسمح محليًا بـ http://127.0.0.1 فقط في الاختبارات.`
      : `قاعدة API يجب أن تكون https:// (وصل: ${base}) — الاستثناء المحلي للاختبارات فقط عبر TURSO_API_ALLOW_INSECURE_BASE=true.`,
  };
}

/** هدف محلي (بلا رمز ولا شبكة) — للتجارب والاختبارات. */
export function isLocalDatabaseUrl(value) {
  return /^(file:|:memory:)/i.test(String(value ?? "").trim());
}

/* ------------------------------------------------------------------ */
/* اشتقاق الهدف: من رابط اتصال أو رابط لوحة تحكم                        */
/* ------------------------------------------------------------------ */

/** رابط الاتصال القانوني: `libsql://<db>-<org>.turso.io` (توثيق Turso). */
export function connectionUrlFor(org, db) {
  return `libsql://${String(db).toLowerCase()}-${String(org).toLowerCase()}.turso.io`;
}

/**
 * من رابط اتصال `libsql://<db>-<org>.turso.io`. الاسم والمؤسسة كلاهما يقبل
 * الشُرَط، فالقطع عند **آخر** شَرّة هو الترجيح الوحيد الممكن محليًا — ويُحسم
 * لاحقًا من ردّ API (`Hostname`) متى كان الرمز متاحًا.
 */
export function orgAndDbFromConnectionUrl(value) {
  const shape = describeDatabaseUrl(value);
  if (shape.kind !== "Turso" && shape.kind !== "libsql.io") return null;
  const httpish = String(value)
    .replace(/^libsql:\/\//i, "https://")
    .replace(/^wss?:\/\//i, "https://");
  let host = "";
  try {
    host = new URL(httpish).hostname.toLowerCase();
  } catch {
    return null;
  }
  const label = host.replace(/\.(turso|libsql)\.io$/, "");
  const at = label.lastIndexOf("-");
  if (at <= 0 || at === label.length - 1) return null;
  return { db: label.slice(0, at), org: label.slice(at + 1), source: "connection-url", tentative: true };
}

/** من رابط لوحة التحكم `https://app.turso.tech/<org>/databases/<db>` — بلا التباس. */
export function orgAndDbFromDashboardUrl(value) {
  const raw = String(value ?? "").trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (!["app.turso.tech", "www.turso.tech", "turso.tech", "app.turso.io"].includes(host)) return null;
  const segments = parsed.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  const at = segments.findIndex((s) => /^(databases|db)$/i.test(s));
  const org = at > 0 ? segments[at - 1] : segments[0];
  const db = at >= 0 ? segments[at + 1] : segments[1];
  if (!org || !db) return null;
  return { org, db, source: "dashboard-url", tentative: false };
}

/** المصدر الموحّد: يجرّب اللوحة أولًا (قاطعة) ثم رابط الاتصال (مرجّحة). */
export function orgAndDbFromValue(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return orgAndDbFromDashboardUrl(raw) ?? orgAndDbFromConnectionUrl(raw);
}

/* ------------------------------------------------------------------ */
/* أوصاف بلا قيمة                                                       */
/* ------------------------------------------------------------------ */

/** قراءة حقل بلا حساسية لحالة الأحرف (انظر ترويسة الملف). */
export function pickField(obj, ...names) {
  if (!obj || typeof obj !== "object") return undefined;
  const index = new Map(Object.keys(obj).map((key) => [key.toLowerCase(), key]));
  for (const name of names) {
    const key = index.get(String(name).toLowerCase());
    if (key !== undefined && obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
  }
  return undefined;
}

/**
 * وصف شكلي لرمز (منصة أو قاعدة) — بلا أي جزء من قيمته. يرصد أيضًا الخطأ
 * الشائع المرصود في الإنتاج: رابط اتصال لُصق في حقل الرمز.
 */
export function describeTokenShape(value) {
  const raw = String(value ?? "");
  if (!raw.trim()) return { kind: "فارغ", detail: "لا قيمة" };
  const parsed = raw.includes("://") ? describeDatabaseUrl(raw) : null;
  if (parsed) return { kind: "رابط لا رمز", detail: `${parsed.scheme}:// · المضيف ${parsed.hostMasked} · طول ${raw.length}` };
  const segments = raw.split(".").length;
  if (/^eyJ/.test(raw) && segments === 3) return { kind: "JWT", detail: `JWT بثلاثة مقاطع · طول ${raw.length}` };
  if (segments === 3) return { kind: "JWT محتمل", detail: `ثلاثة مقاطع بلا بادئة eyJ · طول ${raw.length}` };
  return { kind: "غير معروف", detail: `${segments} مقطع · طول ${raw.length}` };
}

/**
 * يفك مقاطع JWT ليقتصد منها **وصفًا تشغيليًا** فقط: الانتهاء ومستوى الصلاحية.
 * لا يعيد التوقيع ولا أي مطلب آخر (sub/id/…) — فلا يُطبع من الرمز إلا ما ينفع
 * القرار: «هل ينتهي؟» و«هل يكتب؟».
 */
export function decodeJwtOperationsClaims(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    if (!claims || typeof claims !== "object") return null;
    const rawAccess = [claims.a, claims.access, claims.authorization, claims.privileges].find(
      (v) => typeof v === "string"
    );
    return {
      exp: typeof claims.exp === "number" && claims.exp > 0 ? claims.exp : null,
      iat: typeof claims.iat === "number" ? claims.iat : null,
      access: rawAccess ? (ACCESS_LABELS[String(rawAccess).toLowerCase()] ?? "غير معروف") : null,
    };
  } catch {
    return null;
  }
}

/** وصف الرمز المسكوك: النوع والطول ومستوى الصلاحية والانتهاء — بلا قيمة. */
export function describeMintedToken(token) {
  const shape = describeTokenShape(token);
  const claims = decodeJwtOperationsClaims(token);
  const bits = [`طول ${String(token ?? "").length}`];
  if (claims?.access) bits.push(claims.access);
  if (!claims) bits.push("تعذّر قراءة مطالباته (يُقبل كما هو)");
  else if (claims.exp) {
    const days = Math.round((claims.exp * 1000 - Date.now()) / 86_400_000);
    bits.push(`ينتهي ${new Date(claims.exp * 1000).toISOString().slice(0, 10)} (بعد ${days} يومًا)`);
  } else bits.push("بلا انتهاء");
  return `${shape.kind} · ${bits.join(" · ")}`;
}

/** تقنيع معرّفات الهدف (منظمة/قاعدة/مضيف/رابط) — نفس قاعدة تقنيع المضيف. */
export function maskTarget({ org = "", db = "", hostname = "", url = "" } = {}) {
  const shape = url ? describeDatabaseUrl(url) : null;
  const local = isLocalDatabaseUrl(url);
  let maskedUrl = "—";
  if (url) {
    if (local) {
      // قاعدة محلية: المخطط + طول القيمة فقط (لا مسار كامل في السجل).
      maskedUrl = `${String(url).split(":")[0]}:… (طول ${String(url).length})`;
    } else {
      const schemeEnd = String(url).indexOf("://");
      const prefix = schemeEnd > 0 ? `${String(url).slice(0, schemeEnd)}://` : "";
      maskedUrl = `${prefix}${shape ? shape.hostMasked : maskHost(hostname || url)}`;
    }
  }
  return {
    org: org ? maskHost(org) : "—",
    db: db ? maskHost(db) : "—",
    host: hostname ? maskHost(hostname) : "—",
    url: maskedUrl,
    local,
    urlShape: shape
      ? { scheme: shape.scheme, kind: local ? "قاعدة محلية" : shape.kind, hostLength: shape.hostLength, pathShape: shape.pathShape }
      : null,
  };
}

/* ------------------------------------------------------------------ */
/* نداءات API                                                           */
/* ------------------------------------------------------------------ */

/** ترجمة فشل HTTP/شبكة إلى حكم قابل للتنفيذ — بلا جسم خام وبلا رمز. */
export function classifyApiFailure(status, text = "", error = null) {
  if (error) {
    const message = String(error?.message ?? error);
    if (/timeout|aborted/i.test(message)) return "انتهت مهلة الاتصال بـ Turso API (شبكة بطيئة أو محجوبة).";
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|fetch failed|dns|ECONNRESET|ECONNREFUSED/i.test(message)) {
      return "تعذّر الوصول إلى Turso API (DNS/شبكة محجوبة) — لا يمكن حلّ الهدف ولا سكّ الرمز من هنا.";
    }
    return `خطأ اتصال: ${message.slice(0, 160)}`;
  }
  const code = Number(status);
  const hint = String(text || "").replace(/\s+/g, " ").slice(0, 160);
  if (code === 401 || code === 403) {
    return `رمز المنصة مرفوض أو ناقص الصلاحية (HTTP ${code}) — يلزم نطاق يغطّي القاعدة الهدف وصلاحية db:mint-token${hint ? ` · ${hint}` : ""}`;
  }
  if (code === 404) return `لا مورد بهذا المسار (HTTP 404) — اسم المنظمة أو القاعدة مختلف${hint ? ` · ${hint}` : ""}`;
  if (code === 429) return "حد المعدل على Platform API (HTTP 429) — أعد المحاولة بعد دقائق.";
  if (code >= 500) return `خطأ من خادم Turso (HTTP ${code})${hint ? ` · ${hint}` : ""}`;
  return `استجابة غير متوقعة (HTTP ${code || "بلا رمز"})${hint ? ` · ${hint}` : ""}`;
}

/** نداء واحد: الرمز في الرأس (لا في argv ولا في الرابط)، والمهلة صريحة. */
export async function apiRequest(base, path, options = {}) {
  const { method = "GET", query, platformToken, body, timeoutMs = 20_000 } = options;
  const root = String(base).endsWith("/") ? String(base) : `${String(base)}/`;
  const url = new URL(String(path).replace(/^\/+/, ""), root);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
  }
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${platformToken}`,
        "Content-Type": "application/json",
        "User-Agent": "aborof/mint-turso-token",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json, text };
  } catch (error) {
    return { ok: false, status: 0, json: null, text: "", error };
  }
}

/**
 * حلّ الهدف: من الأعلام، أو من قيمة مضبوطة حاليًا (رابط لوحة/رابط اتصال)،
 * أو من API. ومتى كان رمز المنصة متاحًا يُؤكَّد الهدف من الخادم نفسه ويُؤخذ
 * `Hostname` القانوني منه — فلا يُبنى رابط من تخمين.
 *
 * القراءة فقط (GET): تُستخدم في `--dry-run` وفي المعاملة الحقيقية معًا، أي أن
 * المعاينة ترى ما سيراه التنفيذ حرفيًا.
 */
export async function fetchTarget(options = {}) {
  const {
    apiBase = DEFAULT_API_BASE,
    platformToken = "",
    org = "",
    db = "",
    urlValue = "",
    timeoutMs = 20_000,
    allowApi = true,
  } = options;

  const derived = urlValue ? orgAndDbFromValue(urlValue) : null;
  let targetOrg = String(org || "").trim();
  let targetDb = String(db || "").trim();
  const source = targetOrg || targetDb ? "flag" : derived ? derived.source : "api";
  if (!targetOrg && derived?.org) targetOrg = derived.org;
  if (!targetDb && derived?.db) targetDb = derived.db;

  const notes = [];
  if (derived?.source === "dashboard-url") {
    notes.push("القيمة المضبوطة حاليًا رابط لوحة تحكم لا رابط اتصال — اشتُقّ الهدف من مسارها.");
  } else if (derived?.tentative) {
    notes.push("الاشتقاق من رابط اتصال مرجّح (القطع عند آخر شَرّة) — يُحسم من ردّ الخادم.");
  }

  const result = {
    ok: false,
    org: targetOrg,
    db: targetDb,
    hostname: "",
    url: "",
    source,
    apiConfirmed: false,
    notes,
    candidates: [],
    orgCandidates: [],
  };

  if (!allowApi || !platformToken) {
    if (!targetOrg || !targetDb) {
      result.error =
        "لا يمكن تحديد الهدف: مرّر --org و--db، أو اضبط TURSO_DATABASE_URL/TURSO_ORG/TURSO_DB، أو وفّر TURSO_PLATFORM_TOKEN للاكتشاف من API.";
      return result;
    }
    result.url = connectionUrlFor(targetOrg, targetDb);
    result.notes.push("بلا رمز منصة: الرابط مشتق محليًا ولم يُؤكَّد من الخادم.");
    result.ok = true;
    return result;
  }

  // 1) المنظمة: من العلم أو من الاشتقاق أو من القائمة (إن كانت واحدة فهي هي).
  if (!targetOrg) {
    const res = await apiRequest(apiBase, "organizations", { platformToken, timeoutMs });
    if (!res.ok) {
      result.error = classifyApiFailure(res.status, res.text, res.error);
      return result;
    }
    const orgs = Array.isArray(res.json?.organizations) ? res.json.organizations : [];
    const slugs = orgs.map((o) => String(pickField(o, "slug", "name") ?? "")).filter(Boolean);
    if (slugs.length === 1) {
      targetOrg = slugs[0];
      notes.push("المنظمة أُخذت من API (واحدة فقط على هذا الرمز).");
    } else if (!slugs.length) {
      result.error = "لم يُعِد API أي منظمة على هذا الرمز — تحقّق من نطاق الرمز.";
      return result;
    } else {
      result.orgCandidates = slugs.map((slug) => maskHost(slug));
      result.error = `أكثر من منظمة على هذا الرمز (${slugs.length}) — مرّر --org صراحةً.`;
      return result;
    }
  }

  // 2) القاعدة + المضيف القانوني: الهدف المفرد أولًا (إن عُرف الاسم)، والقائمة
  //    للاحتياط والتصحيح ولحلّ الغموض.
  const single = targetDb
    ? await apiRequest(apiBase, `organizations/${encodeURIComponent(targetOrg)}/databases/${encodeURIComponent(targetDb)}`, {
        platformToken,
        timeoutMs,
      })
    : { ok: false, status: 0, text: "" };
  let record = single.ok ? pickField(single.json, "database") ?? single.json : null;

  if (!record) {
    const list = await apiRequest(apiBase, `organizations/${encodeURIComponent(targetOrg)}/databases`, {
      platformToken,
      timeoutMs,
    });
    if (!list.ok && !single.ok) {
      result.error = classifyApiFailure(single.status || list.status, single.text || list.text, single.error || list.error);
      return result;
    }
    const databases = Array.isArray(list.json?.databases) ? list.json.databases : [];
    const rows = databases.map((d) => ({
      name: String(pickField(d, "name", "Name") ?? ""),
      hostname: String(pickField(d, "hostname", "Hostname") ?? ""),
      group: String(pickField(d, "group") ?? ""),
    }));
    result.candidates = rows.filter((r) => r.name).map((r) => r.name);

    const wanted = String(targetDb).toLowerCase();
    const match = wanted
      ? rows.find((r) => r.name.toLowerCase() === wanted)
      : rows.length === 1
        ? rows[0]
        : null;
    if (!match) {
      result.error = wanted
        ? `لا قاعدة باسم هذا الهدف على المنظمة (${single.status || list.status}) — المرشّحون: ${result.candidates.join("، ") || "لا أحد"}`
        : `أكثر من قاعدة على المنظمة (${rows.length}) — مرّر --db صراحةً. المرشّحون: ${result.candidates.join("، ")}`;
      return result;
    }
    if (!wanted) notes.push("القاعدة أُخذت من API (واحدة فقط على المنظمة).");
    else if (match.name !== targetDb) notes.push(`صحّح API حالة الأحرف في اسم القاعدة إلى ${match.name}.`);
    record = match;
  }

  const name = String(pickField(record, "name", "Name") ?? targetDb);
  const hostname = String(pickField(record, "hostname", "Hostname") ?? "").toLowerCase();
  result.org = targetOrg;
  result.db = name;
  result.hostname = hostname;
  result.url = hostname ? `libsql://${hostname}` : connectionUrlFor(targetOrg, name);
  result.apiConfirmed = true;
  const group = String(pickField(record, "group") ?? "");
  if (group) notes.push(`المجموعة: ${group}`);
  if (pickField(record, "archived")) notes.push("⚠️ القاعدة مؤرشفة على الخادم — أيقظها قبل التطبيق.");
  if (pickField(record, "block_writes")) notes.push("⚠️ الكتابة محجوبة على القاعدة (block_writes) — بوابة الهجرات ستفشل.");
  result.ok = true;
  return result;
}

/**
 * سكّ رمز القاعدة: `POST …/auth/tokens?expiration&authorization`.
 * يعيد `{ ok, jwt }` — والاستدعاء مسؤول عن عدم طباعة `jwt` أبدًا.
 */
export async function mintDatabaseToken(options = {}) {
  const {
    apiBase = DEFAULT_API_BASE,
    platformToken,
    org,
    db,
    expiration = DEFAULT_EXPIRATION,
    authorization = "full-access",
    timeoutMs = 20_000,
  } = options;

  if (!platformToken) return { ok: false, error: "TURSO_PLATFORM_TOKEN غير متوفر لسكّ الرمز." };
  if (!org || !db) return { ok: false, error: "الهدف ناقص: يلزم المنظمة واسم القاعدة." };
  if (!isValidExpiration(expiration)) {
    return { ok: false, error: `مدة انتهاء غير مقبولة (${expiration}) — الصيغة never أو مثل 2w1d30m.` };
  }
  if (!isValidAuthorization(authorization)) {
    return { ok: false, error: `مستوى صلاحية غير مقبول (${authorization}) — المقبول: ${AUTHORIZATION_LEVELS.join(" / ")}.` };
  }

  const res = await apiRequest(
    apiBase,
    `organizations/${encodeURIComponent(org)}/databases/${encodeURIComponent(db)}/auth/tokens`,
    {
      method: "POST",
      query: { expiration, authorization },
      platformToken,
      // نفس جسم SDK الرسمي: قائمة قواعد ATTACH للقراءة — فارغة تعني بلا attach.
      body: { permissions: { read_attach: { databases: [] } } },
      timeoutMs,
    }
  );
  const jwt = res.json ? String(pickField(res.json, "jwt", "token") ?? "") : "";
  if (!res.ok || !jwt) {
    return {
      ok: false,
      status: res.status,
      error: res.ok && !jwt ? "ردّ الخادم بلا حقل jwt — تحقّق من نطاق رمز المنصة." : classifyApiFailure(res.status, res.text, res.error),
    };
  }
  // تاريخ الانتهاء يُؤخذ من مطالبة `exp` في الرمز نفسه (الخادم هو المصدر)، لا من
  // النص الممرَّر — فيُعرض على المشغّل موعد التدوير الفعلي.
  const claims = decodeJwtOperationsClaims(jwt);
  return {
    ok: true,
    jwt,
    expiration,
    authorization,
    description: describeMintedToken(jwt),
    expiresAt: claims?.exp ? new Date(claims.exp * 1000).toISOString().slice(0, 10) : "",
    expiresInDays: claims?.exp ? Math.max(0, Math.round((claims.exp * 1000 - Date.now()) / 86_400_000)) : null,
  };
}

/* ------------------------------------------------------------------ */
/* CLI (يُستدعى من mint-turso-token.sh)                                 */
/* ------------------------------------------------------------------ */

function argValue(argv, name, fallback = "") {
  const at = argv.indexOf(name);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback;
}

/**
 * مخرج JSON على stdout (يلتقطه الأب في متغير — فلا يصل إلى الشاشة)، وملاحظات
 * مقنّعة على stderr. الرمز المسكوك يظهر في JSON فقط لأن الأب يحتاجه لتمريره
 * إلى أطفاله عبر البيئة.
 */
async function cli(argv) {
  const command = argv[0];
  const platformToken = process.env.TURSO_PLATFORM_TOKEN ?? "";
  const apiBaseRaw = argValue(argv, "--api-base") || process.env.TURSO_API_BASE || DEFAULT_API_BASE;
  const allowInsecure = /^(1|true|yes)$/i.test(process.env.TURSO_API_ALLOW_INSECURE_BASE ?? "");
  const baseCheck = resolveApiBase(apiBaseRaw, { allowInsecure });
  if (!baseCheck.ok) {
    console.log(JSON.stringify({ ok: false, error: baseCheck.error }));
    return 1;
  }
  if (baseCheck.insecure) {
    console.error(`⚠️  قاعدة API محلية غير مشفّرة (وضع اختباري صريح): ${baseCheck.base}`);
  }

  const common = {
    apiBase: baseCheck.base,
    platformToken,
    org: argValue(argv, "--org") || process.env.TURSO_ORG || "",
    db: argValue(argv, "--db") || process.env.TURSO_DB || "",
    urlValue: argValue(argv, "--url") || process.env.TURSO_DATABASE_URL || "",
    // مهلة قابلة للضبط: شبكة بطيئة تستحق انتظارًا أطول، والاختبارات تستحق فشلًا سريعًا.
    timeoutMs: Number(argValue(argv, "--timeout-ms") || process.env.TURSO_API_TIMEOUT_MS || 20_000) || 20_000,
  };

  if (command === "resolve") {
    const target = await fetchTarget({ ...common, allowApi: argv.includes("--no-api") ? false : true });
    target.masked = maskTarget(target);
    // الملاحظات مقنّعة وتُطبع على stderr — فتبقى stdout قناة JSON وحدها.
    for (const note of target.notes ?? []) console.error(`   • ${note}`);
    if (!target.ok && target.orgCandidates?.length) {
      console.error(`   • المنظمات على هذا الرمز (مقنّعة): ${target.orgCandidates.join("، ")}`);
    }
    console.log(JSON.stringify(target));
    return target.ok ? 0 : 1;
  }

  if (command === "mint") {
    if (!platformToken) {
      console.log(JSON.stringify({ ok: false, error: "TURSO_PLATFORM_TOKEN غير مُعيَّن — يُقرأ من البيئة فقط (لا من argv)." }));
      return 2;
    }
    const shape = describeTokenShape(platformToken);
    console.error(`🔐 رمز المنصة: ${shape.detail} (${shape.kind})`);
    if (shape.kind === "رابط لا رمز") {
      console.error("   • هذه قيمة رابط اتصال لا رمز منصة — رمز المنصة يُسكّ من Turso → API Tokens (صلاحية db:mint-token).");
    }
    const target = await fetchTarget(common);
    for (const note of target.notes ?? []) console.error(`   • ${note}`);
    if (!target.ok) {
      console.log(JSON.stringify({ ok: false, stage: "resolve", error: target.error, masked: maskTarget(target) }));
      return 1;
    }
    const minted = await mintDatabaseToken({
      ...common,
      org: target.org,
      db: target.db,
      expiration: argValue(argv, "--expiration", DEFAULT_EXPIRATION),
      authorization: argValue(argv, "--authorization", "full-access"),
    });
    if (!minted.ok) {
      console.log(
        JSON.stringify({
          ok: false,
          stage: "mint",
          error: minted.error,
          status: minted.status ?? null,
          org: target.org,
          db: target.db,
          url: target.url,
          masked: maskTarget(target),
        })
      );
      return 1;
    }
    console.log(
      JSON.stringify({
        ok: true,
        stage: "mint",
        jwt: minted.jwt,
        description: minted.description,
        expiration: minted.expiration,
        expiresAt: minted.expiresAt,
        expiresInDays: minted.expiresInDays,
        authorization: minted.authorization,
        org: target.org,
        db: target.db,
        hostname: target.hostname,
        url: target.url,
        source: target.source,
        apiConfirmed: target.apiConfirmed,
        notes: target.notes,
        masked: maskTarget(target),
      })
    );
    return 0;
  }

  console.log(JSON.stringify({ ok: false, error: `أمر غير معروف: ${command ?? "—"} (المقبول: resolve · mint)` }));
  return 2;
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

// بلا `await` على المستوى الأعلى: هذا الملف تُستورد دواله من الاختبارات (tsx
// يحوّلها إلى CJS حين تُستورد من ملف .ts)، و`await` الأعلى يكسر التحويل. نفس
// نمط `scripts/smoke-production.mjs`.
if (invokedDirectly) {
  cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      // لا يُطبع أي جزء من الرمز: الرسالة تمرّ عبر حجب صريح لقيم البيئة.
      const secrets = [process.env.TURSO_PLATFORM_TOKEN, process.env.TURSO_AUTH_TOKEN].filter(Boolean);
      const message = redact(String(error?.message ?? error), secrets);
      console.log(JSON.stringify({ ok: false, error: `توقف غير متوقع: ${message.slice(0, 200)}` }));
      process.exit(1);
    }
  );
}
