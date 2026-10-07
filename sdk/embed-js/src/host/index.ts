import { createHocClient } from "@handofclient/api";
import { PostMessageChannel } from "../channel.js";
import {
  type ContextChangedPayload,
  type ErrorPayload,
  type HelloPayload,
  type InitPayload,
  MessageType,
  type NavigatePluginToHostPayload,
  type NavigateHostToPluginPayload,
  type ResizePayload,
  type TelemetryPayload,
  type ThemeTokens,
  type TokenRefreshReplyPayload,
  type UiReplyPayload,
  type UiRequestPayload,
} from "../protocol.js";
import { defaultUiHandler } from "./defaultUi.js";
import { encodePackageId } from "./packageIdEncoding.js";
import { ReadyWatchdog } from "./watchdog.js";

export type MountErrorReason = "token-fetch-failed" | "no-active-version" | "iframe-load-failed" | "timeout" | "plugin-error";

export class HocMountError extends Error {
  constructor(public readonly reason: MountErrorReason, message: string) {
    super(message);
    this.name = "HocMountError";
  }
}

/** Contract for a host's own tokenUrl backend endpoint - see docs/postmessage-protocol.md section 4
 * step 1. The host mints this by calling TokenService.IssueEmbedToken server-to-server; embed.js only
 * ever talks to the host's own endpoint over same-origin fetch, never to the Platform API directly for
 * token issuance. */
export interface TokenEndpointResponse {
  token: string;
  expiresAt: string;
  userId: string;
  displayName?: string;
}

export interface HandOfClientConfig {
  /** Platform API base URL, e.g. https://api.handofclient.com - used only for the anonymous, Public
   * GetActiveVersion call (see AuthPolicy.Methods); never for token issuance. */
  apiBaseUrl: string;
  /** Origin serving embed bundles, e.g. https://embed.handofclient.com. */
  embedOrigin: string;
}

let config: HandOfClientConfig | null = null;

export function configure(next: HandOfClientConfig): void {
  config = next;
}

function requireConfig(): HandOfClientConfig {
  if (!config) throw new Error("HandOfClient.configure({ apiBaseUrl, embedOrigin }) must be called before mount().");
  return config;
}

export interface MountOptions {
  hostId: string;
  tenantId: string;
  packageId: string;
  slotId: string;
  /** Same-origin endpoint on the host's own backend that mints an embed token - see
   * TokenEndpointResponse. */
  tokenUrl: string;
  theme: ThemeTokens;
  locale: string;
  launchParams?: Record<string, string>;
  /** Default 15000ms - see docs/postmessage-protocol.md section 4's explicit non-heuristic rule. */
  readyTimeoutMs?: number;
  onError?: (error: HocMountError) => void;
  onNavigate?: (path: string, replace: boolean) => void;
  onTelemetry?: (event: TelemetryPayload) => void;
  onUi?: (request: UiRequestPayload) => Promise<UiReplyPayload>;
}

export interface Mounted {
  unmount(): void;
  setContext(update: ContextChangedPayload): void;
  navigate(path: string, state?: unknown): void;
}

const DEFAULT_READY_TIMEOUT_MS = 15_000;

