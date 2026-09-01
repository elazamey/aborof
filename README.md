# 🧼 متجر أبو رفيدة العزامي — لأدوات ومستلزمات النظافة

متجر إلكتروني كامل **مجاني 100% بدون فيزا**، مبني على Next.js 16 + Turso + Vercel، مع مساعدة ذكية اسمها **سيليا** ترد على العملاء من قاعدة البيانات.

## ✨ المميزات

- 🛍️ عرض وبيع المنتجات بأقسام + بحث + صفحة تفاصيل لكل منتج
- 🛒 سلة مشتريات محفوظة في المتصفح + صفحة إتمام الطلب
- 💳 **الدفع فودافون كاش** على `01095032221` أو الدفع عند الاستلام
- 💬 **زر واتساب عائم** يرسل تفاصيل الطلب كاملة إلى `01095032221`
- 👩‍💼 **شات بوت سيليا** — يرد بالعامية المصرية اعتماداً على منتجات قاعدة البيانات (Gemini المجاني أو Groq المجاني، مع رد احتياطي ذكي بدون مفتاح)
- 🗄️ **Turso** لتخزين المنتجات والطلبات والأسئلة الشائعة وسجل المحادثات
- 🔐 **لوحة تحكم** `/admin` لإضافة/تعديل/حذف المنتجات ومتابعة الطلبات
- 📱 تصميم عربي RTL متجاوب بالكامل

---

## 🚀 خطوات النشر مجاناً (خطوة بخطوة)

### 1) رفع الكود على GitHub

```bash
cd store
git init
git add .
git commit -m "متجر أبو رفيدة العزامي"
git branch -M main
git remote add origin https://github.com/USERNAME/azzami-store.git
git push -u origin main
```

### 2) إنشاء قاعدة بيانات Turso (مجانية)

1. ادخل على <https://turso.tech> وسجّل بحساب GitHub (بدون فيزا).
2. أنشئ Database جديدة (اختر أقرب منطقة مثل `fra` أو `ams`).
3. انسخ:
   - **Database URL** ← `libsql://xxxx.turso.io`
   - **Auth Token** (من Create Token)

> الجداول والمنتجات تُنشأ **تلقائياً** أول مرة يفتح فيها أحد الموقع — لا حاجة لأي أوامر SQL.

### 3) مفتاح الشات بوت (اختر أياً منهما — الاثنان مجانيان)

- **Gemini**: <https://aistudio.google.com/app/apikey> → انسخ المفتاح إلى `GEMINI_API_KEY`
- **Groq**: <https://console.groq.com/keys> → انسخ المفتاح إلى `GROQ_API_KEY`

النظام يجرب Gemini أولاً، ثم Groq، وإن لم يوجد أي مفتاح يرد رداً ذكياً مباشرة من قاعدة البيانات.

### 4) النشر على Vercel

1. <https://vercel.com> → Sign up with GitHub → **Add New Project** → اختر المستودع.
2. من **Environment Variables** أضف:

| المتغير                | القيمة                                                        |
| ---------------------- | ------------------------------------------------------------- |
| `TURSO_DATABASE_URL`   | `libsql://xxxx.turso.io`                                      |
| `TURSO_AUTH_TOKEN`     | التوكن من Turso                                               |
| `GEMINI_API_KEY`       | مفتاح Gemini (اختياري)                                        |
| `GROQ_API_KEY`         | مفتاح Groq (اختياري)                                          |
| `ADMIN_PASSWORD`       | كلمة مرور لوحة التحكم                                         |
| `ADMIN_SESSION_SECRET` | سر عشوائي طويل — **32 حرفاً على الأقل** (إجباري للوحة التحكم) |

3. اضغط **Deploy** ← الموقع يشتغل على رابط `https://اسم-المشروع.vercel.app` مجاناً.

---

## 💻 التشغيل محلياً

```bash
npm install
cp .env.example .env.local   # واملأ القيم
npm run dev
```

افتح <http://localhost:3000>

---

## 🏭 Production Hardening (برنامج PRODUCTION-HARDENING-01)

> القاعدة: **Build PASS ≠ System PASS** — لا يُعتبر أي إصدار جاهزاً إلا باجتياز المستويات الخمسة.

### مستويات PASS

| المستوى            | ماذا يثبت؟                                   | الأمر                                                        |
| ------------------ | -------------------------------------------- | ------------------------------------------------------------ |
| LEVEL 1 — Static   | TypeScript + ESLint + Formatting             | `npm run lint` + `npx tsc --noEmit` + `npm run format:check` |
| LEVEL 2 — Build    | بناء إنتاجي نظيف                             | `npm run build`                                              |
| LEVEL 3 — Runtime  | خادم الإنتاج `next start` يستجيب (وليس dev)  | `npm run test:smoke`                                         |
| LEVEL 4 — Business | رحلة العميل والإدارة كاملة على build الإنتاج | `npm run test:smoke`                                         |
| LEVEL 5 — Recovery | فشل DB / جلسات / طلبات مكررة / استرجاع مخزون | `npm run test:unit`                                          |

**البوابة الكاملة محلياً:** `npm run verify` (تنفذ Levels 1–4 معاً وتفشل عند أي خلل).

### نقاط فحص الإنتاج

- `GET /api/health` — Liveness (هل التطبيق حي؟)
- `GET /api/ready` — Readiness (هل DB قابلة للخدمة؟ `{"status":"ready","database":"ok"}` أو 503)
- كل طلب يحمل `X-Request-Id` (يظهر في الاستجابة والسجلات)
- نقص متغير حرج (`TURSO_DATABASE_URL` / `ADMIN_SESSION_SECRET`) في الإنتاج = **STARTUP FAIL** برسالة واضحة
- إنشاء الطلب **Idempotent**: يرسل العميل `idempotencyKey`، وإعادة المحاولة تُعيد نفس رقم الطلب بلا خصم مزدوج
- إلغاء الطلب **يعيد المخزون** تلقائياً (مرة واحدة)
- Security headers: CSP + `X-Content-Type-Options` + `X-Frame-Options` + `Referrer-Policy` + `Permissions-Policy`
- المراقبة الاصطناعية كل 15 دقيقة عبر GitHub Actions (تحتاج متغير المستودع `PRODUCTION_URL`)

التفاصيل الكاملة: [`PRODUCTION-HARDENING-01.md`](./PRODUCTION-HARDENING-01.md)

---

## 📂 هيكل المشروع

```
src/
├── app/
│   ├── page.tsx              الصفحة الرئيسية
│   ├── cart/page.tsx         السلة وإتمام الطلب (فودافون كاش + واتساب)
│   ├── product/[id]/         صفحة تفاصيل المنتج
│   ├── admin/page.tsx        لوحة التحكم
│   └── api/
│       ├── chat/route.ts     سيليا (Gemini / Groq / رد محلي)
│       ├── products/route.ts إدارة المنتجات
│       └── orders/route.ts   حفظ ومتابعة الطلبات
├── components/               Header / Footer / ProductGrid / ChatWidget
└── lib/
    ├── db.ts                 اتصال Turso + إنشاء الجداول تلقائياً
    ├── seed.ts               بيانات المتجر والمنتجات الابتدائية
    └── cart.ts               إدارة السلة
```

## 🔧 تغيير بيانات المتجر

كل الأرقام والاسم في `src/lib/seed.ts` داخل الكائن `STORE`
(الاسم، رقم الواتساب، رقم فودافون كاش، سعر الشحن، حد الشحن المجاني).

---

**رقم التواصل:** 01095032221 · واتساب متاح على مدار اليوم 💬
