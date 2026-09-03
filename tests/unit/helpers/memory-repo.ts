import {
  ChangeRequest,
  IdentityRepo,
  OtpKind,
  OtpRecord,
  SecurityAlert,
  SecurityEvent,
  SessionRecord,
  User,
} from "@/lib/identity/types";

/** مستودع في الذاكرة (حتمي، بدون DB) — مشترك بين اختبارات الهوية والمراقبة. */
export class MemoryRepo implements IdentityRepo {
  users = new Map<string, User>();
  otps = new Map<string, OtpRecord>();
  changes = new Map<string, ChangeRequest>();
  sessions = new Map<string, SessionRecord>();
  events: SecurityEvent[] = [];
  alerts: SecurityAlert[] = [];
  cooldowns = new Map<string, number>();

  async getUserById(id: string) {
    return this.users.get(id) ?? null;
  }
  async getUserByEmail(normalized: string) {
    return [...this.users.values()].find((u) => u.emailNormalized === normalized) ?? null;
  }
  async getUserByPhone(normalized: string) {
    return [...this.users.values()].find((u) => u.phoneNormalized === normalized) ?? null;
  }
  async getOwner() {
    return [...this.users.values()].find((u) => u.role === "owner") ?? null;
  }
  async createUser(u: User) {
    this.users.set(u.id, u);
  }
  async updateUser(u: User) {
    this.users.set(u.id, u);
  }
  async createOtp(o: OtpRecord) {
    this.otps.set(o.id, o);
  }
  async getOtpById(id: string) {
    return this.otps.get(id) ?? null;
  }
  async listOtps(userId: string, kind: OtpKind) {
    return [...this.otps.values()].filter((o) => o.userId === userId && o.kind === kind);
  }
  async updateOtp(o: OtpRecord) {
    this.otps.set(o.id, o);
  }
  async acquireOtpCooldown(key: string, now: number, cooldownMs: number) {
    // ذرّي (قرار واحد بلا await وسيط — يطابق UPSERT في طبقة SQL)
    const expiresAt = this.cooldowns.get(key);
    if (expiresAt !== undefined && expiresAt > now) {
      return { ok: false, retryAfterMs: expiresAt - now };
    }
    this.cooldowns.set(key, now + cooldownMs);
    return { ok: true, retryAfterMs: 0 };
  }
  async createChangeRequest(c: ChangeRequest) {
    this.changes.set(c.id, c);
  }
  async getChangeRequestById(id: string) {
    return this.changes.get(id) ?? null;
  }
  async listPendingChangeRequests(userId: string, kind?: "email" | "phone") {
    return [...this.changes.values()].filter(
      (c) =>
        c.userId === userId &&
        ["CHANGE_REQUESTED", "NEW_VALUE_VERIFIED", "SECURITY_REVIEW"].includes(c.status) &&
        (!kind || c.kind === kind)
    );
  }
  async updateChangeRequest(c: ChangeRequest) {
    this.changes.set(c.id, c);
  }
  async createSession(s: SessionRecord) {
    this.sessions.set(s.id, s);
  }
  async getSessionById(id: string) {
    return this.sessions.get(id) ?? null;
  }
  async getSessionByTokenHash(tokenHash: string) {
    return [...this.sessions.values()].find((s) => s.tokenHash === tokenHash) ?? null;
  }
  async listSessions(userId: string) {
    return [...this.sessions.values()].filter((s) => s.userId === userId);
  }
  async revokeSession(id: string) {
    const s = this.sessions.get(id);
    if (s) s.revokedAt = Date.now();
  }
  async revokeOtherSessions(userId: string, keepId: string) {
    for (const s of this.sessions.values()) if (s.userId === userId && s.id !== keepId) s.revokedAt = Date.now();
  }
  async revokeAllSessions(userId: string) {
    for (const s of this.sessions.values()) if (s.userId === userId) s.revokedAt = Date.now();
  }
  async createSecurityEvent(e: SecurityEvent) {
    this.events.push(e);
  }
  async listSecurityEvents(userId: string, limit: number) {
    return this.events.filter((e) => e.userId === userId).slice(0, limit);
  }
  async listSecurityEventsSince(since: number, limit?: number) {
    return this.events.filter((e) => e.createdAt >= since).slice(0, limit ?? 1000);
  }
  async sumOtpAttemptsSince(since: number) {
    return [...this.otps.values()].filter((o) => o.createdAt >= since).reduce((a, o) => a + o.attempts, 0);
  }
  async createAlert(a: SecurityAlert) {
    this.alerts.push(a);
  }
  async listAlerts(since: number, limit?: number) {
    return this.alerts.filter((a) => a.createdAt >= since).slice(0, limit ?? 200);
  }
  async deleteSecurityEventsOlderThan(ts: number) {
    this.events = this.events.filter((e) => e.createdAt >= ts);
  }
  async deleteAlertsOlderThan(ts: number) {
    this.alerts = this.alerts.filter((a) => a.createdAt >= ts);
  }
}
