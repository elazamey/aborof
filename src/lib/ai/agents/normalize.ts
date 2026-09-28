/**
 * تطبيع النص العربي — أساس التوجيه الحتمي بين وكلاء الأسطول.
 *
 * لماذا تطبيع يدوي بلا مكتبة: القرار يجب أن يكون **متطابقًا دائمًا** لنفس المدخل
 * (بلا تعلم ولا عشوائية)، وأن يعمل بلا أي مفتاح مزوّد (الرد المحلي هو الحالة
 * الافتراضية في الإنتاج). هذا التطبيع يزيل الفروق الشائعة في الكتابة العربية
 * حتى لا يفشل التوجيه لأن العميل كتب «إزاي» بدل «ازاي» أو «أرضيّات» بدل «ارضيات».
 */

/** تشكيل (حركات) + تطويل + علامات اتجاه وترقيم عربي. */
const DIACRITICS = /[\u064B-\u065F\u0670\u0640\u06D6-\u06ED]/g;
const PUNCTUATION = /[.,!?؟،؛:؛«»"'`()[\]{}\-_/\\|+=*&^%$#@~<>…]/g;

/**
 * تطبيع موحّد: حذف التشكيل والتطويل والترقيم، توحيد الهمزات والألف
 * (أ إ آ ٱ ← ا)، والياء (ى ← ي)، والتاء المربوطة (ة ← ه)، والهمزة على واو/ياء،
 * ثم ضغط المسافات. لا تلامس الأرقام (المحافظات والدفع تحتاجها).
 */
export function normalizeArabic(input: string): string {
  return String(input ?? "")
    .replace(DIACRITICS, "")
    .replace(PUNCTUATION, " ")
    .replace(/[\u0623\u0625\u0622\u0671]/g, "\u0627")
    .replace(/\u0649/g, "\u064A")
    .replace(/\u0629/g, "\u0647")
    .replace(/\u0624/g, "\u0648")
    .replace(/\u0626/g, "\u064A")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** كلمات النص بعد التطبيع، بلا تكرار مع الحفاظ على الترتيب. */
export function normalizedTokens(input: string): string[] {
  const tokens = normalizeArabic(input).split(" ").filter((t) => t.length > 0);
  return Array.from(new Set(tokens));
}

/**
 * توحيد سابقة التعريف «ال» للكلمات المفردة — يمنع فوات تطابق مثل
 * «المنظفات» مع «منظفات». يُطبَّق على المحفزات والرسالة معًا فلا يخلّ بالتماثل.
 * ملاحظة: يُطبَّق فقط عندما تبقى الكلمة 3 أحرف على الأقل بعد الحذف.
 */
export function stripDefiniteArticle(token: string): string {
  if (token.length > 4 && token.startsWith("\u0627\u0644")) return token.slice(2);
  return token;
}

/** صيغة موحّدة للمقارنة: تطبيع + حذف «ال» من كل كلمة. */
export function normalizeForMatch(input: string): string {
  return normalizeArabic(input)
    .split(" ")
    .map(stripDefiniteArticle)
    .filter((t) => t.length > 0)
    .join(" ");
}
