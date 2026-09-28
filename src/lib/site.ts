/**
 * مصدر واحد لعنوان الموقع المطلق — يمنع تكرار النطاق في sitemap/robots/metadata.
 * الافتراضي هو النطاق الإنتاجي الحيّ للمتجر؛ ويُضبط بـ`SITE_URL` عند تغييره.
 */
const DEFAULT_SITE_URL = "https://aborof.vercel.app";

export function siteUrl(): string {
  const raw =
    process.env.SITE_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "") ||
    DEFAULT_SITE_URL;
  return raw.replace(/\/+$/, "");
}

/** رابط مطلق بلا ازدواج شرطة — يُستخدم في sitemap وcanonical وog:url. */
export function absoluteUrl(pathname = "/"): string {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${siteUrl()}${path === "/" ? "" : path}`;
}
