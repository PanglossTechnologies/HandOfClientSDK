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
import { requireConfig } from "./config.js";
import { defaultUiHandler } from "./defaultUi.js";
import { HocMountError, type MountErrorReason } from "./errors.js";
import { encodePackageId } from "./packageIdEncoding.js";
import { fetchEmbedToken, fetchEmbedTokenOrThrow, type TokenEndpointResponse, tokenUrlFor } from "./token.js";
import { ReadyWatchdog } from "./watchdog.js";

export interface MountOptions {
  hostId: string;
  tenantId: string;
  packageId: string;
  slotId: string;
  /** Same-origin endpoint on the host's own backend that mints an embed token - see
   * TokenEndpointResponse. Defaults to `<sitePrefix>token`. */
  tokenUrl?: string;
  /** The site's feature id: added to the token URL as `?featureId=` so the site mints the token for
   * that feature's version. Omit for the original single-plugin integration. */
  featureId?: string;
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

/** Everything needed to show one plugin iframe; shared by mount() (which looks the version up on the
 * platform) and autoMount() (whose resolve answer already names the version). */
export interface IframeSpec
  extends Pick<
    MountOptions,
    "hostId" | "tenantId" | "packageId" | "slotId" | "theme" | "locale" | "launchParams" | "readyTimeoutMs" | "onError" | "onNavigate" | "onTelemetry" | "onUi"
  > {
  version: string;
  entryPoint: string;
  title: string;
  /** Fully formed URL (featureId already applied) used for every token refresh. */
  tokenUrl: string;
  token: TokenEndpointResponse;
  /** Fill the container: the iframe is 100% high and hoc:resize is ignored (page-override / new-page). */
  fullWindow?: boolean;
  /** Aborting before the plugin is ready fails the mount with reason "timeout" and removes the iframe. */
  signal?: AbortSignal;
}

export async function mount(container: HTMLElement, options: MountOptions): Promise<Mounted> {
  const { apiBaseUrl, sitePrefix } = requireConfig();
  const tokenUrl = tokenUrlFor(options.tokenUrl ?? `${sitePrefix}token`, options.featureId);
  const token = await fetchEmbedTokenOrThrow(tokenUrl);

  const registry = createHocClient({ baseUrl: apiBaseUrl }).packageRegistry;
  const scope = { hostId: options.hostId, tenantId: options.tenantId, packageId: options.packageId };
  let activeVersion;
  try {
    activeVersion = await registry.getActiveVersion({ scope, slotId: options.slotId });
  } catch (cause) {
    throw new HocMountError("no-active-version", `No active version for this tenant/slot: ${(cause as Error).message}`);
  }

  return mountIframe(container, {
    ...options,
    version: activeVersion.version!.version,
    entryPoint: activeVersion.version!.manifest!.bundle!.entryPoints[options.slotId] ?? "index.html",
    title: activeVersion.slot?.title || options.slotId,
    tokenUrl,
    token,
  });
}

export function mountIframe(container: HTMLElement, spec: IframeSpec): Promise<Mounted> {
  const { apiBaseUrl, embedOrigin } = requireConfig();
  const packageIdB64 = encodePackageId(spec.packageId);

  const iframe = document.createElement("iframe");
  iframe.title = spec.title;
  iframe.sandbox.add("allow-scripts", "allow-same-origin", "allow-forms", "allow-popups");
  iframe.style.border = "none";
  iframe.style.width = "100%";
  if (spec.fullWindow) iframe.style.height = "100%";
  // "/embed/" is not decorative - it is part of the platform's bundle route
  // ("/embed/{packageIdB64}/{version}/{**path}"); omitting it 404s every mount(). See packageIdEncoding.ts
  // for the packageId encoding.
  iframe.src = `${embedOrigin}/embed/${packageIdB64}/${spec.version}/${spec.entryPoint}`;

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
      spec.onError?.(error);
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
        token: spec.token.token,
        tokenExpiresAt: spec.token.expiresAt,
        tenantContext: { hostId: spec.hostId, tenantId: spec.tenantId, packageId: spec.packageId, slotId: spec.slotId, version: spec.version },
        user: { userId: spec.token.userId, displayName: spec.token.displayName },
        theme: spec.theme,
        locale: spec.locale,
        launchParams: spec.launchParams ?? {},
        apiBaseUrl,
      };
      channel.send(MessageType.Init, initPayload, event.data.msgId);
      watchdog = new ReadyWatchdog(spec.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, () => fail("timeout", "Plugin did not signal ready/error in time"));
    });

    channel.onNotification<Record<string, never>>(MessageType.Ready, succeed);

    channel.onNotification<ErrorPayload>(MessageType.Error, (payload) => {
      fail("plugin-error", payload.message);
    });

    channel.onNotification<ResizePayload>(MessageType.Resize, (payload) => {
      if (!spec.fullWindow) iframe.style.height = `${payload.height}px`;
    });

    channel.onNotification<NavigatePluginToHostPayload>(MessageType.Navigate, (payload) => {
      spec.onNavigate?.(payload.path, payload.replace ?? false);
    });

    channel.onNotification<TelemetryPayload>(MessageType.Telemetry, (payload) => {
      spec.onTelemetry?.(payload);
    });

    channel.onRequest<UiRequestPayload, UiReplyPayload>(MessageType.Ui, (payload) => (spec.onUi ?? defaultUiHandler)(payload));

    channel.onRequest<Record<string, never>, TokenRefreshReplyPayload>(MessageType.TokenRefresh, async () => {
      try {
        const refreshed = await fetchEmbedToken(spec.tokenUrl);
        return { token: refreshed.token, expiresAt: refreshed.expiresAt };
      } catch (cause) {
        return { error: `Host session refresh failed: ${(cause as Error).message}` };
      }
    });

    iframe.onerror = () => fail("iframe-load-failed", "The plugin iframe failed to load");
    spec.signal?.addEventListener("abort", () => fail("timeout", "Plugin did not become ready in time"), { once: true });
    container.appendChild(iframe);
  });
}
