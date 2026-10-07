import { createHocClient } from "@handofclient/api";
import {
  Channel, FilterTransformKind, HookKind, SlotKind, UpdatePolicyKind,
} from "@handofclient/gen-ts/handofclient/v1/package_registry_pb";
import { readFile } from "node:fs/promises";
import type { AuthorHookDecl, AuthorManifest } from "./authorManifest.js";
import { validateAuthorManifest } from "./authorManifest.js";
import { fileExistsAndIsDirectory, packDirectory, scanForHygieneIssues } from "./bundle.js";

export interface PublishOptions {
  manifestPath: string;
  bundleDir: string;
  apiBaseUrl: string;
  apiKey: string;
  /** Print what would happen without uploading/publishing anything. */
  dryRun?: boolean;
}

export class PublishError extends Error {}

export async function publish(options: PublishOptions, log: (line: string) => void = console.log): Promise<void> {
  if (!(await fileExistsAndIsDirectory(options.bundleDir))) {
    throw new PublishError(`Bundle directory not found: ${options.bundleDir}`);
  }

  const manifest = JSON.parse(await readFile(options.manifestPath, "utf8")) as AuthorManifest;

  log(`Packing bundle from ${options.bundleDir} ...`);
  const packed = await packDirectory(options.bundleDir);
  log(`Packed ${packed.files.length} file(s), ${packed.zipBytes.length} bytes, hash ${packed.bundleHash}`);

  const bundleFileSet = new Set(packed.files.map((f) => f.relativePath));
  const validationIssues = validateAuthorManifest(manifest, bundleFileSet);
  if (validationIssues.length > 0) {
    for (const issue of validationIssues) log(`  MANIFEST ERROR [${issue.field}]: ${issue.message}`);
    throw new PublishError(`Manifest validation failed with ${validationIssues.length} issue(s)`);
  }

  const hygieneIssues = await scanForHygieneIssues(packed.files);
  if (hygieneIssues.length > 0) {
    for (const issue of hygieneIssues) log(`  HYGIENE ISSUE [${issue.file}]: ${issue.message}`);
    throw new PublishError(`Bundle failed ${hygieneIssues.length} hygiene check(s) - see design doc "6. Relationship to DotNetShared.Extensibility"`);
  }
  log("Manifest and hygiene checks passed.");

  if (options.dryRun) {
    log("Dry run - not uploading or publishing.");
    return;
  }

  log("Uploading bundle ...");
  const uploadResponse = await fetch(`${options.apiBaseUrl}/internal/bundles`, {
    method: "POST",
    headers: { "x-api-key": options.apiKey, "content-type": "application/zip" },
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

  const client = createHocClient({ baseUrl: options.apiBaseUrl, apiKey: options.apiKey });
  const fileIntegrity: Record<string, string> = {};
  for (const file of packed.files) fileIntegrity[file.relativePath] = file.sri;

  log(`Publishing ${manifest.packageId}@${manifest.version} ...`);
  await client.packageRegistry.publishVersion({
    bundleUploadRef: uploadedHash,
    manifest: toProtoManifest(manifest, uploadedHash, fileIntegrity),
  });
  log("Published.");
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
  };
}
