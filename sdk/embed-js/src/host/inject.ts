import type { InitPayload, UiReplyPayload, UiRequestPayload } from "../protocol.js";
import { HocMountError } from "./errors.js";

/**
 * What an injected (mode "inject") plugin bundle receives. embed.js sets `window.HandOfClientInject.pending`
 * immediately before the bundle's `<script type="module">` is added, and clears it once that script has
 * loaded. Features are injected one at a time, so `pending` always belongs to the script that is about
 * to run. A bundle must take it synchronously, at the top level of its module (before its first
 * `await`), and keep its own reference.
 */
export interface InjectContext {
  featureId: string;
  /** Same shape as the iframe's hoc:init payload, so one SDK code path serves both modes. */
  init: InitPayload;
  /** The `[data-hoc-slot]` element for a `slot` feature; null for page-level features. */
  slotElement: HTMLElement | null;
  /** Equivalent of hoc:token-refresh: asks the site's token endpoint for a fresh token. */
  refreshToken(): Promise<{ token: string; expiresAt: string }>;
  /** Equivalent of hoc:navigate. */
  navigate(path: string, replace: boolean): void;
  /** Equivalent of hoc:ui. Absent: the plugin SDK falls back to the built-in default renderer. */
  ui?(request: UiRequestPayload): Promise<UiReplyPayload>;
}

declare global {
  interface Window {
    HandOfClientInject?: { pending: InjectContext | null };
  }
}

/** The platform publishes sha256 as hex; the `integrity` attribute wants `sha256-<base64>`. Accepts hex,
 * bare base64 or an already-prefixed value. */
export function toIntegrity(sha256: string): string {
  if (sha256.startsWith("sha256-")) return sha256;
  if (/^[0-9a-f]{64}$/i.test(sha256)) {
    const bytes = sha256.match(/../g)!.map((pair) => parseInt(pair, 16));
    return `sha256-${btoa(String.fromCharCode(...bytes))}`;
  }
  return `sha256-${sha256}`;
}

/**
 * Loads `src` as a module script with an `integrity` hash, so only that exact build can run. Resolves
 * once the script has executed. A page Content-Security-Policy that forbids the script surfaces as a
 * "csp-blocked" error naming the origin to allow, rather than a silent network-style failure.
 */
export function loadInjected(src: string, integrity: string, context: InjectContext, timeoutMs: number): Promise<void> {
  const holder = (window.HandOfClientInject ??= { pending: null });
  const origin = new URL(src).origin;

  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    let blockedByCsp = false;
    let finished = false;

    const onViolation = (event: SecurityPolicyViolationEvent) => {
      if (!event.violatedDirective.startsWith("script-src")) return;
      if (event.blockedURI === src || event.blockedURI.startsWith(origin)) blockedByCsp = true;
    };

    const finish = (error?: HocMountError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      document.removeEventListener("securitypolicyviolation", onViolation);
      if (holder.pending === context) holder.pending = null;
      if (error) {
        script.remove();
        reject(error);
      } else {
        resolve();
      }
    };

    const timer = setTimeout(() => finish(new HocMountError("timeout", `Injected bundle did not load within ${timeoutMs}ms: ${src}`)), timeoutMs);

    document.addEventListener("securitypolicyviolation", onViolation);
    script.type = "module";
    script.src = src;
    script.integrity = integrity;
    script.crossOrigin = "anonymous";
    script.onload = () => finish();
    script.onerror = () =>
      // The CSP violation event is queued as its own task and can land just after the error event.
      setTimeout(() => {
        if (blockedByCsp) {
          finish(new HocMountError("csp-blocked", `The page's Content-Security-Policy blocked the feature script. Add ${origin} to script-src to use inject mode.`));
        } else {
          finish(new HocMountError("inject-load-failed", `Could not load ${src}: network error, missing CORS headers, or the file does not match its published sha256.`));
        }
      }, 0);

    holder.pending = context;
    document.head.appendChild(script);
  });
}
