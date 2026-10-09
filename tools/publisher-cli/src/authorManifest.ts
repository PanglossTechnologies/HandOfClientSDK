/**
 * The author-facing manifest.json schema a plugin publisher hand-writes - deliberately friendlier
 * than the wire Manifest proto message it gets translated into (see toProtoManifest below): plain
 * lowercase enum strings instead of SLOT_KIND_* constants, and no bundle.bundleHash/fileIntegrity
 * fields at all, since those are computed from the packed bundle by this CLI, never hand-authored.
 */
export interface AuthorSlotDecl {
  slotId: string;
  kind: "page" | "override" | "panel";
  title?: string;
  showInNav?: boolean;
  defaultEnabled?: boolean;
  targetPath?: string;   // required for kind: "page"
  matchPath?: string;    // required for kind: "override"
  aliasGroupKey?: string;
  hostPanelId?: string;  // required for kind: "panel"
}

export type AuthorFilterTransform =
  | { kind: "append" | "prepend" | "const"; text: string }
  | { kind: "replace"; replacements: Record<string, string> };

export interface AuthorHookDecl {
  hook: string;
  kind: "action" | "filter";
  priority?: number;
  acceptedArgs?: number;
  /** action only */
  webhookUrl?: string;
  /** action only */
  argIndexes?: number[];
  /** filter only */
  transform?: AuthorFilterTransform;
}

export interface AuthorManifest {
  packageId: string;
  publisher: string;
  name: string;
  description?: string;
  version: string;
  hostId: string;
  tenantKey?: string;
  /** slotId -> file path relative to the bundle directory root. */
  entryPoints: Record<string, string>;
  slots: AuthorSlotDecl[];
  hooks?: AuthorHookDecl[];
  permissions?: { scopes?: string[]; egressHosts?: string[] };
  entitlement?: { requiredFeatures?: string[] };
  updatePolicy?: { kind: "pinned" } | { kind: "channel"; channel: "stable" | "beta" };
  /** See Manifest.strict_csp (package_registry.proto). Default false - only set true for a publisher
   * whose bundles must have no network access at all (e.g. untrusted/AI-generated content), not for
   * normal plugins that just want a narrower egress allowlist (use permissions.egressHosts for that). */
  strictCsp?: boolean;
  /** See Manifest.render. "iframe" (default) or "inject": the entry point is a JS module the host page loads
   * with <script type="module" integrity=...>. Inject cannot be combined with strictCsp. */
  render?: "iframe" | "inject";
  /** See Manifest.kind. Default "slot". */
  kind?: "slot" | "page-override" | "new-page";
  /** Site path (starting with "/") for kind "page-override" / "new-page". */
  path?: string;
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ValidationIssue {
  field: string;
  message: string;
}

/** Structural + cross-referential validation against the bundle's actual file list - see design doc
 * "6. Relationship to DotNetShared.Extensibility": "validates the manifest against the schema
 * (declared egress hosts syntactically valid, entry points exist in the bundle)". */
export function validateAuthorManifest(manifest: AuthorManifest, bundleFiles: ReadonlySet<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const require = (condition: boolean, field: string, message: string) => {
    if (!condition) issues.push({ field, message });
  };

  require(!!manifest.packageId, "packageId", "packageId is required");
  require(!!manifest.publisher, "publisher", "publisher is required");
  require(!!manifest.name, "name", "name is required");
  require(!!manifest.hostId, "hostId", "hostId is required");
  require(SEMVER_PATTERN.test(manifest.version ?? ""), "version", `version "${manifest.version}" is not valid semver`);
  require(Object.keys(manifest.entryPoints ?? {}).length > 0, "entryPoints", "at least one entry point is required");
  require((manifest.slots ?? []).length > 0, "slots", "at least one slot is required");

  for (const [slotId, relativePath] of Object.entries(manifest.entryPoints ?? {})) {
    require(bundleFiles.has(normalize(relativePath)), `entryPoints.${slotId}`,
      `entry point file "${relativePath}" was not found in the bundle`);
  }

  for (const slot of manifest.slots ?? []) {
    require(!!slot.slotId, "slots[].slotId", "every slot needs a slotId");
    require(manifest.entryPoints?.[slot.slotId] !== undefined, `slots.${slot.slotId}`,
      `slot "${slot.slotId}" has no matching entryPoints["${slot.slotId}"]`);
    if (slot.kind === "page") require(!!slot.targetPath, `slots.${slot.slotId}.targetPath`, `kind "page" requires targetPath`);
    if (slot.kind === "override") require(!!slot.matchPath, `slots.${slot.slotId}.matchPath`, `kind "override" requires matchPath`);
    if (slot.kind === "panel") require(!!slot.hostPanelId, `slots.${slot.slotId}.hostPanelId`, `kind "panel" requires hostPanelId`);
  }

  for (const host of manifest.permissions?.egressHosts ?? []) {
    require(isSyntacticallyValidHostname(host), `permissions.egressHosts`, `"${host}" is not a syntactically valid hostname`);
  }

  validateHooks(manifest, require);

  if (manifest.kind === "page-override" || manifest.kind === "new-page") {
    require(!!manifest.path && manifest.path.startsWith("/"), "path", `kind "${manifest.kind}" requires a path starting with "/"`);
  }
  if (manifest.render === "inject") {
    require(!manifest.strictCsp, "render", `render "inject" cannot be combined with strictCsp`);
  }

  if (manifest.updatePolicy?.kind === "channel") {
    require(!!manifest.updatePolicy.channel, "updatePolicy.channel", `kind "channel" requires a channel value`);
  }

  return issues;
}

const HOOK_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_/-]*$/;
const FILTER_TRANSFORM_KINDS = ["append", "prepend", "replace", "const"] as const;

