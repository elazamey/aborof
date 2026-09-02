-- 0001_initial: المخطط المرجعي مع قيود السلامة.
-- يُنفَّذ داخل معاملة واحدة. على قواعد البيانات القائمة تُنشأ الجداول
-- بصيغة IF NOT EXISTS، وتُضاف الأعمدة الناقصة بشكل حارس (idempotent).
-- ملاحظة: SQLite لا يدعم إضافة قيود FK/CHECK عبر ALTER TABLE؛ الجداول
-- الجديدة (order_items، rate_limit_counters) تحمل القيود كاملة، وأي إعادة
-- إنشاء مستقبلية لجدول orders ستأخذ القيود من هذا المرجع.
-- ملاحظة: تفعيل foreign_keys يتم عبر PRAGMA داخل كل معاملة كتابة.

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) >= 2 AND length(name) <= 200),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  price REAL NOT NULL CHECK (price >= 0 AND price <= 1000000),
  old_price REAL CHECK (old_price IS NULL OR old_price >= 0),
  category TEXT NOT NULL DEFAULT '' CHECK (length(category) <= 100),
  image TEXT NOT NULL DEFAULT '🧴' CHECK (length(image) <= 20),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0 AND stock <= 1000000),
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  customer TEXT NOT NULL CHECK (length(trim(customer)) >= 2 AND length(customer) <= 120),
  phone TEXT NOT NULL CHECK (length(trim(phone)) >= 8 AND length(phone) <= 30),
  address TEXT NOT NULL DEFAULT '' CHECK (length(address) <= 500),
  governorate TEXT NOT NULL DEFAULT '' CHECK (length(governorate) <= 60),
  items TEXT NOT NULL DEFAULT '[]',
  total REAL NOT NULL CHECK (total >= 0 AND total <= 10000000),
  shipping_fee REAL NOT NULL DEFAULT 0 CHECK (shipping_fee >= 0 AND shipping_fee <= 1000),
  payment TEXT NOT NULL DEFAULT 'vodafone_cash' CHECK (payment IN ('cod', 'vodafone_cash')),
  transfer_ref TEXT NOT NULL DEFAULT '' CHECK (length(transfer_ref) <= 120),
  receipt_url TEXT NOT NULL DEFAULT '' CHECK (length(receipt_url) <= 500),
  status TEXT NOT NULL DEFAULT 'جديد'
    CHECK (status IN ('جديد', 'قيد المراجعة', 'مؤكد', 'قيد الشحن', 'مكتمل', 'ملغى')),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- تفاصيل أصناف الطلب بشكل مُطبّع مع مفتاح أجنبي: يمنع السجلات اليتيمة
-- ويتيح التحقق من الكميات والقيم على مستوى قاعدة البيانات.
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price REAL NOT NULL CHECK (price >= 0),
  qty INTEGER NOT NULL CHECK (qty >= 1 AND qty <= 100),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

CREATE TABLE IF NOT EXISTS faq (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL CHECK (length(question) <= 1000),
  answer TEXT NOT NULL CHECK (length(answer) <= 5000)
);

CREATE TABLE IF NOT EXISTS chat_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT CHECK (question IS NULL OR length(question) <= 4000),
  answer TEXT CHECK (answer IS NULL OR length(answer) <= 8000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL CHECK (length(action) <= 80),
  entity TEXT NOT NULL CHECK (length(entity) <= 80),
  entity_id TEXT NOT NULL DEFAULT '' CHECK (length(entity_id) <= 120),
  details TEXT NOT NULL DEFAULT '{}' CHECK (length(details) <= 4000),
  actor TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- عدّادات تحديد المعدل الموزعة: صف واحد لكل مفتاح، عملية UPSERT ذرية.
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  reset_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_reset ON rate_limit_counters(reset_at);

-- ترقية الأعمدة الناقصة في قواعد البيانات القائمة (حسب الاسم فقط).
-- @ensure-columns:governorate TEXT NOT NULL DEFAULT ''
-- @ensure-columns:shipping_fee REAL NOT NULL DEFAULT 0
-- @ensure-columns:transfer_ref TEXT NOT NULL DEFAULT ''
-- @ensure-columns:receipt_url TEXT NOT NULL DEFAULT ''
-- @ensure-columns:note TEXT NOT NULL DEFAULT ''
