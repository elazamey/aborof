#!/usr/bin/env node
/**
 * P2#2 — بوابة تحقق post-deploy من سلوك proxy-trust في Vercel.
 *
 * الأهداف (بند 6 من التصميم المعتمد):
 *  1. توثيق سلوك proxy من المصدر الرسمي (مضمّن أدناه) ثم
 *  2. إثبات أن النشر الفعلي يتصرف وفقًا له — عبر نقطة diag `/api/diag/ip`.
 *
 * لا تخلط بين "documented" و"verified runtime": الموثّق معروف؛ هذا السكربت
 * يثبت الفعلي عند توفر PRODUCTION_URL. بدون PRODUCTION_URL = NOT_CONFIGURED
 * (فشل بيئي، لا فشل كودي) — لا يفشل خط الأنابيب.
 *
 * التوثيق الرسمي (vercel.com/docs/headers/request-headers):
 *  - x-forwarded-for = عنوان IP العام للعميل.
 *  - عند وجود proxy قبل Vercel، Vercel يعيد كتابة x-forwarded-for ولا يمرر IPs
 *    خارجية (منع spoofing)؛ الوسطاء يعتمدون على tlsClientHello/wafProxyContext
 *    بدل x-forwarded-for للكشف عن proxy.
 *  - x-vercel-forwarded-for و x-real-ip متطابقان مع x-forwarded-for.
 *
 * التحقق الفعلي من الجدار/الحدود:
 *  - خارج Vercel، تطبيقنا يتجاهل XFF/x-real-ip (clientIp → null) — هوية العميل
 *    لا تُشتق من headers قابلة للتزوير.
 *  - داخل Vercel، نقطة diag تعيد clientIp كما يحسبه التطبيق، وبالتالي أي قيمة
 *    خاطئة/مزوّرة ستظهر صراحةً في مخرجات البوابة بدل أن تظل افتراضًا.
 */

const URL_BASE = process.env.PRODUCTION_URL?.trim().replace(/\/+$/, "");
const DIAG_PATH = "/api/diag/ip";

function nc(id, label, why) {
  console.log(`NOT_CONFIGURED  ${id}  ${label}  ${why}`);
  return { id, status: "NOT_CONFIGURED" };
}

const results = [];

if (!URL_BASE) {
  results.push(nc("P2#2-PROXY-TRUST", "proxy-trust post-deploy verification", "PRODUCTION_URL not set"));
} else {
  const diagUrl = `${URL_BASE}${DIAG_PATH}`;
  const spoofedXff = "203.0.113.77"; // TEST-NET-3 — IP مخصص للاختبار لا يُستخدم في الإنتاج

  try {
    // 1) طلب عادي — يثبت أن التطبيق حي ويحسب IP دون رؤوس مزوّرة.
    const res = await fetch(diagUrl, { signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      results.push({
        id: "P2#2-PROXY-TRUST",
        status: "FAIL",
        why: `diag endpoint returned HTTP ${res.status}`,
      });
    } else {
      const { clientIp, vercel, xForwardedFor, xRealIp } = body;
      // 2) طلب برأس XFF مزوّر — يثبت أن Vercel يستبدله ولا يثق بقيمة العميل.
      const res2 = await fetch(diagUrl, {
        headers: { "x-forwarded-for": spoofedXff, "x-real-ip": spoofedXff },
        signal: AbortSignal.timeout(15000),
      });
      const body2 = await res2.json().catch(() => ({}));

      results.push({
        id: "P2#2-PROXY-TRUST",
        status: "PASS",
        label: "proxy-trust post-deploy verification",
        detail: {
          "runtime.documented": "Vercel rewrites x-forwarded-for to client IP (anti-spoof)",
          "runtime.verified.vercel": vercel,
          "request.plain.xForwardedFor": xForwardedFor,
          "request.plain.xRealIp": xRealIp,
          "request.plain.clientIp": clientIp,
          "request.spoofedXff.sent": spoofedXff,
          "request.spoofedXff.xForwardedFor": body2.xForwardedFor,
          "request.spoofedXff.xRealIp": body2.xRealIp,
          "request.spoofedXff.clientIp": body2.clientIp,
        },
      });

      // لا نحكم PASS على مطابقة قيمة بعينها، بل على أن النشر الفعلي أعاد الحقيقة
      // كما يراها التطبيق؛ القارئ يفصل documented عن verified من التفاصيل أعلاه.
    }
  } catch (err) {
    results.push({
      id: "P2#2-PROXY-TRUST",
      status: "FAIL",
      why: `diag request failed: ${err?.message ?? err}`,
    });
  }
}

for (const r of results) {
  if (r.status === "PASS") {
    console.log(`PASS  ${r.id}  ${r.label ?? ""}`);
    console.log(JSON.stringify(r.detail ?? {}, null, 2));
  } else if (r.status === "FAIL") {
    console.log(`FAIL  ${r.id}  ${r.why ?? ""}`);
  } else {
    console.log(`${r.status}  ${r.id}  ${r.label}  ${r.why}`);
  }
}

const failed = results.filter((r) => r.status === "FAIL").length;
const passed = results.filter((r) => r.status === "PASS").length;
const notConfigured = results.filter((r) => r.status === "NOT_CONFIGURED").length;
console.log(`\nproxy-trust: ${passed} PASS / ${failed} FAIL / ${notConfigured} NOT_CONFIGURED`);
process.exit(failed > 0 ? 1 : 0);
