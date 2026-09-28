import type { StoreAgent } from "../types";

/**
 * قسم تشغيل المتجر والجودة — 10 وكلاء.
 *
 * هؤلاء يخدمون **المتجر من الداخل** لا العميل: أدوار مراجعة وتنبيه، وكلها
 * للقراءة فقط وتقدّم ملاحظات نصية ولا تعدّل أي بيانات. تُوجَّه إليها الرسائل
 * ذات الطابع التشغيلي (تُكتب غالبًا من الإدارة في نفس نافذة الدردشة).
 */
export const OPERATIONS_AGENTS: StoreAgent[] = [
  {
    id: "ops_catalog_hygiene",
    name: "مراجع كتالوج المنتجات",
    department: "operations",
    mission: "راجع جودة بيانات المنتجات (اسم، وصف، سعر، مخزون) واذكر النواقص الواضحة.",
    keywords: ["كتالوج", "بيانات المنتجات", "اوصاف المنتجات", "وصف المنتج", "مراجعه المنتجات", "نواقص البيانات"],
    tools: ["search_products", "store_info"],
    guidance: [
      "اذكري ملاحظات محددة على منتجات موجودة فعلًا في النتيجة.",
      "اقترحي صياغة بديلة للوصف بدل النقد العام.",
    ],
    examples: [
      { input: "راجع بيانات المنتجات", expected: "ops_catalog_hygiene" },
      { input: "في نواقص في أوصاف المنتجات؟", expected: "ops_catalog_hygiene" },
    ],
  },
  {
    id: "ops_stock_alerts",
    name: "مراقب المخزون",
    department: "operations",
    mission: "نبّهي على الأصناف القاربة على النفاد أو النافّدة بحسب بيانات المخزون المرجعة.",
    keywords: ["مخزون", "قاربه على النفاد", "المخزون ناقص", "كميات", "اعاده تعبئه"],
    tools: ["search_products", "store_info"],
    guidance: [
      "اذكري رقم المخزون كما ورد من الأداة بلا تخمين.",
      "رتّبي الأصناف بالأكثر إلحاحًا من حيث انخفاض المخزون.",
    ],
    examples: [
      { input: "إيه الأصناف القاربة على النفاد؟", expected: "ops_stock_alerts" },
      { input: "المخزون ناقص", expected: "ops_stock_alerts" },
    ],
  },
  {
    id: "ops_faq_gaps",
    name: "كاشف فجوات الأسئلة الشائعة",
    department: "operations",
    mission: "اكتشفي الأسئلة التي لا تجيبها الأسئلة الشائعة واقترحي صيغة إجابة جديدة.",
    keywords: ["الاسئله الشائعه", "اقترح اجابات", "فجوه", "سؤال متكرر", "محتوى الدعم"],
    tools: ["lookup_faq", "store_info"],
    guidance: [
      "لا تخترعي سياسة جديدة؛ اقترحي إجابة مبنية على ما هو معلن.",
      "اقترحي الصيغة النهائية جاهزة للنسخ.",
    ],
    examples: [
      { input: "في أسئلة شائعة ناقصة؟", expected: "ops_faq_gaps" },
      { input: "اقترح إجابات للأسئلة الجديدة", expected: "ops_faq_gaps" },
    ],
  },
  {
    id: "ops_brand_voice",
    name: "حارس نبرة العلامة",
    department: "operations",
    mission: "تأكدي من أن الردود على نبرة المتجر: ودية، مصرية بسيطة، قصيرة، بلا مبالغة.",
    keywords: ["نبره", "اسلوب الرد", "شخصيه المتجر", "لهجه", "صياغه الرد"],
    tools: ["store_info"],
    guidance: [
      "اذكري مخالفة واحدة محددة إن وُجدت مع نص بديل.",
      "حافظي على اللهجة المصرية البسيطة في أي اقتراح.",
    ],
    examples: [
      { input: "راجع نبرة الردود", expected: "ops_brand_voice" },
      { input: "أسلوب الرد مناسب؟", expected: "ops_brand_voice" },
    ],
  },
  {
    id: "ops_pricing_consistency",
    name: "مدقّق تماسك الأسعار",
    department: "operations",
    mission: "راجعي تماسك السعر مع السعر القديم ونسبة الخصم المعلنة.",
    keywords: ["تماسك الاسعار", "تناقض في الخصومات", "سعر قديم", "نسبه الخصم", "سعر غير منطقي"],
    tools: ["search_products"],
    guidance: [
      "أشيري للتناقض بالأرقام كما وردت من الأداة.",
      "لا تقترحي سعرًا نهائيًا؛ اقترحي قيمة متسقة فقط.",
    ],
    examples: [
      { input: "راجع تماسك الأسعار", expected: "ops_pricing_consistency" },
      { input: "في تناقض في الخصومات؟", expected: "ops_pricing_consistency" },
    ],
  },
  {
    id: "ops_pii_guard",
    name: "حارس خصوصية العملاء",
    department: "operations",
    mission: "راجعي أي نص للتأكد من عدم ظهور بيانات شخصية كاملة (هاتف كامل، عنوان، رقم محفظة).",
    keywords: ["بيانات شخصيه", "خصوصيه", "هاتف كامل", "عنوان العميل", "معلومات حساسه"],
    tools: ["store_info"],
    guidance: [
      "أشيري إلى نمط البيانات فقط بلا إعادة كتابة القيمة نفسها.",
      "اقترحي الصيغة المحجوبة الآمنة بدلًا منها.",
    ],
    examples: [
      { input: "اتأكد مفيش بيانات شخصية", expected: "ops_pii_guard" },
      { input: "راجع الخصوصية", expected: "ops_pii_guard" },
    ],
  },
  {
    id: "ops_seasonal_campaigns",
    name: "مخطط الحملات الموسمية",
    department: "operations",
    mission: "اقترحي أفكار حملات مرتبطة بالمواسم (رمضان، عيد، بداية العام الدراسي) من الكتالوج الحالي.",
    keywords: ["حمله", "موسم", "رمضان", "عيد", "باك تو سكول", "ترند", "تسويق", "اعلان"],
    tools: ["search_products", "store_info"],
    guidance: [
      "اربطي كل فكرة بمنتجات موجودة فعلًا مع سعرها.",
      "اذكري هدف الحملة ومقياس نجاحها في سطر واحد.",
    ],
    examples: [
      { input: "اقترح حملة لرمضان", expected: "ops_seasonal_campaigns" },
      { input: "في أفكار تسويق للموسم؟", expected: "ops_seasonal_campaigns" },
    ],
  },
  {
    id: "ops_chat_quality",
    name: "مقيّم جودة المحادثات",
    department: "operations",
    mission: "قيّمي آخر ردود المحادثة من حيث الوضوح والصحة وطول الرد.",
    keywords: ["جوده الردود", "تقييم المحادثه", "ردود الوكيل", "مراجعه الردود", "تجربه العميل"],
    tools: ["lookup_faq", "store_info"],
    guidance: [
      "اذكري معيارًا واحدًا واضحًا للتحسين مع مثال.",
      "لا تجمعي بيانات عميل أثناء التقييم.",
    ],
    examples: [
      { input: "قيّم جودة الردود", expected: "ops_chat_quality" },
      { input: "راجع تجربة العميل", expected: "ops_chat_quality" },
    ],
  },
  {
    id: "ops_content_safety",
    name: "حارس المحتوى الآمن",
    department: "operations",
    mission: "ارفضي وأعيدي التوجيه لأي طلب خارج نطاق المتجر (سياسة، طب، مواضيع حساسة).",
    keywords: ["خارج النطاق", "نصيحه طبيه", "موضوع حساس", "سياسه", "نصيحه قانونيه", "غير مناسب"],
    tools: ["store_info"],
    guidance: [
      "اعتذري بلطف في سطر واحد وأعيدي الحديث لمنتجات النظافة.",
      "لا تدخلي في جدال ولا تعطي رأيًا في الموضوع الخارجي.",
    ],
    examples: [
      { input: "السؤال خارج نطاق المتجر", expected: "ops_content_safety" },
      { input: "محتاج نصيحة طبية", expected: "ops_content_safety" },
    ],
  },
  {
    id: "ops_analytics_insights",
    name: "محلل مؤشرات المتجر",
    department: "operations",
    mission: "استخرجي ملاحظات تشغيلية من بيانات الكتالوج والأسئلة الشائعة (الأكثر طلبًا، الفجوات، فرص البيع).",
    keywords: ["تحليلات", "مؤشرات", "تقرير", "احصائيات", "الاكثر مبيعا", "اداء المتجر"],
    tools: ["search_products", "lookup_faq", "store_info"],
    guidance: [
      "اذكري الأرقام كما وردت من الأدوات وحددي الفترة إن ذكرها المستخدم.",
      "لا تدّعي بيانات مبيعات غير متاحة في الأدوات — قولي ما هو متاح فقط.",
    ],
    examples: [
      { input: "عايز تقرير عن أداء المتجر", expected: "ops_analytics_insights" },
      { input: "إيه الأكثر مبيعًا؟", expected: "ops_analytics_insights" },
    ],
  },
];
