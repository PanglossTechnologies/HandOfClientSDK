import { createHocClient } from "@handofclient/api";
import {
  Channel, FeatureKind, FilterTransformKind, HookKind, RenderMode, SlotKind, UpdatePolicyKind,
} from "@handofclient/gen-ts/handofclient/v1/package_registry_pb";
import { readFile } from "node:fs/promises";
import type { AuthorHookDecl, AuthorManifest } from "./authorManifest.js";
import { injectEntryFiles, normalizeBundlePath, validateAuthorManifest } from "./authorManifest.js";
import { fileExistsAndIsDirectory, packDirectory, scanForHygieneIssues, scanInjectEntry } from "./bundle.js";

export interface PublishOptions {
  manifestPath: string;
  bundleDir: string;
  apiBaseUrl: string;
  apiKey: string;
  /** Sent as x-hoc-host. Required when apiKey is the platform super-admin key (build automation publishing
   * on a host's behalf); ignored by the platform for a host's own key. */
  hostId?: string;
  /** Print what would happen without uploading/publishing anything. */
  dryRun?: boolean;
}

export class PublishError extends Error {}

export interface PublishedEntry {
  slotId: string;
  path: string;
  /** "sha256-<base64>" of the entry file - the value for a <script integrity=...> attribute. */
  integrity: string;
}

export interface PublishResult {
  packageId: string;
  version: string;
  render: "iframe" | "inject";
  bundleHash: string;
  entries: PublishedEntry[];
  /** False for a dry run. */
  published: boolean;
}

