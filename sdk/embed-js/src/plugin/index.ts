import { createHocClient, type HocClient as GeneratedHocClient } from "@handofclient/api";
import { PostMessageChannel } from "../channel.js";
import {
  type ContextChangedPayload,
  type ErrorPayload,
  type HelloPayload,
  type InitPayload,
  isEnvelope,
  makeEnvelope,
  MessageType,
  type NavigateHostToPluginPayload,
  type NavigatePluginToHostPayload,
  type ReadyPayload,
  type TelemetryPayload,
  type ThemeTokens,
  type UiReplyPayload,
  type UiRequestPayload,
} from "../protocol.js";
import { startAutoResize } from "./resize.js";
import { HostRelayTokenProvider } from "./tokenProvider.js";

const SDK_VERSION = "0.1.0";

export interface HocContext {
  hostId: string;
  tenantId: string;
  packageId: string;
  slotId: string;
  version: string;
  user: { userId: string; displayName?: string };
  theme: ThemeTokens;
  locale: string;
  launchParams: Record<string, string>;
}

export type UiRequestOptions =
  | { kind: "modal"; title?: string; body: string }
  | { kind: "toast"; message: string; durationMs?: number }
  | { kind: "confirm"; title?: string; message: string };

class HocSdk {
  private channel: PostMessageChannel | null = null;
  private tokenProvider: HostRelayTokenProvider | null = null;
  private _context: HocContext | null = null;
  private _api: GeneratedHocClient | null = null;
  private stopAutoResize: (() => void) | null = null;
  private contextListeners = new Set<(update: ContextChangedPayload) => void>();
  private navigateListeners = new Set<(payload: NavigateHostToPluginPayload) => void>();

  /**
   * Runs the handshake (docs/postmessage-protocol.md section 4), invokes `callback` with the resolved
   * context, and signals hoc:ready/hoc:error based on whether it completes without throwing. Must be
   * called exactly once per iframe load.
   */
  async init(callback: (context: HocContext) => void | Promise<void>): Promise<void> {
    const { initPayload, trustedOrigin } = await this.performHandshake();

    this.channel = new PostMessageChannel(
      () => (this.channel ? { window: window.parent, origin: trustedOrigin } : null),
      (event) => event.source === window.parent && event.origin === trustedOrigin,
    );
    // Registered only after the handshake completes and origin is pinned - see
    // docs/postmessage-protocol.md section 3: no application-visible callback dispatches before init.
    this.channel.onNotification<ContextChangedPayload>(MessageType.ContextChanged, (payload) => {
      for (const listener of this.contextListeners) listener(payload);
    });
    this.channel.onNotification<NavigateHostToPluginPayload>(MessageType.Navigate, (payload) => {
      for (const listener of this.navigateListeners) listener(payload);
    });

    this.tokenProvider = new HostRelayTokenProvider(this.channel, initPayload.token, initPayload.tokenExpiresAt);
    this._api = createHocClient({ baseUrl: initPayload.apiBaseUrl, tokenProvider: this.tokenProvider });
    this._context = {
      hostId: initPayload.tenantContext.hostId,
      tenantId: initPayload.tenantContext.tenantId,
      packageId: initPayload.tenantContext.packageId,
      slotId: initPayload.tenantContext.slotId,
      version: initPayload.tenantContext.version,
      user: initPayload.user,
      theme: initPayload.theme,
      locale: initPayload.locale,
      launchParams: initPayload.launchParams,
    };

    try {
      await callback(this._context);
      this.channel.send<ReadyPayload>(MessageType.Ready, {});
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.channel.send<ErrorPayload>(MessageType.Error, { message: error.message, stack: error.stack, fatal: true });
      throw error;
    }
  }

  get context(): HocContext {
    if (!this._context) throw new Error("hoc.context accessed before hoc.init(callback) resolved");
    return this._context;
  }

  /** The six generated Platform API service clients, pre-authed with the current embed token and
   * auto-refreshing (see HostRelayTokenProvider) - design doc's "hoc.api". */
  get api(): GeneratedHocClient {
    if (!this._api) throw new Error("hoc.api accessed before hoc.init(callback) resolved");
    return this._api;
  }

