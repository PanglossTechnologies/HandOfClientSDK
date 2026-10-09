# Browser components: request, my features, admin

Three framework-free components in `embed.js` that talk to your site's `hoc/api/*`
(`openapi/site-hoc-api.yaml`) and nothing else. Each is a custom element and a function; `HandOfClient.features.*`
makes the same calls without any UI.

| Element | Function | Does |
|---|---|---|
| `<hoc-request-feature>` | `HandOfClient.requestFeature(el, opts)` | Text box, optional "change something I already have" picker, page copy ([page snapshot](page-snapshot.md)), submit, confirmation. |
| `<hoc-my-features>` | `HandOfClient.myFeatures(el, opts)` | My requests with status and a reply box when the build asks a question; my features with versions, keep this version / follow the latest, sharing, turn off. |
| `<hoc-feature-admin>` | `HandOfClient.featureAdmin(el, opts)` | Settings (with the inject / iframe explanation), every request (status filter), every feature with roll back for everyone, data sources editor. |

```html
<script src="embed.global.js"></script>
<script>HandOfClient.configure({ apiBaseUrl: "...", embedOrigin: "...", sitePrefix: "hoc/" });</script>

<hoc-request-feature></hoc-request-feature>
<hoc-my-features></hoc-my-features>
<hoc-feature-admin></hoc-feature-admin>   <!-- the site decides who may see this page; the API answers 403 to non-admins anyway -->
```

The drop-in script registers the elements. With a bundler call `defineComponents()` once (safe to repeat).
Only `sitePrefix` is used from the config (default `hoc/`).

## Attributes and options

* All elements: `site-prefix` overrides the configured prefix. `el.refresh()` reloads their data.
* `<hoc-request-feature>`: `feature-id="..."` makes every request a change to that feature (hides the picker);
  `snapshot="off"` never captures the page. Function options: `featureId`, `snapshot` (`false`, or `captureSnapshot`
  options), `onSubmitted(request)`. The element also fires a bubbling `hoc-request-submitted` event with the stored request
  in `detail`.
* Function forms take `{ api }` to use a custom `createFeaturesApi({ sitePrefix, fetch })`, for example to add your CSRF
  header to every non-GET call. They return `{ refresh(), destroy() }`.

## Behaviour worth knowing

* Redaction is on: the request sends the default-redacted snapshot (text blanked, form values dropped). Mark public parts
  with `data-hoc-keep`, private parts with `data-hoc-skip`. If the capture itself fails the request is sent without it.
* Sharing controls show only for the owner and admins (the API returns `sharing` only to them). Whether a share is allowed is
  the site's call; its refusal text is shown.
* Roll back for everyone asks for a second confirming click first.
* The admin feature list is what the API returns for the signed-in admin ("features visible to me"), so a feature nobody has
  shared with that admin does not appear. Settings saves to the platform fail as one: you see the error and nothing is saved.
* Every list has loading, empty and error (with Try again) states. Controls are native buttons, inputs, `<details>`, so they
  work from the keyboard; status changes are announced through a live region; touch targets are at least 44 px.

## Styling

Components render in a shadow root, so page CSS does not leak in, and these custom properties set on the element (or any
ancestor) do pass through:

`--hoc-font`, `--hoc-font-size`, `--hoc-text`, `--hoc-muted`, `--hoc-surface`, `--hoc-input-bg`, `--hoc-border`, `--hoc-hover`,
`--hoc-accent`, `--hoc-accent-text`, `--hoc-focus`, `--hoc-danger`, `--hoc-danger-bg`, `--hoc-success`, `--hoc-success-bg`,
`--hoc-warn`, `--hoc-radius`, `--hoc-padding`, `--hoc-gap`.

```css
hoc-request-feature { --hoc-accent: #7c3aed; --hoc-radius: 4px; }
```

## `HandOfClient.features`

`createRequest`, `listRequests`, `replyToRequest`, `listFeatures`, `listFeatureVersions`, `pinFeatureVersion`,
`setFeatureCurrentVersion`, `shareFeature`, `unshareFeature`, `setFeatureEnabled`, `findUsers`, `getSettings`, `putSettings`
(one per operation in the OpenAPI file). Failures throw `FeaturesApiError` with `code` (the site's error code, or
`network_error` / `unexpected_response`), `status` and a user-safe `message`.
