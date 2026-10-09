import type { InitPayload, TelemetryPayload, ThemeTokens, UiReplyPayload, UiRequestPayload } from "../protocol.js";
import { requireConfig } from "./config.js";
import { HocMountError } from "./errors.js";
import { type InjectContext, loadInjected, toIntegrity } from "./inject.js";
import { type Mounted, mountIframe } from "./mount.js";
import { encodePackageId } from "./packageIdEncoding.js";
import { fetchEmbedToken, fetchEmbedTokenOrThrow, readEmbedClaims, tokenUrlFor } from "./token.js";

/** One entry of `GET <sitePrefix>api/resolve` - see openapi/site-hoc-api.yaml `ResolvedFeature`. */
export interface ResolvedFeature {
  featureId: string;
  kind: "slot" | "page-override" | "new-page";
  mode: "inject" | "iframe";
  slotId: string;
  path?: string | null;
  packageId: string;
  version: string;
  sha256: string;
  entry: string;
}

export interface AutoMountOptions {
  /** Page path sent to the site. Default `location.pathname`. */
  path?: string;
  /** Budget for the resolve lookup; on expiry the original page shows. Default 1500. */
  timeoutMs?: number;
  /** Budget for loading what resolve returned, counted from the answer; on expiry the original page
   * shows (a full-window iframe is removed again). Default 3000. */
  loadTimeoutMs?: number;
  /** CSS selector for the element a `slot` feature mounts into. Default `[data-hoc-slot="<slotId>"]`. */
  slotSelector?: (feature: ResolvedFeature) => string;
  theme?: ThemeTokens;
  locale?: string;
  /** Called for every failure (resolve, token, load, CSP, missing slot); the page keeps working. The
   * default logs a console warning. */
  onError?: (error: HocMountError, feature?: ResolvedFeature) => void;
  /** Handles `hoc:navigate` from a plugin. Default: same-origin navigation of the host page. */
  onNavigate?: (path: string, replace: boolean) => void;
  onTelemetry?: (event: TelemetryPayload) => void;
  onUi?: (request: UiRequestPayload) => Promise<UiReplyPayload>;
}

export interface AutoMountResult {
  /** Features that were loaded and are running. */
  applied: ResolvedFeature[];
  /** Features (or the lookup itself, `feature` undefined) that failed; the original page shows. */
  failed: { feature?: ResolvedFeature; error: HocMountError }[];
  /** True when loadTimeoutMs expired before everything was ready. */
  loadTimedOut: boolean;
  /** Removes iframes and restores the original page. Injected scripts cannot be undone. */
  unmount(): void;
}

const DEFAULT_RESOLVE_TIMEOUT_MS = 1500;
const DEFAULT_LOAD_TIMEOUT_MS = 3000;

/** Un-hides the body hidden by hoc-head.js. Safe to call when hoc-head.js was never used. */
function reveal(): void {
  (window as unknown as { __hocReveal?: () => void }).__hocReveal?.();
  document.getElementById("hoc-hide")?.remove();
}

/** Same-origin navigation only: a plugin must not be able to send the host page elsewhere. */
function defaultNavigate(path: string, replace: boolean): void {
  const url = new URL(path, location.href);
  if (url.origin !== location.origin) {
    console.warn(`HandOfClient: ignoring hoc:navigate to another origin (${url.origin})`);
    return;
  }
  if (replace) location.replace(url);
  else location.assign(url);
}

function defaultTheme(): ThemeTokens {
  const style = getComputedStyle(document.body);
  return {
    colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    accentColor: "#1976d2",
    backgroundColor: style.backgroundColor,
    textColor: style.color,
    fontFamily: style.fontFamily,
    borderRadius: "4px",
  };
}

