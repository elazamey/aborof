import { db } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { metrics } from "@/lib/observability/metrics";

/**
 * تحديد معدل موزع.
 *
 * الواجهة `RateLimitStore` مستقلة عن التطبيق؛ التنفيذ الافتراضي في الإنتاج
 * يشارك الحالة عبر Turso (جدول rate_limit_counters) بعملية ذرية واحدة، فلا
 * يمكن تجاوز الحد بتعدد نسخ Serverless أو بإعادة تشغيل العملية. عند غياب
 * قاعدة البيانات (تطوير محلي) نستخدم مخزنًا في الذاكرة كحل أخير.
 */

export interface RateLimitResult {
  ok: boolean;
  retryAfter: number;
  count: number;
  limit: number;
}

export interface RateLimitStore {
  /** زيادة ذرية للعدّاد وفحص الحد في نفس العملية. */
  hit(bucketKey: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  async hit(bucketKey: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const current = this.buckets.get(bucketKey);
    if (!current || current.resetAt <= now) {
      this.buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
      return { ok: true, retryAfter: 0, count: 1, limit };
    }
    current.count += 1;
    return {
      ok: current.count <= limit,
      retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
      count: current.count,
      limit,
    };
  }
}

/**
 * وعد هجرة مشترك على مستوى العملية حتى لا تتسابق نسخ متعددة من المخزن
 * على تطبيق نفس الهجرة (قيد UNIQUE على schema_migrations).
 */
let sharedMigration: Promise<void> | null = null;
function migrateOnce() {
  if (!sharedMigration) {
    sharedMigration = runMigrations().then(
      () => undefined,
      (e) => {
        sharedMigration = null;
        throw e;
      }
    );
  }
  return sharedMigration;
}

/**
 * مخزن موزع عبر Turso. يعتمد على قيد UNIQUE للصف ويستخدم UPSERT ذريًا
 * مع RETURNING حتى تكون الزيادة والفحص عملية واحدة لا تتسابق معها طلبات أخرى.
 */
export class TursoRateLimitStore implements RateLimitStore {
  private async ensure() {
    await migrateOnce();
  }

  async hit(bucketKey: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const c = db();
    if (!c) throw new Error("rate-limit: database unavailable");
    await this.ensure();
    const now = Date.now();
    const resetAt = now + windowMs;
    const result = await c.batch(
      [
        { sql: "DELETE FROM rate_limit_counters WHERE reset_at <= ?", args: [now] },
        {
          sql: `INSERT INTO rate_limit_counters (bucket_key, count, reset_at)
                VALUES (?, 1, ?)
                ON CONFLICT(bucket_key) DO UPDATE SET
                  count = CASE WHEN rate_limit_counters.reset_at <= ? THEN 1 ELSE rate_limit_counters.count + 1 END,
                  reset_at = CASE WHEN rate_limit_counters.reset_at <= ? THEN ? ELSE rate_limit_counters.reset_at END
                RETURNING count, reset_at`,
          args: [bucketKey, resetAt, now, now, resetAt],
        },
      ],
      "write"
    );
    const row = result[1]?.rows[0] as unknown as { count?: number | bigint; reset_at?: number | bigint } | undefined;
    const count = Number(row?.count ?? 1);
    const storedResetAt = Number(row?.reset_at ?? resetAt);
    return {
      ok: count <= limit,
      retryAfter: Math.max(1, Math.ceil((storedResetAt - now) / 1000)),
      count,
      limit,
    };
  }
}

let storePromise: Promise<RateLimitStore> | null = null;

async function getStore(): Promise<RateLimitStore> {
  if (storePromise) return storePromise;
  storePromise = (async () => {
    if (db()) {
      try {
        const distributed = new TursoRateLimitStore();
        // اختبار مبكر: فشل الهجرة/الاتصال يسقطنا للذاكرة بدل تعطيل المسارات.
        await distributed.hit("__warmup__", 10_000, 60_000);
        return distributed;
      } catch (e) {
        console.error("rate-limit: falling back to in-memory store:", String((e as Error)?.message ?? e));
      }
    }
    return new InMemoryRateLimitStore();
  })();
  return storePromise;
}

/** مفتاح مركب: الغرض (المسار) + هوية العميل. لا يقبل أي مفتاح مشتق من العميل. */
function bucketKey(request: Request, scope: string): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip") || "anonymous";
  return `${scope}:${ip}`;
}

export async function rateLimit(
  request: Request,
  scope: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const store = await getStore();
  try {
    const result = await store.hit(bucketKey(request, scope), limit, windowMs);
    if (!result.ok) metrics.recordRateLimit(scope);
    return result;
  } catch (e) {
    // فشل المخزن الموزع: نسجّل وننتقل للذاكرة بدل السماح بمرور بلا حد.
    console.error("rate-limit: store error, using in-memory:", String((e as Error)?.message ?? e));
    storePromise = Promise.resolve(new InMemoryRateLimitStore());
    return (await storePromise).hit(bucketKey(request, scope), limit, windowMs);
  }
}
