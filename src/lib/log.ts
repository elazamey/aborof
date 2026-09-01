/**
 * سجل منظم (structured logs) بصيغة JSON — سطر واحد لكل حدث.
 * القاعدة: لا تُسجَّل كلمات المرور أو session secrets أو بيانات حساسة أبداً.
 */
export function log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}) {
  const entry = {
    level,
    ts: new Date().toISOString(),
    message,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  return line;
}
