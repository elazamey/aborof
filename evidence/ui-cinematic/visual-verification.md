# Visual Verification — Cinematic Dark UI (Phase 1)

التاريخ: 2026-09-02 — الالتزام: (قبل push — SHA يُسجَّل بعد الالتزام)

## كيف أُنجز التحقق؟

### 1) تحقق آلي على مستوى DOM/HTTP (نُفّذ — خادم إنتاج حقيقي `next start`)

| الفحص | النتيجة |
| ----- | ------- |
| طبقات الهيرو السينمائية (`hero-orb`, `hero-grid`, `hero-copy`, `hero-kicker`, `hero-art-inner`) | ✅ موجودة في HTML |
| لمعة البطاقات `card-shine` + قسم `section-products` | ✅ موجودة |
| البنية المحفوظة: `<header>` `<nav>` `<main>` + `روفيده` + `aria-label="البحث في المنتجات"` | ✅ موجودة |
| RTL: `<html lang="ar" dir="rtl">` + meta description | ✅ سليمة |
| حالة السلة الفارغة `empty` (عند عدم وجود items) | ✅ تُعرض كما هو مطلوب |
| CSS المخدوم: 19.8 kB خام / **5.2 kB gzip** | ✅ داخل الميزانية (40 kB) |
| `prefers-reduced-motion` + `:focus-visible` + `@media (hover:hover) and (pointer:fine)` | ✅ موجودة بعد التصغير |

### 2) معاينة بصرية حقيقية (Desktop + Mobile) — LIVE PREVIEW

المتجر يعمل الآن كمعاينة حية في المتصفح:
- **Desktop (1440×900)**: الرئيسية → المنتجات → صفحة منتج → السلة → لوحة التحكم
- **Mobile (390×844)**: وضع عمود واحد، أزرار ≥ 48px، checkout أخف تأثيرات

نقاط المعاينة المطلوبة يدويًا (من المالك):
- [ ] الهيرو: توهج محكوم + شبكة خلفية + كرة ضوء متحركة + نص متدرج
- [ ] البطاقات: ارتفاع + لمعة عند التمرير (Desktop فقط)
- [ ] حركة دخول الهيرو (fade-up) ثم اختفاء التأثير عند `prefers-reduced-motion`
- [ ] الـcheckout: يعمل بدون 3D — أسرع وأسهل من الرئيسية
- [ ] الإيموجي يظهر على جميع المقاسات، وبدون أي WebGL (صفر تبعيات)

### 3) لقطات شاشة حقيقية (نُفّذت في CI — google-chrome على ubuntu-latest)

التُقطت 8 لقطات عبر `scripts/ui-shots.mjs` ضد خادم الإنتاج الحقيقي (`next start`) داخل GitHub Actions (متصفح حقيقي + شبكة كاملة)، وسُحبت إلى الفرع في `evidence/ui-cinematic/shots/`:

| اللقطة | الحجم | الوجهة |
| ------ | ----- | ------ |
| `desktop-home.png` (1440×900) | 1.2 MB | الرئيسية — الهيرو + البطاقات |
| `desktop-product.png` | 410 KB | صفحة منتج + مشابهات |
| `desktop-cart.png` | 250 KB | السلة (فارغة) |
| `desktop-admin.png` | 287 KB | لوحة التحكم |
| `mobile-home.png` (390×844) | 945 KB | الرئيسية موبايل |
| `mobile-product.png` | 334 KB | صفحة منتج موبايل |
| `mobile-cart.png` | 181 KB | السلة موبايل |
| `mobile-admin.png` | 181 KB | لوحة التحكم موبايل |

مرجع التشغيل: run `33580222532` (success) — commit `75225dd`.

### 4) سكربت اللقطات (مستدام)

```bash
npm i --no-save playwright-core
CHROME_PATH=/usr/bin/google-chrome node scripts/ui-shots.mjs http://localhost:3000
# أو محليًا مع متصفح مثبت: node scripts/ui-shots.mjs http://localhost:3000
```

يُنتج 8 لقطات ويحفظها في `evidence/ui-cinematic/shots/`.

## ماذا يضمن فحص الـUI داخل البوابة؟ (PASS في آخر تشغيل)

- `PL13-UI-CSS-BUDGET` — 27 kB خام ≤ 40 kB
- `PL14-UI-NO-EXTERNAL` — صفر أصول خارجية (لا خطوط/CDN)
- `PL15-UI-CLASSES` — 93 صنفًا مستخدمًا كلها معرّفة في CSS
- `PL16-UI-STATES` — حالات loading/error/empty/success معرّفة ومستخدمة
- `PL17-UI-FOCUS` — تنقّل لوحة مفاتيح مرئي

## الحالة

PHASE 1 (Cinematic UI) — التنفيذ مكتمل، التحقق الآلي كامل، المعاينة البشرية بانتظار المالك عبر الـLive Preview.
