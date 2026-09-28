/** @type {import('next').NextConfig} */

/**
 * إعداد التطوير فقط — لا يمس المعمارية ولا أي مسار إنتاجي.
 *
 * Next 16 يحجب أصول التطوير (مثل `/_next/hmr`) عن أي Origin غير مصرّح به.
 * بدل تثبيت اسم مضيف معيّن في الكود، تُقرأ القائمة من `ALLOWED_DEV_ORIGINS`
 * (مفصولة بفواصل). المتغير غير مُعيَّن = السلوك الافتراضي للـ Next حرفيًا،
 * فلا يتغير شيء في أي بيئة لا تحتاجه (بما فيها بناء الإنتاج).
 */
const allowedDevOrigins = (process.env.ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig = allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {};

export default nextConfig;
