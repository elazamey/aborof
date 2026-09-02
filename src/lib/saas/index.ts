/**
 * SaaS Layer — مرجع حتمي لنموذج المنصة (راجع SAAS-MODEL.md).
 *
 * ملاحظة معمارية (قرار المستخدم): لا يُبنى Billing فوق `orders` الحالي؛
 * نطاق مستقل (billing/ و tenant/) — هذا المجلد مرجع إضافي غير مربوط بالمتجر،
 * والمتجر الحالي يعمل كما هو (single-tenant) حتى التنفيذ الكامل.
 */
export * from "./plans";
export * from "./entitlements";
export * from "./subscription";
export * from "./kpis";
