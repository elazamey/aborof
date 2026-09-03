import type { Client } from "@libsql/client";
import { ChangeRequest, IdentityRepo, OtpKind, OtpRecord, SecurityEvent, SessionRecord, User } from "./types";
import type { SecurityAlert } from "../monitoring/types";
import { newId } from "./otp";

/**
 * تطبيق IdentityRepo فوق libsql + مخطط الهوية.
 * المخطط إضافي بحت (لا DROP/RENAME) — يمر من RC02-ROLLBACK.
 */

export const IDENTITY_SCHEMA = [
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
  `CREATE INDEX IF NOT EXISTS idx_security_alerts_created ON security_alerts(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS otp_cooldowns (
    cooldown_key TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )`,
];

type Row = Record<string, unknown>;

function rowToUser(r: Row): User {
  return {
    id: String(r.id),
    email: String(r.email),
    emailNormalized: String(r.email_normalized),
    emailVerifiedAt:
      r.email_verified_at === null || r.email_verified_at === undefined ? null : Number(r.email_verified_at),
    phone: r.phone === null || r.phone === undefined ? null : String(r.phone),
    phoneNormalized:
      r.phone_normalized === null || r.phone_normalized === undefined ? null : String(r.phone_normalized),
    phoneVerifiedAt:
      r.phone_verified_at === null || r.phone_verified_at === undefined ? null : Number(r.phone_verified_at),
    passwordHash: r.password_hash === null || r.password_hash === undefined ? null : String(r.password_hash),
    role: (r.role as User["role"]) ?? "owner",
    tenantId: r.tenant_id === null || r.tenant_id === undefined ? null : String(r.tenant_id),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastLoginAt: r.last_login_at === null || r.last_login_at === undefined ? null : Number(r.last_login_at),
  };
}

function rowToOtp(r: Row): OtpRecord {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    kind: r.kind as OtpKind,
    channel: r.channel as OtpRecord["channel"],
    tokenHash: String(r.token_hash),
    expiresAt: Number(r.expires_at),
    maxAttempts: Number(r.max_attempts),
    attempts: Number(r.attempts),
    consumedAt: r.consumed_at === null || r.consumed_at === undefined ? null : Number(r.consumed_at),
    createdAt: Number(r.created_at),
    requestId: r.request_id === null || r.request_id === undefined ? null : String(r.request_id),
    target: r.target === null || r.target === undefined ? null : String(r.target),
  };
}

function rowToChange(r: Row): ChangeRequest {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    kind: r.kind as ChangeRequest["kind"],
    currentValueHash: String(r.current_value_hash),
    newValueNormalized: String(r.new_value_normalized),
    status: r.status as ChangeRequest["status"],
    requestedAt: Number(r.requested_at),
    verifiedAt: r.verified_at === null || r.verified_at === undefined ? null : Number(r.verified_at),
    securityDelayUntil:
      r.security_delay_until === null || r.security_delay_until === undefined ? null : Number(r.security_delay_until),
    expiresAt: Number(r.expires_at),
    completedAt: r.completed_at === null || r.completed_at === undefined ? null : Number(r.completed_at),
    createdAt: Number(r.created_at),
    requestId: r.request_id === null || r.request_id === undefined ? null : String(r.request_id),
  };
}

function rowToSession(r: Row): SessionRecord {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    tokenHash: String(r.token_hash),
    label: r.label === null || r.label === undefined ? null : String(r.label),
    createdAt: Number(r.created_at),
    lastSeenAt: Number(r.last_seen_at),
    revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
  };
}

function rowToEvent(r: Row): SecurityEvent {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    event: String(r.event),
    metadata: String(r.metadata),
    ip: r.ip === null || r.ip === undefined ? null : String(r.ip),
    requestId: r.request_id === null || r.request_id === undefined ? null : String(r.request_id),
    createdAt: Number(r.created_at),
  };
}

