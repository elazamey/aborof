/**
 * استخراج بيانات اتصال Turso من قيمتَي البيئة الخام — وحدة نقيّة: لا شبكة ولا
 * قراءة لـ`process.env` ولا كتابة في السجلات.
 *
 * لماذا: عند لصق القيم في لوحة Vercel تتكرر أخطاء لا ترفضها اللوحة ولا يراها
 * المالك، لكن `createClient` يرميها فيسقط المتجر كله بـ503 «إعداد الاتصال غير
 * صالح»:
 *   - أحرف اتجاه/عرض صفري خفية (RLM/LRM/ZWSP) تدخل مع النسخ من نص عربي،
 *   - علامات تنصيص أو باكتيك أو أقواس منسوخة من محادثة أو وثيقة،
 *   - كتلة `.env` كاملة (سطران) مُلصقة في حقل واحد،
 *   - حقلان متبادلان (الرمز في خانة الرابط والعكس)،
 *   - مضيف بلا `libsql://`، أو رابط لوحة التحكم بدل رابط الاتصال.
 * هذه الوحدة تستخرج الرابط والرمز من أي ترتيب من هذه، وتقول بالضبط ما أصلحته
 * أو ما تعذّر إصلاحه.
 *
 * قاعدة صلبة: **الوصف يحمل الأنواع والأطوال والأعداد فقط — لا أي جزء من رابط
 * أو رمز**. لذلك يجوز كتابته في السجلات وعرضه في التشخيص المحمي.
 */

/** نوع ما وُجد داخل حقل. `bare-name` = كلمة قصيرة بلا نقاط (اسم قاعدة/مؤسسة). */
export type TursoValueKind =
  | "libsql-url"
  | "http-url"
  | "file-url"
  | "host"
  | "dashboard-url"
  | "jwt"
  | "opaque"
  | "bare-name"
  | "placeholder"
  | "other";

/** إصلاحات طُبّقت على قيمة صالحة بعد تنظيفها. رموز ثابتة بلا قيم. */
export type TursoRepair =
  | "invisible-chars-removed"
  | "decoration-stripped"
  | "both-values-in-one-field"
  | "url-from-token-field"
  | "token-from-url-field"
  | "scheme-added"
  | "scheme-rewritten"
  | "dashboard-url-derived"
  | "token-from-url-query"
  | "url-query-dropped"
  | "url-path-dropped";

/** لماذا تعذّر الاستخراج. رموز ثابتة. */
export type TursoProblem =
  | "URL_NOT_FOUND"
  | "URL_PLACEHOLDER"
  | "URL_DASHBOARD_INCOMPLETE"
  | "URL_UNPARSEABLE"
  | "TOKEN_MISSING";

/**
 * - `unset`: لا شيء مضبوط (الرابط فارغ ولا رابط في الحقل الآخر).
 * - `ok`: قيم صالحة كما هي.
 * - `repaired`: قيم صالحة بعد إصلاح آلي (انظر `repairs`).
 * - `invalid`: شيء مضبوط لكن لا يمكن استخراج اتصال صالح منه (انظر `problem`).
 */
export type TursoConfigStatus = "unset" | "ok" | "repaired" | "invalid";

export interface TursoFieldShape {
  /** طول النص بعد إزالة الأحرف الخفية والمسافات الطرفية (بلا قيمته). */
  length: number;
  /** عدد الأسطر غير الفارغة في القيمة الخام. */
  lines: number;
  /** أنواع ما وُجد داخل الحقل بلا تكرار. فارغ = الحقل فارغ. */
  kinds: TursoValueKind[];
}

export interface TursoCredentialResolution {
  status: TursoConfigStatus;
  /** رابط جاهز لـ`createClient` — معرَّف فقط عند `ok`/`repaired`. */
  url: string | undefined;
  authToken: string | undefined;
  repairs: TursoRepair[];
  problem: TursoProblem | undefined;
  urlField: TursoFieldShape;
  tokenField: TursoFieldShape;
  /** `true` = الرمز المختار JWT انتهت صلاحيته؛ `null` = لا JWT أو لا `exp`. */
  tokenExpired: boolean | null;
}

/** ما يصلح للكتابة في السجلات: أنواع وأطوال وأسباب فقط. */
export interface TursoConfigDiagnosis {
  status: TursoConfigStatus;
  problem: TursoProblem | null;
  repairs: TursoRepair[];
  url_field: TursoFieldShape;
  token_field: TursoFieldShape;
  token_expired: boolean | null;
  hint: string;
}

