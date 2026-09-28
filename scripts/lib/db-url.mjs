/**
 * أوصاف آمنة لرابط قاعدة البيانات — للتشخيص فقط، ولا تُطبع قيمة الرابط.
 *
 * الفروق الثلاثة التي تفسّر فشل اتصال واحد تفسيرات مختلفة تمامًا:
 *   1. قيمة موضعية لم تُستبدل (`libsql://<db>.turso.io` كما في التوثيق)،
 *   2. نطاق ليس Turso (رابط تطبيق مثلًا) ⇒ الرد HTML لا JSON، وهو نص الخطأ
 *      الحرفي الذي يظهر من @libsql/client عندها،
 *   3. رابط Turso سليم لكن المضيف لا يستجيب ⇒ شبكة/قاعدة محذوفة/رمز خاطئ.
 */

/** يقنّع المضيف: أول 3 حروف + آخر 9 — يكفي للتعرّف ولا يكفي لإعادة البناء. */
export function maskHost(host) {
  const h = String(host ?? "");
  if (!h) return "—";
  if (h.length <= 12) return `${h.slice(0, 3)}…`;
  return `${h.slice(0, 3)}…${h.slice(-9)}`;
}

/** محلّل نقي (بلا شبكة): مخطّط الرابط، ونوع مضيفه، وهل هو قيمة موضعية. */
export function describeDatabaseUrl(url) {
  const value = String(url ?? "");
  const schemeMatch = value.match(/^([a-z0-9+.-]+):\/\//i);
  const scheme = (schemeMatch?.[1] ?? (value.startsWith("file:") ? "file" : "بلا مخطّط")).toLowerCase();
  const hasPlaceholder = /[<>]|\.\.\.|\bx{2,}\b/i.test(value);

  let kind = "غير معروف";
  let hostMasked = "—";
  const httpish = value
    .replace(/^libsql:\/\//i, "https://")
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://");
  try {
    const host = new URL(httpish).hostname.toLowerCase();
    hostMasked = maskHost(host);
    if (host === "turso.io" || host.endsWith(".turso.io")) kind = "Turso";
    else if (host === "libsql.io" || host.endsWith(".libsql.io")) kind = "libsql.io";
    else if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) kind = "نطاق داخلي";
    else kind = "نطاق خارج Turso";
  } catch {
    kind = hasPlaceholder ? "قيمة موضعية غير مستبدلة" : "رابط غير قابل للتحليل";
  }

  return { scheme, kind, hostMasked, hasPlaceholder, length: value.length };
}

/**
 * يحوّل رابط libsql/ws إلى أصل HTTP لفحص إمكانية الوصول. `origin` يجرّد المسار
 * والاستعلام — فبعض روابط Turso تحمل `?authToken=…`، ويجب ألا يظهر رمز في السجل.
 */
export function originForHttpProbe(url) {
  const value = String(url ?? "");
  const httpish = value
    .replace(/^libsql:\/\//i, "https://")
    .replace(/^wss?:\/\//i, "https://");
  if (!/^https?:\/\//i.test(httpish)) return null;
  try {
    return new URL(httpish).origin;
  } catch {
    return null;
  }
}
