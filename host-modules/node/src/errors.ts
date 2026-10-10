/** Machine-readable debugging detail on an error (no human text): which input and why (see openapi/site-hoc-api.yaml). */
export interface ErrorDetail {
  /** The request field or query parameter (dotted path), e.g. `text`, `dataSources[0].baseUrl`. */
  field: string;
  /** Closed snake_case set: required, too_long, wrong_type, invalid_format, invalid_value, out_of_range, unknown_user, not_found. */
  reason: string;
  /** The offending or allowed values, when that helps. */
  values?: string[];
  /** The bound for too_long / out_of_range. */
  limit?: number;
}

/** What the platform answered when a site-side call failed: `status` 0 means it could not be reached at all. */
export interface PlatformFailure extends Partial<ErrorDetail> {
  status: number;
  /** The platform's `/host/v1` error code. */
  error?: string;
}

/** Error type carrying the contract's stable error code and HTTP status (see openapi/site-hoc-api.yaml). */
export class HocError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly detail?: ErrorDetail,
    public readonly platform?: PlatformFailure,
  ) {
    super(message);
    this.name = "HocError";
  }

  /** The JSON error body: `{error, message}` plus the structured `field`/`reason`/`values`/`limit` and `platform` when present. */
  toPayload(): Record<string, unknown> {
    const out: Record<string, unknown> = { error: this.code, message: this.message };
    if (this.detail) {
      out.field = this.detail.field;
      out.reason = this.detail.reason;
      if (this.detail.values && this.detail.values.length > 0) out.values = this.detail.values;
      if (this.detail.limit !== undefined) out.limit = this.detail.limit;
    }
    if (this.platform) out.platform = this.platform;
    return out;
  }
}

/** Distil a failed platform call (`{status, body}`) into the `platform` block of an error. */
export function platformFailure(res: { status: number; body: any }): PlatformFailure {
  const out: PlatformFailure = { status: res.status };
  const b = res.body;
  if (b !== null && typeof b === "object" && !Array.isArray(b)) {
    if (typeof b.error === "string") out.error = b.error;
    if (typeof b.field === "string") out.field = b.field;
    if (typeof b.reason === "string") out.reason = b.reason;
    if (Array.isArray(b.values)) out.values = b.values.map(String);
    if (typeof b.limit === "number") out.limit = b.limit;
  }
  return out;
}

export const unauthenticated = () => new HocError(401, "unauthenticated", "Please sign in.");
export const invalid = (message: string, field: string, reason: string, extra: { values?: string[]; limit?: number } = {}) =>
  new HocError(400, "invalid_request", message, { field, reason, ...extra });
export const notFound = (message = "No such feature.") => new HocError(404, "not_found", message);
export const forbidden = (message = "You are not allowed to do this.") => new HocError(403, "forbidden", message);
export const platformUnavailable = (res?: { status: number; body: any }) =>
  new HocError(502, "platform_unavailable", "The HandOfClient platform could not be reached.", undefined, res ? platformFailure(res) : undefined);