// ───────────────────────── ثوابت التحليل ─────────────────────────

// فئة Cf (اتجاه/عرض صفري/BOM/الشرطة اللينة…) وأحرف التحكم عدا الفراغات المعتادة.
const INVISIBLE_TEST = /[\p{Cf}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const INVISIBLE_ALL = /[\p{Cf}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

// ما لا يدخل في رابط: مسافة، تنصيص (عادي/ذكي/عربي)، باكتيك، أقواس، فواصل (عادية وعربية)،
// نجمة (Markdown). الحروف غير اللاتينية تبقى (مضيف IDN مشروع) فلا يُبتر رابط صالح.
const URL_STOP = "\\s\"'`<>“”‘’«»„‟‹›(){}\\[\\],;|*\\\\\u060C\u061B\u061F\u06D4";
// `file:` و`:memory:` روابط محلية صالحة (تطوير/اختبار) — لا تُمسّ ولا تُعدّ خطأ.
const FILE_STOP = "\\s\"'`<>“”‘’«»";
const URL_OR_FILE = new RegExp(
  `(?:\\bfile:[^${FILE_STOP}]+|\\b[a-z][a-z0-9+.-]*:\\/\\/[^${URL_STOP}]+|(?<![\\w:]):memory:(?![\\w:]))`,
  "gi",
);
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
const BARE_TURSO_HOST = new RegExp(
  `(?<![\\w@.-])[a-z0-9][a-z0-9.-]*\\.turso\\.io(?::\\d{1,5})?(?:\\/[^${URL_STOP}]*)?(?![\\w-])`,
  "gi",
);
// `KEY=` (و`export KEY=`) المنسوخة من ملف .env أو من سطر أوامر. اسم متغيّر بيئة
// تقليدي (أحرف كبيرة وشرطة سفلية) كي لا تُؤكل نهاية رمز base64 المحشوّ بـ`=`.
const ENV_ASSIGNMENT = /\b(?:export\s+)?[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\s*=/g;
const LOOKALIKE_DASH = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/;
const LOOKALIKE_DASH_ALL = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const WRAPPER_CHARS = /["'`“”‘’«»„‟‹›<>(){}[\]*,;|]/g;
// قيم نموذجية شائعة (من .env.example ومن توثيق Turso). `example` وحدها ليست
// نموذجية: قد يكون اسم قاعدة حقيقي.
const PLACEHOLDER =
  /[<>…]|\.{3}|\byour[-_]?(?:db|database|turso|token|url|org|username)|\b(?:x{3,}|replace[-_]?(?:me|with)|change[-_]?me)\b/i;
const DASHBOARD_HOST = /(^|\.)turso\.tech$/i;
const SUPPORTED_SCHEMES = new Set(["libsql", "wss", "ws", "https", "http"]);
const HOST_SHAPE = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])$/i;

interface ScannedUrl {
  kind: "libsql-url" | "http-url" | "file-url" | "dashboard-url" | "other";
  /** النص المستخرج بلا علامات ختام الجمل. */
  value: string;
  scheme: string;
  placeholder: boolean;
}

interface ScannedField {
  shape: TursoFieldShape;
  urls: ScannedUrl[];
  hosts: string[];
  jwts: string[];
  /** رموز غير JWT تصلح كرمز مصادقة (طويلة ومن أحرف الرموز). */
  opaque: string[];
  hasPlaceholder: boolean;
  hadInvisible: boolean;
  /** هل بقي نص (تنصيص، KEY=، أقواس، كلمات) حول القيمة المستخرجة؟ */
  decorated: boolean;
}

function emptyField(hadInvisible: boolean): ScannedField {
  return {
    shape: { length: 0, lines: 0, kinds: [] },
    urls: [],
    hosts: [],
    jwts: [],
    opaque: [],
    hasPlaceholder: false,
    hadInvisible,
    decorated: false,
  };
}

// ───────────────────────── المسح ─────────────────────────

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function classifyUrl(match: string): ScannedUrl {
  // نقطة/فاصلة في آخر الرابط غالبًا ختام جملة لا جزء منه. (النقطتان `:` تبقيان:
  // هي آخر `:memory:` و`file::memory:`.)
  const value = match.replace(/[.,;!?_*~\u060C\u061B\u061F\u06D4]+$/, "");
  const scheme = value.slice(0, value.indexOf(":")).toLowerCase();
  const placeholder = PLACEHOLDER.test(value);
  if (scheme === "file" || value.toLowerCase() === ":memory:") {
    return { kind: "file-url", value, scheme: "file", placeholder };
  }

  let host: string;
  try {
    host = new URL(value.replace(/^[a-z][a-z0-9+.-]*:/i, "https:")).hostname;
  } catch {
    return { kind: "other", value, scheme, placeholder };
  }
  if (DASHBOARD_HOST.test(host)) return { kind: "dashboard-url", value, scheme, placeholder };
  if (scheme === "libsql" || scheme === "wss" || scheme === "ws" || scheme === "turso") {
    return { kind: "libsql-url", value, scheme, placeholder };
  }
  if (scheme === "https" || scheme === "http") return { kind: "http-url", value, scheme, placeholder };
  return { kind: "other", value, scheme, placeholder };
}

/** سقف المسح: قيمة بيئة حقيقية أقصر بكثير؛ السقف يمنع تكلفة تعبيرات نمطية على نص عدائي. */
const MAX_SCAN_LENGTH = 10_000;

function scanField(raw: string | undefined): ScannedField {
  const source = typeof raw === "string" ? raw.slice(0, MAX_SCAN_LENGTH) : "";
  const hadInvisible = INVISIBLE_TEST.test(source);
  const lines = source
    .split(/\r\n|[\r\n\u2028\u2029]/)
    .filter((line) => line.replace(INVISIBLE_ALL, "").trim()).length;

  let text = source.replace(INVISIBLE_ALL, "").replace(/\s+/g, " ").trim();
  // شرطات مطبعية بدل `-` (تصحيح تلقائي في الجوال/Word): تُحوَّل مضيفًا لا يُحلّ (IDN) بصمت.
  const dashes = LOOKALIKE_DASH.test(text);
  if (dashes) text = text.replace(LOOKALIKE_DASH_ALL, "-");
  const encoded = /%3a%2f%2f/i.test(text);
  if (encoded) text = safeDecode(text);
  if (!text) return emptyField(hadInvisible);

  // الأنماط عامة (`g`)؛ matchAll/replace لا يتقاسمان مؤشر المسح بين الاستدعاءات.
  const urls = [...text.matchAll(URL_OR_FILE)].map((m) => classifyUrl(m[0]));
  let rest = text.replace(URL_OR_FILE, " ");

  const jwts = [...rest.matchAll(JWT)].map((m) => m[0]);
  rest = rest.replace(JWT, " ");

  const hosts = [...rest.matchAll(BARE_TURSO_HOST)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
  rest = rest.replace(BARE_TURSO_HOST, " ");

  // القيم النموذجية تُفحص قبل تجريد الأقواس (وإلا ضاع `<db>` في الكلمة `db`)؛
  // أما `< >` الفارغة فبقايا قوسين كانا يحيطان بقيمة مستخرجة، لا قيمة نموذجية.
  const hasPlaceholder = urls.some((u) => u.placeholder) || PLACEHOLDER.test(rest.replace(/<\s*>/g, " "));

  const words = rest
    .replace(ENV_ASSIGNMENT, " ")
    .replace(WRAPPER_CHARS, " ")
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word) && word.toLowerCase() !== "export");

  // رمز كُسر على أسطر عند النسخ (نافذة ضيقة/محادثة): إن كانت القطع تكوّن JWT كاملًا حين تُوصَل.
  let rejoined = false;
  if (jwts.length === 0 && urls.length === 0 && hosts.length === 0 && words.length > 1) {
    const joined = words.join("");
    if (new RegExp(`^${JWT.source}$`).test(joined)) {
      jwts.push(joined);
      words.length = 0;
      rejoined = true;
    }
  }

  const kinds = new Set<TursoValueKind>();
  const opaque: string[] = [];
  for (const url of urls) kinds.add(url.kind);
  if (hosts.length) kinds.add("host");
  if (jwts.length) kinds.add("jwt");
  for (const word of words) {
    if (/^[A-Za-z0-9._~+/=-]{16,}$/.test(word)) {
      kinds.add("opaque");
      opaque.push(word);
    } else if (/^[a-z0-9][a-z0-9_-]*$/i.test(word)) {
      kinds.add("bare-name");
    } else {
      kinds.add("other");
    }
  }
  if (hasPlaceholder) kinds.add("placeholder");

  // زينة = كلمات بقيت، أو قيمة وحيدة لا يطابقها النص كله (تنصيص/KEY=/ختام جملة).
  const values = [...urls.map((u) => u.value), ...hosts, ...jwts];
  const decorated =
    values.length > 0 &&
    (encoded || dashes || rejoined || words.length > 0 || (values.length === 1 && text !== values[0]));

  return {
    shape: { length: text.length, lines, kinds: [...kinds] },
    urls,
    hosts,
    jwts,
    opaque,
    hasPlaceholder,
    hadInvisible,
    decorated,
  };
}

// ───────────────────────── تحويل الرابط ─────────────────────────

function isTursoCloudUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*\.turso\.io(?::\d+)?(?:[/?#]|$)/i.test(url);
}

/** رابط لوحة التحكم ⇒ رابط الاتصال القانوني `libsql://<db>-<org>.turso.io`. */
function deriveFromDashboard(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value.replace(/^[a-z][a-z0-9+.-]*:/i, "https:"));
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean).map(safeDecode);
  const at = segments.findIndex((segment) => /^(databases|db)$/i.test(segment));
  const org = at > 0 ? segments[at - 1] : segments[0];
  const name = at >= 0 ? segments[at + 1] : segments[1];
  const slug = (part: string | undefined) =>
    String(part ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "");
  const o = slug(org);
  const n = slug(name);
  if (!o || !n || /^(databases|db)$/.test(n)) return null;
  return `libsql://${n}-${o}.turso.io`;
}

