# Development principles

## Workflow: Design before implementation

When user asks for a change or new feature, do NOT jump straight to proposing implementation details or code. Instead:

1. **Ask clarifying questions** - understand the full scope and intent
2. **Discuss design options** - present tradeoffs, get user's preference
3. **Firm up requirements** - agree on behavior, edge cases, UX details
4. **Only then implement** - after the user explicitly says to proceed

Do not conflate "here's how I'd do it" with "let me do it now". The user wants to think through the design collaboratively before any code is written.

**Questions are not implementation requests.** If the user asks "does X need to change?" or "how does Y work?", answer the question. Do not write or modify code unless the user explicitly says to proceed (e.g. "go ahead", "implement it", "make that change"). The bar for starting to code is an explicit directive, not an implied one.

## Design/Development Philosophy

- **Do the right thing** - Never avoid a refactor because "it's minimal lines" or "it doesn't fix a bug". Correctness, clarity and proper design matter regardless of scope. This project is both a product and a learning tool
- Read before writing
- Verify completeness
- Ask when uncertain
- Be systematic, not selective

## Communication style

- **Keep replies short** - Long answers are hard to read. Prefer the minimum needed to convey the point. If the reply gets long anyway, summarize your reply at the end with a TLDR section so user doesn't have to go through the whole thing.
- **Pause for input** - When you need a decision or clarification from the user, stop there and ask. Do not assume an answer and proceed

## Go architecture: no boilerplate classes

The Go backend (`go-server/`) deliberately avoids the "class for everything"
pattern (a struct + `New*` constructor + method receivers) where there is no
genuine object. This is a single-process, single-developer app, so blanket
struct-based dependency injection is not worth the boilerplate: its indirection
earns its keep only where there is real per-instance state or a genuine test
seam. There is a growing unit-test suite (e.g. `internal/queue`,
`internal/pipeline`, `internal/utils`), with integration tests planned; where a
test needs to substitute a collaborator, introduce a narrow, purpose-built seam
(as the pipeline does with its injectable queue factory and `Queue` interface)
rather than threading dependencies through constructors everywhere.

Rules going forward:

- **Structs + `New*` only for genuine classes** - i.e. a type that has real,
  mutable, per-instance state AND is (or realistically could be) instantiated
  more than once. The canonical example is `queue.Queue` (three live instances:
  index, video, geo). If there is exactly one instance for the life of the
  process, it is a singleton, not a class.
- **Single-instance state -> package-level.** Fold it into package-level vars
  plus package-level functions. If it needs collaborators or a state file, give
  the package an `Init(...)` that sets the package vars once at startup (mirrors
  `scheduler.Init`, `geo.Init`, `ml.Init`, `indexing.Init`). Otherwise expose
  plain package functions.
- **App-wide resources are globals.** `database.DB` (the `*sql.DB`),
  `config.Startup` (immutable env config), and `config.Runtime` (mutable,
  DB-persisted settings) are package-level singletons read directly as
  `pkg.Name`. Do not thread them through constructors or handler structs.
- **Handlers are package-level.** HTTP handlers register via a package-level
  `RegisterRoutes(rg *gin.RouterGroup, ...)` that wires any collaborators into
  package vars and mounts unexported handler funcs. No `Handler` struct.
- **The DB layer is package functions.** Query/exec helpers are package-level
  functions on the global `database.DB`, not methods on a `*SomethingDB`
  wrapper. When a business-layer function and a raw DB function would collide on
  a name in the same package, keep the DB-layer one unexported (e.g.
  `insertUser`) and let the exported name be the business entry point.
- **Do not reintroduce boilerplate classes.** When adding a feature, default to
  package-level functions + (if needed) an `Init`. Reach for a struct only when
  the "genuine class" bar above is met. If unsure whether something qualifies,
  ask.

## Code style rules

