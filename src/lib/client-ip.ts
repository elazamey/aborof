/**
 * P2#2 — مصدر عنوان العميل الموثوق (Trusted Client IP).
 *
 * حدود الثقة محصورة في **Vercel runtime**: `process.env.VERCEL === "1"`
 * (تضبطه المنصة عند التشغيل — لا يتحكم به العميل، ويُستخدم أصلًا في
 * `src/instrumentation.ts`).
 *
 * داخل الحدود الموثوقة (Vercel):
 *   - المصدر الأساسي = `x-forwarded-for` (Vercel يستبدله بعنوان العميل
 *     الحقيقي — وثائق Vercel الرسمية: «we overwrite the X-Forwarded-For
 *     header … to prevent IP spoofing»).
 *   - `x-real-ip` = fallback فقط (مطابق لـ `x-forwarded-for` عند Vercel)
 *     عند غياب الأول.
 *
 * خارج الحدود الموثوقة (محلي/مباشر/preview/self-host):
 *   - لا نثق بأي forwarding header (`x-forwarded-for` / `x-real-ip`)
 *     يرسله العميل — لأنها قابلة للتزوير بالكامل.
 *   - لا نفترض رأسًا بديلًا ولا نُنشئ هوية IP وهمية → نعيد `null`.
 */
export function isVercelRuntime(): boolean {
  return process.env.VERCEL === "1";
}

function firstIp(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim();
  return first && first.length > 0 ? first : null;
}

export function clientIp(request: Request): string | null {
  if (!isVercelRuntime()) return null;
  return firstIp(request.headers.get("x-forwarded-for")) ?? firstIp(request.headers.get("x-real-ip"));
}
