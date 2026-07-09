# Remix v3 Beta 5 adoption audit

## Current version

This repository already uses `remix@3.0.0-beta.5` (`package.json`) and resolves
`@remix-run/ui@0.4.0` through the lockfile. No Remix upgrade is a prerequisite
for the changes below.

The application uses Remix as a set of libraries on top of `Bun.serve()`:

- `remix/fetch-router` in `app/router.tsx`
- `remix/html-template` in the server-rendered route shell
- the component runtime from `remix/ui` in `app/client`

It is not a generated Remix app and does not use `remix/node-fetch-server`.

## Recommendations

### High: separate development and production starts

**Files:** `package.json`, `README.md`, `src/app-server.ts`

Beta 5 fixed the default `remix new` template so its production command sets
`NODE_ENV=production` and its development command owns the watcher. This repo
previously had only `app:start`, which always used `bun --watch` and allowed
`app/config/init-env.ts` to default to development.

The audit implements:

- `app:dev` with `NODE_ENV=development` and the Bun watcher
- `app:start` with `NODE_ENV=production` and no watcher
- `SIGINT` and `SIGTERM` handling that closes active connections before exit

This also activates the existing production minification and source-map
settings in `server/bundling.ts`.

### High: adopt `remix/ui/button` and `remix/ui/input` through app-level mixes

**Files:** `app/client/editing-workspace.tsx`,
`app/client/trim-points.tsx`, `app/assets/styles.css`

The two workspaces contain roughly 40 custom `.button` controls and 10 custom
`.text-input` controls. There is no third-party browser component library to
remove. A staged migration to the Beta 5 `button()` and `input()` mixes would
centralize focus, disabled, sizing, and default button behavior.

This should not be a direct markup replacement yet. The Beta 5 styled mixes use
a fixed light palette and pill-shaped buttons, while this app uses semantic CSS
variables and automatic dark mode. Also, Remix UI emits styles in its `rmx`
cascade layer, while the existing unlayered classes take precedence. The safe
implementation is an app-level mix that composes the first-party behavior with
the existing design tokens, followed by one panel at a time and visual
regression coverage. The exact tone mapping, especially the app's unsupported
`danger` tone, needs a design decision.

### High: fingerprint production browser assets before immutable caching

**Files:** `server/bundling.ts`, `app/router.tsx`,
`app/components/layout.tsx`

Production currently builds browser modules on every request and sends
one-year `immutable` cache headers for stable URLs such as
`/app/client/entry.tsx`, `/node_modules/remix/ui`, and `/assets/styles.css`.
Those URLs are not content-hashed, so a browser can retain stale code after an
upgrade.

Adopt a production build manifest with content-hashed filenames (the direction
of the improved template and `remix/assets`) before retaining immutable
caching. Until that pipeline exists, `no-cache` is safer. This was not changed
in this audit because it affects the custom Bun bundler, package publication,
and local fixture serving together.

### Medium: pilot `remix/ui/select`

**File:** `app/client/editing-workspace.tsx`

Three native selects choose primary/secondary chapters and chapter status.
They are good semantic candidates for Beta 5's first-party `Select` and
`Option`, which add consistent keyboard and listbox behavior. Migrate these
after the app-level control theme exists; replacing them now would introduce a
visually inconsistent popup and changes controlled-value behavior.

### Medium: keep domain-specific editing controls custom

**Files:** `app/client/editing-workspace.tsx`,
`app/client/trim-points.tsx`

The waveform canvas, trim handles, timeline ranges, range inputs, queue rows,
and transcript jump results do not map cleanly to Beta 5 components. In
particular, the transcript search performs navigation rather than form-value
selection, so adopting `remix/ui/combobox` would add state and filtering
complexity without a clear behavior improvement.

### Low: breadcrumbs, accordion, and tabs

**Files:** `app/routes/index.tsx`, `app/routes/trim-points.tsx`, and their
client workspace counterparts

Breadcrumbs would add little value to a two-route application. Accordion and
tabs would change the dense editor's information architecture and should only
be introduced with a product requirement for collapsible or mutually exclusive
panels.

## `trustProxy`

`trustProxy` does not help the current topology:

- `src/app-server.ts` uses `Bun.serve()`, not
  `createRequestListener()` from `remix/node-fetch-server`.
- The server binds to loopback by default and the repository has no reverse
  proxy, container, or hosting configuration.
- Routing only reads URL pathnames, browser requests use relative URLs, and the
  app does not consume client addresses or forwarded headers.
- The local file APIs in `app/video-api.ts` and `app/trim-api.ts` are not safe
  to expose as a public service without a separate access-control design.

If the app later moves behind a trusted TLS-terminating proxy, either migrate
the HTTP adapter to `remix/node-fetch-server` and enable `trustProxy`, or add a
Bun-specific trusted-proxy layer. Only enable forwarded-header trust when the
server is reachable exclusively through a proxy that overwrites those headers;
otherwise clients can spoof host, protocol, and address data.

## Default template comparison

| Beta 5 template improvement | Repository status |
| --- | --- |
| Production sets `NODE_ENV=production` | Adopted by `app:start` in this audit |
| Development server owns the watcher | Adopted by `app:dev` |
| Browser assets are minified in production | Already conditional in `server/bundling.ts`; now activated by the production script |
| Client/server frame resolution | Not applicable; this app does not use Remix frames |
| Node fetch server and `trustProxy` | Not applicable to the Bun adapter and current local-only topology |
| Signal-aware shutdown | Adopted for `SIGINT` and `SIGTERM` |

The next production-start improvement should be a prebuilt, fingerprinted
browser asset pipeline. It is more valuable here than switching the working Bun
HTTP adapter to Node solely to match the template.