export async function publish(options: PublishOptions, log: (line: string) => void = console.log): Promise<PublishResult> {
  if (!(await fileExistsAndIsDirectory(options.bundleDir))) {
    throw new PublishError(`Bundle directory not found: ${options.bundleDir}`);
  }

  let manifest: AuthorManifest;
  try {
    manifest = JSON.parse(await readFile(options.manifestPath, "utf8")) as AuthorManifest;
  } catch (error) {
    throw new PublishError(`Could not read manifest ${options.manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  log(`Packing bundle from ${options.bundleDir} ...`);
  const packed = await packDirectory(options.bundleDir);
  log(`Packed ${packed.files.length} file(s), ${packed.zipBytes.length} bytes, hash ${packed.bundleHash}`);

  const bundleFileSet = new Set(packed.files.map((f) => f.relativePath));
  const validationIssues = validateAuthorManifest(manifest, bundleFileSet);
  if (validationIssues.length > 0) {
    for (const issue of validationIssues) log(`  MANIFEST ERROR [${issue.field}]: ${issue.message}`);
    throw new PublishError(`Manifest validation failed with ${validationIssues.length} issue(s)`);
  }

  const render = manifest.render === "inject" ? "inject" : "iframe";
  const sriByPath = new Map(packed.files.map((f) => [f.relativePath, f.sri]));
  const entries: PublishedEntry[] = Object.entries(manifest.entryPoints).map(([slotId, path]) => {
    const normalized = normalizeBundlePath(path);
    return { slotId, path: normalized, integrity: sriByPath.get(normalized)! };
  });

  const hygieneIssues = await scanForHygieneIssues(packed.files);
  if (render === "inject") {
    for (const file of injectEntryFiles(manifest)) {
      hygieneIssues.push(...(await scanInjectEntry(packed.files.find((f) => f.relativePath === file)!)));
    }
  }
  if (hygieneIssues.length > 0) {
    for (const issue of hygieneIssues) log(`  HYGIENE ISSUE [${issue.file}]: ${issue.message}`);
    throw new PublishError(`Bundle failed ${hygieneIssues.length} hygiene check(s) - see "Hygiene checks" in docs/plugin-author-tutorial.md`);
  }
  log("Manifest and hygiene checks passed.");
  for (const entry of entries) log(`  ${render} entry ${entry.slotId}: ${entry.path}  integrity ${entry.integrity}`);

  const result: PublishResult = {
    packageId: manifest.packageId, version: manifest.version, render, bundleHash: packed.bundleHash, entries, published: false,
  };

  if (options.dryRun) {
    log("Dry run - not uploading or publishing.");
    return result;
  }

  log("Uploading bundle ...");
  const uploadResponse = await fetch(`${options.apiBaseUrl}/host/v1/bundles`, {
    method: "POST",
    headers: { "x-api-key": options.apiKey, "content-type": "application/zip", ...(options.hostId ? { "x-hoc-host": options.hostId } : {}) },
    body: packed.zipBytes,
  });
  if (!uploadResponse.ok) {
    throw new PublishError(`Bundle upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`);
  }
  const { bundleHash: uploadedHash } = (await uploadResponse.json()) as { bundleHash: string };
  if (uploadedHash !== packed.bundleHash) {
    throw new PublishError(`Server-reported hash ${uploadedHash} does not match locally computed hash ${packed.bundleHash}`);
  }
  log(`Bundle uploaded, confirmed hash ${uploadedHash}.`);

  const client = createHocClient({ baseUrl: options.apiBaseUrl, apiKey: options.apiKey, onBehalfOfHost: options.hostId });
  const fileIntegrity: Record<string, string> = {};
  for (const file of packed.files) fileIntegrity[file.relativePath] = file.sri;

  log(`Publishing ${manifest.packageId}@${manifest.version} ...`);
  let response;
  try {
    response = await client.packageRegistry.publishVersion({
      bundleUploadRef: uploadedHash,
      manifest: toProtoManifest(manifest, uploadedHash, fileIntegrity),
    });
  } catch (error) {
    // ConnectError messages already read "[code] detail" (e.g. "[already_exists] ... is already published").
    throw new PublishError(`PublishVersion failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // The platform records its own sha256 SRI for every inject entry point. It hashes the same bytes we
  // did, so a difference means the stored bundle is not what we packed - do not report success.
  if (render === "inject") {
    const recorded = response.version?.manifest?.bundle?.fileIntegrity ?? {};
    for (const entry of entries) {
      const platformValue = recorded[entry.path];
      if (platformValue !== undefined && platformValue !== entry.integrity) {
        throw new PublishError(`Published, but the platform recorded integrity ${platformValue} for ${entry.path} while the local file hashes to ${entry.integrity}`);
      }
    }
  }
  log("Published.");
  return { ...result, published: true };
}

function toProtoTransform(transform: AuthorHookDecl["transform"]) {
  if (!transform) return undefined;
  const kind = {
    append: FilterTransformKind.APPEND,
    prepend: FilterTransformKind.PREPEND,
    replace: FilterTransformKind.REPLACE,
    const: FilterTransformKind.CONST,
  }[transform.kind];
  return {
    kind,
    text: transform.kind === "replace" ? "" : transform.text,
    replacements: transform.kind === "replace" ? transform.replacements : {},
  };
}

function toProtoManifest(manifest: AuthorManifest, bundleHash: string, fileIntegrity: Record<string, string>) {
  return {
    manifestVersion: 1,
    packageId: manifest.packageId,
    publisher: manifest.publisher,
    name: manifest.name,
    description: manifest.description ?? "",
    version: manifest.version,
    hostId: manifest.hostId,
    tenantKey: manifest.tenantKey ?? "",
    bundle: {
      entryPoints: manifest.entryPoints,
      bundleHash,
      fileIntegrity,
    },
    slots: manifest.slots.map((slot) => ({
      slotId: slot.slotId,
      kind: { page: SlotKind.PAGE, override: SlotKind.OVERRIDE, panel: SlotKind.PANEL }[slot.kind],
      title: slot.title ?? "",
      showInNav: slot.showInNav ?? false,
      defaultEnabled: slot.defaultEnabled ?? true,
      targetPath: slot.targetPath ?? "",
      matchPath: slot.matchPath ?? "",
      aliasGroupKey: slot.aliasGroupKey ?? "",
      hostPanelId: slot.hostPanelId ?? "",
    })),
    hooks: (manifest.hooks ?? []).map((hook) => ({
      hook: hook.hook,
      kind: hook.kind === "filter" ? HookKind.FILTER : HookKind.ACTION,
      priority: hook.priority ?? 0,
      acceptedArgs: hook.acceptedArgs ?? 0,
      webhookUrl: hook.webhookUrl ?? "",
      argIndexes: hook.argIndexes ?? [],
      transform: toProtoTransform(hook.transform),
    })),
    permissions: {
      scopes: manifest.permissions?.scopes ?? [],
      egressHosts: manifest.permissions?.egressHosts ?? [],
    },
    entitlement: {
      requiredFeatures: manifest.entitlement?.requiredFeatures ?? [],
    },
    updatePolicy: {
      kind: manifest.updatePolicy?.kind === "channel" ? UpdatePolicyKind.CHANNEL : UpdatePolicyKind.PINNED,
      channel: manifest.updatePolicy?.kind === "channel" && manifest.updatePolicy.channel === "beta" ? Channel.BETA : Channel.STABLE,
    },
    strictCsp: manifest.strictCsp ?? false,
    render: manifest.render === "inject" ? RenderMode.INJECT : RenderMode.IFRAME,
    kind: { slot: FeatureKind.SLOT, "page-override": FeatureKind.PAGE_OVERRIDE, "new-page": FeatureKind.NEW_PAGE }[manifest.kind ?? "slot"],
    path: manifest.path ?? "",
  };
}
