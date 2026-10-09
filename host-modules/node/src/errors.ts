/** Error type carrying the contract's stable error code and HTTP status (see openapi/site-hoc-api.yaml). */
export class HocError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HocError";
  }
}

export const unauthenticated = () => new HocError(401, "unauthenticated", "Please sign in.");
export const invalid = (message: string) => new HocError(400, "invalid_request", message);
export const notFound = (message = "No such feature.") => new HocError(404, "not_found", message);
export const forbidden = (message = "You are not allowed to do this.") => new HocError(403, "forbidden", message);
export const platformUnavailable = () => new HocError(502, "platform_unavailable", "The HandOfClient platform could not be reached.");
