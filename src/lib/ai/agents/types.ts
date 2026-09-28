/**
 * أسطول وكلاء المتجر — العقود (المرحلة الرابعة، إضافة بالكامل).
 *
 * وكيل المتجر هنا **تعريف تصريحي** لا كود تنفيذي: هوية + مهمة + محفزات توجيه
 * + مجموعة أدوات مسموحة من طبقة MCP المحكومة. لا يستطيع أي وكيل:
 *   - تنفيذ شيء بنفسه (التنفيذ حصريًا عبر `McpToolRegistry`)،
 *   - أو توسيع صلاحياته (المسموح تقاطع مع قائمة الطبقة، لا اتحاد معها)،
 *   - أو الكتابة في قاعدة البيانات (كل أدوات الأسطول `readOnly` إلزامًا).
 *
 * الفائدة من الفصل: خمسون وكيلًا = خمسون صفًا في كتالوج مُتحقَّق منه، لا خمسون
 * مسارًا جديدًا. العرض الحالي (شخصية واحدة) يبقى كما هو ما دام العلم مغلقًا.
 */

export const AGENT_DEPARTMENTS = [
  "sales",
  "support",
  "logistics",
  "payments",
  "operations",
] as const;

export type AgentDepartment = (typeof AGENT_DEPARTMENTS)[number];

/** الوصف العربي للأقسام — للعرض في المانيفست الإداري ودليل التشغيل. */
export const DEPARTMENT_LABELS: Record<AgentDepartment, string> = {
  sales: "المبيعات والترشيح",
  support: "خدمة العملاء والدعم",
  logistics: "الشحن واللوجستيات",
  payments: "الدفع والفوترة",
  operations: "تشغيل المتجر والجودة",
};

/**
 * مثال توجيه معلن مع الوكيل: يُثبت أن محفزات الوكيل تعمل فعليًا في CI،
 * ويُصدَّر داخل المانيفست ليقرأه أي فريق أو أداة خارجية.
 */
export interface AgentExample {
  /** نص المستخدم كما يُكتب طبيعيًا (لا كلمة محفّز مقتطعة إن أمكن). */
  input: string;
  /** معرّف الوكيل المتوقع — يجب أن يساوي `id` صاحب المثال، ويتحقق آليًا. */
  expected: string;
}

export interface StoreAgent {
  /** معرّف ثابت بصيغة snake_case — يُستخدم في السجل والتوجيه والاختبارات. */
  id: string;
  /** الاسم المعروض للعميل (أو للإدارة في وكلاء التشغيل). */
  name: string;
  department: AgentDepartment;
  /** مهمة واحدة واضحة بصيغة أمر — تُلصق في رسالة النظام عند التوجيه. */
  mission: string;
  /** محفزات عربية تُطبَّع عند التسجيل (بلا تشكيل ولا همزات مختلفة). */
  keywords: string[];
  /** أسماء أدوات MCP — تُتحقق عند التسجيل مقابل الأدوات المسجّلة للقراءة فقط. */
  tools: string[];
  /** 1-3 قواعد سلوك قصيرة تُلصق مع المهمة. */
  guidance: string[];
  /** هل يُطلب التصعيد لقناة بشرية (واتساب) في نهاية الرد؟ */
  escalateToHuman?: boolean;
  /** الوكيل الافتراضي عند غياب أي تطابق — واحد فقط في الأسطول كله. */
  isDefault?: boolean;
  /**
   * أمثلة توجيه معلنة (2-3 لكل وكيل). تُفرض في CI: كل مثال يجب أن يُوجَّه
   * فعلًا إلى الوكيل المعلن، وإلا فشل الاختبار المُولَّد من هذه البيانات نفسها.
   * لا تُخزَّن هنا نصوص رسائل النظام: الرسالة تُركَّب من mission + guidance.
   */
  examples: AgentExample[];
}

/** نتيجة التوجيه: الوكيل الأساسي ومن يساعده، مع سبب القرار. */
export interface AgentSelection {
  primary: StoreAgent;
  supporters: StoreAgent[];
  /** 0..1 — نسبة من سقف الدرجة، تُستخدم للمراقبة لا للقرار. */
  confidence: number;
  /** الكلمات التي طابقت فعلًا (بعد التطبيع) — للشفافية في الاختبارات والسجل. */
  matched: string[];
  routedBy: "keyword" | "fallback";
}

/** بيانات مختصرة تُعاد في استجابة /api/chat — بلا أي محتوى داخلي حساس. */
export interface FleetResponseMeta {
  primary: { id: string; name: string; department: AgentDepartment };
  supporters: { id: string; name: string; department: AgentDepartment }[];
  routed_by: AgentSelection["routedBy"];
  confidence: number;
}
