# Lean syntax migration

Goal: remove boilerplate "class" (`New*` + struct + method-receiver) code that
was added by following Go conventions to the letter. This is a single-dev
project with no unit tests (except `utils/exifdate_test.go`) and no appetite for
convention-only boilerplate. Reduce to:

1. `db` and `config` as global/singleton resources (not threaded through
   constructors).
2. `New`/struct pattern kept ONLY where there is genuine, mutable, long-lived
   state (true "classes").
3. Everything else becomes package-level functions -- the Go equivalent of
   Node.js module exports/imports.

## Decisions (locked)

- Globals stay in their existing packages:
  - `database.DB` -- package-level `var DB *sql.DB`, set in `main` after `Open`.
  - `config.Rt` -- package-level singleton `*RuntimeConfig`, set by
    `LoadRuntimeConfig`. The struct + mutex + typed setters are KEPT (genuine
    in-memory singleton); only the pointer-threading through constructors is
    removed. Its internal `db` field uses the global `database.DB`.
- Handlers become package-level route funcs: `func RegisterRoutes(rg)` plus
  unexported `func handlerName(c *gin.Context)`. No `Handler` struct.
- `collections.OnCollectionChanged` becomes a package-level `var`.
- `server` becomes fully package-level: `server.Setup(webFS)` builds the engine
  and mounts routes; `server.Run()` runs it. No `Server` struct.
- New `internal/lifecycle` package holds `StartupActions()` and
  `ShutdownCleanup()` so `main.go` stays lean. (Name: lifecycle.)
- Non-global cross-package collaborators keep flowing through `New` for the
  genuine stateful objects for now; revisit after first cut.
- Acceptance bar per step: `./build.sh` compiles green. User does manual
  runtime testing.

## Classification

### KEEP as struct + New (genuine state)
- `queue.Queue` -- goroutine, channels, atomics, mutex.
- `scheduler.Scheduler` -- cron runner, job maps, mutex.
- `geo.RateLimiter` -- persisted counters, mutex.
- `frames.Manager` -- in-memory frame state, SSE clients, mutexes.
- `jobs.FileWatcher`, `jobs.ScheduledIndexing` -- fsnotify watchers / cron
  handles, live maps.
- `indexing.Indexer` -- orchestrator holding queues + collaborators + logger.
- `indexing.Organizer` -- holds config + db; review whether it can be funcs
  (has no mutable runtime state beyond injected deps). Tentatively KEEP but
  drop db/config params (globals). Revisit.
- `config.RuntimeConfig` -- singleton, keep struct/methods, expose as `config.Rt`.

### COLLAPSE to package-level funcs
DB wrappers (hold only `*sql.DB`): convert methods to package funcs on global
`database.DB`, delete struct + `New*DB`:
- `collections.CollectionsDB`
- `albums.AlbumsDB`
- `search.SearchDB`
- `indexing.IndexingDB`
- `frames.FramesDB`
- `ml.MLDB`
- `geo.GeoDB`
- `auth.AuthDB`
- `dashboard` (handler holds only conn)

Handlers (hold only a service/manager pointer): convert to package-level
`RegisterRoutes` + unexported handler funcs:
- `collections.Handler`, `albums.Handler`, `search.Handler`, `media.Handler`,
  `dashboard.Handler`, `indexing.Handler`, `geo.Handler`, `ml.Handler`,
  `items.Handler`, `frames.Handler`, `authn.Handler`,
  `admin.ConfigHandler`, `admin.UsersHandler`, `admin.JobsHandler`.

Services (stateless business logic): fold into package-level funcs:
- `collections.Service`, `geo.Service`, `ml.Service`.
- `auth.Service` -- holds `jwtSecret` (from startup config) + db. Options:
  keep as a thin singleton (`auth.JWTSecret` package var set at startup) with
  package-level funcs, since CLI commands (`create-user` etc.) reuse it. Decide
  during Phase 3.

## Phases (incremental; compile after each)

- Phase 0: Add `database.DB` global + `config.Rt` singleton. Wire in `main`.
  Keep everything else working (constructors can read globals internally as a
  bridge, or keep taking params until their phase). Compile.
- Phase 1: Collapse DB wrappers -> package funcs on `database.DB`. Update
  callers (services/handlers/stateful objects). Compile.
- Phase 2: Collapse Handlers -> package-level route funcs. Update `server`
  wiring incrementally. Compile.
- Phase 3: Collapse Services -> package funcs. Resolve `auth.Service`. Compile.
- Phase 4: Trim genuine stateful objects' constructors to drop db/config
  params (now global). Compile.
- Phase 5: Add `internal/lifecycle` (StartupActions/ShutdownCleanup). Slim
  `server` to package-level `Setup`/`Run`. Slim `main.go`. Compile.

## Status

- [x] Phase 0
- [ ] Phase 1
- [ ] Phase 2
- [ ] Phase 3
- [ ] Phase 4
- [ ] Phase 5

## Resume notes

(Update this section at the end of each session: what was done, what compiles,
what is next, any surprises.)

- Plan agreed with user on 2026-09-22. Lifecycle package name confirmed.
- Phase 0 DONE (compiles green: `go build -tags "fts5 sqlite_math_functions"
  ./...` exit 0; `go vet` on touched packages exit 0):
  - `internal/database/database.go`: added package-level `var DB *sql.DB`, set
    in `Open` (`DB = conn`). Renamed the old wrapper struct `DB` -> `dbHandle`
    and added exported alias `type DBHandle = dbHandle` so the 3 existing
    callers keep compiling. Receivers/literal updated (`(d *dbHandle)`,
    `&dbHandle{...}`). This wrapper is a temporary bridge; removed in Phase 5.
  - `internal/config/runtime.go`: added package-level `var Rt *RuntimeConfig`,
    published at end of `LoadRuntimeConfig` (`Rt = rc`). Struct + mutex +
    setters unchanged (genuine singleton).
  - Callers updated to `*database.DBHandle`: `internal/server/server.go` (field
    + `New` param), `main.go` (`cliDB`).
  - NOTE: globals are set but not yet consumed anywhere; existing constructors
    still thread db/config. Phase 1+ will switch consumers over to the globals
    then delete the wrappers/params.
- NEXT: Phase 1 -- collapse the 9 DB wrappers to package-level funcs on
  `database.DB`. Start with a leaf package (e.g. `albums` or `dashboard`) to
  keep the blast radius small, compile, then proceed.

