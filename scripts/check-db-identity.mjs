#!/usr/bin/env node
/**
 * بوابة الهوية — فشل مغلق إذا كان توكن القاعدة المُسكوك **لغير** القاعدة
 * المتصل بها. المدخلات عبر البيئة فقط (لا وسائط سطر — لا تسريب في `ps`):
 *
 *   MINTED_DB_TOKEN   توكن القاعدة الناتج من mint-turso-token.sh
 *   EXPECTED_DB       اسم القاعدة كما أعادته Platform API
 *   EXPECTED_org      اسم المؤسسة (اختياري)
 *   EXPECTED_HOST     المضيف كما أعادته Platform API (اختياري)
 *
 * المخرج سطر حكم ثابت واحد (`GATE_IDENTITY=…`) ورمز خروج — لا أي قيمة خام:
 *   0 = PASS        ادعاء db/org موجود ومطابق (أو HOST مطابق للاشتقاق)
 *   0 = NO_CLAIMS   لا ادعاءي db/org (توكن بلا هوية ادّعائية) — يُعلَن لا يُبتلع:
 *                    سلسلة الحيازة (المؤسسة نفسها سلّمت الرابط والتوكن عبر
 *                    نفس نداء الـ API) هي الدليل، ولا توجد مطابقة تخالف.
 *   1 = MISMATCH    ادعاء موجود يخالف المتوقع — يُوقَف كل شيء قبل أي كتابة.
 *   2 = BAD_INPUT   مدخلات ناقصة أو رمز غير قابل للفك.
 */
import { connectionUrlFromClaims, decodeTokenClaims, maskHost } from "./lib/db-url.mjs";

const token = process.env.MINTED_DB_TOKEN ?? "";
const expectedDb = process.env.EXPECTED_DB ?? "";
const expectedOrg = process.env.EXPECTED_ORG ?? "";
const expectedHost = (process.env.EXPECTED_HOST ?? "").toLowerCase();

if (!token) {
  console.error("GATE_IDENTITY=BAD_INPUT — MINTED_DB_TOKEN غير معيّن");
  process.exit(2);
}

const claims = decodeTokenClaims(token);
if (!claims.ok) {
  console.error("GATE_IDENTITY=BAD_INPUT — تعذّر فك ادعاءات الرمز");
  process.exit(2);
}

const masked = (v) => (v ? maskHost(v) : "—");

// 1) ادعاء db موجود: يُطابق بالاسم الصريح ثم بالمضيف المشتق منه.
if (claims.db) {
  if (expectedDb && claims.db !== expectedDb) {
    console.error(
      `GATE_IDENTITY=MISMATCH — db claim=${masked(claims.db)} ≠ expected=${masked(expectedDb)}`
    );
    process.exit(1);
  }
  if (expectedHost) {
    const derived = connectionUrlFromClaims(claims).map((c) =>
      c.replace(/^libsql:\/\//i, "").toLowerCase()
    );
    if (!derived.includes(expectedHost)) {
      console.error(
        `GATE_IDENTITY=MISMATCH — host المتصل=${masked(expectedHost)} ≠ المشتق من الادّعاءات=${masked(derived[0] ?? "")}`
      );
      process.exit(1);
    }
  }
}

// 2) ادعاء org موجود: يُطابق بالاسم الصريح.
if (claims.org && expectedOrg && claims.org !== expectedOrg) {
  console.error(`GATE_IDENTITY=MISMATCH — org claim=${masked(claims.org)} ≠ expected=${masked(expectedOrg)}`);
  process.exit(1);
}

// 3) لا ادعاء أصلًا: هوية غير قابلة للمقارنة — تُعلَم لا تُمرَّر بصمت.
if (!claims.db && !claims.org) {
  console.log(`GATE_IDENTITY=NO_CLAIMS — alg=${claims.alg ?? "—"} · لا ادّعاءي db/org للمقارنة (سلسلة الحيازة عبر Platform API)`);
  process.exit(0);
}

console.log(
  `GATE_IDENTITY=PASS — db=${masked(claims.db)} · org=${masked(claims.org)} · alg=${claims.alg ?? "—"}`
);
process.exit(0);
