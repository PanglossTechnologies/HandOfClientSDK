import { hoc } from "@handofclient/embed-js/plugin";

const root = document.getElementById("root")!;

interface VendorSpendRow {
  vendor: string;
  total: number;
  orders: number;
}

function applyTheme(theme: { fontFamily: string; textColor: string; backgroundColor: string; accentColor: string }): void {
  const style = document.documentElement.style;
  style.setProperty("--hoc-font-family", theme.fontFamily);
  style.setProperty("--hoc-text-color", theme.textColor);
  style.setProperty("--hoc-background-color", theme.backgroundColor);
  style.setProperty("--hoc-accent-color", theme.accentColor);
}

function formatCurrency(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

// This plugin has no storage/egress permissions (see manifest.json) - it is deliberately a pure,
// read-only rendering of data the host computes server-side and hands over once via launchParams at
// mount time (see docs/postmessage-protocol.md's InitPayload.launchParams). This sidesteps a real,
// still-open design gap found while building this (task E4): there is no sanctioned way for a plugin
// to call the HOST's own business-data API directly - the served CSP's connect-src is pinned to the
// platform API origin only, and the embed JWT's audience is the platform, not the host's API, so a raw
// cross-origin fetch to warehouse's own /api/v1 would be blocked and wouldn't validate there anyway.
// launchParams (host computes at token-mint time, before the iframe even loads) is the correct v1
// shape for a read-only "dashboard/report" customization; a live/refreshable data bridge is a real
// follow-up design question, not something this plugin needed to solve.
await hoc.init(async (context) => {
  applyTheme(context.theme);

  let rows: VendorSpendRow[] = [];
  try {
    rows = JSON.parse(context.launchParams.vendorSpendJson ?? "[]");
  } catch {
    rows = [];
  }

  if (rows.length === 0) {
    root.innerHTML = `
      <h2>Vendor Spend</h2>
      <p class="empty">No purchase-order data yet for this tenant.</p>
    `;
    hoc.resizeAuto(root);
    return;
  }

  const maxTotal = Math.max(...rows.map((r) => r.total));
  const bars = rows
    .map((r) => {
      const pct = maxTotal > 0 ? (r.total / maxTotal) * 100 : 0;
      return `
        <div class="bar-row">
          <div class="bar-label" title="${escapeHtml(r.vendor)}">${escapeHtml(r.vendor)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
          <div class="bar-value">${formatCurrency(r.total)}<span class="bar-meta">${r.orders} order${r.orders === 1 ? "" : "s"}</span></div>
        </div>`;
    })
    .join("");

  root.innerHTML = `
    <h2>Vendor Spend</h2>
    <p class="subtitle">Total purchase-order spend by vendor (excludes draft/cancelled orders)</p>
    ${bars}
  `;

  // Must run after root has real content - see hoc.resizeAuto's own doc.
  hoc.resizeAuto(root);
});
