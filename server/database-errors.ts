export function databaseErrorStatus(
  error: unknown,
  duplicateMessage = "That SKU or category name is already in use.",
): { status: number; message: string } | null {
  let current: unknown = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    const wrapped = current as { code?: unknown; cause?: unknown };
    const code = wrapped.code == null ? "" : String(wrapped.code);
    if (code === "23505") return { status: 409, message: duplicateMessage };
    if (code === "23503") return { status: 400, message: "The selected record is no longer available." };
    if (code === "23514") return { status: 400, message: "One or more values are outside the allowed range." };
    current = wrapped.cause;
  }
  return null;
}
