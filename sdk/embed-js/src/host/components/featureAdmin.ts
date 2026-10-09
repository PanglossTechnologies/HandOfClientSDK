import { features as defaultApi, FeaturesApiError, type DataSource, type Feature, type FeaturesApi, type RenderingMode, type Settings, type SharePolicy } from "../features.js";
import { featureCard } from "./featureCard.js";
import { requestsSection } from "./requestsSection.js";
import type { ComponentHandle } from "./requestFeature.js";
import { busy, button, createShell, emptyView, errorText, errorView, h, inlineError, loadingView, uid } from "./ui.js";

export interface FeatureAdminOptions {
  /** Defaults to `HandOfClient.features` (the configured site prefix). */
  api?: FeaturesApi;
}

const SECRET_NAME = /^[a-z0-9_-]{1,64}$/;
const POLICY_LABEL: Record<SharePolicy, string> = { owner: "The person who owns the feature", admins: "Administrators only", nobody: "Nobody" };

interface SourceRow {
  name: string;
  baseUrl: string;
  secret: string;
  secretValue: string;
  openapi: string;
  /** The vault already holds a value for `secret`; blank `secretValue` keeps it. */
  hadSecret: boolean;
}

const toRow = (d: DataSource): SourceRow => ({
  name: d.name, baseUrl: d.baseUrl, secret: d.auth?.secret ?? "", secretValue: "", hadSecret: !!d.auth,
  openapi: d.openapi ? JSON.stringify(d.openapi, null, 2) : "",
});

