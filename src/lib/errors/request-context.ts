import { randomUUID } from "node:crypto";

/**
 * يُنشئ معرّف طلب موحد. نفضّل المعرّف القادم من المنصة (Vercel/البروكسي)
 * عند وجوده حتى تُربط سجلاتنا بما في سجلات البنية التحتية، وإلا نُولّد واحدًا.
 */
export function getRequestId(request: Request): string {
  const incoming =
    request.headers.get("x-request-id") ??
    request.headers.get("x-vercel-id") ??
    "";
  const trimmed = incoming.trim();
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : `req_${randomUUID()}`;
}
