# Page snapshots (`HandOfClient.captureSnapshot`)

Captures the rendered page as one self-contained HTML string plus metadata, so a layout-faithful copy can be
shown to an AI builder without sending the data on the page. Redaction is on by default.

```js
const snap = HandOfClient.captureSnapshot();            // redacted
const raw  = HandOfClient.captureSnapshot({ redact: false });
// bundler: import { captureSnapshot } from "@handofclient/embed-js/host";
```

Returns `{ html, url, path, title, viewport, redacted, capturedAt, stylesheets }`. `viewport` is
`{ width, height, devicePixelRatio, scrollX, scrollY }`. `stylesheets` is `{ inlined, byUrl }`: how many
sheets were inlined, and the URLs of those the browser would not let us read.

## What is captured

- The rendered DOM (so JS-built content is included), as the document looks now.
- Readable stylesheets are inlined as `<style>`: linked sheets, `<style>` elements (including rules added
  through the CSSOM), `adoptedStyleSheets`, and `@import`s. Relative `url()` references are made absolute.
- Cross-origin sheets served without CORS cannot be read; they stay as `<link rel="stylesheet" href>` with the
  absolute URL (query string kept - it names a public asset, e.g. Google Fonts families).
- A `<base>` is added so the links and images that remain resolve against the original site.

Never captured, in either mode: scripts, `noscript`, `template`, comments, inline event handlers,
`<object>`/`<embed>`, `iframe` contents (the element is kept, empty), canvas/video pixels, `http-equiv` meta,
and password / file input values. Shadow DOM contents are not captured.

## Redaction (default)

| Item | Result |
| --- | --- |
| Text nodes, `<title>`, CSS `content:` strings | every non-space character becomes `x` (same length, whitespace and wrapping preserved) |
| `value`, `placeholder`, `title`, `checked`, `selected` attributes; textarea contents | dropped |
| `alt`, `aria-label`, `aria-description`, `aria-valuetext`, `label`; `data-*` values | same-length `x` placeholder |
| Query strings and fragments on `href`, `src`, `action`, `formaction`, `poster`, `srcset` | stripped |
| Page `url` | origin + path only |
| `meta` other than `charset` and `viewport` | dropped |
| Classes, ids, tag structure, field `name`s, inline styles, CSS | kept (this is the layout) |

Note `data-*` values are redacted, so CSS that selects on a data attribute value (`[data-state=open]`) will not
match in the snapshot; wrap such markup in `data-hoc-keep` if the builder needs it.

## Per-element control (both honoured even with `redact: false` for skip)

- `data-hoc-keep` - this subtree is copied verbatim (text, values, URLs). Use for public, structural content
  such as headings and pricing. Keep is the author's explicit opt-in; it does not override `data-hoc-skip`.
- `data-hoc-skip` - this subtree is left out. An empty element of the same tag, `class` and pixel size, marked
  `data-hoc-skipped`, takes its place so surrounding layout holds.

## Turning redaction off

`captureSnapshot({ redact: false })` keeps text, current form values (typed text, checked boxes, selected
options) and full URLs. Use only for pages that hold nothing private, or on explicit user consent.
