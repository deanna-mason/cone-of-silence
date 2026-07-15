/** Trimmed 1–64 chars, no control characters. Returns null when invalid. */
export function parseLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (label.length < 1 || label.length > 64) return null;
  if (/\p{C}/u.test(label)) return null;
  return label;
}

/** Recognized token kinds; returns null for anything else (including missing/other types). */
export function parseKind(value: unknown): "room-creation" | "signup" | null {
  return value === "room-creation" || value === "signup" ? value : null;
}

/** True when body is a plain object with exactly the given keys. */
export function hasExactKeys(body: unknown, keys: string[]): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const actual = Object.keys(body as Record<string, unknown>);
  return actual.length === keys.length && keys.every((k) => actual.includes(k));
}
