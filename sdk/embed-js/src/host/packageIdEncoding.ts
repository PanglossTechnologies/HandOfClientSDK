/**
 * Mirrors services/platform/HandOfClient.Platform/Bundles/BundleEndpoints.cs's EncodePackageId exactly
 * - packageId contains a literal "/" (design doc's own example: "acme/wms-labels"), which cannot
 * survive as a single ASP.NET route segment. Both sides must produce byte-identical output; this is
 * the one place that requirement is load-bearing (a mismatch here 404s every embed).
 */
export function encodePackageId(packageId: string): string {
  const bytes = new TextEncoder().encode(packageId);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
