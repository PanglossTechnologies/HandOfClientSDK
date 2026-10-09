/**
 * One feature as a card: shared by `<hoc-my-features>` (keep a version, turn off, share) and
 * `<hoc-feature-admin>` (roll back for everyone). The card owns its own state so a server answer updates
 * it in place and open panels, typed text and focus survive.
 */
import type { Feature, FeaturesApi, FeatureVersion, FeatureVersions } from "../features.js";
import { button, compact, emptyView, errorText, errorView, formatDate, h, inlineError, loadingView, replaceKeepingFocus, uid } from "./ui.js";

export interface CardContext {
  api: FeaturesApi;
  say(text: string): void;
  /** User id -> display name, filled from the share picker so shared-with lists can show names. */
  names: Map<string, string>;
}

export interface FeatureCard {
  el: HTMLElement;
  update(feature: Feature): void;
}

const KIND_LABEL = { slot: "Panel on a page", "page-override": "Replaces a page", "new-page": "New page" } as const;

export function featureCard(ctx: CardContext, initial: Feature, mode: "mine" | "admin"): FeatureCard {
  let feature = initial;
  let versions: FeatureVersions | null = null;
  let pending = false;
  const titleId = uid("feature");
  const el = h("article", { class: "card", "aria-labelledby": titleId });
  const head = h("div", { class: "stack" });
  const controls = h("div", { class: "row" });
  const errorSlot = h("div");
  const versionsBody = h("div");
  const versionsDetails = h("details", { on: { toggle: () => { if (versionsDetails.open && !versions) void loadVersions(); } } },
    h("summary", { "data-key": "versions" }, mode === "admin" ? "Versions and roll back" : "Versions"), versionsBody);
  const shareBody = h("div");
  const shareDetails = h("details", {}, h("summary", { "data-key": "share" }, "Sharing"), shareBody);
  el.append(head, controls, errorSlot, versionsDetails, shareDetails);

  const key = (name: string): string => `${feature.id}:${name}`;

  /** Runs one server call that answers with the updated feature. Ignores clicks while one is running. */
  async function act(work: () => Promise<Feature>, done: string): Promise<void> {
    if (pending) return;
    pending = true;
    el.setAttribute("aria-busy", "true");
    errorSlot.replaceChildren();
    try {
      update(await work());
      ctx.say(done);
    } catch (error) {
      errorSlot.replaceChildren(inlineError(errorText(error)));
    } finally {
      pending = false;
      el.removeAttribute("aria-busy");
    }
  }

  async function loadVersions(): Promise<void> {
    versionsBody.replaceChildren(loadingView("Loading versions..."));
    try {
      versions = await ctx.api.listFeatureVersions(feature.id);
      renderVersions();
    } catch (error) {
      versionsBody.replaceChildren(errorView(error, () => void loadVersions()));
    }
  }

  function renderHead(): void {
    const parts: string[] = [KIND_LABEL[feature.kind] ?? feature.kind];
    if (feature.path) parts.push(feature.path);
    const versionLine = feature.pinnedVersion
      ? `Version ${feature.pinnedVersion} (you kept it; latest is ${feature.currentVersion})`
      : `Version ${feature.currentVersion} (following the latest)`;
    head.replaceChildren(...compact(
      h("h3", { id: titleId }, feature.title),
      h("p", { class: "muted" }, parts.join(" - ")),
      h("p", {}, versionLine),
      mode === "mine" && !feature.enabled ? h("p", { class: "note" }, "This feature is turned off for you.") : null,
      mode === "admin" ? h("p", { class: "muted" }, `Owner: ${ctx.names.get(feature.ownerUserId) ?? feature.ownerUserId}. Rendering: ${feature.mode}.`) : null));
  }

  function renderControls(): void {
    const nodes: Node[] = [];
    if (mode === "mine") {
      nodes.push(feature.enabled
        ? button("Turn off", () => void act(() => ctx.api.setFeatureEnabled(feature.id, false), "Turned off."), { key: key("toggle"), ariaLabel: `Turn off ${feature.title}` })
        : button("Turn on", () => void act(() => ctx.api.setFeatureEnabled(feature.id, true), "Turned on."), { key: key("toggle"), kind: "primary", ariaLabel: `Turn on ${feature.title}` }));
      if (feature.pinnedVersion) {
        nodes.push(button("Follow latest", () => void act(() => ctx.api.pinFeatureVersion(feature.id, null), "Now following the latest version."),
          { key: key("follow"), ariaLabel: `Follow the latest version of ${feature.title}` }));
      }
    }
    replaceKeepingFocus(controls, ...nodes);
  }

  function renderVersions(): void {
    if (!versions) return;
    if (!versions.versions.length) return void versionsBody.replaceChildren(emptyView("No versions yet."));
    const currentIndex = versions.versions.findIndex((v) => v.version === feature.currentVersion);
    const items = versions.versions.map((v, index) => h("li", { class: "card" },
      h("div", { class: "row spread" },
        h("strong", {}, `Version ${v.version}`),
        h("span", { class: "muted" }, formatDate(v.publishedAt))),
      h("div", { class: "row" },
        v.version === feature.currentVersion ? h("span", { class: "badge Success" }, "Latest") : null,
        v.version === feature.pinnedVersion ? h("span", { class: "badge InProgress" }, "Kept by you") : null),
      h("div", { class: "row" }, ...versionActions(v, index, currentIndex))));
    replaceKeepingFocus(versionsBody, h("ul", { class: "plain" }, ...items));
  }

  function versionActions(v: FeatureVersion, index: number, currentIndex: number): Node[] {
    if (mode === "mine") {
      if (v.version === feature.pinnedVersion) return [];
      return [button("Keep this version", () => void act(() => ctx.api.pinFeatureVersion(feature.id, v.version), `Keeping version ${v.version}.`),
        { key: key(`keep-${v.version}`), ariaLabel: `Keep version ${v.version}` })];
    }
    if (v.version === feature.currentVersion) return [];
    const older = currentIndex >= 0 && index > currentIndex;
    return [confirmingButton(older ? "Roll back for everyone" : "Make current for everyone", `Version ${v.version} will replace version ${feature.currentVersion} for everyone who has not kept a version.`,
      () => act(() => ctx.api.setFeatureCurrentVersion(feature.id, v.version), `Version ${v.version} is now current for everyone.`), key(`current-${v.version}`), `${older ? "Roll back to" : "Make current"} version ${v.version}`)];
  }

  function renderShare(): void {
    const sharing = feature.sharing;
    shareDetails.hidden = !sharing;
    if (!sharing) return;
    const searchId = uid("search");
    const results = h("div", { "aria-live": "polite" });
    const search = h("input", { type: "search", id: searchId, autocomplete: "off", placeholder: "Name or email" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let searchToken = 0;

    async function runSearch(): Promise<void> {
      const query = search.value.trim();
      const token = ++searchToken;
      if (!query) return void results.replaceChildren();
      results.replaceChildren(loadingView("Searching..."));
      try {
        const users = (await ctx.api.findUsers(query)).filter((u) => !sharing!.userIds.includes(u.id));
        if (token !== searchToken) return; // a newer search is already running
        for (const u of users) if (u.name) ctx.names.set(u.id, u.name);
        results.replaceChildren(users.length
          ? h("ul", { class: "plain" }, ...users.map((u) => h("li", {}, button(`Share with ${u.name ?? u.id}`,
              () => void act(() => ctx.api.shareFeature(feature.id, { userIds: [u.id] }), `Shared with ${u.name ?? u.id}.`), { key: key(`add-${u.id}`) }))))
          : emptyView("No one found."));
      } catch (error) {
        if (token === searchToken) results.replaceChildren(errorView(error, () => void runSearch()));
      }
    }
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => void runSearch(), 250);
    });
    search.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        clearTimeout(timer);
        void runSearch();
      }
    });

    const named = sharing.userIds.length
      ? h("ul", { class: "plain" }, ...sharing.userIds.map((id) => {
          const label = ctx.names.get(id) ?? id;
          return h("li", { class: "row spread" }, h("span", {}, label),
            button("Remove", () => void act(() => ctx.api.unshareFeature(feature.id, id), `Stopped sharing with ${label}.`), { key: key(`rm-${id}`), ariaLabel: `Stop sharing with ${label}` }));
        }))
      : h("p", { class: "muted" }, "Not shared with any named people.");

    const everyone = sharing.everyone
      ? h("div", { class: "row spread" }, h("span", {}, "Shared with everyone."),
          button("Stop sharing with everyone", () => void act(() => ctx.api.unshareFeature(feature.id, "everyone"), "Stopped sharing with everyone."), { key: key("everyone") }))
      : h("div", { class: "row spread" }, h("span", {}, "Not shared with everyone."),
          button("Share with everyone", () => void act(() => ctx.api.shareFeature(feature.id, { everyone: true }), "Shared with everyone."), { key: key("everyone") }));

    replaceKeepingFocus(shareBody, h("div", { class: "stack" }, everyone, named,
      h("div", {}, h("label", { htmlFor: searchId }, "Share with someone"), search), results));
  }

  function update(next: Feature): void {
    feature = next;
    renderHead();
    renderControls();
    renderVersions();
    renderShare();
  }

  update(initial);
  return { el, update };
}

/** A destructive action behind a visible second step: the first click asks, the second does it. */
function confirmingButton(label: string, warning: string, run: () => Promise<void>, dataKey: string, ariaLabel: string): HTMLElement {
  const wrap = h("div", { class: "row" });
  const ask = (): void => {
    const confirm = button(`Confirm: ${label.toLowerCase()}`, () => void run(), { kind: "danger", key: dataKey, ariaLabel: `Confirm: ${ariaLabel}` });
    wrap.replaceChildren(h("p", { class: "note" }, warning), confirm, button("Cancel", () => {
      wrap.replaceChildren(first());
      wrap.querySelector<HTMLElement>("button")?.focus();
    }, { key: `${dataKey}-cancel` }));
    confirm.focus();
  };
  const first = (): HTMLElement => button(label, ask, { key: dataKey, ariaLabel });
  wrap.append(first());
  return wrap;
}
