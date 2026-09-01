type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/**
 * حد أعلى لعدد الدلاء في الذاكرة — بعدها تُنظَّف الدلاء المنتهية.
 * يمنع النمو اللانهائي للخريطة (تسريب ذاكرة) في الخوادم طويلة العمر.
 * ملاحظة معمارية: على serverless متعدد النسخ (Vercel) كل نسخة لها
 * ذاكرتها الخاصة، لذا هذا التحديد وقائي وليس حلاً نهائياً للتوزيع —
 * عند الحاجة يُستبدل بحل خارجي (Upstash Redis مثلاً).
 */
const MAX_BUCKETS = 1000;

/** عدد الدلاء الحالي — يُستخدم في الاختبارات لضمان كون التحديد bounded */
export function rateLimitMapSize() {
  return buckets.size;
}

function prune(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function rateLimit(request: Request, scope: string, limit: number, windowMs: number) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const key = `${scope}:${forwarded || request.headers.get("x-real-ip") || "anonymous"}`;
  const now = Date.now();
  // الحفاظ على الحجم محدوداً: تنظيف الدلاء المنتهية عند الاقتراب من الحد
  if (buckets.size >= MAX_BUCKETS) prune(now);
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  current.count += 1;
  return { ok: current.count <= limit, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
}
