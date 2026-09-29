/**
 * CeliaTokenManager — توكنات وكيل مُدارة: توليد آمن، بصمة SHA-256، نطاقات لكل
 * توكن، إلغاء/تدوير، وكشف واحد للنص الصريح.
 *
 * القواعد الحاكمة لهذه الوحدة (كلها مُختبرة):
 *  1. **النص الصريح لا يُخزَّن ولا يُسجَّل ولا يُسترجَع.** يُعاد مرة واحدة في
 *     استجابة الإنشاء/التدوير، ثم لا يوجد ما يمكن تسريبه لاحقًا.
 *  2. **بصمة فقط في القاعدة:** `token_hash` عمود واحد يُلمس في هذا الملف حصريًا
 *     (تحرسه بوابة ثابتة)، ولا تغادر هذه الوحدة أي بصمة في كائنات القراءة.
 *  3. **سقفان لا سقف واحد:** (أ) كتالوج `CELIA_KNOWN_SCOPES` عند الكتابة،
 *     (ب) صلاحيات المانح نفسه (anti-escalation) — والنطاق الفعلي وقت الطلب
 *     يبقى مقيّدًا بسقف المتجر `CELIA_ALLOWED_SCOPES` عبر الـScopeGuard.
 *  4. **كل تغيير في معاملة واحدة مع سطر تدقيق:** لا إنشاء ولا إلغاء ولا تدوير
 *     بلا أثر يحمل هوية الفاعل.
 *  5. **لا حذف فيزيائي:** الإلغاء تغيير حالة — واقعة التدقيق تبقى للأبد.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Client } from "@libsql/client";
import { db, ensureSchema } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { auditInsertStatement } from "@/lib/rbac/store";
import { actorCan, type RbacActor } from "@/lib/rbac/guard";
import { isKnownPermission, type RbacPermission } from "@/lib/rbac/permissions";
import { CELIA_KNOWN_SCOPES, isCeliaTokensEnabled, isScopeAllowed, type CeliaScope } from "./config";

/** بادئة مميزة تُسهِّل الكشف الآلي عن تسريب التوكن في السجلات والمستودعات. */
export const TOKEN_PREFIX = "cel_";

/** 32 بايت = 256 بت من CSPRNG. */
export const TOKEN_BYTES = 32;

/** طول إجمالي متوقع: 4 + 43 = 47 حرفًا (base64url بلا حشو). */
export const TOKEN_LENGTH = TOKEN_PREFIX.length + Math.ceil((TOKEN_BYTES * 4) / 3);

export type CeliaTokenStatus = "active" | "revoked";

/** تمثيل عام — لا يحمل بصمة ولا نصًا صريحًا. */
export interface CeliaTokenPublic {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  status: CeliaTokenStatus;
  createdBy: string;
  useCount: number;
  expiresAt: number;
  expired: boolean;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * خريطة النطاق ← صلاحيات RBAC التي تخوّل منحه.
 *
 * القاعدة: لا يمنح الفاعل نطاقًا يزيد عن صلاحياته الفعلية. النطاقات الخاصة
 * بسيليا نفسها (الأسئلة والمحادثات) تحتاج صلاحية إدارة التوكنات `celia:manage`،
 * وبقية النطاقات تُسقَط على صلاحية المجال المقابلة في الكتالوج.
 */
export const SCOPE_GRANT_MAP: Record<string, RbacPermission[]> = {
  "products:read": ["products:write"],
  "products:write": ["products:write"],
  "orders:read": ["orders:read"],
  "orders:write": ["orders:write"],
  "admin:read": ["admin:read"],
  "mcp:read": ["mcp:read"],
  "mcp:write": ["celia:manage"],
  "faq:read": ["celia:manage"],
  "faq:write": ["celia:manage"],
  "chat:read": ["celia:manage"],
  "chat:write": ["celia:manage"],
};

const KNOWN_SCOPE_SET: ReadonlySet<string> = new Set<string>(CELIA_KNOWN_SCOPES);

async function client(): Promise<Client> {
  const c = db();
  if (!c) throw Errors.serviceUnavailable("توكنات سيليا تحتاج قاعدة بيانات مربوطة (TURSO_DATABASE_URL).");
  await ensureSchema();
  return c;
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// التوليد والبصمة
// ---------------------------------------------------------------------------

/**
 * توليد توكن جديد: 256 بت عشوائية من CSPRNG بصيغة `cel_<base64url>`.
 * لا يُخزَّن الناتج في أي مكان — يُعاد للمنادي مرة واحدة.
 */
export function generateToken(): { token: string; hash: string; prefix: string } {
  const token = TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, hash: hashToken(token), prefix: tokenPrefix(token) };
}

/**
 * بصمة SHA-256 hex.
 *
 * لماذا دالة سريعة هنا (خلاف كلمات المرور في `rbac/password.ts` التي تستخدم
 * scrypt مع ملح)؟ لأن المدخل سر عشوائي بطول 256 بت: لا يوجد «قاموس» ولا مساحة
 * بحث تُستنفد، فالدالة البطيئة تضيف كلفة CPU لكل طلب بلا أي مكسب أمني.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** أول 12 حرفًا — للتمييز البصري في اللوحة فقط (لا يكفي للاستخدام). */
export function tokenPrefix(token: string): string {
  return token.slice(0, 12);
}

/** هل النص بصيغة توكن مُدار؟ (يُستخدم للفرز قبل أي عمل على قاعدة البيانات). */
export function looksLikeManagedToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX) && value.length === TOKEN_LENGTH;
}

