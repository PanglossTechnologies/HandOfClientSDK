import { features as defaultApi, type Feature, type FeaturesApi, type RequestSnapshot, type SiteRequest } from "../features.js";
import { captureSnapshot, type SnapshotOptions } from "../snapshot.js";
import { busy, button, createShell, errorText, h, inlineError, loadingView, uid } from "./ui.js";

export interface ComponentHandle {
  /** Reloads the data the component shows. */
  refresh(): Promise<void>;
  /** Removes the component's UI. */
  destroy(): void;
}

export interface RequestFeatureOptions {
  /** Defaults to `HandOfClient.features` (the configured site prefix). */
  api?: FeaturesApi;
  /** Fixes the request as a change to this existing feature; hides the picker. */
  featureId?: string;
  /** Capture the page with the request. `false` hides the option; an object is passed to `captureSnapshot`. Default true. */
  snapshot?: boolean | SnapshotOptions;
  /** Called with the stored request after a successful submit. */
  onSubmitted?: (request: SiteRequest) => void;
}

const MAX_TEXT = 20000;

/** `<hoc-request-feature>`: describe a feature (or a change to one), optionally send a picture of the page, submit. */
export function requestFeature(host: HTMLElement, options: RequestFeatureOptions = {}): ComponentHandle {
  const api = options.api ?? defaultApi;
  const shell = createShell(host, "Request a feature");
  const snapshotWanted = options.snapshot !== false;
  let destroyed = false;
  let pickable: Feature[] = [];
  let draft = ""; // survives a refresh() re-render

  async function loadTargets(): Promise<void> {
    if (options.featureId) return;
    try {
      pickable = await api.listFeatures();
    } catch (error) {
      console.warn("HandOfClient: could not load features for the change picker", error);
      pickable = []; // the request can still be sent as a new feature
    }
  }

  function renderForm(note?: string): void {
    const textId = uid("text");
    const errId = uid("err");
    const targetId = uid("target");
    const text = h("textarea", { id: textId, name: "text", maxLength: MAX_TEXT, rows: 5, required: true, "aria-describedby": `${textId}-help`, value: draft });
    text.addEventListener("input", () => (draft = text.value));
    const help = h("p", { id: `${textId}-help`, class: "muted" }, "Describe what you want in your own words. Press Ctrl+Enter to send.");
    const errorSlot = h("div", { id: errId });
    const target = pickable.length && !options.featureId
      ? h("select", { id: targetId, name: "featureId" },
          h("option", { value: "" }, "A new feature"),
          ...pickable.map((f) => h("option", { value: f.id }, `Change: ${f.title}`)))
      : null;
    const capture = snapshotWanted
      ? h("input", { type: "checkbox", id: uid("snap"), checked: true, name: "snapshot" })
      : null;
    const submit = h("button", { type: "submit", class: "btn primary", "data-key": "submit" }, "Send request");

    const form = h("form", { novalidate: true, class: "stack", on: { submit: (e: Event) => { e.preventDefault(); void send(); } } },
      h("h2", {}, options.featureId ? "Request a change" : "Request a feature"),
      note ? h("p", { class: "note" }, note) : null,
      h("div", {}, h("label", { htmlFor: textId }, "What would you like?"), text, help),
      target ? h("div", {}, h("label", { htmlFor: targetId }, "Is this a change to something you already have?"), target) : null,
      options.featureId ? h("p", { class: "note" }, "This request changes an existing feature.") : null,
      capture
        ? h("label", { class: "inline" }, capture, "Include a copy of this page so the builder can see what you see. Text and personal details are blanked out.")
        : null,
      errorSlot,
      h("div", { class: "row" }, submit));

    text.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void send();
      }
    });
    shell.root.replaceChildren(form);

    async function send(): Promise<void> {
      const body = text.value.trim();
      errorSlot.replaceChildren();
      text.removeAttribute("aria-invalid");
      if (!body) {
        text.setAttribute("aria-invalid", "true");
        errorSlot.append(inlineError("Please describe what you would like."));
        text.focus();
        return;
      }
      await busy([submit, text], async () => {
        let snapshot: RequestSnapshot | undefined;
        let snapshotFailed = false;
        if (capture?.checked) {
          try {
            snapshot = toContract(captureSnapshot(typeof options.snapshot === "object" ? options.snapshot : {}));
          } catch (error) {
            console.warn("HandOfClient: page snapshot failed; sending the request without it", error);
            snapshotFailed = true;
          }
        }
        try {
          const request = await api.createRequest({ text: body, snapshot, featureId: options.featureId || target?.value || undefined });
          host.dispatchEvent(new CustomEvent("hoc-request-submitted", { detail: request, bubbles: true, composed: true }));
          options.onSubmitted?.(request);
          draft = "";
          if (!destroyed) renderConfirmation(request, snapshotFailed);
        } catch (error) {
          errorSlot.replaceChildren(inlineError(errorText(error)));
        }
      });
    }
  }

  function renderConfirmation(request: SiteRequest, snapshotFailed: boolean): void {
    const box = h("div", { class: "success", tabIndex: -1, "data-key": "confirmation" },
      h("h2", {}, "Request received"),
      h("p", {}, "We are working on it. You can follow it, and answer any questions we have, under My features."),
      snapshotFailed ? h("p", { class: "muted" }, "A copy of the page could not be included, so it was sent without one.") : null,
      h("p", { class: "muted" }, `Reference: ${request.id}`),
      h("div", { class: "row" }, button("Send another request", () => renderForm(), { key: "again" })));
    shell.root.replaceChildren(box);
    box.focus();
    shell.say("Request received.");
  }

  async function refresh(): Promise<void> {
    await loadTargets();
    if (!destroyed) renderForm();
  }

  shell.root.append(loadingView());
  void refresh();
  return {
    refresh,
    destroy: () => {
      destroyed = true;
      shell.destroy();
    },
  };
}

/** The contract's `PageSnapshot` (openapi `PageSnapshot`): the capture minus fields the site does not store. */
function toContract(s: ReturnType<typeof captureSnapshot>): RequestSnapshot {
  return {
    url: s.url, path: s.path, title: s.title, html: s.html, redacted: s.redacted, capturedAt: s.capturedAt,
    viewport: { width: s.viewport.width, height: s.viewport.height },
  };
}