/**
 * The whole point of this function is the filter rule.
 *
 * An action is fire-and-forget, so a webhook is a faithful implementation of it. A filter is not:
 * the host is blocked mid-computation waiting for a return value. Rather than let an author write
 * a filter webhook that appears to work and then mangles a page the first time the network is slow,
 * a filter must declare a transform the host can evaluate locally, and a filter that names a
 * webhook is rejected here with the reason spelled out.
 */
function validateHooks(
  manifest: AuthorManifest,
  require: (condition: boolean, field: string, message: string) => void,
): void {
  const declaredEgress = new Set(manifest.permissions?.egressHosts ?? []);

  (manifest.hooks ?? []).forEach((hook, index) => {
    const at = `hooks[${index}]`;
    require(HOOK_NAME_PATTERN.test(hook.hook ?? ""), `${at}.hook`,
      `"${hook.hook}" is not a valid host hook name`);
    require(hook.kind === "action" || hook.kind === "filter", `${at}.kind`,
      `kind must be "action" or "filter", got "${hook.kind}"`);
    require(hook.priority === undefined || Number.isInteger(hook.priority), `${at}.priority`,
      "priority must be an integer");
    require(hook.acceptedArgs === undefined || (Number.isInteger(hook.acceptedArgs) && hook.acceptedArgs >= 0),
      `${at}.acceptedArgs`, "acceptedArgs must be a non-negative integer");

    if (hook.kind === "action") {
      require(!!hook.webhookUrl, `${at}.webhookUrl`, `kind "action" requires a webhookUrl`);
      require(!hook.transform, `${at}.transform`,
        `kind "action" cannot carry a transform - an action's return value is discarded by the host`);

      if (hook.webhookUrl) {
        let parsed: URL | undefined;
        try {
          parsed = new URL(hook.webhookUrl);
        } catch {
          require(false, `${at}.webhookUrl`, `"${hook.webhookUrl}" is not a valid absolute URL`);
        }
        if (parsed) {
          require(parsed.protocol === "https:", `${at}.webhookUrl`,
            `webhookUrl must be https:// - hook payloads carry host data`);
          require(declaredEgress.has(parsed.hostname), `${at}.webhookUrl`,
            `"${parsed.hostname}" must also be listed in permissions.egressHosts - a hook webhook ` +
            `is relayed by the platform under the same allowlist as any other outbound call`);
        }
      }
      for (const argIndex of hook.argIndexes ?? []) {
        require(Number.isInteger(argIndex) && argIndex >= 0, `${at}.argIndexes`,
          "argIndexes must be non-negative integers");
      }
      return;
    }

    if (hook.kind === "filter") {
      require(!hook.webhookUrl, `${at}.webhookUrl`,
        `kind "filter" cannot use a webhook: a WordPress filter must return a value synchronously ` +
        `and an HTTP round trip cannot. Declare a transform instead, or model this as an action ` +
        `if you do not actually need to change the value`);
      require(!!hook.transform, `${at}.transform`, `kind "filter" requires a transform`);
      require(hook.argIndexes === undefined, `${at}.argIndexes`,
        `argIndexes applies to actions only - a filter transform sees only the filtered value`);

      const transform = hook.transform;
      if (!transform) return;
      require((FILTER_TRANSFORM_KINDS as readonly string[]).includes(transform.kind), `${at}.transform.kind`,
        `transform kind must be one of ${FILTER_TRANSFORM_KINDS.join(", ")}, got "${transform.kind}"`);

      if (transform.kind === "replace") {
        const pairs = Object.entries(transform.replacements ?? {});
        require(pairs.length > 0, `${at}.transform.replacements`,
          `transform kind "replace" requires at least one search -> replacement pair`);
        for (const [search] of pairs) {
          require(search.length > 0, `${at}.transform.replacements`,
            "a replacement search string cannot be empty");
        }
      } else {
        require(typeof (transform as { text?: unknown }).text === "string", `${at}.transform.text`,
          `transform kind "${transform.kind}" requires text`);
      }
    }
  });
}

function normalize(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isSyntacticallyValidHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(host);
}
