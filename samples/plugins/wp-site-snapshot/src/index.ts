import { hoc } from "@handofclient/embed-js/plugin";

/**
 * Site Snapshot - the reference plugin for the WordPress host adapter.
 *
 * The interesting part is not the chart, it is the request path. A plugin bundle cannot fetch the
 * WordPress site directly: the CSP the platform serves with every bundle pins connect-src to the
 * Platform API, which is what forces all egress through EgressProxy. So a call to the host's own data
 * API travels:
 *
 *   this bundle -> hoc.http.send -> EgressProxy (allowlist + SSRF checks + audit) -> WordPress
 *
 * and authenticates with the reserved {{hoc:token}} placeholder, which the proxy replaces with this
 * caller's own already-validated embed token. The bundle never holds a credential, and WordPress ends
 * up running the query as the real logged-in user with their real capabilities.
 */

/** handofclient.v1.HttpMethod.HTTP_METHOD_GET */
const HTTP_GET = 1;

interface SiteSummary {
  name: string;
  url: string;
  wpVersion: string;
  theme: { name: string; version: string };
  counts: {
    posts: number;
    pages: number;
    commentsApproved: number;
    commentsPending: number;
    users: number;
  };
  hasWoo: boolean;
}

interface MonthCount {
  month: string;
  count: number;
}

interface RecentComment {
  id: number;
  postTitle: string;
  author: string;
  date: string;
  excerpt: string;
}

const decoder = new TextDecoder();

/**
 * Runs one named query against the host's data API.
 *
 * Every failure mode is distinguished here rather than collapsed into "something went wrong",
 * because the three that actually happen have three completely different fixes: the site owner has
 * not allowlisted their own domain, the user lacks the capability the query requires, or the query
 * name is wrong.
 */
async function query<T>(restBase: string, name: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${restBase.replace(/\/$/, "")}/q/${name}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await hoc.http.send({
    method: HTTP_GET,
    url: url.toString(),
    headers: [
      // Substituted server-side by EgressProxy. The literal string is what ships in the bundle.
      { name: "Authorization", value: "Bearer {{hoc:token}}" },
      // Fallback for Apache/CGI hosts that strip Authorization - see HOC_REST::extract_bearer_token.
      { name: "X-HOC-Token", value: "{{hoc:token}}" },
    ],
    timeoutMs: 10_000,
  });

  const text = decoder.decode(response.body);

  if (response.statusCode === 403) {
    throw new Error(`Your WordPress account does not have permission to run "${name}".`);
  }
  if (response.statusCode === 404) {
    throw new Error(`This site's HandOfClient plugin does not offer the query "${name}".`);
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Query "${name}" failed (HTTP ${response.statusCode}): ${text.slice(0, 200)}`);
  }

  return JSON.parse(text).data as T;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statCard(label: string, value: number | string): HTMLElement {
  const card = el("div", "card");
  card.appendChild(el("div", "card-value", String(value)));
  card.appendChild(el("div", "card-label", label));
  return card;
}

/**
 * A plain SVG bar chart. No charting library: the bundle is served with script-src 'self' and there
 * is no CDN to load one from, and inlining a full charting library into a bundle for one bar chart
 * would be several hundred kilobytes for something forty lines of SVG does.
 */
function barChart(rows: MonthCount[]): HTMLElement {
  const wrapper = el("div", "chart");

  if (rows.length === 0) {
    wrapper.appendChild(el("p", "empty", "No posts published in this period."));
    return wrapper;
  }

  const width = 640;
  const height = 200;
  const padding = { top: 12, right: 12, bottom: 28, left: 32 };
  const max = Math.max(...rows.map((r) => r.count), 1);
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const barWidth = plotWidth / rows.length;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Posts published per month, maximum ${max}`);

  rows.forEach((row, index) => {
    const barHeight = (row.count / max) * plotHeight;
    const x = padding.left + index * barWidth;
    const y = padding.top + plotHeight - barHeight;

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(x + barWidth * 0.15));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(barWidth * 0.7));
    rect.setAttribute("height", String(Math.max(barHeight, row.count > 0 ? 2 : 0)));
    rect.setAttribute("fill", "var(--hoc-accent-color, #2271b1)");
    rect.setAttribute("rx", "2");

    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${row.month}: ${row.count}`;
    rect.appendChild(title);
    svg.appendChild(rect);

    // Only every other label below ~12 months, or they overlap into mush.
    if (rows.length <= 12 || index % 2 === 0) {
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", String(x + barWidth / 2));
      label.setAttribute("y", String(height - 8));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("font-size", "10");
      label.setAttribute("fill", "currentColor");
      label.textContent = row.month.slice(2);
      svg.appendChild(label);
    }
  });

  wrapper.appendChild(svg);
  return wrapper;
}

await hoc.init(async (context) => {
  const root = document.getElementById("root")!;
  root.textContent = "";

  const restBase = context.launchParams.restBase;
  if (!restBase) {
    throw new Error(
      "This plugin needs the host to supply a restBase launch parameter. It is designed for the WordPress host adapter.",
    );
  }

  root.appendChild(el("h1", "title", context.launchParams.siteName || "Site Snapshot"));

  const status = el("p", "status", "Reading site data...");
  root.appendChild(status);

  try {
    // Sequential, not Promise.all: EgressProxy applies a per-tenant rate limit, and three
    // simultaneous calls from one panel is exactly the burst it exists to shape.
    const summary = await query<SiteSummary>(restBase, "site.summary");
    const months = await query<MonthCount[]>(restBase, "posts.count-by-month", { months: "12" });
    const comments = await query<RecentComment[]>(restBase, "comments.recent", { limit: "5" }).catch(
      // Recent comments need moderate_comments; an editor without it should still see the rest of
      // the page rather than an error in place of everything.
      () => null,
    );

    status.remove();

    const cards = el("div", "cards");
    cards.appendChild(statCard("Posts", summary.counts.posts));
    cards.appendChild(statCard("Pages", summary.counts.pages));
    cards.appendChild(statCard("Comments", summary.counts.commentsApproved));
    cards.appendChild(statCard("Pending", summary.counts.commentsPending));
    cards.appendChild(statCard("Users", summary.counts.users));
    root.appendChild(cards);

    root.appendChild(el("h2", undefined, "Posts published, last 12 months"));
    root.appendChild(barChart(months));

    if (comments && comments.length > 0) {
      root.appendChild(el("h2", undefined, "Recent comments"));
      const list = el("ul", "comments");
      for (const comment of comments) {
        const item = el("li");
        item.appendChild(el("strong", undefined, comment.author));
        item.appendChild(document.createTextNode(` on ${comment.postTitle}`));
        item.appendChild(el("div", "excerpt", comment.excerpt));
        list.appendChild(item);
      }
      root.appendChild(list);
    }

    const footer = el(
      "p",
      "footer",
      `WordPress ${summary.wpVersion} - theme ${summary.theme.name} ${summary.theme.version}${
        summary.hasWoo ? " - WooCommerce detected" : ""
      }`,
    );
    root.appendChild(footer);
  } catch (error) {
    status.remove();
    const box = el("div", "error");
    box.appendChild(el("strong", undefined, "Could not read this site's data."));
    box.appendChild(el("p", undefined, (error as Error).message));
    box.appendChild(
      el(
        "p",
        "hint",
        "If this is the first run: in WordPress, go to HandOfClient > Settings and tick \"Also allow this site itself\" under the outbound allowlist.",
      ),
    );
    root.appendChild(box);
  }

  hoc.resizeAuto(root);
});