/** `<hoc-feature-admin>`: the site's settings, every request, every feature (roll back for everyone), data sources. */
export function featureAdmin(host: HTMLElement, options: FeatureAdminOptions = {}): ComponentHandle {
  const api = options.api ?? defaultApi;
  const shell = createShell(host, "Feature administration");
  const names = new Map<string, string>();
  let destroyed = false;

  const settingsBody = h("div");
  const featuresBody = h("div");
  const settingsId = uid("settings");
  const featuresId = uid("all-features");
  const requests = requestsSection({ api, say: shell.say, scope: "all", title: "All requests", allowReply: false, statusFilter: true });

  async function loadSettings(): Promise<boolean> {
    settingsBody.replaceChildren(loadingView("Loading settings..."));
    try {
      renderSettings(await api.getSettings());
      return true;
    } catch (error) {
      if (error instanceof FeaturesApiError && (error.code === "forbidden" || error.code === "unauthenticated")) {
        shell.root.replaceChildren(h("div", { class: "state error", role: "alert" }, "Only administrators can manage features."));
        return false;
      }
      settingsBody.replaceChildren(errorView(error, () => void loadSettings()));
      return true;
    }
  }

  function renderSettings(settings: Settings): void {
    let rows: SourceRow[] = settings.dataSources.map(toRow);
    const state = { ...settings };
    const errorSlot = h("div", { tabIndex: -1 });
    const rowsBody = h("div", { class: "stack" });

    const radio = (value: RenderingMode, title: string, text: string): HTMLElement => {
      const id = uid("mode");
      return h("div", { class: "card" }, h("label", { class: "inline", htmlFor: id },
        h("input", { type: "radio", name: "renderingMode", id, value, checked: state.renderingMode === value, on: { change: () => (state.renderingMode = value) } }),
        h("span", {}, h("strong", {}, title), h("br"), text)));
    };
    const select = (label: string, value: string, choices: Array<[string, string]>, set: (v: string) => void): HTMLElement => {
      const id = uid("sel");
      return h("div", {}, h("label", { htmlFor: id }, label),
        h("select", { id, on: { change: (e: Event) => set((e.target as HTMLSelectElement).value) } },
          ...choices.map(([v, text]) => h("option", { value: v, selected: v === value }, text))));
    };
    const policyChoices = (Object.keys(POLICY_LABEL) as SharePolicy[]).map((p): [string, string] => [p, POLICY_LABEL[p]]);

    function renderRows(): void {
      rowsBody.replaceChildren(...(rows.length ? rows.map((row, index) => sourceFieldset(row, index)) : [emptyView("No data sources. Add one if features should read your own API.")]));
    }

    function sourceFieldset(row: SourceRow, index: number): HTMLElement {
      const input = (label: string, field: keyof SourceRow, type: string, extra: Record<string, unknown> = {}): HTMLElement => {
        const id = uid("ds");
        return h("div", {}, h("label", { htmlFor: id }, label),
          h("input", { id, type, value: row[field] as string, autocomplete: "off", ...extra, on: { input: (e: Event) => ((row[field] as string) = (e.target as HTMLInputElement).value) } }));
      };
      const openapiId = uid("ds-openapi");
      return h("fieldset", { "data-row": String(index) },
        h("legend", {}, row.name || `Data source ${index + 1}`),
        h("div", { class: "stack" },
          input("Name", "name", "text", { "data-field": "name" }),
          input("Base URL", "baseUrl", "url", { placeholder: "https://api.example.com", "data-field": "baseUrl" }),
          input("Secret name (optional)", "secret", "text", { placeholder: "my-api-key", "data-field": "secret" }),
          input(row.hadSecret ? "New secret value (leave blank to keep the stored one)" : "Secret value", "secretValue", "password", { autocomplete: "new-password", "data-field": "secretValue" }),
          h("div", {}, h("label", { htmlFor: openapiId }, "OpenAPI description (optional, JSON)"),
            h("textarea", { id: openapiId, rows: 4, value: row.openapi, "data-field": "openapi", on: { input: (e: Event) => (row.openapi = (e.target as HTMLTextAreaElement).value) } })),
          h("div", { class: "row" }, button("Remove data source", () => {
            rows = rows.filter((r) => r !== row);
            renderRows();
            (rowsBody.querySelector("button, input") as HTMLElement | null ?? addButton).focus();
          }, { kind: "danger", key: `remove-${index}`, ariaLabel: `Remove data source ${row.name || index + 1}` }))));
    }

    const addButton = button("Add data source", () => {
      rows.push({ name: "", baseUrl: "", secret: "", secretValue: "", openapi: "", hadSecret: false });
      renderRows();
      rowsBody.querySelector<HTMLElement>(`[data-row="${rows.length - 1}"] input`)?.focus();
    }, { key: "add-source" });

    const save = h("button", { type: "submit", class: "btn primary", "data-key": "save-settings" }, "Save settings");

    function validate(): { problems: string[]; sources: DataSource[] } {
      const problems: string[] = [];
      const sources: DataSource[] = [];
      const seen = new Set<string>();
      rows.forEach((row, i) => {
        const where = `Data source ${i + 1}`;
        const name = row.name.trim();
        if (!name) problems.push(`${where}: enter a name.`);
        else if (seen.has(name.toLowerCase())) problems.push(`${where}: the name "${name}" is used twice.`);
        seen.add(name.toLowerCase());
        let url: URL | undefined;
        try {
          url = new URL(row.baseUrl.trim());
        } catch (cause) {
          console.warn("HandOfClient: invalid data source URL", cause);
        }
        if (!url || !/^https?:$/.test(url.protocol)) problems.push(`${where}: enter a full web address starting with https://.`);
        const secret = row.secret.trim();
        if (secret && !SECRET_NAME.test(secret)) problems.push(`${where}: the secret name may use lowercase letters, digits, "-" and "_" (up to 64).`);
        if (!secret && row.secretValue) problems.push(`${where}: enter a secret name for the secret value.`);
        let openapi: Record<string, unknown> | undefined;
        if (row.openapi.trim()) {
          try {
            const parsed: unknown = JSON.parse(row.openapi);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
            openapi = parsed as Record<string, unknown>;
          } catch (cause) {
            console.warn("HandOfClient: invalid data source OpenAPI JSON", cause);
            problems.push(`${where}: the OpenAPI description is not a valid JSON object.`);
          }
        }
        sources.push({
          name, baseUrl: row.baseUrl.trim(), ...(openapi ? { openapi } : {}),
          ...(secret ? { auth: { type: "bearer" as const, secret, ...(row.secretValue ? { secretValue: row.secretValue } : {}) } } : {}),
        });
      });
      return { problems, sources };
    }

    async function submit(): Promise<void> {
      errorSlot.replaceChildren();
      const { problems, sources } = validate();
      if (problems.length) {
        errorSlot.replaceChildren(h("div", { class: "inline-error", role: "alert" }, h("strong", {}, "Please fix these first:"), h("ul", {}, ...problems.map((p) => h("li", {}, p)))));
        errorSlot.focus();
        return;
      }
      await busy([save], async () => {
        try {
          const saved = await api.putSettings({ ...state, dataSources: sources });
          Object.assign(state, saved);
          rows = saved.dataSources.map(toRow);
          renderRows();
          errorSlot.replaceChildren(h("p", { class: "success", role: "status" }, "Settings saved."));
          shell.say("Settings saved.");
        } catch (error) {
          errorSlot.replaceChildren(inlineError(errorText(error)));
        }
      });
    }

    renderRows();
    settingsBody.replaceChildren(h("form", { class: "stack", novalidate: true, on: { submit: (e: Event) => { e.preventDefault(); void submit(); } } },
      h("fieldset", {}, h("legend", {}, "How new features run"),
        h("p", {}, "This applies to features built from now on."),
        radio("inject", "Inject (recommended)", "New features run directly inside your pages, so they look and behave exactly like the rest of your site and can use your site's own API with the signed-in user's login."),
        radio("iframe", "Iframe", "New features run in a sandboxed frame. They can only reach your data through HandOfClient's network proxy (with its allowlist and audit log), and cannot read or change the rest of the page.")),
      h("fieldset", {}, h("legend", {}, "Who can do what"),
        h("div", { class: "stack" },
          select("Who can share a feature with named people", state.shareWithNamedUsers, policyChoices, (v) => (state.shareWithNamedUsers = v as SharePolicy)),
          select("Who can share a feature with everyone", state.shareWithEveryone, policyChoices, (v) => (state.shareWithEveryone = v as SharePolicy)),
          select("Who can see every request", state.viewAllRequests, [["admins", "Administrators only"], ["everyone", "Everyone"]], (v) => (state.viewAllRequests = v as "admins" | "everyone")))),
      h("fieldset", {}, h("legend", {}, "Data sources"),
        h("p", { class: "muted" }, "APIs that new features may call. Each secret is stored with HandOfClient and is never shown again."),
        rowsBody, h("div", { class: "row" }, addButton)),
      errorSlot,
      h("div", { class: "row" }, save)));
  }

  async function loadFeatures(): Promise<void> {
    featuresBody.replaceChildren(loadingView("Loading features..."));
    try {
      const list: Feature[] = await api.listFeatures();
      if (destroyed) return;
      featuresBody.replaceChildren(list.length
        ? h("ul", { class: "plain" }, ...list.map((f) => h("li", {}, featureCard({ api, say: shell.say, names }, f, "admin").el)))
        : emptyView("No features yet."));
    } catch (error) {
      featuresBody.replaceChildren(errorView(error, () => void loadFeatures()));
    }
  }

  shell.root.append(
    h("section", { "aria-labelledby": settingsId }, h("h2", { id: settingsId }, "Settings"), settingsBody),
    requests.el,
    h("section", { "aria-labelledby": featuresId },
      h("div", { class: "row spread" }, h("h2", { id: featuresId }, "All features"),
        button("Refresh", () => void loadFeatures(), { key: "refresh-features", ariaLabel: "Refresh all features" })),
      featuresBody));

  async function refresh(): Promise<void> {
    if (!(await loadSettings())) return; // not an admin: nothing else to show
    await Promise.all([requests.refresh(), loadFeatures()]);
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