- **No non-ASCII characters in code** - Use only ASCII in source files (comments, strings, identifiers). Use plain dashes (`-`) instead of em-dashes, straight quotes instead of curly quotes, etc.
- **Preserve existing comments** - When rewriting on refactoring code, do not remove comments that are still relevant (TODOs, explanation of quirks, workaround notes, commented-out code with rationale). Only remove a comment if the code it describes no longer exists or the concern is fully resolved

## Frontend conventions

- **Confirmation dialogs** - When a web change needs a confirm/cancel (or any
  yes/no) dialog, use the shared `showConfirmDialog` helper in
  `web/js/utils.mjs`. Do NOT hand-roll a new `sl-dialog` or use the native
  `window.confirm`. Signature:
  `showConfirmDialog(title, message, btn1Text = 'OK', btn2Text = 'Cancel')`.
  It appends an `sl-dialog` to `document.body`, and returns a Promise resolving
  to `1` (primary/btn1 clicked), `2` (btn2 clicked), or `false` (dismissed
  without a button). `message` is inserted as HTML, so never pass unsanitized
  user input into it.

- **Safe-area insets (mobile)** - the `web/` frontend also runs inside the
  Capacitor Android WebView (`mobile/`), which draws edge-to-edge under the
  status bar / gesture bar (SDK 36 forces this). Any `position: fixed` or
  `position: absolute` element anchored to a viewport edge MUST offset by the
  device inset, e.g. `top: calc(2px + env(safe-area-inset-top))` or
  `bottom: calc(12px + env(safe-area-inset-bottom))` (also `-left`/`-right` for
  notches). `env(safe-area-inset-*)` is `0` in a desktop browser, so this is a
  no-op on the web and needs no separate mobile stylesheet -- but omitting it
  makes the element overlap (and steal taps from) the system bars on a phone.
  Non-edge-anchored content inherits the inset from `#app-root`'s padding
  (set in `mobile/index.html`); only viewport-anchored fixed/absolute elements
  need their own `env()` offset.

- **Keep `web/` mobile-build-friendly** - `mobile/build.sh` bundles the shared
  `web/` frontend into the app with esbuild and vendors its deps locally (no
  runtime CDN). Two things break the mobile build if added carelessly to `web/`:
  (1) a new runtime-CDN dependency or import-map specifier -- add it to the
  bundle/vendor step in `mobile/build.sh`, do not rely on it being fetched at
  runtime; (2) code that assumes a global set by a CDN `<script>` (the way the
  old Navigo CDN set `window.Navigo`) -- bundled npm packages set no such
  global. Prefer normal ESM imports.

- **Do not gate app init on `DOMContentLoaded` alone** - the mobile boot imports
  `main.mjs` dynamically, after `DOMContentLoaded` has already fired, so a
  listener added then never runs. Guard on `document.readyState` (run now if not
  `loading`, else add the listener). See `web/js/main.mjs`'s router init.

## Mobile (Capacitor) conventions

The `mobile/` folder is a thin Capacitor Android wrapper around the shared
`web/` frontend (see `mobile/README.md` for the architecture). These rules keep
it thin and keep the web app the single source of truth.

- **`web/` owns all UI and features; `mobile/` stays a shell.** Do NOT fork UI
  or feature logic into `mobile/`. The only things that belong there are: the
  boot (`mobile-boot.mjs`), the first-run server-URL intake screen
  (`pl-server-setup.mjs`), native bridges/shims (`mobile-back.mjs`), and the
  Capacitor project config. Anything a user sees or interacts with goes in
  `web/` so the browser and app stay identical.

- **Boot order: set everything the web app needs BEFORE importing `main.mjs`.**
  `mobile-boot.mjs` must install native shims and `window.__API_BASE__` (the
  server URL) and then `await import('./main.mjs')` -- never earlier, or app
  code runs against the wrong origin / without the shim. New native setup
  follows the `initBackButton()` pattern: a side-effecting init called at the
  top of `boot()`.

