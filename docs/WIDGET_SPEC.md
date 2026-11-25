# WidgetBoard Widget Specification

**Status:** v1 draft · **Widget API:** 1 · **Manifest `schema_version`:** 1

This is the contract between three parties:

| Party | Owns |
|---|---|
| **WidgetBoard** (the host) | Authentication, the admin board, the dashboard, layout persistence, widget installation, the runtime that loads widgets, and every platform capability a widget can use. |
| **This repository** (the marketplace) | The package and manifest standard, the registry, the contribution workflow and the automated checks. |
| **A widget** | Its interface, styling, data logic, external API integrations, settings and cleanup. |

A widget is an independent package. It never imports WidgetBoard internals; it talks to the host only through the `ctx` object described in section 6.

Words in capitals (MUST, MUST NOT, SHOULD) are requirements. Sections marked *verified* were tested in a real browser while writing this document (the tests are described in section 8). Anything not marked verified is a design requirement that has not been built yet.

---

## 1. Package format

A package is a folder with a `manifest.json` and the files it references.

```
widgets/<namespace>/<name>/
├── manifest.json     required
├── widget.js         the entry module named by manifest.entry
├── widget.css        optional, manifest.styles
└── assets/…          optional images, fonts
```

Rules (enforced by `tools/validate.mjs`, and again by the installer):

| Rule | Value |
|---|---|
| Files per package | at most 25 |
| Size of one file | at most 1 MiB, and not empty |
| Total size | at most 3 MiB |
| File types | `.json .js .css .svg .png .jpg .webp .woff2 .md .txt` |
| File names | lower-case letters, digits, `.` `_` `-`; segments never start with `.`; `/` separates folders |
| Not allowed | symbolic links, hidden files or folders, archives, HTML, anything that is not listed above |
| Dependencies | none to fetch. Libraries a widget needs are bundled into its own files. No `import` of a URL, no `node_modules`, no host paths. |

A package is a fixed list of files, not an archive. The installer downloads each file individually, so there is no extraction step and no archive-path attacks to defend against.

### Identity

`id` is `<namespace>.<name>`, for example `alice.weather`.

- The **namespace** is the publisher's GitHub username in lower case. It is also the folder name under `widgets/`, and the marketplace's code-owner rules give that folder to that user.
- `core`, `wb` and `widgetboard` are reserved and can never be published. `core.*` is for widgets built into WidgetBoard. `example` is only valid inside `examples/`.
- The id is permanent. Renaming a widget is publishing a new widget.

---

## 2. Manifest

`manifest.json` is validated by [`schema/manifest.schema.json`](../schema/manifest.schema.json). Unknown fields are rejected so typos fail early. A complete example is [`examples/hello-clock`](../examples/hello-clock/manifest.json).

| Field | Required | Meaning |
|---|---|---|
| `schema_version` | yes | Always `1`. |
| `id` | yes | See above. |
| `name`, `description`, `author`, `license` | yes | Shown in the marketplace. `license` is an SPDX-style identifier such as `MIT`. |
| `version` | yes | `MAJOR.MINOR.PATCH`. No pre-release or build suffixes in v1. |
| `category` | yes | One of `finance markets weather time productivity system media home news utilities other`. Category is metadata, not a folder, so it can change without changing the id. |
| `requires.api` | yes | The Widget API major version the widget was written for (section 10). |
| `requires.min_widgetboard` | no | Oldest WidgetBoard release that works. |
| `entry` | yes | Path of the entry module (`.js`). |
| `styles` | no | Path of a stylesheet (`.css`). |
| `size.default` | yes | `[columns, rows]` when first placed. |
| `size.min`, `size.max` | no | Limits in cells. Defaults: `[1, 1]` and the whole grid. |
| `refresh.default`, `refresh.min` | no | Milliseconds, 1000 to 86400000. Omit `refresh` entirely for a widget that never needs scheduled refreshes. |
| `settings` | no | The widget's options (section 7). At most 20. |
| `elements` | no | Named parts whose visibility the user can set (section 6.3). |
| `permissions.network` | no | HTTPS hosts the widget may reach (section 9). |
| `aliases` | no | Legacy card type names this widget also answers to (section 10.3). |
| `tags`, `homepage` | no | Marketplace search metadata. |

