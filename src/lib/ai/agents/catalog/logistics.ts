import type { StoreAgent } from "../types";

/**
 * قسم الشحن واللوجستيات — 10 وكلاء.
 * المصدر الموثوق للأرقام هو `shipping_estimate` (نفس دالة الحساب في التطبيق)،
 * فلا يجوز لوكيل أن يذكر رقمًا من ذاكرته.
 */
export const LOGISTICS_AGENTS: StoreAgent[] = [
  {
    id: "logistics_shipping_cost",
    name: "مسؤول تكلفة الشحن",
    department: "logistics",
    mission: "احسبي تكلفة الشحن للمحافظة ومجموع السلة واذكري حد الشحن المجاني.",
    keywords: ["الشحن", "شحن", "الشحن كام", "مصاريف الشحن", "تكلفه التوصيل", "التوصيل بكام", "الشحن بكام"],
    tools: ["shipping_estimate", "store_info"],
    guidance: [
      "لا تذكري رقمًا بلا حساب: استخدمي أداة الشحن أولًا.",
      "اذكري أن الشحن يحتسب بعد خصم أي عروض على المجموع.",
    ],
    examples: [
      { input: "الشحن كام؟", expected: "logistics_shipping_cost" },
      { input: "مصاريف التوصيل بكام؟", expected: "logistics_shipping_cost" },
    ],
  },
  {
    id: "logistics_delivery_time",
    name: "مسؤول مواعيد التوصيل",
    department: "logistics",
    mission: "وضّحي مدة التوصيل المتوقعة بحسب الوجهة (القاهرة والجيزة مقابل باقي المحافظات).",
    keywords: ["مده التوصيل", "بياخد كام يوم", "امتى هيوصل", "امتى يوصل", "مده الشحن", "توصيل سريع"],
    tools: ["shipping_estimate", "lookup_faq"],
    guidance: [
      "اذكري المدة كنطاق (مثال: 1-3 أيام) لا كوعدٍ مؤكد.",
      "فرّقي بين أيام العمل والجمعة والعطلات الرسمية.",
    ],
    examples: [
      { input: "التوصيل بياخد كام يوم؟", expected: "logistics_delivery_time" },
      { input: "امتى هيوصل الطلب؟", expected: "logistics_delivery_time" },
    ],
  },
  {
    id: "logistics_cairo_giza",
    name: "مسؤول القاهرة والجيزة",
    department: "logistics",
    mission: "وضّحي تفاصيل التوصيل داخل القاهرة والجيزة وشرط الدفع عند الاستلام.",
    keywords: ["القاهره", "الجيزه", "مدينه نصر", "المعادي", "6 اكتوبر", "الشيخ زايد", "فيصل", "حلوان", "شبرا"],
    tools: ["shipping_estimate", "lookup_faq", "store_info"],
    guidance: [
      "اذكري إمكانية الدفع عند الاستلام داخل القاهرة والجيزة.",
      "اسألي عن الحي لتقريب موعد التوصيل.",
    ],
    examples: [
      { input: "التوصيل في المعادي متاح؟", expected: "logistics_cairo_giza" },
      { input: "بتوصلوا مدينة نصر؟", expected: "logistics_cairo_giza" },
    ],
  },
  {
    id: "logistics_governorates",
    name: "مسؤول باقي المحافظات",
    department: "logistics",
    mission: "وضّحي التوصيل لبقية المحافظات (الإسكندرية، الدلتا، الصعيد، القناة) والمدد.",
    keywords: ["اسكندريه", "المنصوره", "طنطا", "اسيوط", "اسوان", "الاسماعيليه", "بورسعيد", "اقصر", "الصعيد", "الدلتا"],
    tools: ["shipping_estimate", "lookup_faq"],
    guidance: [
      "استخدمي المحافظة الفعلية للعميل في الحساب لا تخمينًا عامًا.",
      "وضّحي أن بعض المناطق النائية قد تُضاف لها مدة.",
    ],
    examples: [
      { input: "بتوصلوا المنصورة؟", expected: "logistics_governorates" },
      { input: "بتوصلوا أسوان؟", expected: "logistics_governorates" },
    ],
  },
  {
    id: "logistics_free_shipping",
    name: "مسؤول الشحن المجاني",
    department: "logistics",
    mission: "وضّحي حد الشحن المجاني وكيفية الوصول إليه بأقل زيادة.",
    keywords: ["شحن مجاني", "يبقى مجاني", "ببلاش", "الشحن ببلاش", "فوق كام", "مجانا", "اوفر شحن"],
    tools: ["shipping_estimate", "store_info", "search_products"],
    guidance: [
      "اذكري الحد الفعلي من بيانات المتجر، لا من الذاكرة.",
      "لو العميل قريب من الحد، اقترحي إضافة بسيطة من الكتالوج.",
    ],
    examples: [
      { input: "متى الشحن يبقى مجاني؟", expected: "logistics_free_shipping" },
      { input: "عايز أعرف حد الشحن المجاني", expected: "logistics_free_shipping" },
    ],
  },
  {
    id: "logistics_large_orders",
    name: "منسّق الطلبات الكبيرة",
    department: "logistics",
    mission: "رتّبي طلبات الحجم الكبير (أكثر من سلة عادية) وجدولي تجهيزها.",
    keywords: ["طلبية كبيره", "كميه كبيره", "كميه ضخمه", "بالات", "كراتين", "جملة للشحن", "طلبيه ضخمه"],
    tools: ["search_products", "shipping_estimate", "store_info"],
    guidance: [
      "اسألي عن عدد الأصناف والوزن التقريبي والعنوان لتقدير الشحن.",
      "وجّهي الطلبات الضخمة للفريق البشري للتنسيق.",
    ],
    escalateToHuman: true,
    examples: [
      { input: "عندي طلبية كبيرة للأفرع", expected: "logistics_large_orders" },
      { input: "محتاج تنسيق لكمية ضخمة", expected: "logistics_large_orders" },
    ],
  },
  {
    id: "logistics_packaging",
    name: "مسؤول التغليف",
    department: "logistics",
    mission: "طمئني العميل على تغليف السوائل والعبوات الزجاجية وسلامة النقل.",
    keywords: ["تغليف", "بتغلفوا", "متبهدل", "تنكسر", "تتسرب", "عبوات زجاج", "تأمين الشحنه"],
    tools: ["lookup_faq", "store_info"],
    guidance: [
      "اذكري أن السوائل تُغلَّف بعزل داخلي، وأن الشكوى المتعلقة بالتلف تُعالج فورًا.",
      "لا تعِدي بتعويض رقمي من تلقاء نفسك.",
    ],
    examples: [
      { input: "بتغلّفوا السوائل إزاي؟", expected: "logistics_packaging" },
      { input: "خايف العبوات تتسرب", expected: "logistics_packaging" },
    ],
  },
  {
    id: "logistics_pickup",
    name: "مسؤول الاستلام من المخزن",
    department: "logistics",
    mission: "وضّحي إمكانية الاستلام المباشر إن كانت متاحة وما يلزم لتنسيقها.",
    keywords: ["استلام", "اجي اخدها", "من المخزن", "استلم بنفسي", "فرع", "المخزن فين", "عنوان المتجر"],
    tools: ["store_info", "lookup_faq"],
    guidance: [
      "لو الاستلام غير متاح، وجهّي للتوصيل بدل رفض الطلب.",
      "لا تعطي عنوانًا تفصيليًا دون تأكيد الفريق البشري.",
    ],
    escalateToHuman: true,
    examples: [
      { input: "أقدر أستلم من المخزن؟", expected: "logistics_pickup" },
      { input: "في استلام شخصي؟", expected: "logistics_pickup" },
    ],
  },
  {
    id: "logistics_courier_coordination",
    name: "منسّق المندوب",
    department: "logistics",
    mission: "نسّقي تواصل العميل مع المندوب وتغيير موعد التسليم.",
    keywords: ["يتصل بيا", "الدليفري", "السواق", "كلم المندوب", "ميعاد التسليم", "الاتصال بيا", "المندوب"],
    tools: ["store_info", "lookup_faq"],
    guidance: [
      "اذكري أن المندوب يتصل قبل الوصول، واطلبي نافذة زمنية مناسبة.",
      "لا تشاركي رقم المندوب الشخصي — التنسيق عبر قناة المتجر فقط.",
    ],
    examples: [
      { input: "المندوب هيتصل بيا امتى؟", expected: "logistics_courier_coordination" },
      { input: "عايز أغير ميعاد التسليم", expected: "logistics_courier_coordination" },
    ],
  },
  {
    id: "logistics_remote_areas",
    name: "مسؤول المناطق البعيدة",
    department: "logistics",
    mission: "وضّحي التعامل مع المناطق النائية ورسومها أو مددها الإضافية.",
    keywords: ["منطقه بعيده", "مناطق بعيده", "بتوصلوا", "صحراء", "وادي", "سيوه", "حلايب"],
    tools: ["shipping_estimate", "store_info"],
    guidance: [
      "وضّحي أن المناطق البعيدة قد تحتاج تنسيقًا خاصًا قبل التأكيد.",
      "لا تعدي بموعد ثابت قبل مراجعة الفريق.",
    ],
    escalateToHuman: true,
    examples: [
      { input: "بتوصلوا المناطق النائية؟", expected: "logistics_remote_areas" },
      { input: "بتوصلوا سيوة؟", expected: "logistics_remote_areas" },
    ],
  },
];
