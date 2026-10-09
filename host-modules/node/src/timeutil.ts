/** Timestamps: stored and sent as UTC ISO-8601 with milliseconds and a `Z`, e.g. `2026-10-09T18:00:05.123Z`. */
export function nowIso(): string {
  return new Date().toISOString();
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/i;

/** Parse an ISO-8601 timestamp (any fraction length; no zone = UTC) to epoch milliseconds. null if it is not one. */
export function parseIso(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = ISO.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const ms = Number((frac ?? "0").slice(0, 3).padEnd(3, "0"));
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  const check = new Date(t);
  // Date.UTC rolls over (month 13, day 40); a real timestamp must come back unchanged.
  if (
    check.getUTCFullYear() !== Number(y) ||
    check.getUTCMonth() !== Number(mo) - 1 ||
    check.getUTCDate() !== Number(d) ||
    Number(h) > 23 ||
    Number(mi) > 59 ||
    Number(s) > 59
  ) {
    return null;
  }
  let offsetMinutes = 0;
  if (zone && zone.toUpperCase() !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    offsetMinutes = (zone[0] === "+" ? 1 : -1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
  }
  return t - offsetMinutes * 60_000;
}