Rules that a JSON Schema cannot express, enforced by `tools/validate.mjs` and required of the installer:

1. `size.min ≤ size.default ≤ size.max` on both axes.
2. `refresh.default ≥ refresh.min` when both are present.
3. A `select` or `combobox` default MUST be one of its options (a `combobox` with `allowCustom` not set to `false` may use any value). Option values are unique.
4. A `number` default MUST lie within its `min`..`max`; a text default MUST NOT exceed its `maxLength`.
5. `id` MUST equal the package's folder (`widgets/<namespace>/<name>`).
6. `entry` and `styles` MUST exist in the package.
7. Element keys are unique.
8. An alias MUST NOT repeat the widget's own name.

### How the manifest becomes what the host already uses

WidgetBoard's layout engine and admin editor already work from a small "card type description": `size`, `defaults`, `minRefreshMs`, `params`, `label`, `description`. A widget does not provide that separately. The host derives it from the manifest in exactly one place, so there is a single source of truth:

| Manifest | Host's card-type description |
|---|---|
| `id` | the card's `type` |
| `name` / `description` | `label` / `description` |
| `size.default` `[c, r]` | `size.default {col_span: c, row_span: r}` |
| `size.min` / `size.max` | `size.min` / `size.max` in the same `{col_span, row_span}` form |
| `settings.*.default` | `defaults.params` |
| `refresh.default` / `refresh.min` | `defaults.refreshMs` / `minRefreshMs` |
| `settings` (non-secret) | `params`, the schema the editor builds its form from |
| `elements` | the visibility rows in the editor (new: today the editor offers only the four standard slots) |

The arrays in the manifest are the human-friendly form; the conversion to `{col_span, row_span}` happens only inside that one adapter.

---

## 3. Loading JavaScript and CSS

Every file of an installed or built-in widget is served by the host at an immutable, versioned URL:

```
/widgets/<id>/<version>/<file>          e.g. /widgets/alice.weather/1.2.0/widget.js
```

The host MUST:

- serve **only files that belong to an enabled widget's installed package**: clean the path, refuse anything outside the package folder, no directory listings;
- set `Content-Type` from the extension (`.js` → `text/javascript`, `.css` → `text/css`) and `X-Content-Type-Options: nosniff`;
- set `Cache-Control: public, max-age=31536000, immutable` (the URL contains the version);
- set `Access-Control-Allow-Origin: *` on widget files. *Verified:* a module script requested from a sandboxed frame is blocked without it (section 8). These files are public static assets, so this exposes nothing.

A widget's module may import other files **inside its own package** by relative path. It cannot import anything else: not host files, not other widgets, not a URL.

CSS is loaded by the host, not by the widget. Widget CSS SHOULD use the platform theme variables (section 6.5) and the card size container (section 5), and MUST NOT depend on class names or structure outside its own root.

---

## 4. Built-in and installed widgets share one runtime

A built-in widget is a package like any other. It has a `manifest.json` and the same `entry` shape, and its id is `core.<name>`. The only differences are where the files come from and how much the host trusts them:

| | Built-in (`core.*`) | Installed |
|---|---|---|
| Files | embedded in the WidgetBoard binary | `<data>/widgets/<id>/<version>/` |
| Served at | `/widgets/<id>/<version>/…` | `/widgets/<id>/<version>/…` |
| Manifest, `ctx`, lifecycle, settings, refresh | identical | identical |
| Runs as | in-page ES module (trusted, ships with the host) | sandboxed frame (section 8) |
| Can be removed | no | yes |

The widget code does not change between the two. The host picks the execution mode from where the package came from, never from a field in the manifest. (A `runtime` field would let a widget ask for less isolation, so the manifest schema rejects one.)

