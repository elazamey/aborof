// مُولَّد آليًا من ملف الهجرة المرجعي — لا تعدّله يدويًا.
export const migrationSql = `
-- 0004_celia_tokens: توكنات وكيل مُدارة (CeliaTokenManager) — هوية ونطاق وإلغاء لكل توكن.
--
-- المبادئ المحكومة لهذه الهجرة:
--  1. fail-closed: كل السلوك الجديد خلف علم ENABLE_CELIA_TOKENS، والغياب يبقي
--     توكن البيئة CELIA_AGENT_TOKEN يعمل حرفيًا كما هو (تعايش لا كسر).
--  2. لا يُخزَّن النص الصريح للتوكن أبدًا: عمود token_hash فقط (SHA-256 hex لسر
--     عشوائي 256 بت)، والقيمة الصريحة تُعرض مرة واحدة عند الإنشاء/التدوير.
--  3. token_hash فريد: تكرار توكنين مستحيل على مستوى قاعدة البيانات، لا مراجعة بشرية.
--  4. token_prefix للعرض في اللوحة فقط (أول 12 حرفًا) ولا يكفي لإعادة التركيب.
--  5. لا حذف فيزيائي: الإلغاء تغيير حالة يحفظ واقعة التدقيق (revoked_at/revoked_by).
--  6. قيود CHECK تمنع أي صف فاسد حتى لو جاء من خارج طبقة التطبيق: صيغة البصمة
--     وطولها، صيغة البادئة، النطاقات مصفوفة JSON صالحة، والحالة محصورة.
CREATE TABLE IF NOT EXISTS celia_tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (length(trim(label)) >= 2 AND length(label) <= 60),
  CHECK (id GLOB 'ct_[0-9a-f]*' AND length(id) BETWEEN 6 AND 40),
  CHECK (token_prefix GLOB 'cel_*' AND length(token_prefix) BETWEEN 12 AND 20),
  CHECK (length(token_hash) = 64 AND token_hash GLOB '[0-9a-f]*'),
  CHECK (length(scopes) <= 2000),
  CHECK (json_valid(scopes)),
  CHECK (json_type(scopes) = 'array'),
  CHECK (status IN ('active', 'revoked')),
  CHECK (length(created_by) <= 60),
  CHECK (use_count >= 0),
  CHECK (expires_at >= 0)
);

CREATE INDEX IF NOT EXISTS idx_celia_tokens_status ON celia_tokens(status);
CREATE INDEX IF NOT EXISTS idx_celia_tokens_created_by ON celia_tokens(created_by);

` as string;
