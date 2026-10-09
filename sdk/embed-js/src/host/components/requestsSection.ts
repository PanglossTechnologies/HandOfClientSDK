/** The request list shared by `<hoc-my-features>` (mine, with reply boxes) and `<hoc-feature-admin>` (everyone's, read-only). */
import type { FeaturesApi, RequestStatus, SiteRequest } from "../features.js";
import { busy, button, compact, emptyView, errorText, errorView, formatDate, h, inlineError, loadingView, replaceKeepingFocus, uid } from "./ui.js";

export interface RequestsSectionOptions {
  api: FeaturesApi;
  say(text: string): void;
  scope: "mine" | "all";
  title: string;
  /** Show a reply box on `NeedsInfo` requests (the requester's own list only). */
  allowReply: boolean;
  /** Offer a status filter (the admin list). */
  statusFilter?: boolean;
  /** Where a finished request can be seen, if known. */
  linkFor?: (request: SiteRequest) => string | undefined;
}

const PAGE_SIZE = 20;
const STATUS_LABEL: Record<RequestStatus, string> = { InProgress: "In progress", NeedsInfo: "Needs your answer", Rejected: "Not built", Success: "Ready" };
const STATUSES: RequestStatus[] = ["InProgress", "NeedsInfo", "Rejected", "Success"];

export function requestsSection(options: RequestsSectionOptions): { el: HTMLElement; refresh(): Promise<void>; rerender(): void } {
  const { api } = options;
  const headingId = uid("requests");
  const body = h("div");
  const el = h("section", { "aria-labelledby": headingId });
  let items: SiteRequest[] = [];
  let nextCursor: string | null = null;
  let filter: RequestStatus | "" = "";
  let loadToken = 0;
  let loadedOnce = false;

  const refreshButton = button("Refresh", () => void refresh(), { key: "refresh", ariaLabel: `Refresh ${options.title.toLowerCase()}` });
  const filterSelect = options.statusFilter
    ? h("select", { "aria-label": "Filter by status", on: { change: (e: Event) => { filter = (e.target as HTMLSelectElement).value as RequestStatus | ""; void refresh(); } } },
        h("option", { value: "" }, "All statuses"), ...STATUSES.map((s) => h("option", { value: s }, STATUS_LABEL[s].replace("Needs your answer", "Needs an answer"))))
    : null;
  el.append(h("div", { class: "row spread" }, h("h2", { id: headingId }, options.title), h("div", { class: "row" }, filterSelect, refreshButton)), body);

  async function fetchPage(cursor?: string): Promise<void> {
    const token = ++loadToken;
    const page = await api.listRequests({ scope: options.scope, limit: PAGE_SIZE, cursor, status: filter ? [filter] : undefined });
    if (token !== loadToken) return;
    items = cursor ? [...items, ...page.requests] : page.requests;
    nextCursor = page.nextCursor;
  }

  async function refresh(): Promise<void> {
    body.replaceChildren(loadingView("Loading requests..."));
    try {
      await fetchPage();
      loadedOnce = true;
      render();
    } catch (error) {
      body.replaceChildren(errorView(error, () => void refresh()));
    }
  }

  async function loadMore(trigger: HTMLButtonElement): Promise<void> {
    await busy([trigger], async () => {
      try {
        await fetchPage(nextCursor ?? undefined);
        render();
      } catch (error) {
        body.append(inlineError(errorText(error)));
      }
    });
  }

  function render(): void {
    if (!items.length) {
      return void body.replaceChildren(emptyView(options.scope === "mine" ? "You have not asked for anything yet." : "No requests match."));
    }
    const more: HTMLButtonElement | null = nextCursor ? button("Show more", () => void loadMore(more!), { key: "more" }) : null;
    replaceKeepingFocus(body, ...compact(h("ul", { class: "plain" }, ...items.map((r) => h("li", {}, requestCard(r)))), more) as Node[]);
  }

  function requestCard(request: SiteRequest): HTMLElement {
    const card = h("article", { class: "card" });
    const paint = (r: SiteRequest): void => {
      const link = r.status === "Success" ? options.linkFor?.(r) : undefined;
      card.replaceChildren(...compact(
        h("p", {}, r.text),
        h("div", { class: "row" },
          h("span", { class: `badge ${r.status}` }, STATUS_LABEL[r.status] ?? r.status),
          h("span", { class: "muted" }, formatDate(r.createdAt)),
          options.scope === "all" ? h("span", { class: "muted" }, `by ${r.userName ?? r.userId}`) : null),
        r.status === "Rejected" && r.message ? h("p", {}, `Reason: ${r.message}`) : null,
        r.status === "Success" ? h("p", {}, "It is live for you.", link ? " " : "", link ? h("a", { href: link }, "See where it appears") : null) : null,
        r.status === "NeedsInfo" ? needsInfo(r) : null));
    };

    function needsInfo(r: SiteRequest): HTMLElement {
      if (!options.allowReply) return h("p", {}, `Question: ${r.message ?? ""}`);
      const id = uid("reply");
      const answer = h("textarea", { id, rows: 3, maxLength: 20000, "aria-describedby": `${id}-q` });
      const errorSlot = h("div");
      const send = h("button", { type: "submit", class: "btn primary", "data-key": `reply-${r.id}` }, "Send answer");
      const form = h("form", { class: "stack", novalidate: true, on: { submit: (e: Event) => { e.preventDefault(); void reply(); } } },
        h("p", { id: `${id}-q`, class: "note" }, r.message ?? "We need a little more information."),
        h("div", {}, h("label", { htmlFor: id }, "Your answer"), answer),
        errorSlot, h("div", { class: "row" }, send));
      answer.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void reply();
        }
      });
      async function reply(): Promise<void> {
        errorSlot.replaceChildren();
        const text = answer.value.trim();
        if (!text) {
          answer.setAttribute("aria-invalid", "true");
          errorSlot.append(inlineError("Please type your answer first."));
          answer.focus();
          return;
        }
        await busy([send, answer], async () => {
          try {
            const updated = await api.replyToRequest(r.id, text);
            items = items.map((x) => (x.id === updated.id ? updated : x));
            paint(updated);
            options.say("Answer sent.");
          } catch (error) {
            errorSlot.replaceChildren(inlineError(errorText(error)));
          }
        });
      }
      return form;
    }

    paint(request);
    return card;
  }

  return { el, refresh, rerender: () => loadedOnce && render() };
}