---

## 5. Size and layout

The widget declares `size.default`, `size.min` and `size.max` in grid cells. The layout engine clamps every card to those limits and never lets cards overlap or leave the grid. A widget MUST render correctly at every size from `min` to `max`, including the smallest.

Within the widget, the host gives you its real size instead of making you measure it:

- `ctx.size` is `{ width, height, cols, rows }` (pixels and cells) at mount time.
- `ctx.onResize(fn)` calls `fn(size)` whenever it changes. Resizing or moving a card never remounts it.
- The widget's area is a CSS **size container named `card`**, so a stylesheet can adapt with `@container card (min-width: 240px) { … }`.

Which shapes a widget supports is its own business. The host does not prescribe layouts, but widgets SHOULD design for at least: about 1×1, long (wide), tall, and larger squares, and drop lower-priority content before overflowing. Nothing may scroll and nothing may overflow the card.

---

## 6. Runtime and lifecycle

### 6.1 The module

The entry file's default export is an object:

```js
export default {
  mount(ctx)    { /* build the interface; once */ },
  refresh(ctx)  { /* optional: fetch/update data; called by the host on a schedule */ },
  update(ctx)   { /* optional: settings changed; if absent the host unmounts and remounts */ },
  unmount(ctx)  { /* optional: extra cleanup */ },
};
```

Every hook may be `async`. Widgets own their state (use `this` or a closure); the host never reads it.

### 6.2 Lifecycle

1. **mount** runs once. It MUST finish within 10 seconds or the widget is treated as failed.
2. If the manifest has `refresh`, the host calls **refresh** immediately after mount succeeds, then every `refreshMs` (the user may change the interval but never below `refresh.min`). The host never runs `refresh` concurrently with itself: a tick is skipped while the previous call is pending. Widgets MUST NOT run their own polling loop for data; use `refresh`.
3. **update** runs when the user edits the widget's settings (`ctx.settings` already has the new values).
4. **unmount** runs when the widget is removed, disabled, updated to a new version, or the card is edited in a way that requires a remount.

Moving or resizing a card does not run any hook except `ctx.onResize` listeners.

**Cleanup is guaranteed by the host, not trusted to the widget.** On teardown the host aborts `ctx.signal`, clears every timer made through `ctx.setInterval` / `ctx.setTimeout`, removes the widget's DOM, and (for installed widgets) destroys the frame. A widget that forgets to clean up cannot leak timers or requests.

**Errors.** A throw or rejection in `mount` shows a "this widget failed" state on that card, logs the error and does not affect other cards. A failing `refresh` keeps the last content on screen and retries with exponential backoff (up to 5 minutes). One bad widget never breaks the dashboard.

### 6.3 The `ctx` object

