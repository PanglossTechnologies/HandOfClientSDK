/** What `getCurrentUser` may return: an object with an `id` (string or number) and optionally `name` / `email`. */
export interface SiteUser {
  id: string | number;
  name?: string | null;
  email?: string | null;
  [key: string]: unknown;
}

/** The site's user as the host module sees it. `raw` is the site's own object, handed back to `isAdmin`. */
export interface HocUser {
  id: string;
  name: string | null;
  email: string | null;
  raw: unknown;
}

const field = (obj: unknown, name: string): unknown => (obj !== null && typeof obj === "object" ? (obj as Record<string, unknown>)[name] : undefined);
const text = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));

/** Accept an object with `id` (and optionally `name` / `email`). null / no id means signed out. */
export function toUser(obj: unknown): HocUser | null {
  if (obj === null || obj === undefined || obj === false) return null;
  const id = text(field(obj, "id"));
  if (id === null) return null;
  return { id, name: text(field(obj, "name")), email: text(field(obj, "email")), raw: obj };
}
