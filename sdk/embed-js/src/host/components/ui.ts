/**
 * Shared plumbing for the browser components: a tiny element builder, the shadow-root shell with the
 * `--hoc-*` themed stylesheet, loading/empty/error states, and focus-preserving re-render.
 */
import { FeaturesApiError } from "../features.js";

type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; on?: Partial<Record<keyof HTMLElementEventMap, (event: any) => void>> };

/** Drops the null/false children of a conditional list so it can go to `append`/`replaceChildren`. */
export const compact = (...children: Child[]): Array<Node | string> => children.filter((c): c is Node | string => !!c);

/** `h("button", { class: "primary", type: "button", on: { click } }, "Save")` */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "on") for (const [type, handler] of Object.entries(value as object)) node.addEventListener(type, handler as EventListener);
    else if (key in node && key !== "list") (node as any)[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

let idCounter = 0;
export const uid = (prefix: string): string => `hoc-${prefix}-${++idCounter}`;

/** The text to show for a failed call. Never leaks anything but the site's own user-safe message. */
export function errorText(error: unknown): string {
  if (error instanceof FeaturesApiError) return error.message;
  console.warn("HandOfClient: unexpected component error", error);
  return "Something went wrong. Please try again.";
}

export interface Shell {
  /** Where the component renders; lives in the host element's shadow root. */
  root: HTMLElement;
  /** Polite announcements (saved, sent...). */
  say(text: string): void;
  destroy(): void;
}

/** Attaches (or reuses) an open shadow root on `host`, installs the stylesheet and returns the render root. */
export function createShell(host: HTMLElement, label: string): Shell {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  shadow.replaceChildren();
  const style = document.createElement("style");
  style.textContent = STYLES;
  const root = h("div", { class: "hoc", role: "region", "aria-label": label });
  const live = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });
  shadow.append(style, root, live);
  return {
    root,
    say: (text) => {
      live.textContent = "";
      // A tick later so screen readers announce a repeat of the same text.
      setTimeout(() => (live.textContent = text), 20);
    },
    destroy: () => shadow.replaceChildren(),
  };
}

/** Re-renders `container` and puts focus back on the control that had it (matched by `data-key`). */
export function replaceKeepingFocus(container: HTMLElement, ...nodes: Node[]): void {
  const rootNode = container.getRootNode() as ShadowRoot | Document;
  const key = (rootNode.activeElement as HTMLElement | null)?.dataset?.key;
  const had = key !== undefined && container.contains(rootNode.activeElement);
  container.replaceChildren(...nodes);
  if (had) {
    // The control may be gone (a "Keep this version" button becomes a label): fall back to the first one left.
    (container.querySelector<HTMLElement>(`[data-key="${CSS.escape(key!)}"]`) ?? container.querySelector<HTMLElement>("button, input, select, textarea"))?.focus();
  }
}

export function loadingView(text = "Loading..."): HTMLElement {
  return h("div", { class: "state loading", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), text);
}

export function emptyView(text: string): HTMLElement {
  return h("p", { class: "state empty" }, text);
}

/** An error with a Retry button (when `retry` is given). Announced to screen readers. */
export function errorView(error: unknown, retry?: () => void): HTMLElement {
  return h("div", { class: "state error", role: "alert" },
    h("span", {}, errorText(error)),
    retry ? h("button", { type: "button", class: "btn", "data-key": "retry", on: { click: retry } }, "Try again") : null);
}

export function inlineError(text: string): HTMLElement {
  return h("p", { class: "inline-error", role: "alert" }, text);
}

export function button(label: string, onClick: () => void, opts: { kind?: "primary" | "danger" | "plain"; key?: string; disabled?: boolean; ariaLabel?: string } = {}): HTMLButtonElement {
  return h("button", {
    type: "button", class: `btn ${opts.kind ?? ""}`.trim(), "data-key": opts.key, disabled: opts.disabled,
    "aria-label": opts.ariaLabel, on: { click: onClick },
  }, label);
}

