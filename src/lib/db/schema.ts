/**
 * مخطط Drizzle — طبقة TypeScript الشفافة فوق Turso/libSQL.
 *
 * هذا الملف **لا يحلّ محل** الهجرات الحتمية في `src/lib/db/migrations/*.sql`.
 * الهجرات المرجعية (0001_initial.sql + 0002_search_fts5.sql) تبقى المصدر
 * الوحيد للحقيقة من حيث البنية الفعلية على القاعدة، وتُطبَّق فقط عبر
 * `runMigrations` (المُستخدَم في `ensureSchema` وفي بوابة `apply-migrations.mjs`).
 *
 * دور هذا المخطط:
 *   1. أمان الأنواع (Type Safety) عند كتابة استعلامات Drizzle.
 *   2. توليد SQL مرجعي عبر `drizzle-kit generate` للمقارنة (لا للتطبيق المباشر).
 *   3. التوافق مع `drizzle-orm/libsql` على Edge.
 *
 * القاعدة الذهبية: أي تغيير في البنية يمرّ أولًا عبر ملف `.sql` مرجعي +
 * `sync-migrations.mjs` (للبصمة) + `runMigrations`، ثم يُحدَّث هذا الملف
 * ليتطابق. العكس (تعديل schema ثم توليد هجرة Drizzle وتطبيقها مباشرة)
 * مرفوض — يكسر بوابة الهجرات وحتميتها.
 *
 * ملاحظة FTS5: جدول `product_search` الافتراضي (VIRTUAL TABLE USING fts5)
 * يُدار بالكامل عبر الهجرة 0002 ولا يُمثَّل هنا — Drizzle لا يدعم الجداول
 * الافتراضية بشكل أصلي، ومزامنته تتم في `src/lib/search.ts`.
 */

import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, index, check } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// products — الكتالوج
// ---------------------------------------------------------------------------
export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    price: real("price").notNull(),
    oldPrice: real("old_price"),
    category: text("category").notNull().default(""),
    image: text("image").notNull().default("🧴"),
    stock: integer("stock").notNull().default(0),
    featured: integer("featured").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    nameCheck: check(
      "products_name_check",
      sql`length(trim(${table.name})) >= 2 AND length(${table.name}) <= 200`
    ),
    descriptionCheck: check(
      "products_description_check",
      sql`length(${table.description}) <= 5000`
    ),
    priceCheck: check(
      "products_price_check",
      sql`${table.price} >= 0 AND ${table.price} <= 1000000`
    ),
    oldPriceCheck: check(
      "products_old_price_check",
      sql`${table.oldPrice} IS NULL OR ${table.oldPrice} >= 0`
    ),
    categoryCheck: check(
      "products_category_check",
      sql`length(${table.category}) <= 100`
    ),
    imageCheck: check(
      "products_image_check",
      sql`length(${table.image}) <= 20`
    ),
    stockCheck: check(
      "products_stock_check",
      sql`${table.stock} >= 0 AND ${table.stock} <= 1000000`
    ),
    featuredCheck: check(
      "products_featured_check",
      sql`${table.featured} IN (0, 1)`
    ),
  })
);

// ---------------------------------------------------------------------------
// orders — الطلبات
// ---------------------------------------------------------------------------
export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    customer: text("customer").notNull(),
    phone: text("phone").notNull(),
    address: text("address").notNull().default(""),
    governorate: text("governorate").notNull().default(""),
    items: text("items").notNull().default("[]"),
    total: real("total").notNull(),
    shippingFee: real("shipping_fee").notNull().default(0),
    payment: text("payment").notNull().default("vodafone_cash"),
    transferRef: text("transfer_ref").notNull().default(""),
    receiptUrl: text("receipt_url").notNull().default(""),
    status: text("status").notNull().default("جديد"),
    note: text("note").notNull().default(""),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    customerCheck: check(
      "orders_customer_check",
      sql`length(trim(${table.customer})) >= 2 AND length(${table.customer}) <= 120`
    ),
    phoneCheck: check(
      "orders_phone_check",
      sql`length(trim(${table.phone})) >= 8 AND length(${table.phone}) <= 30`
    ),
    addressCheck: check(
      "orders_address_check",
      sql`length(${table.address}) <= 500`
    ),
    governorateCheck: check(
      "orders_governorate_check",
      sql`length(${table.governorate}) <= 60`
    ),
    totalCheck: check(
      "orders_total_check",
      sql`${table.total} >= 0 AND ${table.total} <= 10000000`
    ),
    shippingFeeCheck: check(
      "orders_shipping_fee_check",
      sql`${table.shippingFee} >= 0 AND ${table.shippingFee} <= 1000`
    ),
    paymentCheck: check(
      "orders_payment_check",
      sql`${table.payment} IN ('cod', 'vodafone_cash')`
    ),
    transferRefCheck: check(
      "orders_transfer_ref_check",
      sql`length(${table.transferRef}) <= 120`
    ),
    receiptUrlCheck: check(
      "orders_receipt_url_check",
      sql`length(${table.receiptUrl}) <= 500`
    ),
    statusCheck: check(
      "orders_status_check",
      sql`${table.status} IN ('جديد', 'قيد المراجعة', 'مؤكد', 'قيد الشحن', 'مكتمل', 'ملغى')`
    ),
    noteCheck: check(
      "orders_note_check",
      sql`length(${table.note}) <= 500`
    ),
    createdAtIdx: index("idx_orders_created").on(table.createdAt),
  })
);

