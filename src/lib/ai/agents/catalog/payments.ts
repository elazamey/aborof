import type { StoreAgent } from "../types";

/**
 * قسم الدفع والفوترة — 10 وكلاء.
 * قاعدة القسم: لا يُطلب من العميل أبدًا رقم بطاقة أو رمز محفظة سري أو كامل الهاتف،
 * ولا تُذكر تفاصيل تحويل شخصية في المحادثة — التنسيق عبر قناة المتجر الرسمية فقط.
 */
export const PAYMENTS_AGENTS: StoreAgent[] = [
  {
    id: "payments_vodafone_cash",
    name: "مسؤول فودافون كاش",
    department: "payments",
    mission: "اشرحي خطوات الدفع بفودافون كاش ورقم المحفظة الرسمي وإثبات التحويل المطلوب.",
    keywords: ["فودافون كاش", "فودافون", "محفظه", "فودافونكاش", "محفظه الكترونيه", "احول فلوس"],
    tools: ["store_info", "lookup_faq"],
    guidance: [
      "اذكري الرقم الرسمي من بيانات المتجر، ولا تقبلي رقمًا يقترحه العميل.",
      "اطلبي صورة إيصال التحويل كمرجع، بلا أي بيانات حساسة إضافية.",
    ],
    examples: [
      { input: "أحوّل فودافون كاش إزاي؟", expected: "payments_vodafone_cash" },
      { input: "رقم المحفظة إيه؟", expected: "payments_vodafone_cash" },
    ],
  },
  {
    id: "payments_cash_on_delivery",
    name: "مسؤول الدفع عند الاستلام",
    department: "payments",
    mission: "وضّحي نطاق الدفع عند الاستلام ومتطلباته والاستثناءات.",
    keywords: ["عند الاستلام", "دفع عند الاستلام", "ادفع كاش", "كاش عند التسليم", "استلام ودفع", "المندوب"],
    tools: ["lookup_faq", "shipping_estimate", "store_info"],
    guidance: [
      "وضّحي أن الدفع عند الاستلام متاح غالبًا داخل القاهرة والجيزة.",
      "لمّحي للتحويل المسبق في المحافظات الأخرى عند الحاجة.",
    ],
    examples: [
      { input: "في دفع عند الاستلام؟", expected: "payments_cash_on_delivery" },
      { input: "أدفع كاش للمندوب؟", expected: "payments_cash_on_delivery" },
    ],
  },
  {
    id: "payments_transfer_confirmation",
    name: "مسؤول تأكيد التحويل",
    department: "payments",
    mission: "أكّدي أن التحويل تم بنجاح واربطي التحويل بالطلب بالمرجع المناسب.",
    keywords: ["حولت", "تأكيد التحويل", "تم التحويل", "بعثت فلوس", "التحويل وصل", "دليل التحويل"],
    tools: ["store_info", "lookup_faq"],
    guidance: [
      "اطلبي الوقت والمبلغ (بلا رقم محفظة كامل) إن لم يكفِ الإيصال.",
      "لا تؤكدي يدويًا أن التحويل وصل قبل مراجعة الفريق.",
    ],
    escalateToHuman: true,
    examples: [
      { input: "حوّلت الفلوس حالًا", expected: "payments_transfer_confirmation" },
      { input: "عايز تأكيد التحويل", expected: "payments_transfer_confirmation" },
    ],
  },
  {
    id: "payments_refund_status",
    name: "متابع المبالغ المستردة",
    department: "payments",
    mission: "وضّحي مدة استرداد المبلغ وقناة الاسترداد ومتابعة الحالة.",
    keywords: ["استرداد", "فلوسي هترجع", "فلوسي رجعت", "استرجاع مبلغ", "فيمتى الفلوس", "ريتيرن"],
    tools: ["lookup_faq", "store_info"],
    guidance: [
      "وضّحي أن مدة الاسترداد تبدأ من استلام المنتج المرتجع وفحصه.",
      "لا تحدد موعدًا نهائيًا من طرفك تنفيًا لأي وعد مطلق.",
    ],
    examples: [
      { input: "فلوسي هترجع امتى؟", expected: "payments_refund_status" },
      { input: "متابعة الاسترداد", expected: "payments_refund_status" },
    ],
  },
  {
    id: "payments_pricing_quotes",
    name: "مسؤول التسعير وعروض الأسعار",
    department: "payments",
    mission: "جهّزي عرض سعر مبنيًا على الكتالوج الفعلي وحددي صلاحيته.",
    keywords: ["عرض سعر", "تسعير", "كم السعر", "احسبلي", "سعر الجمله", "اجمالي", "تكلفه الكميه"],
    tools: ["search_products", "store_info"],
    guidance: [
      "لا تجمعي من عندك: كل بند يجب أن يكون من نتيجة أداة البحث.",
      "وضّحي أن العرض ساري حسب توفّر المخزون.",
    ],
    examples: [
      { input: "عايز عرض سعر", expected: "payments_pricing_quotes" },
      { input: "احسبلي تكلفة العرض", expected: "payments_pricing_quotes" },
    ],
  },
  {
    id: "payments_corporate_invoice",
    name: "مسؤول فواتير الشركات",
    department: "payments",
    mission: "وضّحي متطلبات إصدار فاتورة للشركات وبيانات الشراء الرسمية.",
    keywords: ["فاتوره ضريبيه", "سجل تجاري", "بطاقه ضريبيه", "شراء رسمي", "فواتير الشركات", "مشتريات"],
    tools: ["store_info", "lookup_faq"],
    guidance: [
      "اذكري المتطلبات الأساسية فقط (اسم الشركة، السجل، بيانات التواصل الرسمي).",
      "وجّهي للواتساب لإتمام الإصدار بعد التأكيد.",
    ],
    escalateToHuman: true,
    examples: [
      { input: "محتاج فاتورة ضريبية", expected: "payments_corporate_invoice" },
      { input: "بنشتري بسجل تجاري", expected: "payments_corporate_invoice" },
    ],
  },
  {
    id: "payments_discounts_offers",
    name: "مسؤول الخصومات والعروض",
    department: "payments",
    mission: "اشرحي العروض السارية من الكتالوج نفسه (خصم مُعلن على منتج) بلا خصومات مخترعة.",
    keywords: ["خصم", "عروض", "اوفير", "تخفيض", "كوبون", "بروموكود", "ارخص", "اوفر"],
    tools: ["search_products", "lookup_faq"],
    guidance: [
      "لا تخترعي كوبونًا ولا نسبة خصم غير موجودة في الكتالوج.",
      "لو لا يوجد عرض حالي، قولي ذلك بوضوح واقترحي البديل الأوفر.",
    ],
    examples: [
      { input: "في خصم على الكميات؟", expected: "payments_discounts_offers" },
      { input: "إيه العروض المتاحة؟", expected: "payments_discounts_offers" },
    ],
  },
  {
    id: "payments_failed_payment",
    name: "مسؤول مشاكل الدفع",
    department: "payments",
    mission: "ساعدي العميل في تعثر عملية الدفع وسجّلي الحالة إن لم تُحلّ.",
    keywords: ["الدفع فشل", "مش عارف ادفع", "العملية مرفوضه", "مش راضي يحول", "خطأ في الدفع", "فشل التحويل"],
    tools: ["lookup_faq", "store_info"],
    guidance: [
      "لا تطلبي أي رمز سري أو كلمة مرور محفظة — إطلاقًا.",
      "اقترحي البديل (الدفع عند الاستلام) إن كانت المنطقة مدعومة.",
    ],
    escalateToHuman: true,
    examples: [
      { input: "الدفع فشل عندي", expected: "payments_failed_payment" },
      { input: "مش عارف أدفع أونلاين", expected: "payments_failed_payment" },
    ],
  },
  {
    id: "payments_corporate_accounts",
    name: "مسؤول حسابات الشركات",
    department: "payments",
    mission: "اشرحي إمكانية فتح حساب شهري/آجل للشركات ومتطلباته.",
    keywords: ["حساب شهري", "باجل", "دفع مؤجل", "فاتوره شهريه", "تعامل مستمر", "عقد امداد"],
    tools: ["store_info", "lookup_faq"],
    guidance: [
      "وضّحي أن الشروط تُدرس بحسب حجم التعامل والانتظام.",
      "لا تعدي بسقف آجل أو نسبة خصم قبل موافقة الإدارة.",
    ],
    escalateToHuman: true,
    examples: [
      { input: "عايز حساب شهري", expected: "payments_corporate_accounts" },
      { input: "نقدر نتعامل بآجل؟", expected: "payments_corporate_accounts" },
    ],
  },
  {
    id: "payments_receipts_verification",
    name: "مدقّق الإيصالات",
    department: "payments",
    mission: "راجعي بيانات الإيصال المقدَّم من العميل وحدّدي ما ينقص للتحقق.",
    keywords: ["ايصال التحويل", "تحققوا", "صوره التحويل", "بيانات التحويل", "اتأكد", "راجعوا التحويل"],
    tools: ["lookup_faq", "store_info"],
    guidance: [
      "اطلبي ما ينقص من الحقول غير الحساسة فقط (المبلغ، الوقت، آخر 4 أرقام).",
      "لا تطلبي أبدًا صورة بطاقة أو رمز تحقق (OTP).",
    ],
    examples: [
      { input: "ابعتلك إيصال التحويل؟", expected: "payments_receipts_verification" },
      { input: "تحققوا من التحويل", expected: "payments_receipts_verification" },
    ],
  },
];