/** Runs `work` with `controls` disabled so a double click cannot send twice. */
export async function busy<T>(controls: HTMLElement[], work: () => Promise<T>): Promise<T> {
  const disabled = controls.map((c) => (c as HTMLButtonElement).disabled);
  controls.forEach((c) => ((c as HTMLButtonElement).disabled = true));
  try {
    return await work();
  } finally {
    controls.forEach((c, i) => ((c as HTMLButtonElement).disabled = disabled[i]));
  }
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const STYLES = `
:host { display: block; }
.hoc, .hoc * { box-sizing: border-box; }
.hoc {
  font-family: var(--hoc-font, system-ui, -apple-system, "Segoe UI", sans-serif);
  font-size: var(--hoc-font-size, 16px);
  line-height: 1.45;
  color: var(--hoc-text, #1f2937);
  max-width: 100%;
  min-width: 0;
}
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
h2, h3, h4 { margin: 0 0 var(--hoc-gap, 8px); line-height: 1.25; }
h2 { font-size: 1.25em; } h3 { font-size: 1.1em; } h4 { font-size: 1em; }
p { margin: 0 0 var(--hoc-gap, 8px); }
.muted { color: var(--hoc-muted, #6b7280); font-size: 0.9em; }
.card {
  background: var(--hoc-surface, #fff); border: 1px solid var(--hoc-border, #d1d5db);
  border-radius: var(--hoc-radius, 8px); padding: var(--hoc-padding, 14px); margin: 0 0 var(--hoc-gap, 10px);
  min-width: 0; overflow-wrap: anywhere;
}
.row { display: flex; flex-wrap: wrap; gap: var(--hoc-gap, 8px); align-items: center; min-width: 0; }
.row.spread { justify-content: space-between; }
.stack { display: flex; flex-direction: column; gap: var(--hoc-gap, 8px); }
label { display: block; font-weight: 600; margin: 0 0 4px; }
label.inline { display: inline-flex; align-items: center; gap: 8px; font-weight: 400; min-height: 44px; }
input[type=text], input[type=search], input[type=url], input[type=password], textarea, select {
  width: 100%; min-height: 44px; padding: 10px 12px; font: inherit; color: inherit;
  background: var(--hoc-input-bg, #fff); border: 1px solid var(--hoc-border, #d1d5db); border-radius: var(--hoc-radius, 8px);
}
textarea { min-height: 120px; resize: vertical; }
input[type=checkbox], input[type=radio] { width: 22px; height: 22px; margin: 0; flex: none; accent-color: var(--hoc-accent, #2563eb); }
:is(input, textarea, select, button, summary, a):focus-visible { outline: 3px solid var(--hoc-focus, #f59e0b); outline-offset: 2px; }
.btn {
  min-height: 44px; min-width: 44px; padding: 8px 16px; font: inherit; font-weight: 600; cursor: pointer;
  color: var(--hoc-text, #1f2937); background: var(--hoc-surface, #fff);
  border: 1px solid var(--hoc-border, #d1d5db); border-radius: var(--hoc-radius, 8px);
}
.btn:hover:not(:disabled) { background: var(--hoc-hover, #f3f4f6); }
.btn.primary { background: var(--hoc-accent, #2563eb); border-color: var(--hoc-accent, #2563eb); color: var(--hoc-accent-text, #fff); }
.btn.primary:hover:not(:disabled) { filter: brightness(0.92); background: var(--hoc-accent, #2563eb); }
.btn.danger { color: var(--hoc-danger, #b91c1c); border-color: var(--hoc-danger, #b91c1c); }
.btn:disabled { opacity: 0.55; cursor: not-allowed; }
.state { padding: 12px; border-radius: var(--hoc-radius, 8px); margin: 0 0 var(--hoc-gap, 10px); }
.state.loading { display: flex; gap: 10px; align-items: center; color: var(--hoc-muted, #6b7280); }
.state.empty { color: var(--hoc-muted, #6b7280); border: 1px dashed var(--hoc-border, #d1d5db); text-align: center; }
.state.error, .inline-error { color: var(--hoc-danger, #b91c1c); background: var(--hoc-danger-bg, #fef2f2); border: 1px solid var(--hoc-danger, #b91c1c); }
.state.error { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.inline-error { padding: 8px 12px; border-radius: var(--hoc-radius, 8px); margin: 8px 0; }
.success { color: var(--hoc-success, #166534); background: var(--hoc-success-bg, #f0fdf4); border: 1px solid var(--hoc-success, #166534); padding: 12px; border-radius: var(--hoc-radius, 8px); }
.spinner { width: 18px; height: 18px; border: 3px solid var(--hoc-border, #d1d5db); border-top-color: var(--hoc-accent, #2563eb); border-radius: 50%; animation: hoc-spin 0.8s linear infinite; }
@keyframes hoc-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 0.85em; font-weight: 600; border: 1px solid currentColor; }
.badge.InProgress { color: var(--hoc-accent, #2563eb); }
.badge.NeedsInfo { color: var(--hoc-warn, #b45309); }
.badge.Rejected { color: var(--hoc-danger, #b91c1c); }
.badge.Success { color: var(--hoc-success, #166534); }
details > summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; font-weight: 600; }
fieldset { border: 1px solid var(--hoc-border, #d1d5db); border-radius: var(--hoc-radius, 8px); margin: 0 0 var(--hoc-gap, 10px); padding: var(--hoc-padding, 14px); min-width: 0; }
legend { font-weight: 600; padding: 0 6px; }
ul.plain { list-style: none; margin: 0; padding: 0; }
ul.plain li { margin: 0 0 6px; }
.note { background: var(--hoc-hover, #f3f4f6); border-radius: var(--hoc-radius, 8px); padding: 10px 12px; font-size: 0.92em; }
a { color: var(--hoc-accent, #2563eb); }
code { font-family: ui-monospace, Consolas, monospace; font-size: 0.9em; overflow-wrap: anywhere; }
@media (max-width: 480px) { .row.stack-sm { flex-direction: column; align-items: stretch; } .btn { flex: 1 1 auto; } }
`;