- **Dismissable overlays MUST use `CloseWatcher`.** Any new closable UI in `web/`
  (dialog, panel, overlay, inline editor) should dismiss via the web
  `CloseWatcher` API, as the existing overlays and Shoelace components do. The
  mobile layer wraps `CloseWatcher` into a LIFO stack (`mobile-back.mjs`) so the
  Android hardware back button closes the topmost one automatically -- with zero
  mobile-side changes. Hand-rolling Esc/close handling instead silently breaks
  the hardware back button in the app.

- **Capacitor plugins/deps: pin to the Capacitor major (8) and re-sync.** Add
  `@capacitor/*` plugins at a version matching `@capacitor/core` (currently 8.x),
  run `npm install` + `npx cap sync android`, and rebuild. Frontend libraries
  that the shared `web/` code imports must also be bundled/vendored by
  `mobile/build.sh` (see the "keep web/ mobile-build-friendly" frontend rule).

- **Native back routing is hash-aware, not `history.back()`.** The hash router
  accumulates stale entries, so the back handler decides from the current route
  (close overlay -> else navigate to the gallery home -> else `App.exitApp()`),
  not by walking raw history. Extend `isRootRoute()` in `mobile-back.mjs` if new
  top-level routes are added.

## Commit message format

- The user always commits manually. Do NOT run `git commit` (or `git add`/`git push`) unless explicitly asked. Prepare and describe the changes; leave the actual commit to the user.
- When asked for a commit message:
  * Start with the scope prefix indicating what changed: `web:`, `go-server:` or combined (e.g. `g-server+web:`)
  * Use `go-server:` for any change under `go-server/` (the Go backend, which is what is current). The bare `server:` prefix referred to the retired Note.js `server/` and shot no longer be used
  * After the prefix, capitalize the first word and state which component/module the change is in (e.g. `In pl-album-name,`)
  * Follow this with a short summary (imperative mood)
  * Use the body for details if needed
  * Keep it short. Prefer single summary line; only add a brief body when it genuinely aids understanding. Avoid long, exhaustive bullet lists of every touched file -- summarize the change, not the diff
  * For changes to agentic config files (e.g. `AGENTS.md`), use `agents:` as
    the prefix. This refers to the file being changed, not to whether an agent
    made the change -- code changes an agent makes still use their normal scope
    prefix (`go-server:`, `web:`, etc.)

## Database migrations

- DDL changes (new/dropped/renamed tables or columns) go in a NEW versioned file under `go-server/internal/database/migrations` (e.g. `013-new-feature.sql`), embedded via `//go:embed`.
- Never edit a committed migration file -- it's frozen. Keep iterating on the current new file until done
- Data migrations (INSERT/UPDATE backfills) are one-time manual scripts prefixed with the version number in `0xx` format (e.g. `012-backfill-capture-time`).
- Fresh installs apply all DDL migrations in order
- To add one: create `NNN-<name>.sql`, then add `{version: N, filename: "migrations/NNN-<name>.sql"}` to the `migrations` slice in `runMigrations()` (`internal/database/database.go`). Each run in a transaction when `PRAGMA user_version < N`; `user_version` is set to `N` after commit (SQLite cannot set it inside a transaction)
- FTS5 tables (`metadata_fts_porter`, `metadata_fts_unicode`) don't support ALTER TABLE -- adding columns means drop+recreate. No rebuild helper exists yet; create one when needed.

## Service Worker version bump (web changes)

Any change under `web/` requires bumping the `VERSION` constant in `web/sw.mjs` to trigger the PWA "New version available" banner. This applies on the dev box too -- the service worker uses the version to detect changes, so bumping is the way to pick up updates without manually refreshing the browser.

- **Patch (1.0.X)** - bug fixes, small style/copy tweaks, no-behavior-change refactors
- **Minor (1.X.0)** - new features/components, additive UI, non-breaking behavior changes
- **Major (X.0.0)** - breaking changes, removed features, large redesigns

Rules: 
- bump in the same commit as the web change
- bump every time a web file changes (each distinct change gets its own bump)
- no skipping versions
- ask if unsure patch vs minor
- server-only changes need no bump

