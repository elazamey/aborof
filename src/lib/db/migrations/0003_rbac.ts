// مُولَّد آليًا من ملف الهجرة المرجعي — لا تعدّله يدويًا.
export const migrationSql = `
-- 0003_rbac: لوحة الصلاحيات (M1) — أدوار ومستخدمون قابلون للتعديل في قاعدة البيانات.
--
-- المبادئ المحكومة لهذه الهجرة:
--  1. fail-closed: كل السلوك الجديد خلف علم ENABLE_RBAC، وغيابه يبقي المسار
--     القديم (كلمة مرور الإدارة المشتركة) حرفيًا كما هو.
--  2. لا كلمة مرور بنص صريح في أي مكان: عمود password_hash فقط، وقيمته
--     بصمة scrypt مع ملح عشوائي تُبنى في طبقة التطبيق (src/lib/rbac/password.ts).
--  3. الأدوار المدمجة (builtin = 1) غير قابلة للتعديل أو الحذف: دور owner هو
--     دور الكسر الزجاجي الذي يمنع الإغلاق الكامل على الفريق.
--  4. ON DELETE RESTRICT بين المستخدم والدور: لا مستخدم يتيم بلا دور صالح.
--  5. قيود CHECK تمنع أي صف غير صالح حتى لو جاء من خارج طبقة التطبيق: معرّف
--     الدور نص لاتيني مستقر (لا تشكيل عربي يفسد التدقيق)، والمصادقة/الحالة
--     قيم محصورة، والصلاحيات مصفوفة JSON صالحة.
CREATE TABLE IF NOT EXISTS rbac_roles (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '[]',
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (length(trim(label)) >= 2 AND length(label) <= 60),
  CHECK (id GLOB '[a-z0-9_][a-z0-9_-]*' AND length(id) BETWEEN 2 AND 60),
  CHECK (length(description) <= 300),
  CHECK (length(permissions) <= 4000),
  CHECK (json_valid(permissions)),
  CHECK (json_type(permissions) = 'array'),
  CHECK (builtin IN (0, 1))
);

CREATE TABLE IF NOT EXISTS rbac_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  role_id TEXT NOT NULL REFERENCES rbac_roles(id) ON DELETE RESTRICT,
  password_hash TEXT NOT NULL,
  password_source TEXT NOT NULL DEFAULT 'panel',
  status TEXT NOT NULL DEFAULT 'active',
  token_version INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (length(trim(username)) >= 3 AND length(username) <= 60),
  CHECK (username GLOB '[a-z0-9._-]*'),
  CHECK (length(display_name) <= 60),
  CHECK (length(password_hash) BETWEEN 40 AND 400),
  CHECK (password_source IN ('bootstrap', 'panel')),
  CHECK (status IN ('active', 'disabled')),
  CHECK (token_version >= 1),
  CHECK (failed_attempts >= 0),
  CHECK (locked_until >= 0)
);

CREATE INDEX IF NOT EXISTS idx_rbac_users_role ON rbac_users(role_id);
CREATE INDEX IF NOT EXISTS idx_rbac_users_status ON rbac_users(status);

-- الأدوار المدمجة: owner = كل الصلاحيات، والبقية مجموعات تشغيلية جاهزة.
-- INSERT OR IGNORE يجعل الهجرة آمنة إن أُعيد تطبيقها على قاعدة نصف مهيّأة.
INSERT OR IGNORE INTO rbac_roles (id, label, description, permissions, builtin) VALUES
  ('owner', 'المالك', 'كل الصلاحيات — دور مدمج غير قابل للتعديل أو الحذف.', '["*"]', 1),
  ('operations', 'عمليات المتجر', 'إدارة الطلبات والمنتجات ومانيفست الإدارة مع استخدام سيليا.', '["orders:read","orders:write","products:write","admin:read","mcp:read","celia:use"]', 1),
  ('support', 'خدمة العملاء', 'متابعة الطلبات وتحديث حالتها واستخدام سيليا.', '["orders:read","orders:write","celia:use"]', 1),
  ('viewer', 'قراءة فقط', 'عرض الطلبات ومانيفست الإدارة بلا أي تعديل.', '["orders:read","admin:read","mcp:read"]', 1);

` as string;
