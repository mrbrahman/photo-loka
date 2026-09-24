# Bug: doubled log level word (`INF INFO`) after the singleton fold

## Symptom

Since v0.20.0 (the lean-migration / singleton-fold release), some log lines show
a doubled level token under journald:

```
INF INFO items loaded for frame component=frame-manager frame_id=1 ...
INF WARN no SSE client found for frame component=frame-manager ...
INF INFO scheduled intake indexing component=scheduled-indexing ...
```

Compare v0.15.0 (correct):

```
INF items loaded for frame component=frame-manager frame_id=1 ...
```

The `INF` is tint's level prefix. The extra `INFO`/`WARN` is a SECOND level
rendering. It matches the actual level (Info -> INFO, Warn -> WARN).

Key observation: the doubling appears ONLY on lines logged by the folded
packages (frame-manager, scheduled-indexing, and by extension any package that
now holds a package-level component logger). Lines logged via the root logger
(`slog.Info(...)` directly -- e.g. "ML service is healthy", "libvips
initialized", "server started") are correct.

## Root cause: package-var init order vs slog.SetDefault

During the fold, each component's logger became a package-level var, e.g.:

- `internal/frames/manager.go:45`   `frLogger    = slog.Default().With("component", "frame-manager")`
- `internal/jobs/scheduled.go:19`   `siLogger    = slog.Default().With("component", "scheduled-indexing")`
- `internal/jobs/watcher.go:29`     `fwLogger    = slog.Default().With("component", "file-watcher")`
- `internal/scheduler/scheduler.go:18` `logger  = slog.Default().With("component", "scheduler")`
- `internal/indexing/pipeline.go:27` `idxLogger = slog.Default().With("component", "indexer")`
- `internal/indexing/organizer.go:29` `orgLogger = slog.Default().With("component", "organizer")`
- `internal/geo/finalizer.go:17`    `geoLogger = slog.Default().With("component", "geo-finalizer")`
- `internal/geo/service.go:15`      `logger    = slog.Default().With("component", "geo-service")`
- `internal/ml/service.go:18`       `logger    = slog.Default().With("component", "ml-service")`
- `internal/items/handler.go:23`    `logger    = slog.Default().With("component", "items-handler")`
- `internal/auth/service.go:29`     `logger    = slog.Default()`

Package-level `var` initializers run BEFORE `main()`. But the tint handler is
installed inside `main` -> `runServe()` -> `initLogging()` (main.go:125), which
calls `slog.SetDefault(slog.New(tintHandler))` (main.go:420).

So every one of those package loggers captured slog's BUILT-IN default handler
(stdlib text handler, which renders the level as a word) instead of tint. The
root logger later switched to tint. Under systemd both handlers write to stderr
-> journald, so the folded-package lines carry the stdlib handler's level
rendering in addition to tint's `INF` (from the interplay of the two), hence the
doubled token.

Why it was fine before the fold: these loggers used to be created INSIDE the
`New*()` constructors (NewManager, NewScheduledIndexing, NewFileWatcher, etc.),
which `main` called AFTER `initLogging()`. So they correctly captured the tint
default. Moving logger creation to package-var init time (before main) is what
regressed it.

## Fix options (decide, then apply)

The fragile pattern is snapshotting `slog.Default()` into a package var at init
time. Options considered:

- **A (recommended): lazy component logger.** Don't hold the logger in a var.
  Add a tiny per-package helper that resolves the current default at log time,
  e.g.:

  ```go
  func log() *slog.Logger { return slog.Default().With("component", "frame-manager") }
  ```

  then change `frLogger.Info(...)` -> `log().Info(...)`. Always correct
  regardless of init order; negligible per-call cost (a `With` allocation).
  Downside: touches every log call site in the folded packages.

- **B: assign the logger in each package's `Init()`** (after `slog.SetDefault`).
  Keep the package var, but set it in `Init()` which `main` calls post
  `initLogging()`. Problem: not all folded packages have an `Init` (auth, items,
  organizer, scheduler-has-Init, frames-has-none-now, jobs-have-none-now), so
  several would need one added just for this -- more wiring/boilerplate, against
  the grain of the migration.

- **C: call slog directly at call sites** with `slog.Info(msg, "component",
  "X")`. Biggest edit; re-verbosifies; drops the shared component tag var.

- **D: alternative -- make initLogging run earlier.** Not possible to beat
  package-var init (that always runs before main). Could move tint setup into an
  `init()` in a low-level package that others depend on, but init() ordering
  across packages is by dependency and is fragile/implicit -- do NOT rely on it.

Recommendation: **Option A**. It removes the snapshot entirely, so the class of
bug (capturing a handler before it is installed) cannot recur. Apply per folded
package; keep the `"component"` tag values exactly as they are now (see list
above) so log output is unchanged apart from fixing the doubling.

## Verification after fix

- `go build -tags "fts5 sqlite_math_functions" ./...` and
  `go vet -tags "fts5 sqlite_math_functions" ./...` clean; `gofmt -l` clean.
- Run under systemd (or with INVOCATION_ID set) and confirm folded-package lines
  read `INF items loaded for frame ...` with NO doubled `INFO`/`WARN`.
- Sanity: also check non-systemd (TTY) run still shows the single tint level +
  timestamp.

## Note

`auth/service.go` uses `logger = slog.Default()` (no component tag). Same bug
applies; fix it the same way (or, since auth logs little, `slog.Default()` at
call time). Keep behavior identical.