| Member | Description |
|---|---|
| `id`, `version`, `instanceId` | The widget id, its version, and the card's id in the layout. |
| `settings` | Frozen object of this card's **non-secret** settings, defaults filled in and values coerced to the declared types. An invalid stored value is replaced by the default. |
| `slots` | `{ title?, subtitle?, main?, footer? }`: elements to render into. A slot the user collapsed is missing, so always check. Present unless the manifest declares `elements`. |
| `part(key, tag?, className?)` | For widgets that declare `elements`: returns a new element for that part, or `null` if the user collapsed it. If the user set it to *hidden* the element is created invisible so it keeps its space. |
| `size`, `onResize(fn)` | Section 5. `onResize` returns an unsubscribe function. |
| `signal` | An `AbortSignal` aborted at teardown. Pass it to long operations. |
| `setInterval`, `clearInterval`, `setTimeout`, `clearTimeout` | Host-managed timers (for example a clock's one-second tick). |
| `http.fetch(url, init?)` | The only way to reach the network (section 9). |
| `log(level, message)` | `level` is `debug`, `info`, `warn` or `error`. Rate limited by the host. |

**Element visibility.** Each element has a visibility of `visible`, `hidden` (invisible, keeps its space) or `collapsed` (not created). The user sets it per card. The default elements are the four standard slots. A widget with its own design declares `elements` in the manifest (for example `price`, `change`, `chart`) and builds them with `ctx.part()`; declaring `elements` replaces the standard slots. Visibility is stored in the card as `config.<key>_visibility`, which is how layouts already store it.

### 6.4 Features may be added within an API version

New `ctx` members may appear within one API major version. A widget MUST feature-detect anything it relies on beyond what its `requires.api` guarantees. Existing members never change meaning within a major version.

### 6.5 Styling API

The host exposes the user's theme as CSS custom properties, available to the widget's CSS in both execution modes (for installed widgets the host copies them into the frame, because custom properties do not cross a frame boundary):

`--wb-bg --wb-surface --wb-border --wb-text --wb-text-muted --wb-text-faint --wb-accent --wb-positive --wb-positive-bg --wb-negative --wb-negative-bg --wb-gap --wb-padding --wb-card-padding --wb-radius --wb-border-width --wb-font --wb-font-scale --wb-shadow`

These are the stable names (they come from the theme engine's `themeToCssVars`). Other variables that exist in the host, such as the `--wb-design-*` fallbacks, are internal and not part of the contract.

---

## 7. Settings and persistence

Settings are declared in the manifest, and the admin editor builds the form from them. Types:

| `type` | Stored value | Notes |
|---|---|---|
| `string` | string | single line; `maxLength` ≤ 200, `placeholder` |
| `text` | string | multi-line; `maxLength` ≤ 2000 |
| `number` | number | `min`, `max`, `step` |
| `boolean` | boolean | |
| `select` | string | `options`: strings or `{ value, label }` |
| `combobox` | string | searchable dropdown over `options`; `allowCustom` (default `true`) lets users type their own |
| `secret` | server-side only | see below |

Every setting has a `label`; `help`, `required` and a `default` are optional (a `secret` never has a default). Setting keys are camelCase.

> **Change from the early draft:** the draft manifest used `"type": "text"` for a single-line field. In the editor that has always meant a multi-line box, so single-line is now `string` and `text` means multi-line.

**Where values live**

- **Non-secret settings** are stored per card, in the card's `params` in the dashboard layout, exactly as today. Existing layouts keep working. Because the layout is public and polled by the dashboard, `params` MUST NOT hold secrets.
- **Secrets** are stored on the server, keyed by widget id (shared by every card of that widget), and are never part of the layout, never sent to the browser and never available to widget code. The admin sets them through an authenticated, CSRF-protected endpoint that only ever reports whether a secret *is set*. The stored file is protected with file permissions (`0600`) and written atomically. **It is not encrypted**, and nothing in WidgetBoard may claim it is until it is.
- The only way a widget uses a secret is the `{{secret:key}}` placeholder in `ctx.http.fetch` (section 9), expanded on the server.

**Compatibility of stored values.** A setting that no longer exists is ignored (kept in the layout, not passed to the widget). A value whose type no longer fits falls back to the default. Removing or renaming a setting, or changing its type, is a major-version change for the widget.

---

## 8. Trust and isolation

Community widgets are untrusted third-party code. Loading them with a dynamic `import()` into the dashboard page does **not** sandbox them.

### What was tested

These checks ran in headless Chromium 153 with web security and site isolation on (the bundled test build ships with both disabled, which first produced false results; they were re-run with default security). The test server issued an `HttpOnly; SameSite=Strict` session cookie, as WidgetBoard does, and had an admin-only endpoint standing in for `PUT /api/layout`.

| # | Widget code runs… | Result |
|---|---|---|
| 1 | as an in-page ES module (today's design) | **Called the admin endpoint successfully** with the admin's session. |
| 2 | in `<iframe>` with no `sandbox` attribute | Same: full access to the page's cookies, DOM and admin API. |
| 3 | in `<iframe sandbox="allow-scripts allow-same-origin">` | Same. `allow-same-origin` cancels the sandbox. |
| 4 | in `<iframe sandbox="allow-scripts">` | `parent.document`, `document.cookie` and `localStorage` all throw. Its origin is `null`. The admin call was blocked at the CORS preflight; a *simple* credentialed request (no preflight) **was sent but without the session cookie**. |
| 5 | as 4, plus `connect-src 'none'` on the frame document | **No request of any kind reached the server.** |
| 6 | as 4, assets without `Access-Control-Allow-Origin` | The module script did not load at all. Widget files need the header (section 3). |
| 7 | frame URL opened directly (top level), no `sandbox` header | Ran with the real origin and **successfully called the admin endpoint.** |
| 8 | frame URL opened directly, with `Content-Security-Policy: sandbox allow-scripts` | Admin call blocked. |

Conclusions:

- In-page loading cannot meet the requirement that widget JavaScript never gets administrative access. The session cookie is `HttpOnly`, so the code cannot *read* it, but it can *use* it, because its requests are same-origin and carry it.
- A sandboxed frame without `allow-same-origin` can meet it.

**Not tested, so not claimed:** WebRTC, frame self-navigation, resource exhaustion (CPU, memory, infinite loops), side-channel attacks, and behaviour on the Raspberry Pi Zero 2 W's browser. CSP narrows what a frame can do; it is not a complete containment of network egress. Do not describe widgets as "secure" or "safe", only as running in a restricted frame with a defined set of mitigations.

### Requirements

1. **Installed widgets run in a sandboxed frame.** `sandbox="allow-scripts"` and nothing else. `allow-same-origin` MUST NOT be added, ever.
2. **Built-in widgets (`core.*`) run in-page.** They are part of the WidgetBoard binary and are as trusted as the host.
3. **The host MUST NOT execute installed widgets in-page**, not even behind a developer flag. Until the frame runtime exists, installed widgets are listed and configurable but not run.
4. **Frame documents are generated by the host**, at `/widgets/<id>/<version>/_frame` (a name no package file can have). The response MUST carry a CSP that includes `sandbox allow-scripts` (test 8: otherwise opening the URL directly bypasses the sandbox), `connect-src 'none'` (test 5), `form-action 'none'`, `base-uri 'none'` and `script-src` limited to the host's own files. The exact directive list must be re-tested when implemented.
5. **The frame talks to the host through a narrow `postMessage` bridge** implemented by host-owned code (not part of the package). The host accepts messages only from the frame it created (compare `event.source`; `event.origin` is `"null"`), validates every message, and ignores everything else. The bridge carries exactly the `ctx` surface in section 6.3. The widget code is identical in both execution modes.
6. **Admin endpoints MUST NOT trust cookie-less or `Origin: null` requests**, and state-changing admin requests MUST have CSRF protection (test 4 shows simple requests are sent).
7. The dashboard page itself never exposes admin credentials or admin API handles to widgets.

**Known cost:** one frame per widget uses more memory than one page. This must be measured on the Pi Zero 2 W (512 MB) before the frame runtime is finalised. If it is too heavy, options are fewer simultaneous frames or a reviewed "verified" tier, but that must be an explicit, user-visible decision, not a silent downgrade.

---

## 9. Platform capabilities (v1)

Capabilities are generic and reusable. The host contains no integration for any specific service.

### `ctx.http.fetch(url, init?)`

The only network access a widget has. In an installed widget's frame, direct `fetch` is blocked (test 5), so everything goes through the host. Even APIs that allow browser requests go through it, which also gives the host a place to cache and rate-limit on a small device.

```js
const res = await ctx.http.fetch(
  "https://api.example.com/v1/weather?city=Pittsburgh&key={{secret:apiKey}}",
  { headers: { Accept: "application/json" } });
const data = await res.json();      // res: { ok, status, headers, text(), json() }
```

The host performs the request on the server and MUST enforce:

- **Permission.** The URL's host MUST be in the widget's `permissions.network`, as approved by the admin when installing. `https` only, port 443 only. Anything else is rejected.
- **Redirects.** At most 3, each to a host that is also permitted.
- **No private network.** After DNS resolution (and again on every redirect), refuse loopback, private, link-local and the host's own addresses. A widget cannot be used to scan the user's network or reach WidgetBoard's own API. (Local-network access is a future, separate, explicitly granted permission.)
- **Limits.** Methods `GET` and `POST`; request body at most 64 KiB; response at most 1 MiB; 10-second timeout; a per-widget rate limit; widget-supplied headers limited to a safe list (no `Cookie`, no `Authorization`, no `Host`).
- **Identification.** The host sets the `User-Agent` itself (`WidgetBoard/<version> (<widget id>)`).
- **Secrets.** `{{secret:key}}` may appear in the URL, a header value or the body. The server replaces it only if the manifest declares `key` as a `secret` setting and the admin has set it; otherwise the request fails. The secret is sent only to hosts the widget is permitted to reach (which the admin saw at install). Exact secret values are removed from response bodies and headers before they return to the widget, so an upstream that echoes its input cannot hand the secret back.

### `ctx.log`, `ctx.setInterval` and friends

Section 6.3.

### Reserved for later versions

Per-widget storage, notifications, local-network access, and events between widgets. They will be added as new `ctx` members and new `permissions` entries; nothing needs to be built for them now.

---

## 10. Versioning and compatibility

### 10.1 Widget versions

`version` is semantic: a **major** bump for anything that breaks existing cards (removing or renaming a setting, changing its type, shrinking `size.min`'s meaning), **minor** for new options and features, **patch** for fixes. A version is immutable once published (section 11).

### 10.2 Widget API versions

`requires.api` is an integer. The host declares the set of API majors it implements (today `[1]`). A widget whose `requires.api` is not in that set is **incompatible**: it is shown as such, never loaded. When the API moves to 2 the host SHOULD keep running API 1 widgets for at least one WidgetBoard release.

`requires.min_widgetboard` is compared against the running WidgetBoard's version. (WidgetBoard does not yet define a version constant; that is a prerequisite for enforcing this.)

### 10.3 What a layout does when its widget is not available

A card's `type` is a widget id. If that widget is not installed, is disabled, or is incompatible, the card MUST be **preserved exactly** (type, params, config, position and size) and drawn as a placeholder that says why and offers the action (install, enable, update). Layouts MUST NOT be rewritten on load to "repair" an unknown type; for a widget that may simply not be installed *yet*, that would destroy the user's configuration. The size limits of such a card are 1×1 up to the grid.

**Aliases.** Layouts saved before widgets had namespaced ids use bare types (`default`, `ticker`). A manifest may list those in `aliases` so existing layouts keep working when the namespaced widget is installed. Resolution: an exact id match first, then an alias match. An alias is honoured only if the registry entry for that version lists it too (so it was seen in review), and installing a widget whose alias is already taken by another installed widget fails. The saved layout keeps the old type until the user edits that card.

---

## 11. Distribution and installation

### 11.1 The registry

`registry.json` is **generated by CI**, never edited by hand, and validated by [`schema/registry.schema.json`](../schema/registry.schema.json). For each widget it lists every published version with:

- `commit`: the full 40-character SHA the files are fetched from. A branch or tag name is not accepted, so an install can never silently follow a moving ref.
- `path`: the package folder (`widgets/<namespace>/<name>`).
- `files`: every file with its `size` and `sha256`.
- a denormalised copy of `requires`, `aliases` and `permissions`, so the admin board can show permissions before anything is downloaded. The installer MUST check that these equal the downloaded manifest.
- `yanked`: a withdrawn version cannot be newly installed, and installs show a warning.

`latest` is the newest non-yanked version.

### 11.2 Install algorithm (host)

1. Fetch the registry (already done by `GET /api/modules/registry`); pick the entry and version.
2. Check `requires.api` is supported and `min_widgetboard` is satisfied. Show the permissions and wait for admin approval.
3. For each file in `files`, download `https://raw.githubusercontent.com/<registry.repo>/<commit>/<path>/<file>`: only that host, HTTPS, no redirects, a 15-second timeout, reading at most `size + 1` bytes. Reject on any size or `sha256` mismatch.
4. Validate the package exactly as `tools/validate.mjs` does: manifest schema and cross rules, file rules and limits, and agreement with the registry entry.
5. Write everything under `<data>/widgets/.staging/<random>/`, flush it to disk, then `rename` it to `<data>/widgets/<id>/<version>/`. A failure at any step removes the staging folder and leaves the installation exactly as it was.
6. Record it in `<data>/widgets/state.json`, written with the same temp-file-and-rename approach used for the layout.

Installs are serialised (one at a time). Every path is built by joining the data directory with a validated relative path and then checking that the result is still inside the package folder.

### 11.3 On disk

```
<data>/
├── dashboard.json              the layout (exists today)
├── secrets.json                server-side secrets, 0600, not encrypted
└── widgets/
    ├── state.json
    └── alice.weather/
        ├── 1.2.0/              manifest.json, widget.js, …
        └── 1.1.0/              previous version, kept for rollback
```

`state.json`:

```json
{
  "schema_version": 1,
  "widgets": {
    "alice.weather": {
      "version": "1.2.0",
      "previous": "1.1.0",
      "enabled": true,
      "installed_at": "2026-01-05T12:00:00Z",
      "source": { "commit": "<40 hex>" },
      "granted": { "network": ["api.openweathermap.org"] }
    }
  }
}
```

### 11.4 Lifecycle operations

- **Update:** install the new version beside the old one, then switch `version` and set `previous`. If the new version requests permissions beyond `granted`, it is not activated until the admin approves them. Delete anything older than `previous`.
- **Rollback:** switch back to `previous`.
- **Disable / enable:** a flag in `state.json`. A disabled widget's files are not served and its cards become placeholders; its settings and secrets are kept.
- **Remove:** delete the widget's folders, its `state.json` entry and its secrets. Cards in the layout stay as placeholders.
- **Configuration** (non-secret) lives in the layout and survives all of the above.

### 11.5 Contributing a widget

1. Fork this repository.
2. Add `widgets/<your-github-username>/<widget-name>/` with a `manifest.json` and your files. Start from [`examples/hello-clock`](../examples/hello-clock).
3. Run `npm install && npm run validate`.
4. Open a pull request. CI runs the same validation. A maintainer reviews the code; the automated checks only prove the package is well-formed (they include a syntax check), **not that it is safe**, and review is the real gate.
5. After merge, CI publishes the version (a commit-pinned entry in `registry.json`).

*Not built yet:* the GitHub Action that runs validation on pull requests, and the registry generator.

---

## 12. Host API surface (outline)

Not specified in detail yet; listed so the contract's needs are visible. Everything that changes state requires an authenticated admin session and CSRF protection.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/modules/registry` | admin (exists) | The community registry. |
| `GET /api/widgets` | public | Manifests of built-in and installed widgets (no secrets). The dashboard needs this to render. |
| `POST /api/widgets/install`, `…/update`, `…/rollback`, `DELETE /api/widgets/{id}` | admin | Lifecycle. |
| `PUT /api/widgets/{id}/enabled` | admin | Enable or disable. |
| `PUT/DELETE /api/widgets/{id}/secrets/{key}`, `GET …/secrets` | admin | Set or clear secrets; the GET returns `{ key: { set: bool } }` only. |
| `POST /api/widgets/{id}/fetch` | public, per widget | Backs `ctx.http.fetch`. Safe for anonymous dashboard viewers only because of the permission, SSRF and rate-limit rules in section 9. |
| `GET /widgets/<id>/<version>/<file>` | public | Widget files (section 3). |

---

## 13. What changes in WidgetBoard (core)

Observed in the repository at commit `0645e23`; this is the work the contract implies, in the order it should be done.

1. **Make the rewrite build and run again.** It currently cannot start:
   - Seven files import `static/js/cards/index.js`, which no longer exists (`admin/app.js`, `admin/gridEditor.js`, `admin/inspector.js`, `admin/palette.js`, `core/layoutStore.js`, `core/widgetFactory.js`, `dashboard/app.js`), and two import `utils/cardFactory.js`, which was renamed `core/widgetFactory.js`.
   - `dashboard/app.js` imports `./core/dashboard.js` and `./cards/index.js`, neither of which resolves from that folder.
   - The base card template and default layout (`static/json/layout.json`, `static/json/dashboard.json`) are gone but still loaded: by `widgetFactory.loadCardTemplate`, `layoutSync` and `dashboard/layout.go`, so a first run would fail to serve a layout.
   - Both HTML pages point at CSS and JS paths that moved (`static/css/dashboard.css`, `static/js/dashboard.js`, `static/css/admin.css`).
   - The `cmd/widgetboard/*` subpackages still declare `package main`, `main.go` calls functions that are now unexported in other packages, and nine `.go` files are empty (Go rejects an empty file with `expected 'package', found 'EOF'`).
2. **Introduce the registry of widget types** behind the two functions the layout engine already uses, `getMeta(type)` and `hasType(type)`, filled from manifests through the adapter in section 2. The engine itself should barely change.
3. **Stop rewriting unknown types.** `layoutEngine.normalizeOne` replaces an unknown `type` with `"default"`. With community widgets an unknown type usually means "not installed yet" (section 10.3).
4. **Runtime:** replace `widgetFactory.createCard` with the lifecycle in section 6 (host-driven `refresh`, `ctx`, guaranteed cleanup). Built-ins first, in-page.
5. **Go `widgets` package:** state, file server (section 3), installer (section 11), secrets.
6. **Security:** CSRF protection and `Origin: null` handling on admin routes before any installer endpoint exists.
7. **Frame runtime** (section 8), then enable installed widgets.

Also noted: the repository's README and `portfolio.settings` describe "secrets encrypted at rest" and an older Go-`Provider` plugin model. Neither exists in the code, and both should be updated so the documentation matches what is built.

---

## 14. Decisions this specification makes (for confirmation)

1. **Installed widgets run in sandboxed frames; only built-ins run in-page.** This follows directly from test 1. It costs memory on the Pi (section 8).
2. **All widget network access goes through the host.** It is the only way to combine the frame's `connect-src 'none'` with secrets that never reach the browser, and it gives the host one place to rate-limit and cache.
3. **Namespace = GitHub username**, `core` reserved for built-ins.
4. **Packages are fixed file lists pinned by commit and `sha256`**, with no archives.
5. **Settings type names:** `string` is single-line, `text` is multi-line (the draft manifest used `text` for single-line).
6. **Manifest sizes are `[cols, rows]` arrays**, converted once into the engine's `{col_span, row_span}`.
7. **A widget's `refresh` is host-driven**, replacing widget-owned polling.

---

## 15. Conformance

- [`schema/manifest.schema.json`](../schema/manifest.schema.json) and [`schema/registry.schema.json`](../schema/registry.schema.json) check structure.
- `tools/validate.mjs` checks everything else in sections 1 and 2 and the registry's cross-rules (`node tools/validate.mjs all`).
- [`tests/conformance/manifests.json`](../tests/conformance/manifests.json) lists manifests with the expected accept or reject answer. The installer in WidgetBoard's Go code MUST give the same answers for every entry. Regenerate it with `WRITE_CONFORMANCE=1 npm test` after changing the rules.

## 16. Out of scope for v1

Per-widget storage, local-network access, events between widgets, widget-to-widget dependencies, paid widgets, automatic updates without admin approval, and any claim that review or static checks make a widget safe.