// ---------------------------------------------------------------------------
// order_items — أصناف الطلب (مُطبّع)
// ---------------------------------------------------------------------------
export const orderItems = sqliteTable(
  "order_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    price: real("price").notNull(),
    qty: integer("qty").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    priceCheck: check("order_items_price_check", sql`${table.price} >= 0`),
    qtyCheck: check(
      "order_items_qty_check",
      sql`${table.qty} >= 1 AND ${table.qty} <= 100`
    ),
    orderIdx: index("idx_order_items_order").on(table.orderId),
  })
);

// ---------------------------------------------------------------------------
// faq — الأسئلة الشائعة
// ---------------------------------------------------------------------------
export const faq = sqliteTable(
  "faq",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
  },
  (table) => ({
    questionCheck: check(
      "faq_question_check",
      sql`length(${table.question}) <= 1000`
    ),
    answerCheck: check(
      "faq_answer_check",
      sql`length(${table.answer}) <= 5000`
    ),
  })
);

// ---------------------------------------------------------------------------
// chat_logs — سجل المحادثات
// ---------------------------------------------------------------------------
export const chatLogs = sqliteTable(
  "chat_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    question: text("question"),
    answer: text("answer"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    questionCheck: check(
      "chat_logs_question_check",
      sql`${table.question} IS NULL OR length(${table.question}) <= 4000`
    ),
    answerCheck: check(
      "chat_logs_answer_check",
      sql`${table.answer} IS NULL OR length(${table.answer}) <= 8000`
    ),
  })
);

// ---------------------------------------------------------------------------
// admin_audit_log — تدقيق الإدارة
// ---------------------------------------------------------------------------
export const adminAuditLog = sqliteTable(
  "admin_audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull().default(""),
    details: text("details").notNull().default("{}"),
    actor: text("actor").notNull().default("admin"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    actionCheck: check(
      "admin_audit_log_action_check",
      sql`length(${table.action}) <= 80`
    ),
    entityCheck: check(
      "admin_audit_log_entity_check",
      sql`length(${table.entity}) <= 80`
    ),
    entityIdCheck: check(
      "admin_audit_log_entity_id_check",
      sql`length(${table.entityId}) <= 120`
    ),
    detailsCheck: check(
      "admin_audit_log_details_check",
      sql`length(${table.details}) <= 4000`
    ),
  })
);

// ---------------------------------------------------------------------------
// rate_limit_counters — عدّادات تحديد المعدل
// ---------------------------------------------------------------------------
export const rateLimitCounters = sqliteTable(
  "rate_limit_counters",
  {
    bucketKey: text("bucket_key").primaryKey(),
    count: integer("count").notNull().default(0),
    resetAt: integer("reset_at").notNull(),
  },
  (table) => ({
    countCheck: check(
      "rate_limit_counters_count_check",
      sql`${table.count} >= 0`
    ),
    resetAtIdx: index("idx_rate_limit_reset").on(table.resetAt),
  })
);

// ---------------------------------------------------------------------------
// rbac_roles / rbac_users — لوحة الصلاحيات (هجرة 0003)
//
// الهجرة المرجعية هي المصدر الوحيد للحقيقة (القيود والفهارس تُنشأ هناك)،
// وهذا التمثيل لأمان الأنواع والاستعلامات فقط. أبرز ما يجب أن يبقى مطابقًا:
//  - `username` فريد، و`role_id` مفتاح خارجي بـ ON DELETE RESTRICT.
//  - `permissions` نص JSON (مصفوفة) وليس جدولًا مُطبّعًا: الكتالوج في الكود.
//  - `builtin` يميّز الأدوار المحصّنة (owner) عن الأدوار المخصصة.
// ---------------------------------------------------------------------------
export const rbacRoles = sqliteTable(
  "rbac_roles",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    description: text("description").notNull().default(""),
    permissions: text("permissions").notNull().default("[]"),
    builtin: integer("builtin").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    idCheck: check("rbac_roles_id_check", sql`length(${table.id}) BETWEEN 2 AND 60`),
    labelCheck: check(
      "rbac_roles_label_check",
      sql`length(trim(${table.label})) >= 2 AND length(${table.label}) <= 60`
    ),
    descriptionCheck: check(
      "rbac_roles_description_check",
      sql`length(${table.description}) <= 300`
    ),
    permissionsCheck: check("rbac_roles_permissions_check", sql`json_valid(${table.permissions})`),
    builtinCheck: check("rbac_roles_builtin_check", sql`${table.builtin} IN (0, 1)`),
  })
);

