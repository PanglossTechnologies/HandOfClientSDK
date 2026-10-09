import { createFeaturesApi } from "../features.js";
import { featureAdmin } from "./featureAdmin.js";
import { myFeatures } from "./myFeatures.js";
import { requestFeature, type ComponentHandle } from "./requestFeature.js";

type Mount = (host: HTMLElement, api: ReturnType<typeof createFeaturesApi>) => ComponentHandle;

const ELEMENTS: Record<string, Mount> = {
  "hoc-request-feature": (host, api) => requestFeature(host, {
    api,
    featureId: host.getAttribute("feature-id") || undefined,
    snapshot: host.getAttribute("snapshot") === "off" ? false : true,
  }),
  "hoc-my-features": (host, api) => myFeatures(host, { api }),
  "hoc-feature-admin": (host, api) => featureAdmin(host, { api }),
};

/**
 * Registers `<hoc-request-feature>`, `<hoc-my-features>` and `<hoc-feature-admin>`. The drop-in script does
 * this on load; bundler users call it once. Safe to call repeatedly and a no-op outside a browser.
 *
 * Attributes: `site-prefix` (default: the configured one, else "hoc/"); `feature-id` and `snapshot="off"`
 * on `<hoc-request-feature>`. Each element has a `refresh()` method.
 */
export function defineComponents(): void {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") return;
  for (const [name, mount] of Object.entries(ELEMENTS)) {
    if (customElements.get(name)) continue;
    customElements.define(name, class extends HTMLElement {
      private handle?: ComponentHandle;
      connectedCallback(): void {
        // While the page is still parsing, wait: `HandOfClient.configure(...)` normally runs in an inline
        // script right after the one that loads embed.js, and must be seen before the first request.
        const start = (): void => {
          if (!this.isConnected) return;
          this.handle?.destroy();
          this.handle = mount(this, createFeaturesApi({ sitePrefix: this.getAttribute("site-prefix") || undefined }));
        };
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
        else start();
      }
      disconnectedCallback(): void {
        this.handle?.destroy();
        this.handle = undefined;
      }
      refresh(): Promise<void> {
        return this.handle?.refresh() ?? Promise.resolve();
      }
    });
  }
}
