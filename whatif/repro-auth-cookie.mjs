/**
 * إعادة إنتاج defect الكوكيز الإداري باستخدام الوحدة الحقيقية `src/lib/auth.ts`.
 *
 * ما أثبته الـ Runtime فعلًا (curl على :3000):
 *   POST /api/admin/login → 200 + Set-Cookie
 *   GET  /api/admin/session بنفس الكوكيز → {"authenticated":false}
 *   GET  /api/orders       بنفس الكوكيز → 401 AUTH_REQUIRED
 *
 * السبب: `response.cookies.set()` يُرمّز قيمة الكوكيز، والنقطتان `:` في الحمولة
 * تصبح `%3A` على السلك. لكن `verifyAdminSession` تقرأ القيمة كما وصلت وتحسب
 * HMAC فوق النص المُرمَّز، بينما التوقيع الأصلي حُسب فوق النص الخام.
 *
 * التشغيل: node --import tsx whatif/repro-auth-cookie.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// تحميل نفس البيئة التي يعمل بها الخادم حتى يكون التوقيع مطابقًا.
for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const { createAdminSession, verifyAdminSession } = await import("../src/lib/auth.ts");

/** ما تفعله `response.cookies.set()` في Next: ترميز نسبة-مئوي للقيمة. */
const asSentOnTheWire = (value) =>
  value.replace(/:/g, "%3A"); // encodeURIComponent يرمّز `:` إلى %3A

const token = createAdminSession();
const wire = asSentOnTheWire(token);

console.log("token كما أنشأته createAdminSession():");
console.log("  " + token);
console.log("token كما يصل في ترويسة Cookie (بعد ترميز Next):");
console.log("  " + wire);
console.log("");

const rawOk = verifyAdminSession(token);
const wireOk = verifyAdminSession(wire);

console.log(`verifyAdminSession(القيمة الخام)      = ${rawOk}`);
console.log(`verifyAdminSession(القيمة على السلك)  = ${wireOk}`);
console.log("");

// تفصيل سببَي الفشل داخل verifyAdminSession
const payload = wire.slice(0, wire.lastIndexOf("."));
const issuedAt = Number(payload.split(":", 1)[0]);
console.log("تفصيل:");
console.log(`  payload المستخرَج               = ${payload}`);
console.log(`  payload.split(":",1)[0]         = ${JSON.stringify(payload.split(":", 1)[0])}`);
console.log(`  Number(...) → issuedAt          = ${issuedAt}  (Number.isFinite = ${Number.isFinite(issuedAt)})`);
console.log(`  ⇒ حتى لو تطابق HMAC فإن فحص العمر يفشل لأن ':' صارت '%3A'`);
console.log("");

const verdict = rawOk === true && wireOk === false;
console.log(verdict ? "RESULT: defect مؤكّد — الجلسة لا تُقبل أبدًا كما تُرسل على السلك." : "RESULT: لا يوجد defect.");
process.exit(verdict ? 0 : 1);
