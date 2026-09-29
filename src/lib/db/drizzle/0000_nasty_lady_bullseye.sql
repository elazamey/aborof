CREATE TABLE `admin_audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text DEFAULT '' NOT NULL,
	`details` text DEFAULT '{}' NOT NULL,
	`actor` text DEFAULT 'admin' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "admin_audit_log_action_check" CHECK(length("admin_audit_log"."action") <= 80),
	CONSTRAINT "admin_audit_log_entity_check" CHECK(length("admin_audit_log"."entity") <= 80),
	CONSTRAINT "admin_audit_log_entity_id_check" CHECK(length("admin_audit_log"."entity_id") <= 120),
	CONSTRAINT "admin_audit_log_details_check" CHECK(length("admin_audit_log"."details") <= 4000)
);
--> statement-breakpoint
CREATE TABLE `chat_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question` text,
	`answer` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "chat_logs_question_check" CHECK("chat_logs"."question" IS NULL OR length("chat_logs"."question") <= 4000),
	CONSTRAINT "chat_logs_answer_check" CHECK("chat_logs"."answer" IS NULL OR length("chat_logs"."answer") <= 8000)
);
--> statement-breakpoint
CREATE TABLE `faq` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	CONSTRAINT "faq_question_check" CHECK(length("faq"."question") <= 1000),
	CONSTRAINT "faq_answer_check" CHECK(length("faq"."answer") <= 5000)
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`product_id` text NOT NULL,
	`name` text NOT NULL,
	`price` real NOT NULL,
	`qty` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_items_price_check" CHECK("order_items"."price" >= 0),
	CONSTRAINT "order_items_qty_check" CHECK("order_items"."qty" >= 1 AND "order_items"."qty" <= 100)
);
--> statement-breakpoint
CREATE INDEX `idx_order_items_order` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`customer` text NOT NULL,
	`phone` text NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`governorate` text DEFAULT '' NOT NULL,
	`items` text DEFAULT '[]' NOT NULL,
	`total` real NOT NULL,
	`shipping_fee` real DEFAULT 0 NOT NULL,
	`payment` text DEFAULT 'vodafone_cash' NOT NULL,
	`transfer_ref` text DEFAULT '' NOT NULL,
	`receipt_url` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'جديد' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "orders_customer_check" CHECK(length(trim("orders"."customer")) >= 2 AND length("orders"."customer") <= 120),
	CONSTRAINT "orders_phone_check" CHECK(length(trim("orders"."phone")) >= 8 AND length("orders"."phone") <= 30),
	CONSTRAINT "orders_address_check" CHECK(length("orders"."address") <= 500),
	CONSTRAINT "orders_governorate_check" CHECK(length("orders"."governorate") <= 60),
	CONSTRAINT "orders_total_check" CHECK("orders"."total" >= 0 AND "orders"."total" <= 10000000),
	CONSTRAINT "orders_shipping_fee_check" CHECK("orders"."shipping_fee" >= 0 AND "orders"."shipping_fee" <= 1000),
	CONSTRAINT "orders_payment_check" CHECK("orders"."payment" IN ('cod', 'vodafone_cash')),
	CONSTRAINT "orders_transfer_ref_check" CHECK(length("orders"."transfer_ref") <= 120),
	CONSTRAINT "orders_receipt_url_check" CHECK(length("orders"."receipt_url") <= 500),
	CONSTRAINT "orders_status_check" CHECK("orders"."status" IN ('جديد', 'قيد المراجعة', 'مؤكد', 'قيد الشحن', 'مكتمل', 'ملغى')),
	CONSTRAINT "orders_note_check" CHECK(length("orders"."note") <= 500)
);
--> statement-breakpoint
CREATE INDEX `idx_orders_created` ON `orders` (`created_at`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`price` real NOT NULL,
	`old_price` real,
	`category` text DEFAULT '' NOT NULL,
	`image` text DEFAULT '🧴' NOT NULL,
	`stock` integer DEFAULT 0 NOT NULL,
	`featured` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "products_name_check" CHECK(length(trim("products"."name")) >= 2 AND length("products"."name") <= 200),
	CONSTRAINT "products_description_check" CHECK(length("products"."description") <= 5000),
	CONSTRAINT "products_price_check" CHECK("products"."price" >= 0 AND "products"."price" <= 1000000),
	CONSTRAINT "products_old_price_check" CHECK("products"."old_price" IS NULL OR "products"."old_price" >= 0),
	CONSTRAINT "products_category_check" CHECK(length("products"."category") <= 100),
	CONSTRAINT "products_image_check" CHECK(length("products"."image") <= 20),
	CONSTRAINT "products_stock_check" CHECK("products"."stock" >= 0 AND "products"."stock" <= 1000000),
	CONSTRAINT "products_featured_check" CHECK("products"."featured" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `rate_limit_counters` (
	`bucket_key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`reset_at` integer NOT NULL,
	CONSTRAINT "rate_limit_counters_count_check" CHECK("rate_limit_counters"."count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_rate_limit_reset` ON `rate_limit_counters` (`reset_at`);--> statement-breakpoint
CREATE TABLE `schema_migrations` (
	`version` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`checksum` text NOT NULL,
	`applied_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