interface ConnectionUrl {
  url: string;
  /** رمز وُجد داخل معامل `authToken`/`token` في الرابط. */
  queryToken?: string;
  repairs: TursoRepair[];
}

/** ينظّف رابط اتصال: يُبقي المخطط والمضيف والمنفذ، ويُسقط الباقي دون أن يفقد الرمز. */
function toConnectionUrl(item: ScannedUrl): ConnectionUrl | null {
  const repairs: TursoRepair[] = [];
  if (item.kind === "file-url") return { url: item.value, repairs };

  let scheme = item.scheme;
  if (!SUPPORTED_SCHEMES.has(scheme)) {
    // `turso://` غير مدعوم من العميل والمضيف معروف، فنُعيد كتابة المخطط.
    scheme = "libsql";
    repairs.push("scheme-rewritten");
  }

  let parsed: URL;
  try {
    parsed = new URL(item.value.replace(/^[a-z][a-z0-9+.-]*:/i, "https:"));
  } catch {
    return null;
  }
  if (!HOST_SHAPE.test(parsed.hostname)) return null;

  let queryToken: string | undefined;
  let tls = "";
  let dropped = Boolean(parsed.hash);
  for (const [key, value] of parsed.searchParams) {
    if (key === "authToken" || key === "token") {
      if (value.trim() && !queryToken) queryToken = value.trim();
    } else if (key === "tls" && scheme === "libsql" && (value === "0" || value === "1")) {
      tls = `?tls=${value}`;
    } else {
      dropped = true;
    }
  }
  if (dropped) repairs.push("url-query-dropped");

  let path = parsed.pathname === "/" ? "" : parsed.pathname;
  if (path && /\.turso\.io$/i.test(parsed.hostname)) {
    // رابط Turso لا يحمل مسارًا؛ مسار مثل /v2/pipeline يكسر الطلبات.
    path = "";
    repairs.push("url-path-dropped");
  }
  const userinfo = parsed.username
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`
    : "";
  return { url: `${scheme}://${userinfo}${parsed.host}${path}${tls}`, queryToken, repairs };
}

