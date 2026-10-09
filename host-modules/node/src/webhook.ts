/** Webhook signature check (see `/webhook` in openapi/site-hoc-api.yaml). */
import { createHmac, timingSafeEqual } from "node:crypto";
import { parseIso } from "./timeutil.js";

export const SIGNATURE_HEADER = "x-handofclient-signature";
export const TOLERANCE_SECONDS = 300;

/** `sha256=` + lowercase hex HMAC-SHA256 of the raw body. */
export function sign(secret: string | Uint8Array, rawBody: Uint8Array): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** Constant-time comparison of the `X-HandOfClient-Signature` header against the raw body. */
export function verifySignature(secret: string | Uint8Array, rawBody: Uint8Array, header: string | undefined | null): boolean {
  if (!header) return false;
  const want = Buffer.from(sign(secret, rawBody), "utf8");
  const got = Buffer.from(header, "utf8");
  return want.length === got.length && timingSafeEqual(want, got);
}

/** True when `sentAt` is unparsable or differs from now by more than the 300 s tolerance (either direction). */
export function isStale(sentAt: unknown, nowMs: number = Date.now()): boolean {
  const t = parseIso(sentAt);
  if (t === null) return true;
  return Math.abs(nowMs - t) > TOLERANCE_SECONDS * 1000;
}
