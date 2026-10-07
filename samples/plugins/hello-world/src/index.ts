import { hoc } from "@handofclient/embed-js/plugin";

const root = document.getElementById("root")!;

function applyTheme(theme: { fontFamily: string; textColor: string; backgroundColor: string; accentColor: string }): void {
  const style = document.documentElement.style;
  style.setProperty("--hoc-font-family", theme.fontFamily);
  style.setProperty("--hoc-text-color", theme.textColor);
  style.setProperty("--hoc-background-color", theme.backgroundColor);
  style.setProperty("--hoc-accent-color", theme.accentColor);
}

await hoc.init(async (context) => {
  applyTheme(context.theme);

  // hoc.storage: a per-{host,tenant,package} KV store the plugin author never has to run any
  // infrastructure for - see docs/postmessage-protocol.md 5.2 (apiBaseUrl) and the design doc's
  // TenantStorage section. Used here just to prove a real round trip, not because a visit counter is
  // interesting on its own.
  const stored = await hoc.storage.get("visit-count");
  const count = stored.found ? Number(new TextDecoder().decode(stored.value)) + 1 : 1;
  await hoc.storage.set("visit-count", new TextEncoder().encode(String(count)));

  root.innerHTML = `
    <h1 style="margin-top: 0">Hello, ${escapeHtml(context.user.displayName ?? context.user.userId)}!</h1>
    <p>Host: <code>${escapeHtml(context.hostId)}</code> &middot; Tenant: <code>${escapeHtml(context.tenantId)}</code></p>
    <p>This panel has been opened <strong>${count}</strong> time(s) for this tenant (via hoc.storage).</p>
    <button id="toast-btn" type="button">Say hello (hoc.ui.toast)</button>
  `;

  document.getElementById("toast-btn")!.addEventListener("click", () => {
    void hoc.ui.toast(`Hello from packageId ${context.packageId}!`);
  });

  // Must run after root has real content - see hoc.resizeAuto's own doc: it observes rootElement via
  // ResizeObserver and coalesces hoc:resize to one message per animation frame.
  hoc.resizeAuto(root);
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