export function createSqlIdentityRepo(c: Client): IdentityRepo {
  return {
    async getUserById(id) {
      const r = await c.execute("SELECT * FROM users WHERE id = ?", [id]);
      return r.rows[0] ? rowToUser(r.rows[0] as Row) : null;
    },
    async getUserByEmail(normalized) {
      const r = await c.execute("SELECT * FROM users WHERE email_normalized = ?", [normalized]);
      return r.rows[0] ? rowToUser(r.rows[0] as Row) : null;
    },
    async getUserByPhone(normalized) {
      const r = await c.execute("SELECT * FROM users WHERE phone_normalized = ?", [normalized]);
      return r.rows[0] ? rowToUser(r.rows[0] as Row) : null;
    },
    async getOwner() {
      const r = await c.execute("SELECT * FROM users WHERE role = 'owner' LIMIT 1");
      return r.rows[0] ? rowToUser(r.rows[0] as Row) : null;
    },
    async createUser(u) {
      await c.execute(
        `INSERT INTO users (id, email, email_normalized, email_verified_at, phone, phone_normalized, phone_verified_at,
          password_hash, role, tenant_id, created_at, updated_at, last_login_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          u.id,
          u.email,
          u.emailNormalized,
          u.emailVerifiedAt,
          u.phone,
          u.phoneNormalized,
          u.phoneVerifiedAt,
          u.passwordHash,
          u.role,
          u.tenantId,
          u.createdAt,
          u.updatedAt,
          u.lastLoginAt,
        ]
      );
    },
    async updateUser(u) {
      await c.execute(
        `UPDATE users SET email=?, email_normalized=?, email_verified_at=?, phone=?, phone_normalized=?,
          phone_verified_at=?, password_hash=?, role=?, updated_at=?, last_login_at=? WHERE id=?`,
        [
          u.email,
          u.emailNormalized,
          u.emailVerifiedAt,
          u.phone,
          u.phoneNormalized,
          u.phoneVerifiedAt,
          u.passwordHash,
          u.role,
          u.updatedAt,
          u.lastLoginAt,
          u.id,
        ]
      );
    },
    async createOtp(o) {
      await c.execute(
        `INSERT INTO verification_tokens (id, user_id, kind, channel, token_hash, expires_at, max_attempts, attempts, consumed_at, created_at, request_id, target)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          o.id,
          o.userId,
          o.kind,
          o.channel,
          o.tokenHash,
          o.expiresAt,
          o.maxAttempts,
          o.attempts,
          o.consumedAt,
          o.createdAt,
          o.requestId,
          o.target,
        ]
      );
    },
    async getOtpById(id) {
      const r = await c.execute("SELECT * FROM verification_tokens WHERE id = ?", [id]);
      return r.rows[0] ? rowToOtp(r.rows[0] as Row) : null;
    },
    async listOtps(userId, kind) {
      const r = await c.execute(
        "SELECT * FROM verification_tokens WHERE user_id = ? AND kind = ? ORDER BY created_at ASC",
        [userId, kind]
      );
      return r.rows.map((row) => rowToOtp(row as Row));
    },
    async updateOtp(o) {
      await c.execute("UPDATE verification_tokens SET attempts=?, consumed_at=? WHERE id=?", [
        o.attempts,
        o.consumedAt,
        o.id,
      ]);
    },
    async acquireOtpCooldown(key, now, cooldownMs) {
      const expiresAt = now + cooldownMs;
      // جملة واحدة ذرّية: إدراج جديد أو تحديث فقط إن كانت الفتحة منتهية.
      // rowsAffected === 1 → الحجز نجح (إرسال مسموح)؛ === 0 → لا تزال في cooldown.
      const r = await c.execute(
        `INSERT INTO otp_cooldowns (cooldown_key, expires_at) VALUES (?, ?)
         ON CONFLICT(cooldown_key) DO UPDATE SET expires_at = excluded.expires_at
         WHERE otp_cooldowns.expires_at <= ?`,
        [key, expiresAt, now]
      );
      if (r.rowsAffected === 1) return { ok: true, retryAfterMs: 0 };
      // لا تزال في cooldown — اقرأ المتبقي فقط (لـ Retry-After دقيق)؛
      // القرار نفسه (رفض) حُسم ذرّيًا في الجملة أعلاه.
      const cur = await c.execute("SELECT expires_at FROM otp_cooldowns WHERE cooldown_key = ?", [key]);
      const remaining = Number(cur.rows[0]?.expires_at ?? 0) - now;
      return { ok: false, retryAfterMs: Math.max(0, remaining) };
    },
    async createChangeRequest(cr) {
      await c.execute(
        `INSERT INTO identity_change_requests (id, user_id, kind, current_value_hash, new_value_normalized, status,
          requested_at, verified_at, security_delay_until, expires_at, completed_at, created_at, request_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          cr.id,
          cr.userId,
          cr.kind,
          cr.currentValueHash,
          cr.newValueNormalized,
          cr.status,
          cr.requestedAt,
          cr.verifiedAt,
          cr.securityDelayUntil,
          cr.expiresAt,
          cr.completedAt,
          cr.createdAt,
          cr.requestId,
        ]
      );
    },
    async getChangeRequestById(id) {
      const r = await c.execute("SELECT * FROM identity_change_requests WHERE id = ?", [id]);
      return r.rows[0] ? rowToChange(r.rows[0] as Row) : null;
    },
    async listPendingChangeRequests(userId, kind) {
      const r = await c.execute(
        `SELECT * FROM identity_change_requests WHERE user_id = ? AND status IN ('CHANGE_REQUESTED','NEW_VALUE_VERIFIED','SECURITY_REVIEW')
         ${kind ? "AND kind = ?" : ""} ORDER BY created_at DESC`,
        kind ? [userId, kind] : [userId]
      );
      return r.rows.map((row) => rowToChange(row as Row));
    },
    async updateChangeRequest(cr) {
      await c.execute(
        `UPDATE identity_change_requests SET status=?, verified_at=?, security_delay_until=?, completed_at=? WHERE id=?`,
        [cr.status, cr.verifiedAt, cr.securityDelayUntil, cr.completedAt, cr.id]
      );
    },
    async createSession(s) {
      await c.execute(
        `INSERT INTO sessions (id, user_id, token_hash, label, created_at, last_seen_at, revoked_at) VALUES (?,?,?,?,?,?,?)`,
        [s.id, s.userId, s.tokenHash, s.label, s.createdAt, s.lastSeenAt, s.revokedAt]
      );
    },
    async getSessionById(id) {
      const r = await c.execute("SELECT * FROM sessions WHERE id = ?", [id]);
      return r.rows[0] ? rowToSession(r.rows[0] as Row) : null;
    },
    async getSessionByTokenHash(tokenHash) {
      const r = await c.execute("SELECT * FROM sessions WHERE token_hash = ?", [tokenHash]);
      return r.rows[0] ? rowToSession(r.rows[0] as Row) : null;
    },
    async listSessions(userId) {
      const r = await c.execute("SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC", [userId]);
      return r.rows.map((row) => rowToSession(row as Row));
    },
    async revokeSession(id) {
      await c.execute("UPDATE sessions SET revoked_at = ? WHERE id = ?", [Date.now(), id]);
    },
    async revokeOtherSessions(userId, keepId) {
      await c.execute("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL", [
        Date.now(),
        userId,
        keepId,
      ]);
    },
    async revokeAllSessions(userId) {
      await c.execute("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [
        Date.now(),
        userId,
      ]);
    },
    async createSecurityEvent(e) {
      await c.execute(
        `INSERT INTO security_events (id, user_id, event, metadata, ip, request_id, created_at) VALUES (?,?,?,?,?,?,?)`,
        [e.id, e.userId, e.event, e.metadata, e.ip, e.requestId, e.createdAt]
      );
    },
    async listSecurityEvents(userId, limit) {
      const r = await c.execute("SELECT * FROM security_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?", [
        userId,
        limit,
      ]);
      return r.rows.map((row) => rowToEvent(row as Row));
    },
    async listSecurityEventsSince(since, limit) {
      const r = await c.execute(
        "SELECT * FROM security_events WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?",
        [since, limit ?? 1000]
      );
      return r.rows.map((row) => rowToEvent(row as Row));
    },
    async sumOtpAttemptsSince(since) {
      const r = await c.execute(
        "SELECT COALESCE(SUM(attempts), 0) AS n FROM verification_tokens WHERE created_at >= ?",
        [since]
      );
      return Number(r.rows[0]?.n ?? 0);
    },
    async createAlert(a) {
      await c.execute(
        `INSERT INTO security_alerts (id, alert_key, level, type, user_id, ip_hash, message, metadata, created_at, resolved_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [a.id, a.alertKey, a.level, a.type, a.userId, a.ipHash, a.message, a.metadata, a.createdAt, a.resolvedAt]
      );
    },
    async listAlerts(since, limit) {
      const r = await c.execute(
        "SELECT * FROM security_alerts WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?",
        [since, limit ?? 200]
      );
      return r.rows.map((row) => rowToAlert(row as Row));
    },
    async deleteSecurityEventsOlderThan(ts) {
      await c.execute("DELETE FROM security_events WHERE created_at < ?", [ts]);
    },
    async deleteAlertsOlderThan(ts) {
      await c.execute("DELETE FROM security_alerts WHERE created_at < ?", [ts]);
    },
  };
}

function rowToAlert(r: Row): SecurityAlert {
  return {
    id: String(r.id),
    alertKey: String(r.alert_key),
    level: String(r.level) as "INFO" | "WARNING" | "CRITICAL",
    type: String(r.type),
    userId: r.user_id === null || r.user_id === undefined ? null : String(r.user_id),
    ipHash: r.ip_hash === null || r.ip_hash === undefined ? null : String(r.ip_hash),
    message: String(r.message),
    metadata: String(r.metadata),
    createdAt: Number(r.created_at),
    resolvedAt: r.resolved_at === null || r.resolved_at === undefined ? null : Number(r.resolved_at),
  };
}

export function ensureOwnerUser(c: Client): IdentityRepo & { owner: () => Promise<User | null> } {
  const repo = createSqlIdentityRepo(c);
  return Object.assign(repo, {
    async owner() {
      const r = await c.execute("SELECT * FROM users WHERE role = 'owner' LIMIT 1");
      return r.rows[0] ? rowToUser(r.rows[0] as Row) : null;
    },
  });
}

export { newId };
