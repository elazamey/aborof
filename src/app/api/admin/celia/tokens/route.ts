import { NextResponse } from "next/server";
import { apiHandler, Errors, readJson } from "@/lib/errors/handler";
import { rateLimit } from "@/lib/rate-limit";
import { requirePermission } from "@/lib/rbac";
import { CELIA_KNOWN_SCOPES, isCeliaTokensEnabled } from "@/lib/celia/config";
import { createToken, listTokens, revokeToken, rotateToken } from "@/lib/celia/tokens";
import { celiaTokenActionContract, celiaTokenCreateContract, firstZodIssue } from "@/lib/validation/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * توكنات سيليا المُدارة (CeliaTokenManager) — القراءة والإنشاء.
 *
 * البوابات بالترتيب الصارم:
 *   1. `ENABLE_CELIA_TOKENS=true` وإلا 404 موحّد (لا كشف لوجود النقطة).
 *   2. 401 بلا جلسة إدارة صالحة، ثم 403 بلا صلاحية:
 *      `celia:read` للعرض، `celia:manage` للإنشاء.
 *   3. حدّ معدل على الكتابة (نفس نمط مسارات RBAC).
 *   4. عقد Zod `.strict()`، ثم تحقق العضوية في كتالوج النطاقات داخل المخزن.
 *   5. النص الصريح يُعاد **مرة واحدة** في استجابة الإنشاء، ولا يُخزَّن أبدًا.
 */

async function enforceRateLimit(request: Request, scope: string) {
  const limit = await rateLimit(request, scope, 20, 10 * 60 * 1000);
  if (!limit.ok) throw Errors.rateLimited(limit.retryAfter);
}

function guard() {
  if (!isCeliaTokensEnabled()) throw Errors.notFound("هذه النقطة غير متاحة");
}

export const GET = apiHandler("/api/admin/celia/tokens/list", async (request) => {
  guard();
  await requirePermission(request, "celia:read");

  const tokens = await listTokens();
  // كتالوج النطاقات للعرض في مصفوفة الواجهة — بلا أي سر أو بصمة.
  return NextResponse.json({ ok: true, tokens, catalog: { scopes: [...CELIA_KNOWN_SCOPES].sort() } });
});

export const POST = apiHandler("/api/admin/celia/tokens/create", async (request) => {
  guard();
  const actor = await requirePermission(request, "celia:manage");
  await enforceRateLimit(request, "admin-celia-tokens");

  const raw = await readJson(request, 8_000);
  const parsed = celiaTokenCreateContract.safeParse(raw);
  if (!parsed.success) throw Errors.validationFailed(firstZodIssue(parsed.error));

  const { label, scopes, expiresInDays } = parsed.data.token;
  const result = await createToken(
    {
      label,
      scopes,
      expiresAt: expiresInDays && expiresInDays > 0 ? Date.now() + expiresInDays * 24 * 60 * 60 * 1000 : 0,
    },
    actor
  );

  return NextResponse.json({
    ok: true,
    token: result.token,
    // الكشف الوحيد — لا يوجد مسار لاسترجاع هذه القيمة لاحقًا.
    plaintext: result.plaintext,
  });
});

export const PATCH = apiHandler("/api/admin/celia/tokens/action", async (request) => {
  guard();
  const actor = await requirePermission(request, "celia:manage");
  await enforceRateLimit(request, "admin-celia-tokens");

  const raw = await readJson(request, 8_000);
  const parsed = celiaTokenActionContract.safeParse(raw);
  if (!parsed.success) throw Errors.validationFailed(firstZodIssue(parsed.error));

  const { id, action } = parsed.data;
  if (action === "revoke") {
    return NextResponse.json({ ok: true, action, token: await revokeToken(id, actor) });
  }
  const rotated = await rotateToken(id, actor);
  // التدوير = كشف واحد جديد للتوكن الجديد؛ القيمة القديمة صارت ملغاة في نفس المعاملة.
  return NextResponse.json({ ok: true, action, token: rotated.token, plaintext: rotated.plaintext });
});
