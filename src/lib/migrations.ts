import type { Client } from "@libsql/client";

/**
 * نظام Migrations مبسّط ومنضبط:
 * - جدول `schema_meta` يحمل رقم الإصدار الحالي لقاعدة البيانات.
 * - كل تغيير schema يُضاف كـ Migration برقم تسلسلي، ولا يُعدَّل schema خارجها.
 * - عند الإقلاع تُطبَّق الهجرات الناقصة بالترتيب ثم يُحدَّث الإصدار.
 */

export type Migration = {
  version: number;
  name: string;
  up: (c: Client) => Promise<void>;
};

async function columnNames(c: Client, table: string): Promise<Set<string>> {
  const r = await c.execute(`PRAGMA table_info(${table})`);
  return new Set(r.rows.map((row) => String((row as { name?: string }).name)));
}

async function addColumnIfMissing(c: Client, table: string, name: string, definition: string) {
  const cols = await columnNames(c, table);
  if (!cols.has(name)) {
    await c.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial-schema",
    up: async (c) => {
      await c.batch(
        [
          `CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            price REAL NOT NULL,
            old_price REAL,
            category TEXT DEFAULT '',
            image TEXT DEFAULT '🧴',
            stock INTEGER DEFAULT 0,
            featured INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
          )`,
          `CREATE TABLE IF NOT EXISTS orders (
            id TEXT PRIMARY KEY,
            customer TEXT NOT NULL,
            phone TEXT NOT NULL,
            address TEXT DEFAULT '',
            governorate TEXT DEFAULT '',
            items TEXT NOT NULL,
            total REAL NOT NULL,
            shipping_fee REAL DEFAULT 0,
            payment TEXT DEFAULT 'vodafone_cash',
            transfer_ref TEXT DEFAULT '',
            receipt_url TEXT DEFAULT '',
            status TEXT DEFAULT 'جديد',
            note TEXT DEFAULT '',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
          )`,
          `CREATE TABLE IF NOT EXISTS faq (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            question TEXT NOT NULL,
            answer TEXT NOT NULL
          )`,
          `CREATE TABLE IF NOT EXISTS chat_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            question TEXT, answer TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
          )`,
          `CREATE TABLE IF NOT EXISTS admin_audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            entity TEXT NOT NULL,
            entity_id TEXT DEFAULT '',
            details TEXT DEFAULT '',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
          )`,
        ],
        "write"
      );
    },
  },
  {
    version: 2,
    name: "orders-extended-columns",
    up: async (c) => {
      for (const [name, definition] of Object.entries({
        governorate: "TEXT DEFAULT ''",
        shipping_fee: "REAL DEFAULT 0",
        transfer_ref: "TEXT DEFAULT ''",
        receipt_url: "TEXT DEFAULT ''",
      })) {
        await addColumnIfMissing(c, "orders", name, definition);
      }
    },
  },
  {
    version: 3,
    name: "orders-idempotency-key",
    up: async (c) => {
      // مفتاح idempotency لمنع تكرار الطلبات (نفس العملية = نفس رقم الطلب)
      await addColumnIfMissing(c, "orders", "idempotency_key", "TEXT");
      await c.execute("CREATE INDEX IF NOT EXISTS idx_orders_idempotency_key ON orders(idempotency_key)");
    },
  },
  {
    version: 4,
    name: "identity-hardening-01",
    up: async (c) => {
      // IDENTITY-HARDENING-01 (P0 Security): users / verification_tokens /
      // identity_change_requests / security_events / sessions — إضافي بحت.
      // (المخطط مضمَّن هنا — لا استيرادات نسبية — حتى يعمل migrate-check
      //  مع node --experimental-strip-types الذي يتطلب امتدادًا صريحًا.)
      await c.batch(
        [
          `CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            email_normalized TEXT NOT NULL UNIQUE,
            email_verified_at INTEGER,
            phone TEXT,
            phone_normalized TEXT UNIQUE,
            phone_verified_at INTEGER,
            password_hash TEXT,
            role TEXT NOT NULL DEFAULT 'owner',
            tenant_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_login_at INTEGER
          )`,
          `CREATE TABLE IF NOT EXISTS verification_tokens (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            channel TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            max_attempts INTEGER NOT NULL DEFAULT 5,
            attempts INTEGER NOT NULL DEFAULT 0,
            consumed_at INTEGER,
            created_at INTEGER NOT NULL,
            request_id TEXT,
            target TEXT
          )`,
          `CREATE TABLE IF NOT EXISTS identity_change_requests (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            current_value_hash TEXT NOT NULL,
            new_value_normalized TEXT NOT NULL,
            status TEXT NOT NULL,
            requested_at INTEGER NOT NULL,
            verified_at INTEGER,
            security_delay_until INTEGER,
            expires_at INTEGER NOT NULL,
            completed_at INTEGER,
            created_at INTEGER NOT NULL,
            request_id TEXT
          )`,
          `CREATE TABLE IF NOT EXISTS security_events (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            event TEXT NOT NULL,
            metadata TEXT NOT NULL DEFAULT '{}',
            ip TEXT,
            request_id TEXT,
            created_at INTEGER NOT NULL
          )`,
          `CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            label TEXT,
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            revoked_at INTEGER
          )`,
          `CREATE INDEX IF NOT EXISTS idx_verification_tokens_user ON verification_tokens(user_id, kind)`,
          `CREATE INDEX IF NOT EXISTS idx_identity_change_user ON identity_change_requests(user_id, status)`,
          `CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events(user_id, created_at)`,
          `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
        ],
        "write"
      );
    },
  },
  {
    version: 5,
    name: "identity-security-monitoring",
    up: async (c) => {
      // IDENTITY SECURITY MONITORING (P0): security_alerts — تنبيهات الكواشف
      // (dedupe عبر alert_key الفريد لكل نافذة زمنية). إضافي بحت.
      await c.batch(
        [
          `CREATE TABLE IF NOT EXISTS security_alerts (
            id TEXT PRIMARY KEY,
            alert_key TEXT NOT NULL UNIQUE,
            level TEXT NOT NULL,
            type TEXT NOT NULL,
            user_id TEXT,
            ip_hash TEXT,
            message TEXT NOT NULL,
            metadata TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL,
            resolved_at INTEGER
          )`,
          `CREATE INDEX IF NOT EXISTS idx_security_alerts_created ON security_alerts(created_at)`,
        ],
        "write"
      );
    },
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** يطبّق الهجرات الناقصة ويعيد الإصدار الحالي لقاعدة البيانات */
export async function applyMigrations(c: Client): Promise<number> {
  await c.execute(
    "CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL)"
  );
  await c.execute("INSERT OR IGNORE INTO schema_meta (id, version) VALUES (1, 0)");

  for (const migration of MIGRATIONS) {
    const row = await c.execute("SELECT version FROM schema_meta WHERE id=1");
    const current = Number(row.rows[0]?.version ?? 0);
    if (current >= migration.version) continue;
    await migration.up(c);
    await c.execute("UPDATE schema_meta SET version=? WHERE id=1", [migration.version]);
  }

  const final = await c.execute("SELECT version FROM schema_meta WHERE id=1");
  return Number(final.rows[0]?.version ?? 0);
}
