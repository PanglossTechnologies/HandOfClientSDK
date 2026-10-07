/**
 * Wire types for the postMessage embed protocol - see docs/postmessage-protocol.md (task C1) for the
 * normative spec. Shared verbatim between the host-side and plugin-side halves of this package so both
 * sides can never drift on envelope/message shape.
 */

export const PROTOCOL_VERSION = 1;

export interface Envelope<TPayload = unknown> {
  v: 1;
  type: string;
  msgId: string;
  replyTo?: string;
  payload: TPayload;
}

export const MessageType = {
  Hello: "hoc:hello",
  Init: "hoc:init",
  Ready: "hoc:ready",
  Error: "hoc:error",
  Resize: "hoc:resize",
  Navigate: "hoc:navigate",
  TokenRefresh: "hoc:token-refresh",
  ContextChanged: "hoc:context-changed",
  Telemetry: "hoc:telemetry",
  Ui: "hoc:ui",
} as const;

export function isEnvelope(data: unknown): data is Envelope {
  if (typeof data !== "object" || data === null) return false;
  const candidate = data as Record<string, unknown>;
  return (
    candidate.v === PROTOCOL_VERSION &&
    typeof candidate.type === "string" &&
    typeof candidate.msgId === "string" &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null
  );
}

export function makeMsgId(): string {
  return crypto.randomUUID();
}

export function makeEnvelope<T>(type: string, payload: T, replyTo?: string): Envelope<T> {
  return replyTo === undefined
    ? { v: PROTOCOL_VERSION, type, msgId: makeMsgId(), payload }
    : { v: PROTOCOL_VERSION, type, msgId: makeMsgId(), replyTo, payload };
}

// --- Payload shapes (see docs/postmessage-protocol.md section 5) ---

export interface ThemeTokens {
  colorScheme: "light" | "dark";
  accentColor: string;
  backgroundColor: string;
  textColor: string;
  fontFamily: string;
  borderRadius: string;
}

export interface TenantContext {
  hostId: string;
  tenantId: string;
  packageId: string;
  slotId: string;
  version: string;
}

export interface HelloPayload {
  sdkVersion: string;
  nonce: string;
}

export interface InitPayload {
  token: string;
  tokenExpiresAt: string;
  tenantContext: TenantContext;
  user: { userId: string; displayName?: string };
  theme: ThemeTokens;
  locale: string;
  launchParams: Record<string, string>;
  /** Platform API base URL for hoc.api/hoc.storage/hoc.http (see plugin/index.ts) - the host already
   * knows this from its own HandOfClient.configure() call, so the plugin never has to guess or hardcode
   * a domain (which would break the moment embed/API origins are split across subdomains - see D0). */
  apiBaseUrl: string;
}

export type ReadyPayload = Record<string, never>;

export interface ErrorPayload {
  message: string;
  stack?: string;
  fatal: boolean;
}

export interface ResizePayload {
  height: number;
}

export interface NavigatePluginToHostPayload {
  path: string;
  replace?: boolean;
}

export interface NavigateHostToPluginPayload {
  path: string;
  state?: unknown;
}

export type TokenRefreshRequestPayload = Record<string, never>;

export type TokenRefreshReplyPayload = { token: string; expiresAt: string } | { error: string };

export interface ContextChangedPayload {
  tenantContext?: Partial<TenantContext>;
  user?: { userId: string; displayName?: string };
  theme?: ThemeTokens;
  locale?: string;
}

export interface TelemetryPayload {
  kind: "timing" | "error";
  name: string;
  value?: number;
  detail?: Record<string, unknown>;
}

export type UiRequestPayload =
  | { kind: "modal"; options: { title?: string; body: string } }
  | { kind: "toast"; options: { message: string; durationMs?: number } }
  | { kind: "confirm"; options: { title?: string; message: string } };

export type UiReplyPayload = { closed: true } | { shown: true } | { confirmed: boolean };
