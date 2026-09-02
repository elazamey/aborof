/**
 * سياسة رؤوس HTTP الأمنية المركزية.
 *
 * CSP تُنشر في البداية بوضع `Content-Security-Policy-Report-Only` (مراقبة فقط)
 * حتى لا تكسر الموقع؛ بعد التحقق من التقارير تُنقل إلى `Content-Security-Policy`.
 * الرؤوس الصارمة الأخرى (HSTS، nosniff، frame-guard، referrer) مفعّلة فورًا.
 */

export function buildContentSecurityPolicy(): string {
  const directives = [
    "default-src 'self'",
    // خطوط وستايل: الموقع يستخدم inline styles في بعض المكونات.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://generativelanguage.googleapis.com https://api.groq.com https://*.vercel-insights.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ];
  return directives.join("; ");
}

export function buildSecurityHeaders(cspReportOnly: boolean): Record<string, string> {
  const csp = buildContentSecurityPolicy();
  const cspHeader = cspReportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
  return {
    [cspHeader]: csp,
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-DNS-Prefetch-Control": "off",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}