async function resolveFeatures(sitePrefix: string, path: string, timeoutMs: number): Promise<ResolvedFeature[]> {
  const url = new URL(`${sitePrefix}api/resolve`, document.baseURI);
  url.searchParams.set("path", path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { credentials: "same-origin", signal: controller.signal });
    if (!response.ok) throw new HocMountError("resolve-failed", `resolve responded ${response.status}`);
    const body = (await response.json()) as { features?: ResolvedFeature[] };
    return body.features ?? [];
  } catch (cause) {
    if (cause instanceof HocMountError) throw cause;
    if (controller.signal.aborted) throw new HocMountError("timeout", `resolve did not answer within ${timeoutMs}ms`);
    throw new HocMountError("resolve-failed", `resolve failed: ${(cause as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Page lookup: asks the site which features apply to the signed-in user on this path, then injects,
 * overrides or mounts them. Never throws - on any problem the original page
 * shows and the failure is in the result / `onError`. Pair with hoc-head.js to avoid a flash of the
 * original page; without it, autoMount still works but the original is visible while it loads.
 */
export async function autoMount(options: AutoMountOptions = {}): Promise<AutoMountResult> {
  const { apiBaseUrl, embedOrigin, sitePrefix } = requireConfig();
  const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  const result: AutoMountResult = { applied: [], failed: [], loadTimedOut: false, unmount: () => undefined };
  const cleanups: (() => void)[] = [];
  result.unmount = () => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  };

  const report = (error: HocMountError, feature?: ResolvedFeature) => {
    result.failed.push({ feature, error });
    if (options.onError) options.onError(error, feature);
    else console.warn(`HandOfClient autoMount${feature ? ` (${feature.featureId})` : ""}: ${error.reason}: ${error.message}`);
  };

  try {
    let features: ResolvedFeature[];
    try {
      features = await resolveFeatures(sitePrefix, options.path ?? location.pathname, options.timeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS);
    } catch (cause) {
      report(cause as HocMountError);
      return result;
    }
    if (features.length === 0) return result;

    const theme = options.theme ?? defaultTheme();
    const locale = options.locale ?? (document.documentElement.lang || "en");
    const onNavigate = options.onNavigate ?? defaultNavigate;
    const loadAbort = new AbortController();
    let pageLevelTaken = false;

    const apply = async (feature: ResolvedFeature): Promise<void> => {
      const pageLevel = feature.kind !== "slot";
      if (pageLevel) {
        if (pageLevelTaken) return; // the site returns at most one per path; ignore extras defensively
        pageLevelTaken = true;
      }
      const tokenUrl = tokenUrlFor(`${sitePrefix}token`, feature.featureId);
      const token = await fetchEmbedTokenOrThrow(tokenUrl);
      if (loadAbort.signal.aborted) throw new HocMountError("timeout", "Gave up before this feature was ready (loadTimeoutMs)");
      const claims = readEmbedClaims(token.token);
      const hostId = claims.hostId ?? "";
      const tenantId = claims.tenantId ?? "";

      let slotElement: HTMLElement | null = null;
      if (feature.kind === "slot") {
        const selector = options.slotSelector?.(feature) ?? `[data-hoc-slot="${CSS.escape(feature.slotId)}"]`;
        slotElement = document.querySelector<HTMLElement>(selector);
        if (!slotElement) throw new HocMountError("no-slot", `No element matches ${selector} for slot "${feature.slotId}"`);
      }

      if (feature.mode === "inject") {
        const init: InitPayload = {
          token: token.token,
          tokenExpiresAt: token.expiresAt,
          tenantContext: { hostId, tenantId, packageId: feature.packageId, slotId: feature.slotId, version: feature.version },
          user: { userId: token.userId, displayName: token.displayName },
          theme,
          locale,
          launchParams: {},
          apiBaseUrl,
        };
        const context: InjectContext = {
          featureId: feature.featureId,
          init,
          slotElement,
          refreshToken: async () => {
            const refreshed = await fetchEmbedToken(tokenUrl);
            return { token: refreshed.token, expiresAt: refreshed.expiresAt };
          },
          navigate: onNavigate,
        };
        const src = `${embedOrigin}/embed/${encodePackageId(feature.packageId)}/${feature.version}/${feature.entry}`;
        await loadInjected(src, toIntegrity(feature.sha256), context, loadTimeoutMs);
        return;
      }

      // iframe mode
      const frame = pageLevel ? installPageFrame(theme) : null;
      const container = frame ? frame.container : slotElement!;
      let mounted: Mounted;
      try {
        mounted = await mountIframe(container, {
          hostId,
          tenantId,
          packageId: feature.packageId,
          slotId: feature.slotId,
          version: feature.version,
          entryPoint: feature.entry,
          title: feature.slotId,
          tokenUrl,
          token,
          theme,
          locale,
          readyTimeoutMs: loadTimeoutMs,
          fullWindow: pageLevel,
          signal: loadAbort.signal,
          onNavigate,
          onTelemetry: options.onTelemetry,
          onUi: options.onUi,
        });
      } catch (cause) {
        frame?.restore(); // put the original page back
        throw cause;
      }
      cleanups.push(() => {
        mounted.unmount();
        frame?.restore();
      });
    };

    const jobs = features.map(async (feature) => {
      try {
        await apply(feature);
        result.applied.push(feature);
      } catch (cause) {
        report(cause instanceof HocMountError ? cause : new HocMountError("plugin-error", (cause as Error).message), feature);
      }
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), loadTimeoutMs);
    });
    const outcome = await Promise.race([Promise.all(jobs).then(() => "done" as const), deadline]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      result.loadTimedOut = true;
      loadAbort.abort(); // page-level iframes still loading fail and restore the original page
      // Let the aborted iframe mounts reject and restore the original page before it is revealed.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return result;
  } finally {
    reveal();
  }
}

/** Hides the original page's body children and returns a full-window container for the plugin iframe,
 * plus `restore()` which removes the container and shows the original page again. */
function installPageFrame(theme: ThemeTokens): { container: HTMLElement; restore: () => void } {
  const hidden = Array.from(document.body.children).map((element) => {
    const el = element as HTMLElement;
    const previous = el.style.display;
    el.style.display = "none";
    return { el, previous };
  });
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-hoc-page-frame", "");
  Object.assign(wrapper.style, { position: "fixed", inset: "0", zIndex: "2147483000", background: theme.backgroundColor });
  document.body.appendChild(wrapper);
  return {
    container: wrapper,
    restore: () => {
      wrapper.remove();
      for (const { el, previous } of hidden) el.style.display = previous;
    },
  };
}
