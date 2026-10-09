import { features as defaultApi, type Feature, type FeaturesApi } from "../features.js";
import { featureCard, type FeatureCard } from "./featureCard.js";
import { requestsSection } from "./requestsSection.js";
import type { ComponentHandle } from "./requestFeature.js";
import { button, createShell, emptyView, errorView, h, loadingView, uid } from "./ui.js";

export interface MyFeaturesOptions {
  /** Defaults to `HandOfClient.features` (the configured site prefix). */
  api?: FeaturesApi;
}

/** `<hoc-my-features>`: my requests (status, answer questions) and my features (versions, keep one, share, turn off). */
export function myFeatures(host: HTMLElement, options: MyFeaturesOptions = {}): ComponentHandle {
  const api = options.api ?? defaultApi;
  const shell = createShell(host, "My features");
  const names = new Map<string, string>();
  let loaded: Feature[] = [];
  let destroyed = false;

  const requests = requestsSection({
    api, say: shell.say, scope: "mine", title: "My requests", allowReply: true,
    linkFor: (request) => loaded.find((f) => f.id === request.featureId)?.path ?? undefined,
  });

  const featuresHeading = uid("features");
  const featuresBody = h("div");
  const featuresSection = h("section", { "aria-labelledby": featuresHeading },
    h("div", { class: "row spread" }, h("h2", { id: featuresHeading }, "My features"),
      button("Refresh", () => void loadFeatures(), { key: "refresh-features", ariaLabel: "Refresh my features" })),
    featuresBody);
  shell.root.append(requests.el, featuresSection);

  async function loadFeatures(): Promise<void> {
    featuresBody.replaceChildren(loadingView("Loading features..."));
    try {
      loaded = await api.listFeatures();
      if (destroyed) return;
      requests.rerender(); // "See where it appears" links need the feature paths
      if (!loaded.length) return void featuresBody.replaceChildren(emptyView("You do not have any features yet. Request one and it will show up here."));
      const cards: FeatureCard[] = loaded.map((f) => featureCard({ api, say: shell.say, names }, f, "mine"));
      featuresBody.replaceChildren(h("ul", { class: "plain" }, ...cards.map((c) => h("li", {}, c.el))));
    } catch (error) {
      featuresBody.replaceChildren(errorView(error, () => void loadFeatures()));
    }
  }

  async function refresh(): Promise<void> {
    await Promise.all([loadFeatures(), requests.refresh()]);
  }

  void refresh();
  return {
    refresh,
    destroy: () => {
      destroyed = true;
      shell.destroy();
    },
  };
}
