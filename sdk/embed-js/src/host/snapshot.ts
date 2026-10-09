/**
 * Page snapshot capture: the rendered DOM of the current page as one self-contained HTML string, with
 * readable stylesheets inlined and (by default) all user content redacted, so a layout-faithful copy of
 * the page can be sent to an AI builder without sending the data on it. See docs/page-snapshot.md.
 *
 * Redaction is structural, not a regex pass over the HTML: the snapshot is built node by node into an
 * inert document, so nothing is copied unless a rule here copies it.
 */

export interface SnapshotOptions {
  /** Default true. false keeps text, form values and URLs as they are (still never captures scripts,
   * comments or password values, and still honours `data-hoc-skip`). */
  redact?: boolean;
  /** Document to capture. Default: the global `document`. */
  document?: Document;
}

export interface PageSnapshot {
  /** `<!doctype html>` plus the serialized document. */
  html: string;
  /** Page URL; with redaction on: origin + path only (no query string or fragment). */
  url: string;
  path: string;
  /** With redaction on: same-length placeholder text. */
  title: string;
  viewport: { width: number; height: number; devicePixelRatio: number; scrollX: number; scrollY: number };
  redacted: boolean;
  capturedAt: string;
  stylesheets: {
    /** Stylesheets (and `<style>` elements, adopted sheets) emitted as inline `<style>`. */
    inlined: number;
    /** Stylesheets the browser would not let us read (cross-origin without CORS); left as `<link href>`. */
    byUrl: string[];
  };
}

/** Subtree is kept verbatim (no text/value redaction) while redaction is on elsewhere. */
export const KEEP_ATTRIBUTE = "data-hoc-keep";
/** Subtree is omitted entirely (an empty same-size placeholder element is left so layout holds). */
export const SKIP_ATTRIBUTE = "data-hoc-skip";

const DROP_ELEMENTS = new Set(["script", "noscript", "template", "base", "object", "embed", "applet", "frame", "frameset"]);
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "cite", "xlink:href"]);
/** Attributes that carry human-readable text: replaced by a same-length placeholder when redacting. */
const TEXT_ATTRIBUTES = new Set(["alt", "aria-label", "aria-description", "aria-valuetext", "aria-placeholder", "label"]);
/** Attributes dropped entirely when redacting (spec: value/placeholder/title). */
const DROPPED_WHEN_REDACTING = new Set(["value", "placeholder", "title", "checked", "selected"]);
const ALWAYS_DROPPED_ATTRIBUTES = new Set(["srcdoc", "nonce", "integrity", "crossorigin"]);

interface State {
  redact: boolean;
}

/** Every non-whitespace character becomes "x": same length, whitespace (and so wrapping) preserved. */
export function placeholder(text: string): string {
  return text.replace(/\S/g, "x");
}

function stripUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("#") || trimmed.toLowerCase().startsWith("data:") || trimmed.toLowerCase().startsWith("javascript:")) {
    return trimmed.toLowerCase().startsWith("javascript:") ? "" : trimmed;
  }
  const cut = trimmed.search(/[?#]/);
  return cut === -1 ? trimmed : trimmed.slice(0, cut);
}

function stripSrcset(value: string): string {
  return value
    .split(",")
    .map((candidate) => {
      const [url, ...descriptor] = candidate.trim().split(/\s+/);
      return [stripUrl(url ?? ""), ...descriptor].join(" ").trim();
    })
    .filter(Boolean)
    .join(", ");
}

/** Rewrites relative `url(...)` references in inlined CSS so they still resolve once the sheet no longer
 * lives at its own URL. */
function absolutizeCssUrls(css: string, base: string | null): string {
  if (!base) return css;
  return css.replace(/url\(\s*(["']?)([^"')]+?)\1\s*\)/gi, (whole, quote: string, raw: string) => {
    if (/^(data:|#|about:|[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) return whole;
    try {
      return `url(${quote}${new URL(raw, base).href}${quote})`;
    } catch {
      return whole;
    }
  });
}

/** `content: "text"` strings in CSS are page text too. */
function redactCssStrings(css: string): string {
  return css.replace(/(content\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi, (_, head: string, literal: string) => {
    const quote = literal[0];
    return `${head}${quote}${placeholder(literal.slice(1, -1))}${quote}`;
  });
}

/** CSS text of a sheet with imports flattened, or null if the browser blocks reading its rules. */
function sheetCss(sheet: CSSStyleSheet, depth = 0): string | null {
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    return null;
  }
  const parts: string[] = [];
  for (const rule of Array.from(rules)) {
    const imported = (rule as CSSImportRule).styleSheet;
    if (imported !== undefined && "href" in rule) {
      const inner = depth < 5 && imported ? sheetCss(imported, depth + 1) : null;
      if (inner !== null) {
        const media = (rule as CSSImportRule).media?.mediaText;
        parts.push(media && media !== "all" ? `@media ${media}{${inner}}` : inner);
        continue;
      }
    }
    parts.push(rule.cssText);
  }
  return absolutizeCssUrls(parts.join("\n"), sheet.href);
}

interface Context {
  source: Document;
  target: Document;
  inlined: number;
  byUrl: string[];
}

function sanitizeAttributes(live: Element, out: Element, state: State): void {
  for (const attr of Array.from(out.attributes)) {
    const name = attr.name.toLowerCase();
    const drop = () => out.removeAttribute(attr.name);
    if (name.startsWith("on") || ALWAYS_DROPPED_ATTRIBUTES.has(name)) {
      drop();
      continue;
    }
    if (!state.redact) continue;
    if (DROPPED_WHEN_REDACTING.has(name)) {
      drop();
    } else if (name === "srcset" || name === "imagesrcset") {
      out.setAttribute(attr.name, stripSrcset(attr.value));
    } else if (URL_ATTRIBUTES.has(name)) {
      out.setAttribute(attr.name, stripUrl(attr.value));
    } else if (TEXT_ATTRIBUTES.has(name)) {
      out.setAttribute(attr.name, placeholder(attr.value));
    } else if (name.startsWith("data-") && !name.startsWith("data-hoc-")) {
      out.setAttribute(attr.name, placeholder(attr.value));
    }
  }
}

/** Current (not default) form state - the DOM attributes only hold the defaults. */
function syncFormState(live: Element, out: Element, state: State): void {
  const tag = live.localName;
  if (tag === "input") {
    const input = live as HTMLInputElement;
    const type = (input.type || "text").toLowerCase();
    if (type === "password" || type === "file") {
      out.removeAttribute("value");
      out.removeAttribute("checked");
      return;
    }
    if (state.redact) return; // attributes already dropped by sanitizeAttributes
    if (type === "checkbox" || type === "radio") {
      if (input.checked) out.setAttribute("checked", "");
      else out.removeAttribute("checked");
    } else {
      out.setAttribute("value", input.value);
    }
  } else if (tag === "option" && !state.redact) {
    if ((live as HTMLOptionElement).selected) out.setAttribute("selected", "");
    else out.removeAttribute("selected");
  }
}

function emitStyle(ctx: Context, css: string, state: State, attrs: Record<string, string>): Element {
  const style = ctx.target.createElement("style");
  for (const [key, value] of Object.entries(attrs)) if (value) style.setAttribute(key, value);
  style.textContent = state.redact ? redactCssStrings(css) : css;
  ctx.inlined++;
  return style;
}

function copyNode(live: Node, ctx: Context, state: State): Node | null {
  if (live.nodeType === Node.TEXT_NODE) {
    const text = live.nodeValue ?? "";
    return ctx.target.createTextNode(state.redact ? placeholder(text) : text);
  }
  if (live.nodeType !== Node.ELEMENT_NODE) return null; // comments, processing instructions

  const el = live as Element;
  const tag = el.localName;
  if (el.hasAttribute(SKIP_ATTRIBUTE)) return skipPlaceholder(el, ctx);
  if (DROP_ELEMENTS.has(tag)) return null;
  if (el.id === "hoc-hide") return null; // hoc-head.js's body hider, not page content

  if (tag === "style") {
    const sheet = (el as HTMLStyleElement).sheet;
    if (sheet?.disabled) return null;
    const css = sheet ? sheetCss(sheet) : null;
    return emitStyle(ctx, css ?? el.textContent ?? "", state, { media: el.getAttribute("media") ?? "" });
  }
  if (tag === "link") {
    const rel = (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("stylesheet")) return null;
    const link = el as HTMLLinkElement;
    if (link.sheet?.disabled || link.disabled) return null;
    const css = link.sheet ? sheetCss(link.sheet) : null;
    if (css !== null) {
      return emitStyle(ctx, css, state, { media: el.getAttribute("media") ?? "", "data-hoc-inlined-from": state.redact ? stripUrl(link.href) : link.href });
    }
    // Unreadable: reference by absolute URL. The query string is kept on purpose - a stylesheet URL names
    // a public asset (Google Fonts selects families in its query), not user data.
    ctx.byUrl.push(link.href);
    const out = ctx.target.createElement("link");
    out.setAttribute("rel", "stylesheet");
    out.setAttribute("href", link.href);
    if (el.getAttribute("media")) out.setAttribute("media", el.getAttribute("media")!);
    return out;
  }
  if (tag === "meta") {
    const httpEquiv = el.getAttribute("http-equiv");
    const name = (el.getAttribute("name") ?? "").toLowerCase();
    if (httpEquiv) return null; // refresh / CSP would act on the copy
    if (state.redact && !el.hasAttribute("charset") && name !== "viewport") return null;
  }

  const kept = el.hasAttribute(KEEP_ATTRIBUTE);
  const childState: State = kept ? { redact: false } : state;
  const out = ctx.target.importNode(el, false) as Element;
  sanitizeAttributes(el, out, childState);
  syncFormState(el, out, childState);

  if (tag === "iframe") return out; // contents are another document; not captured
  if (tag === "textarea") {
    const value = (el as HTMLTextAreaElement).value;
    if (!childState.redact && value) out.textContent = value;
    return out;
  }
  if (tag === "canvas" || tag === "video" || tag === "audio") return out;

  for (const child of Array.from(el.childNodes)) {
    const copied = copyNode(child, ctx, childState);
    if (copied) out.appendChild(copied);
  }
  return out;
}

/** An empty element of the same tag and size, so layout around a skipped subtree is unchanged. */
function skipPlaceholder(el: Element, ctx: Context): Element {
  const out = ctx.target.createElement(el.localName);
  const cls = el.getAttribute("class");
  if (cls) out.setAttribute("class", cls);
  const rect = el.getBoundingClientRect();
  out.setAttribute("style", `width:${Math.round(rect.width)}px;height:${Math.round(rect.height)}px`);
  out.setAttribute("data-hoc-skipped", "");
  return out;
}

export function captureSnapshot(options: SnapshotOptions = {}): PageSnapshot {
  const source = options.document ?? document;
  const redact = options.redact ?? true;
  const win = source.defaultView ?? window;
  const target = source.implementation.createHTMLDocument("");
  const ctx: Context = { source, target, inlined: 0, byUrl: [] };
  const state: State = { redact };

  const html = copyNode(source.documentElement, ctx, state) as Element;
  const head = html.querySelector("head") ?? html.insertBefore(target.createElement("head"), html.firstChild);

  // <base> so relative references that survive (links, images) still point at the original site.
  const base = target.createElement("base");
  base.setAttribute("href", redact ? stripUrl(source.baseURI) : source.baseURI);
  head.insertBefore(base, head.firstChild);

  // Constructed stylesheets (document.adoptedStyleSheets) live outside the DOM.
  for (const sheet of source.adoptedStyleSheets ?? []) {
    const css = sheetCss(sheet);
    if (css !== null) head.appendChild(emitStyle(ctx, css, state, { "data-hoc-adopted": "" }));
  }

  const location = win.location;
  const title = source.title ?? "";
  return {
    html: `<!doctype html>${html.outerHTML}`,
    url: redact ? `${location.origin}${location.pathname}` : location.href,
    path: location.pathname,
    title: redact ? placeholder(title) : title,
    viewport: {
      width: win.innerWidth,
      height: win.innerHeight,
      devicePixelRatio: win.devicePixelRatio,
      scrollX: Math.round(win.scrollX),
      scrollY: Math.round(win.scrollY),
    },
    redacted: redact,
    capturedAt: new Date().toISOString(),
    stylesheets: { inlined: ctx.inlined, byUrl: ctx.byUrl },
  };
}