/**
 * تطبيع وتحقّق النطاقات: تُرفض المجهولة، ويُمنع الفارغ، ويُزال التكرار.
 * fail-closed: أي نطاق خارج كتالوج `CELIA_KNOWN_SCOPES` = رفض لا تجاهل.
 */
export function normalizeScopes(input: unknown[]): string[] {
  const out: string[] = [];
  for (const raw of input) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!KNOWN_SCOPE_SET.has(value)) {
      throw Errors.validationFailed(`نطاق غير معروف: ${value || "(فارغ)"}`);
    }
    if (!out.includes(value)) out.push(value);
  }
  if (out.length === 0) throw Errors.validationFailed("اختر نطاقًا واحدًا على الأقل.");
  return out;
}

/**
 * النطاقات التي يملك المانح تخويل منحها. الفاعل صاحب `*` (المالك) يمنح كل شيء.
 * النطاق بلا خريطة صريحة = لا يُمنح (fail-closed) بدل افتراض ضمني.
 */
export function grantableScopes(actor: RbacActor): Set<string> {
  if (actor.mode === "legacy" || actor.wildcard) return new Set(CELIA_KNOWN_SCOPES);
  const out = new Set<string>();
  for (const scope of CELIA_KNOWN_SCOPES) {
    const needed = SCOPE_GRANT_MAP[scope];
    if (!needed || needed.length === 0) continue;
    if (needed.every((permission) => actorCan(actor, permission))) out.add(scope);
  }
  return out;
}

/** يتحقق أن كل نطاق مطلوب ممنوح للمانح — وإلا 403 بلا كشف لصلاحياته. */
export function assertCanGrant(actor: RbacActor, scopes: string[]) {
  const grantable = grantableScopes(actor);
  const denied = scopes.filter((scope) => !grantable.has(scope));
  if (denied.length > 0) {
    throw Errors.forbidden("لا تملك الصلاحية لمنح أحد هذه النطاقات — لا تصعيد صلاحيات.");
  }
}

// ---------------------------------------------------------------------------
// القراءة
// ---------------------------------------------------------------------------

