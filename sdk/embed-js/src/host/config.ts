export interface HandOfClientConfig {
  /** Platform API base URL, e.g. https://api.handofclient.com - used only for the anonymous, Public
   * GetActiveVersion call (see AuthPolicy.Methods); never for token issuance. */
  apiBaseUrl: string;
  /** Origin serving embed bundles, e.g. https://embed.handofclient.com. */
  embedOrigin: string;
  /** Where the site mounts its `hoc/` endpoints (openapi/site-hoc-api.yaml). Default "hoc/". Relative
   * values resolve against the page's base URI (so they work under a sub-path from a root-level page);
   * use an absolute path such as "/shop/hoc/" when pages live at several depths. */
  sitePrefix?: string;
}

let config: HandOfClientConfig | null = null;

export function configure(next: HandOfClientConfig): void {
  config = next;
}

/** The site prefix for callers that need nothing else from the config (the browser components and
 * `features.*` only talk to the site): the configured one, else the default - never throws. */
export function resolveSitePrefix(): string {
  const raw = config?.sitePrefix ?? "hoc/";
  return raw.endsWith("/") ? raw : `${raw}/`;
}

export function requireConfig(): HandOfClientConfig & { sitePrefix: string } {
  if (!config) throw new Error("HandOfClient.configure({ apiBaseUrl, embedOrigin }) must be called first.");
  const raw = config.sitePrefix ?? "hoc/";
  return { ...config, sitePrefix: raw.endsWith("/") ? raw : `${raw}/` };
}