export const rbacUsers = sqliteTable(
  "rbac_users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull().unique(),
    displayName: text("display_name").notNull().default(""),
    roleId: text("role_id")
      .notNull()
      .references(() => rbacRoles.id, { onDelete: "restrict" }),
    passwordHash: text("password_hash").notNull(),
    passwordSource: text("password_source").notNull().default("panel"),
    status: text("status").notNull().default("active"),
    tokenVersion: integer("token_version").notNull().default(1),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: integer("locked_until").notNull().default(0),
    lastLoginAt: text("last_login_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    usernameCheck: check(
      "rbac_users_username_check",
      sql`length(trim(${table.username})) >= 3 AND length(${table.username}) <= 60`
    ),
    displayNameCheck: check(
      "rbac_users_display_name_check",
      sql`length(${table.displayName}) <= 60`
    ),
    passwordHashCheck: check(
      "rbac_users_password_hash_check",
      sql`length(${table.passwordHash}) BETWEEN 40 AND 400`
    ),
    passwordSourceCheck: check(
      "rbac_users_password_source_check",
      sql`${table.passwordSource} IN ('bootstrap', 'panel')`
    ),
    statusCheck: check("rbac_users_status_check", sql`${table.status} IN ('active', 'disabled')`),
    tokenVersionCheck: check("rbac_users_token_version_check", sql`${table.tokenVersion} >= 1`),
    failedAttemptsCheck: check(
      "rbac_users_failed_attempts_check",
      sql`${table.failedAttempts} >= 0`
    ),
    lockedUntilCheck: check("rbac_users_locked_until_check", sql`${table.lockedUntil} >= 0`),
    roleIdx: index("idx_rbac_users_role").on(table.roleId),
    statusIdx: index("idx_rbac_users_status").on(table.status),
  })
);

// ---------------------------------------------------------------------------
// schema_migrations — سجل الهجرات الحتمي
// ---------------------------------------------------------------------------
export const schemaMigrations = sqliteTable("schema_migrations", {
  version: text("version").primaryKey(),
  name: text("name").notNull(),
  checksum: text("checksum").notNull(),
  appliedAt: text("applied_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// تصدير تجميعي + أنواع مستنتجة
// ---------------------------------------------------------------------------
export const schema = {
  products,
  orders,
  orderItems,
  faq,
  chatLogs,
  adminAuditLog,
  rateLimitCounters,
  rbacRoles,
  rbacUsers,
  schemaMigrations,
} as const;

export type ProductRow = typeof products.$inferSelect;
export type NewProductRow = typeof products.$inferInsert;
export type OrderRow = typeof orders.$inferSelect;
export type NewOrderRow = typeof orders.$inferInsert;
export type OrderItemRow = typeof orderItems.$inferSelect;
export type NewOrderItemRow = typeof orderItems.$inferInsert;
export type FaqRow = typeof faq.$inferSelect;
export type ChatLogRow = typeof chatLogs.$inferSelect;
export type AdminAuditLogRow = typeof adminAuditLog.$inferSelect;
export type RateLimitCounterRow = typeof rateLimitCounters.$inferSelect;
export type SchemaMigrationRow = typeof schemaMigrations.$inferSelect;
export type RbacRoleRow = typeof rbacRoles.$inferSelect;
export type NewRbacRoleRow = typeof rbacRoles.$inferInsert;
export type RbacUserRow = typeof rbacUsers.$inferSelect;
export type NewRbacUserRow = typeof rbacUsers.$inferInsert;

// FTS5 — يُدار عبر الهجرة 0002 فقط (VIRTUAL TABLE). لا يُمثَّل في Drizzle
// كجدول عادي؛ الاستعلام عليه يكون عبر SQL الخام في `src/lib/search.ts`:
//   SELECT * FROM product_search WHERE product_search MATCH ?
// ومزامنته تتم في `ensureProductSearchInSync`.
