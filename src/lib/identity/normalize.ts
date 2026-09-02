/**
 * تطبيع البريد والهاتف — هوية واحدة مقيسة:
 *  البريد: lowercase + trim (مع تجاهل النقاط فقط في Gmail؟ لا — نطبيع ببساطة وثبات).
 *  الهاتف: صيغة E.164 موحدة +20XXXXXXXXXX مهما دخل المستخدم.
 */

export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null;
  return email;
}

/** يحوّل أي صيغة مصرية إلى +20XXXXXXXXXX — أو null إن لم تكن رقمًا مصريًا صالحًا */
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0020")) digits = digits.slice(4);
  else if (digits.startsWith("20")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length !== 10 || !/^1[0125][0-9]{8}$/.test(digits)) return null;
  return `+20${digits}`;
}

export function sha256Hex(value: string): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}