  private get scope() {
    const context = this.context;
    return { hostId: context.hostId, tenantId: context.tenantId, packageId: context.packageId };
  }

  storage = {
    get: async (key: string) => this.api.tenantStorage.get({ scope: this.scope, key }),
    set: async (key: string, value: Uint8Array<ArrayBuffer>, ifMatchEtag?: string) =>
      this.api.tenantStorage.set({ scope: this.scope, key, value, ifMatchEtag }),
    delete: async (key: string) => this.api.tenantStorage.delete({ scope: this.scope, key }),
    fileExists: async (path: string) => this.api.tenantStorage.fileExists({ scope: this.scope, path }),
  };

  http = {
    send: async (request: {
      method: number;
      url: string;
      headers?: { name: string; value: string }[];
      body?: Uint8Array<ArrayBuffer>;
      timeoutMs?: number;
    }) => this.api.egressProxy.send({ scope: this.scope, ...request }),
  };

  navigate(path: string, replace = false): void {
    this.channel?.send<NavigatePluginToHostPayload>(MessageType.Navigate, { path, replace });
  }

  onContextChanged(listener: (update: ContextChangedPayload) => void): () => void {
    this.contextListeners.add(listener);
    return () => this.contextListeners.delete(listener);
  }

  onHostNavigate(listener: (payload: NavigateHostToPluginPayload) => void): () => void {
    this.navigateListeners.add(listener);
    return () => this.navigateListeners.delete(listener);
  }

  ui = {
    modal: (body: string, title?: string) =>
      this.request<UiReplyPayload & { closed: true }>({ kind: "modal", options: { title, body } }),
    toast: (message: string, durationMs?: number) =>
      this.request<UiReplyPayload & { shown: true }>({ kind: "toast", options: { message, durationMs } }),
    confirm: (message: string, title?: string): Promise<boolean> =>
      this.request<UiReplyPayload & { confirmed: boolean }>({ kind: "confirm", options: { title, message } }).then((r) => r.confirmed),
  };

  private request<T>(payload: UiRequestPayload): Promise<T> {
    if (!this.channel) throw new Error("hoc.ui used before hoc.init(callback) resolved");
    return this.channel.request<UiRequestPayload, T>(MessageType.Ui, payload);
  }

  /** Coalesces ResizeObserver callbacks to at most one hoc:resize per animation frame - see
   * docs/postmessage-protocol.md section 5.5. Call once, after the plugin's root element exists. */
  resizeAuto(rootElement: HTMLElement): void {
    if (!this.channel) throw new Error("hoc.resizeAuto used before hoc.init(callback) resolved");
    this.stopAutoResize?.();
    this.stopAutoResize = startAutoResize(this.channel, rootElement);
  }

  private performHandshake(): Promise<{ initPayload: InitPayload; trustedOrigin: string }> {
    return new Promise((resolve) => {
      const helloEnvelope = makeEnvelope<HelloPayload>(MessageType.Hello, { sdkVersion: SDK_VERSION, nonce: crypto.randomUUID() });

      function onMessage(event: MessageEvent) {
        // Pre-pinning: accept only from window.parent, and dispatch only for the specific hoc:init
        // that answers *this* hello - see docs/postmessage-protocol.md section 3.
        if (event.source !== window.parent) return;
        if (!isEnvelope(event.data) || event.data.type !== MessageType.Init || event.data.replyTo !== helloEnvelope.msgId) return;
        window.removeEventListener("message", onMessage);
        resolve({ initPayload: event.data.payload as InitPayload, trustedOrigin: event.origin });
      }
      window.addEventListener("message", onMessage);
      // "*" is the one and only legitimate use of a wildcard targetOrigin in this protocol: the plugin
      // cannot know the host's real origin before this exact reply tells it - see section 3.
      window.parent.postMessage(helloEnvelope, "*");
    });
  }
}

/** Singleton - one plugin bundle instance runs inside exactly one iframe for exactly one mount. */
export const hoc = new HocSdk();
