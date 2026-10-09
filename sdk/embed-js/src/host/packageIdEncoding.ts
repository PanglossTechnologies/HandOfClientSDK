/**
 * Mirrors the platform's bundle-route packageId encoding exactly (unpadded base64url of the UTF-8 bytes)
 * - packageId contains a literal "/" (for example "acme/wms-labels"), which cannot
 * survive as a single URL path segment. Both sides must produce byte-identical output; this is
 * the one place that requirement is load-bearing (a mismatch here 404s every embed).
 */
export function encodePackageId(packageId: string): string {
  const bytes = new TextEncoder().encode(packageId);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