// ───────────────────────── الرموز ─────────────────────────

function jwtExpiry(jwt: string): number | null {
  try {
    const payload = jwt.split(".")[1] ?? "";
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

function isExpired(jwt: string, now: number): boolean {
  const exp = jwtExpiry(jwt);
  return exp !== null && exp * 1000 <= now;
}

/** يفضّل أول JWT غير منتهٍ؛ وإن انتهت كلها فأولها. */
function pickJwt(candidates: string[], now: number): string | undefined {
  return candidates.find((jwt) => !isExpired(jwt, now)) ?? candidates[0];
}

// ───────────────────────── الاستخراج ─────────────────────────

type Source = "url-field" | "token-field";

interface UrlChoice {
  connection: ConnectionUrl;
  source: Source;
  derived: boolean;
  bareHost: boolean;
}

interface TokenChoice {
  token: string;
  source: Source;
  viaQuery: boolean;
}

/** أول رابط اتصال صالح في الحقل: روابط صريحة ثم مضيفات Turso العارية. */
function firstUsableUrl(field: ScannedField, source: Source): UrlChoice | null {
  for (const item of field.urls) {
    if (item.kind === "dashboard-url" || item.kind === "other" || item.placeholder) continue;
    const connection = toConnectionUrl(item);
    if (connection) return { connection, source, derived: false, bareHost: false };
  }
  for (const host of field.hosts) {
    if (PLACEHOLDER.test(host)) continue;
    const connection = toConnectionUrl(classifyUrl(`libsql://${host}`));
    if (connection) return { connection, source, derived: false, bareHost: true };
  }
  return null;
}

function firstDerivedUrl(field: ScannedField, source: Source): UrlChoice | null {
  for (const item of field.urls) {
    if (item.kind !== "dashboard-url" || item.placeholder) continue;
    const derived = deriveFromDashboard(item.value);
    if (derived) return { connection: { url: derived, repairs: [] }, source, derived: true, bareHost: false };
  }
  return null;
}

/** JWT في خانة الرمز، ثم في خانة الرابط، ثم معامل الرابط، ثم رمز غير JWT. */
function chooseToken(
  choice: UrlChoice,
  urlField: ScannedField,
  tokenField: ScannedField,
  now: number,
): TokenChoice | null {
  const fromTokenField = pickJwt(tokenField.jwts, now);
  if (fromTokenField) return { token: fromTokenField, source: "token-field", viaQuery: false };
  const fromUrlField = pickJwt(urlField.jwts, now);
  if (fromUrlField) return { token: fromUrlField, source: "url-field", viaQuery: false };
  if (choice.connection.queryToken) return { token: choice.connection.queryToken, source: choice.source, viaQuery: true };
  if (tokenField.opaque[0]) return { token: tokenField.opaque[0], source: "token-field", viaQuery: false };
  if (urlField.opaque[0]) return { token: urlField.opaque[0], source: "url-field", viaQuery: false };
  return null;
}

function classifyProblem(urlField: ScannedField, tokenField: ScannedField): TursoProblem {
  const urls = [...urlField.urls, ...tokenField.urls];
  if (urls.some((u) => u.kind === "dashboard-url")) return "URL_DASHBOARD_INCOMPLETE";
  if (urlField.hasPlaceholder || tokenField.hasPlaceholder) return "URL_PLACEHOLDER";
  const urlish = urls.length > 0 || urlField.hosts.length > 0 || tokenField.hosts.length > 0;
  return urlish ? "URL_UNPARSEABLE" : "URL_NOT_FOUND";
}

/**
 * يستخرج رابط الاتصال والرمز من قيمتَي `TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN`.
 * `now` للاختبار فقط (فحص انتهاء JWT).
 */
export function resolveTursoCredentials(
  rawUrl: string | undefined,
  rawToken: string | undefined,
  now: number = Date.now(),
): TursoCredentialResolution {
  const urlField = scanField(rawUrl);
  const tokenField = scanField(rawToken);
  const shapes = { urlField: urlField.shape, tokenField: tokenField.shape };
  const failure = (status: "unset" | "invalid", problem?: TursoProblem): TursoCredentialResolution => ({
    ...shapes,
    status,
    url: undefined,
    authToken: undefined,
    repairs: [],
    problem,
    tokenExpired: null,
  });

  // 1) الرابط: رابط اتصال في خانة الرابط، ثم في خانة الرمز، ثم اشتقاق من رابط لوحة.
  const choice =
    firstUsableUrl(urlField, "url-field") ??
    firstUsableUrl(tokenField, "token-field") ??
    firstDerivedUrl(urlField, "url-field") ??
    firstDerivedUrl(tokenField, "token-field");

  if (!choice) {
    const nothingSet = urlField.shape.length === 0 && tokenField.urls.length === 0 && tokenField.hosts.length === 0;
    return nothingSet ? failure("unset") : failure("invalid", classifyProblem(urlField, tokenField));
  }

  // 2) الرمز. Turso السحابي يشترط رمزًا دائمًا؛ بدونه لا طلب يصل، فنفشل فورًا بسبب واضح.
  const tokenChoice = chooseToken(choice, urlField, tokenField, now);
  if (!tokenChoice && isTursoCloudUrl(choice.connection.url)) return failure("invalid", "TOKEN_MISSING");
  const authToken = tokenChoice?.token;
  const hasExpiry = authToken !== undefined && jwtExpiry(authToken) !== null;

  // 3) الإصلاحات: من الحقول التي ساهمت فعلًا في القيمتين المختارتين فقط.
  const repairs = new Set<TursoRepair>(choice.connection.repairs);
  if (choice.source === "token-field") repairs.add("url-from-token-field");
  if (choice.derived) repairs.add("dashboard-url-derived");
  if (choice.bareHost) repairs.add("scheme-added");
  if (tokenChoice?.viaQuery) repairs.add("token-from-url-query");
  if (tokenChoice && !tokenChoice.viaQuery && tokenChoice.source === "url-field") repairs.add("token-from-url-field");
  if (tokenChoice && !tokenChoice.viaQuery && tokenChoice.source === choice.source) {
    repairs.add("both-values-in-one-field");
  }

  const contributing = new Set<ScannedField>([choice.source === "url-field" ? urlField : tokenField]);
  if (tokenChoice && !tokenChoice.viaQuery) contributing.add(tokenChoice.source === "url-field" ? urlField : tokenField);
  for (const field of contributing) {
    if (field.hadInvisible) repairs.add("invisible-chars-removed");
    if (field.decorated) repairs.add("decoration-stripped");
  }

  return {
    ...shapes,
    status: repairs.size ? "repaired" : "ok",
    url: choice.connection.url,
    authToken,
    repairs: [...repairs],
    problem: undefined,
    tokenExpired: hasExpiry && authToken !== undefined ? isExpired(authToken, now) : null,
  };
}

// ───────────────────────── الوصف الآمن ─────────────────────────

function hintFor(resolution: TursoCredentialResolution): string {
  const urlKinds = new Set(resolution.urlField.kinds);
  switch (resolution.problem) {
    case "URL_NOT_FOUND":
      if (urlKinds.has("jwt")) {
        return "TURSO_DATABASE_URL يحمل رمزًا (eyJ…) بدل رابط الاتصال، ولا رابط libsql:// في أي من المتغيّرين. ضع libsql://<db>-<org>.turso.io في TURSO_DATABASE_URL والرمز في TURSO_AUTH_TOKEN ثم أعد النشر.";
      }
      if (urlKinds.has("bare-name")) {
        return "TURSO_DATABASE_URL يحمل اسم القاعدة فقط. ضع رابط الاتصال الكامل libsql://<db>-<org>.turso.io (من Turso ← القاعدة ← Connect) ثم أعد النشر.";
      }
      return "لا رابط اتصال (libsql://…) في أي من المتغيّرين. انسخ الرابط من Turso ← القاعدة ← Connect وضعه في TURSO_DATABASE_URL ثم أعد النشر.";
    case "URL_PLACEHOLDER":
      return "قيمة الرابط نموذجية لم تُستبدل (مثل <db> أو your-db-name). ضع رابط القاعدة الفعلي في TURSO_DATABASE_URL ثم أعد النشر.";
    case "URL_DASHBOARD_INCOMPLETE":
      return "القيمة رابط لوحة تحكم Turso ناقص (بلا اسم قاعدة). استخدم رابط الاتصال libsql://<db>-<org>.turso.io بدلًا منه.";
    case "URL_UNPARSEABLE":
      return "القيمة تشبه رابطًا لكن لا يمكن تحليلها (مضيف غير صالح أو مخطط غير مدعوم). استخدم libsql://<db>-<org>.turso.io.";
    case "TOKEN_MISSING":
      return "رابط Turso موجود لكن لا رمز مصادقة (JWT يبدأ بـ eyJ). أنشئ رمزًا بصلاحية Full access وضعه في TURSO_AUTH_TOKEN ثم أعد النشر.";
    default:
      break;
  }
  if (resolution.tokenExpired === true) {
    return "رمز المصادقة (JWT) منتهي الصلاحية. أنشئ رمزًا جديدًا وضعه في TURSO_AUTH_TOKEN ثم أعد النشر.";
  }
  if (resolution.status === "repaired") {
    return "القيم قابلة للاستخدام بعد إصلاح آلي؛ صحّح المتغيّرات في Vercel لتطابق الشكل الموثّق (URL=libsql://…، TOKEN=eyJ…).";
  }
  if (resolution.status === "unset") return "TURSO_DATABASE_URL غير مضبوط.";
  return "الإعداد سليم.";
}

/** وصف قابل للكتابة في السجلات والتشخيص المحمي — بلا أي قيمة. */
export function describeTursoConfig(resolution: TursoCredentialResolution): TursoConfigDiagnosis {
  return {
    status: resolution.status,
    problem: resolution.problem ?? null,
    repairs: resolution.repairs,
    url_field: resolution.urlField,
    token_field: resolution.tokenField,
    token_expired: resolution.tokenExpired,
    hint: hintFor(resolution),
  };
}
