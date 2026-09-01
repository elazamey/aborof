import { validateEnv } from "@/lib/env";

/**
 * يُستدعى عند إقلاع خادم Next.js (وليس أثناء مرحلة البناء).
 * يطبّق Environment Contract: نقص متغير حرج في الإنتاج = STARTUP FAIL.
 */
export async function register() {
  if (process.env.NEXT_PHASE === "phase-production-build") {
    // لا نوقف `next build` — الفحص يحدث عند التشغيل الفعلي (next start / Vercel runtime)
    return;
  }
  try {
    validateEnv();
  } catch (error) {
    // STARTUP FAIL حقيقي: Next يطبع الخطأ لكنه قد يبقى يعمل كخادم مكسور
    // (كشفه DRILL-05). في `next start` (محلي/حاوية) نخرج بكود غير صفري.
    console.error("[env] " + (error as Error).message);
    if (process.env.NODE_ENV === "production" && process.env.VERCEL !== "1") {
      process.exit(1);
    }
    throw error; // على Vercel: يفشل الطلب (500) وترصده health checks
  }
}