export async function mount(container: HTMLElement, options: MountOptions): Promise<Mounted> {
  const { apiBaseUrl, embedOrigin } = requireConfig();

  let tokenResponse: TokenEndpointResponse;
  try {
    const response = await fetch(options.tokenUrl, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`tokenUrl responded ${response.status}`);
    tokenResponse = (await response.json()) as TokenEndpointResponse;
  } catch (cause) {
    throw new HocMountError("token-fetch-failed", `Failed to fetch embed token: ${(cause as Error).message}`);
  }

  const registry = createHocClient({ baseUrl: apiBaseUrl }).packageRegistry;
  const scope = { hostId: options.hostId, tenantId: options.tenantId, packageId: options.packageId };
  let activeVersion;
  try {
    activeVersion = await registry.getActiveVersion({ scope, slotId: options.slotId });
  } catch (cause) {
    throw new HocMountError("no-active-version", `No active version for this tenant/slot: ${(cause as Error).message}`);
  }

  const version = activeVersion.version!.version;
  const entryPoint = activeVersion.version!.manifest!.bundle!.entryPoints[options.slotId] ?? "index.html";
  const packageIdB64 = encodePackageId(options.packageId);

  const iframe = document.createElement("iframe");
  iframe.title = activeVersion.slot?.title || options.slotId;
  iframe.sandbox.add("allow-scripts", "allow-same-origin", "allow-forms", "allow-popups");
  iframe.style.border = "none";
  iframe.style.width = "100%";
  // "/embed/" is not decorative - it's BundleEndpoints.cs's actual mapped route
  // ("/embed/{packageIdB64}/{version}/{**path}"). Found live: docs/postmessage-protocol.md section 4's
  // ASCII sketch (written assuming the design doc's future per-package-subdomain scheme, where the whole
  // origin IS the embed server) omits it, and this file originally matched the sketch instead of B7's
  // real v1 path-based route - every mount() 404'd until this was caught by actually loading a plugin in
  // a browser. Must stay in sync with B7 until D0/the subdomain scheme lands (see packageIdEncoding.ts).
  iframe.src = `${embedOrigin}/embed/${packageIdB64}/${version}/${entryPoint}`;

  return new Promise<Mounted>((resolve, reject) => {
    let settled = false;
    let watchdog: ReadyWatchdog | null = null;

    const channel = new PostMessageChannel(
      () => (iframe.contentWindow ? { window: iframe.contentWindow, origin: embedOrigin } : null),
      (event) => event.source === iframe.contentWindow && event.origin === embedOrigin,
    );

    const fail = (reason: MountErrorReason, message: string) => {
      if (settled) return;
      settled = true;
      watchdog?.cancel();
      channel.dispose();
      iframe.remove();
      const error = new HocMountError(reason, message);
      options.onError?.(error);
      reject(error);
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      watchdog?.cancel();
      resolve({
        unmount: () => {
          channel.dispose();
          iframe.remove();
        },
        setContext: (update) => channel.send(MessageType.ContextChanged, update),
        navigate: (path, state) => channel.send(MessageType.Navigate, { path, state } satisfies NavigateHostToPluginPayload),
      });
    };

    channel.onNotification<HelloPayload>(MessageType.Hello, (_payload, event) => {
      const initPayload: InitPayload = {
        token: tokenResponse.token,
        tokenExpiresAt: tokenResponse.expiresAt,
        tenantContext: { hostId: options.hostId, tenantId: options.tenantId, packageId: options.packageId, slotId: options.slotId, version },
        user: { userId: tokenResponse.userId, displayName: tokenResponse.displayName },
        theme: options.theme,
        locale: options.locale,
        launchParams: options.launchParams ?? {},
        apiBaseUrl,
      };
      channel.send(MessageType.Init, initPayload, event.data.msgId);
      watchdog = new ReadyWatchdog(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, () => fail("timeout", "Plugin did not signal ready/error in time"));
    });

    channel.onNotification<Record<string, never>>(MessageType.Ready, succeed);

    channel.onNotification<ErrorPayload>(MessageType.Error, (payload) => {
      fail("plugin-error", payload.message);
    });

    channel.onNotification<ResizePayload>(MessageType.Resize, (payload) => {
      iframe.style.height = `${payload.height}px`;
    });

    channel.onNotification<NavigatePluginToHostPayload>(MessageType.Navigate, (payload) => {
      options.onNavigate?.(payload.path, payload.replace ?? false);
    });

    channel.onNotification<TelemetryPayload>(MessageType.Telemetry, (payload) => {
      options.onTelemetry?.(payload);
    });

    channel.onRequest<UiRequestPayload, UiReplyPayload>(MessageType.Ui, (payload) => (options.onUi ?? defaultUiHandler)(payload));

    channel.onRequest<Record<string, never>, TokenRefreshReplyPayload>(MessageType.TokenRefresh, async () => {
      try {
        const response = await fetch(options.tokenUrl, { credentials: "same-origin" });
        if (!response.ok) throw new Error(`tokenUrl responded ${response.status}`);
        const refreshed = (await response.json()) as TokenEndpointResponse;
        return { token: refreshed.token, expiresAt: refreshed.expiresAt };
      } catch (cause) {
        return { error: `Host session refresh failed: ${(cause as Error).message}` };
      }
    });

    iframe.onerror = () => fail("iframe-load-failed", "The plugin iframe failed to load");
    container.appendChild(iframe);
  });
}