function toPublic(row: Record<string, unknown>, now = Date.now()): CeliaTokenPublic {
  const expiresAt = num(row.expires_at);
  return {
    id: String(row.id),
    label: String(row.label ?? ""),
    prefix: String(row.token_prefix ?? ""),
    scopes: parseScopes(row.scopes),
    status: row.status === "revoked" ? "revoked" : "active",
    createdBy: String(row.created_by ?? ""),
    useCount: num(row.use_count),
    expiresAt,
    expired: expiresAt > 0 && expiresAt <= now,
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    revokedBy: row.revoked_by ? String(row.revoked_by) : null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

/** قراءة النطاقات المخزّنة: ما لا يعرفه الكتالوج لا يُعاد كصلاحية (fail-closed). */
export function parseScopes(raw: unknown): string[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is string => typeof item === "string" && KNOWN_SCOPE_SET.has(item));
}

const TOKEN_SELECT = `SELECT id, label, token_prefix, scopes, status, created_by, use_count,
       expires_at, last_used_at, revoked_at, revoked_by, created_at, updated_at
  FROM celia_tokens`;

/** هل الميزة مفتوحة؟ (علم مغلق ⇒ المسارات 404 ولا يظهر شيء في اللوحة). */
export function celiaTokensFeatureState(): { enabled: boolean } {
  return { enabled: isCeliaTokensEnabled() };
}

export async function listTokens(): Promise<CeliaTokenPublic[]> {
  const c = await client();
  const r = await c.execute(`${TOKEN_SELECT} ORDER BY created_at DESC, id DESC LIMIT 200`);
  return r.rows.map((row) => toPublic(row as unknown as Record<string, unknown>));
}

export async function getTokenById(id: string): Promise<CeliaTokenPublic | null> {
  const c = await client();
  const r = await c.execute(`${TOKEN_SELECT} WHERE id = ? LIMIT 1`, [id]);
  const row = r.rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? toPublic(row) : null;
}

// ---------------------------------------------------------------------------
// الكتابة (كلها داخل معاملة + تدقيق)
// ---------------------------------------------------------------------------

function newTokenId(): string {
  return `ct_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export interface CreateTokenInput {
  label: string;
  scopes: string[];
  /** 0 = بلا انتهاء. */
  expiresAt?: number;
}

export interface CreateTokenResult {
  token: CeliaTokenPublic;
  /** النص الصريح — يعود هنا مرة واحدة فقط ولا يُخزَّن. */
  plaintext: string;
}

export function assertLabel(label: string): string {
  const value = label.trim();
  if (value.length < 2 || value.length > 60) {
    throw Errors.validationFailed("اسم التوكن يجب أن يكون بين 2 و60 حرفًا.");
  }
  return value;
}

export async function createToken(input: CreateTokenInput, actor: RbacActor): Promise<CreateTokenResult> {
  if (!isCeliaTokensEnabled()) throw Errors.notFound("هذه النقطة غير متاحة");
  const label = assertLabel(input.label);
  const scopes = normalizeScopes(input.scopes);
  assertCanGrant(actor, scopes);

  const c = await client();
  const id = newTokenId();
  const { token, hash, prefix } = generateToken();
  const expiresAt = Math.max(0, Math.floor(input.expiresAt ?? 0));

  const tx = await c.transaction("write");
  try {
    await tx.execute({
      sql: `INSERT INTO celia_tokens (id,label,token_prefix,token_hash,scopes,status,created_by,expires_at)
            VALUES (?,?,?,?,?,'active',?,?)`,
      args: [id, label, prefix, hash, JSON.stringify(scopes), actor.username, expiresAt],
    });
    await tx.execute(
      auditInsertStatement({
        action: "celia.token_created",
        entity: "celia_token",
        entityId: id,
        details: { label, scopes, expiresAt, prefix },
        actor: actor.username,
      })
    );
    await tx.commit();
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }

  const created = await getTokenById(id);
  if (!created) throw Errors.serviceUnavailable("تعذّر تأكيد إنشاء التوكن بعد الكتابة.");
  return { token: created, plaintext: token };
}

/**
 * إلغاء توكن. الإلغاء **ليس** idempotent عن قصد: المحاولة الثانية تُعيد 409
 * لأن ذلك يكشف انحرافًا (لوحة قديمة، أو محاولة إلغاء سبقتها) يستحق الانتباه.
 */
export async function revokeToken(id: string, actor: RbacActor): Promise<CeliaTokenPublic> {
  if (!isCeliaTokensEnabled()) throw Errors.notFound("هذه النقطة غير متاحة");
  const c = await client();
  const existing = await getTokenById(id);
  if (!existing) throw Errors.notFound("لا يوجد توكن بهذا المعرّف.");
  if (existing.status === "revoked") throw Errors.conflict("هذا التوكن ملغى بالفعل.");

  const tx = await c.transaction("write");
  try {
    await tx.execute({
      sql: "UPDATE celia_tokens SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, revoked_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'",
      args: [actor.username, id],
    });
    await tx.execute(
      auditInsertStatement({
        action: "celia.token_revoked",
        entity: "celia_token",
        entityId: id,
        details: { label: existing.label, prefix: existing.prefix },
        actor: actor.username,
      })
    );
    await tx.commit();
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }

  const updated = await getTokenById(id);
  if (!updated) throw Errors.serviceUnavailable("تعذّر تأكيد الإلغاء بعد الكتابة.");
  return updated;
}

/**
 * تدوير التوكن: توكن جديد بنفس الاسم والنطاقات + إلغاء القديم **في معاملة
 * واحدة**. لا توجد لحظة يكون فيها التوكنان فعّالين معًا، ولا لحظة بلا توكن.
 */
export async function rotateToken(id: string, actor: RbacActor): Promise<CreateTokenResult> {
  if (!isCeliaTokensEnabled()) throw Errors.notFound("هذه النقطة غير متاحة");
  const c = await client();
  const existing = await getTokenById(id);
  if (!existing) throw Errors.notFound("لا يوجد توكن بهذا المعرّف.");
  if (existing.status === "revoked") throw Errors.conflict("لا يمكن تدوير توكن ملغى — أنشئ توكنًا جديدًا.");
  assertCanGrant(actor, existing.scopes);

  const newId = newTokenId();
  const { token, hash, prefix } = generateToken();

  const tx = await c.transaction("write");
  try {
    await tx.execute({
      sql: "UPDATE celia_tokens SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, revoked_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'",
      args: [actor.username, id],
    });
    await tx.execute({
      sql: `INSERT INTO celia_tokens (id,label,token_prefix,token_hash,scopes,status,created_by,expires_at)
            VALUES (?,?,?,?,?,'active',?,?)`,
      args: [newId, existing.label, prefix, hash, JSON.stringify(existing.scopes), actor.username, existing.expiresAt],
    });
    await tx.execute(
      auditInsertStatement({
        action: "celia.token_rotated",
        entity: "celia_token",
        entityId: newId,
        details: { previousId: id, previousPrefix: existing.prefix, prefix, label: existing.label },
        actor: actor.username,
      })
    );
    await tx.commit();
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }

  const created = await getTokenById(newId);
  if (!created) throw Errors.serviceUnavailable("تعذّر تأكيد التدوير بعد الكتابة.");
  return { token: created, plaintext: token };
}

// ---------------------------------------------------------------------------
// التحقق (مسار المصادقة)
// ---------------------------------------------------------------------------

export interface ManagedTokenAuth {
  id: string;
  label: string;
  scopes: string[];
}

interface TokenAuthRow {
  id: unknown;
  label: unknown;
  scopes: unknown;
  status: unknown;
  expires_at: unknown;
  token_hash: unknown;
}

/**
 * التحقق من توكن مُدار بالبصمة.
 *
 * ملاحظات أمنية:
 *  - لا يفترق الرد بين «توكن غير موجود» و«توكن ملغى» و«منتهٍ»: كلها `null`
 *    فيُصدر المسار 401 موحّدًا (لا تعداد للتوكنات).
 *  - المقارنة على البصمة ثابتة الزمن بعد الجلب، دفاعًا احتياطيًا عن أي مقارنة
 *    نصية لاحقة (وإن كان الفهرس الفريد هو خط الدفاع الأول).
 *  - تحديث آخر استخدام **أفضل جهد**: فشله لا يُسقط طلبًا صحيحًا.
 */
export async function verifyManagedToken(presented: string): Promise<ManagedTokenAuth | null> {
  if (!isCeliaTokensEnabled()) return null;
  if (!looksLikeManagedToken(presented)) return null;

  const c = await client();
  const hash = hashToken(presented);
  const r = await c.execute(
    "SELECT id, label, scopes, status, expires_at, token_hash FROM celia_tokens WHERE token_hash = ? LIMIT 1",
    [hash]
  );
  const row = r.rows[0] as unknown as TokenAuthRow | undefined;
  if (!row) return null;

  const stored = Buffer.from(String(row.token_hash ?? ""), "utf8");
  const computed = Buffer.from(hash, "utf8");
  if (stored.length !== computed.length || !timingSafeEqual(stored, computed)) return null;

  if (row.status !== "active") return null;
  const expiresAt = num(row.expires_at);
  if (expiresAt > 0 && expiresAt <= Date.now()) return null;

  const id = String(row.id);
  void touchToken(c, id).catch(() => {});

  return { id, label: String(row.label ?? ""), scopes: parseScopes(row.scopes) };
}

async function touchToken(c: Client, id: string) {
  await c.execute(
    "UPDATE celia_tokens SET use_count = use_count + 1, last_used_at = CURRENT_TIMESTAMP WHERE id = ?",
    [id]
  );
}

/**
 * السقف الفعلي لنطاقات توكن: تقاطعه مع سقف المتجر `CELIA_ALLOWED_SCOPES`.
 * لا يرفع السقف حائز التوكن — رفعه قرار بيئة.
 */
export function effectiveTokenScopes(scopes: string[], storeCeiling: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const scope of scopes) {
    if (isScopeAllowed(scope, storeCeiling)) out.add(scope);
  }
  return out;
}

/** هل كل نطاقات التوكن معروفة في الكتالوج؟ (فحص دفاعي للسطور المقروءة). */
export function allScopesKnown(scopes: string[]): boolean {
  return scopes.every((scope) => KNOWN_SCOPE_SET.has(scope));
}

/** يُستخدم في الفحوص البنيوية: هل النطاق مقبول كمدخل إداري أصلًا؟ */
export function isKnownCeliaScope(value: string): value is CeliaScope {
  return KNOWN_SCOPE_SET.has(value);
}

/** هل صلاحية الفاعل كافية لرؤية اللوحة؟ (يُعيد false في الوضع القديم بلا صلاحيات). */
export function canReadTokens(actor: RbacActor): boolean {
  return actorCan(actor, "celia:read");
}

/** يُبقى التوقيع صريحًا: كل صلاحية مستخدمة في هذه الطبقة معروفة في الكتالوج. */
export const TOKEN_PERMISSIONS: RbacPermission[] = ["celia:read", "celia:manage"].filter(
  (permission): permission is RbacPermission => isKnownPermission(permission)
);
