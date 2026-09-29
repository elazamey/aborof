import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * تجزئة كلمات مرور مستخدمي الإدارة — scrypt (مكتبة Node القياسية، بلا اعتماديات).
 *
 * لماذا scrypt وليس sha256/hmac؟
 *  - sha256 سريع ⇒ تجزئة كلمة مرور بشرية تُكسر بالقوة الغاشمة على GPU.
 *  - scrypt ذاكرتيّ عمدًا (128·N·r بايت) ⇒ يرفع كلفة الكسر بلا حدود مقبولة.
 *
 * الصيغة المخزّنة (نص واحد في عمود password_hash):
 *   scrypt$<N>$<r>$<p>$<salt_base64url>$<hash_base64url>
 *
 * المبادئ المحكمة:
 *  - ملح عشوائي لكل كلمة مرور (16 بايت) ⇒ لا جدول تجزئة مشترك بين المستخدمين.
 *  - المعاملات مخزّنة مع البصمة ⇒ ترقية الكلفة مستقبلًا لا تُبطل البصمات القديمة.
 *  - المقارنة عبر `timingSafeEqual` فقط ⇒ لا مقارنة نصية تُسرب توقيتًا.
 *  - فشل أي خطوة (صيغة مشوّهة/معاملات غير صالحة) = `false` (fail-closed)، ولا
 *    يرمي استثناءً يصل للعميل.
 */

const SCRYPT_PREFIX = "scrypt";

export const SCRYPT_PARAMS = {
  N: 16_384,
  r: 8,
  p: 1,
  keyLength: 64,
} as const;

const SALT_BYTES = 16;
/** الحد الأدنى لنص البصمة في قاعدة البيانات (يُطابق قيد CHECK في الهجرة 0003). */
export const MIN_HASH_LENGTH = 40;
const MAX_HASH_LENGTH = 400;

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number }
) => Promise<Buffer>;

/** الحد الأقصى لذاكرة scrypt — 128·N·r بايت مع هامش أمان. */
const MAX_MEM = 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2;

function encode(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function decode(value: string): Buffer | null {
  try {
    const buffer = Buffer.from(value, "base64url");
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

/** يبني بصمة scrypt لكلمة مرور بالمعاملات الافتراضية. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, SCRYPT_PARAMS.keyLength, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: MAX_MEM,
  });
  return [
    SCRYPT_PREFIX,
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    encode(salt),
    encode(derived),
  ].join("$");
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseHash(stored: unknown): ParsedHash | null {
  if (typeof stored !== "string" || stored.length < MIN_HASH_LENGTH || stored.length > MAX_HASH_LENGTH) {
    return null;
  }
  const parts = stored.split("$");
  if (parts.length !== 6) return null;
  const [prefix, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  if (prefix !== SCRYPT_PREFIX) return null;

  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  // حدود صارمة: تمنع بصمة مُصنّعة تُجبر الخادم على استهلاك ذاكرة ضخمة (DoS).
  if (!Number.isInteger(N) || N < 1024 || N > 1_048_576) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32) return null;
  if (!Number.isInteger(p) || p < 1 || p > 16) return null;

  const salt = decode(saltRaw);
  const hash = decode(hashRaw);
  if (!salt || !hash) return null;
  if (salt.length < 8 || salt.length > 64) return null;
  if (hash.length < 16 || hash.length > 128) return null;

  return { N, r, p, salt, hash };
}

/**
 * يتحقق من كلمة المرور مقابل بصمة مخزّنة. يعيد `false` لأي بصمة مشوّهة،
 * ويستخدم مقارنة ثابتة الزمن عند التطابق الطولي.
 */
export async function verifyPassword(password: string, stored: unknown): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  try {
    const derived = await scrypt(password, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: 128 * parsed.N * parsed.r * 2,
    });
    if (derived.length !== parsed.hash.length) return false;
    return timingSafeEqual(derived, parsed.hash);
  } catch {
    return false;
  }
}

/**
 * بصمة وهمية تُستخدم عند عدم وجود المستخدم: نُنفّذ نفس عمل scrypt حتى لا
 * يفرّق زمن الاستجابة بين "مستخدم غير موجود" و"كلمة مرور خاطئة"
 * (منع تعداد المستخدمين بالتوقيت). تُبنى مرة واحدة وتُخزَّن.
 */
export const DUMMY_HASH = `${SCRYPT_PREFIX}$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${encode(
  Buffer.alloc(SALT_BYTES, 7)
)}$${encode(Buffer.alloc(SCRYPT_PARAMS.keyLength, 11))}`;

/** هل النص المخزَّن بصمة scrypt صالحة الشكل؟ (للفحص في الواجهة/السجل بلا كشف قيم) */
export function isPasswordHash(value: unknown): boolean {
  return parseHash(value) !== null;
}
