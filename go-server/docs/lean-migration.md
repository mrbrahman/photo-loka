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
- [x] Phase 1
- [x] Phase 2
- [x] Phase 3
- [x] Phase 4
- [x] Phase 5

Migration COMPLETE. All phases green.

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

- Phase 1 DONE (compiles green: `go build -tags "fts5 sqlite_math_functions"
  ./...` exit 0; `go vet ./...` exit 0; `./build.sh` produces the binary).
  All 9 DB wrappers removed; grep confirms NO leftover `*DB` type refs or
  `New*DB` constructors.
  - DB wrappers -> package-level funcs using `database.DB`, structs +
    constructors deleted: `albums`, `search`, `frames`, `geo`, `ml`, `auth`,
    `collections`, `indexing`. Plus `dashboard` and `media` handlers dropped
    their `*sql.DB` field/param (still use global `database.DB`); their Handler
    structs remain for Phase 2.
  - Consumers updated to call package funcs directly (dropped the wrapper
    fields/params they only carried for db access):
    * `collections.Service`: now an empty struct delegating to package funcs
      (`NewService()` takes no args). Fully collapsed in Phase 3.
    * `ml.Service`, `auth.Service`: dropped `db` field/param; call same-package
      funcs. `auth.Service` still holds `jwtSecret` (Phase 3 -> package var).
    * `geo.Finalizer`: dropped `db` field/param (kept rateLimiter/geonamesUser).
    * `frames.Manager`: dropped `db` + `searchDB` fields; calls `search.*` and
      same-package frame funcs.
    * `indexing.Indexer`: dropped `db` + `collectionsDB` fields AND the
      `DB() *IndexingDB` accessor; calls same-package indexing funcs and
      `collections.*`. `indexing.Organizer`: dropped `db` field.
    * `jobs.FileWatcher`, `jobs.ScheduledIndexing`: dropped `colDB`.
    * `admin.JobsHandler`, `items.Handler`, `albums.Handler`, `search.Handler`:
      dropped `colDB`/`collectionsDB`; `items.Handler` now calls `indexing.*`
      instead of `h.indexer.DB().*`.
  - main.go constructor calls simplified accordingly; `collectionsDB`,
    `indexingDB`, `albumsDB`, `searchDB`, `authDB`, `mlDB`, `geoDB`, `framesDB`
    vars all removed. `LoadRuntimeConfig(db.Conn)` remains (config loader still
    takes the conn; the singleton owns its own handle for setters).
  - LESSON: bulk sed on receivers is error-prone -- inconsistent replacement
    (`(recv *T) ` -> `(` vs ``) left stray `func (Name(` in geo/search/frames;
    fixed with a follow-up sed. Verify `func \([A-Z]` and `func \([a-z]` after
    each sed pass.
- NEXT: Phase 2 -- collapse the Handler structs to package-level RegisterRoutes
  + unexported handler funcs. Handlers currently still carry non-db collaborators
  (organizer, mlClient, indexer, frameManager, scheduler, authSvc, rtConfig,
  thumbsDir/facesDir). Decide per-handler: package vars vs keep-as-struct. Update
  `server.go` wiring as each handler collapses. `collections.OnCollectionChanged`
  -> package var.

- Phase 2 DONE (compiles green: `go build`/`go vet -tags "fts5
  sqlite_math_functions" ./...` exit 0; `./build.sh` exit 0). grep confirms NO
  `type *Handler struct` and NO `New*Handler` constructors remain.
  - All 14 handlers collapsed to package-level `RegisterRoutes(rg, ...deps)` +
    unexported handler funcs. Handler struct + New*Handler deleted.
  - Collaborator pattern: `RegisterRoutes` takes the collaborators as params,
    stores them in package-level vars, then mounts routes. Runtime config uses
    the `config.Rt` singleton directly (admin config handler, indexing, items).
    Package vars used: geo/ml `svc`; authn/admin `authService`; collections
    `svc` + `OnCollectionChanged`; albums `organizer`; search `mlClient`;
    indexing `indexer`/`indexQueue`/`videoQueue`; frames `manager`; items
    `organizer`/`mlService`/`thumbsDir`/`logger`; media `thumbsDir`/`facesDir`.
  - admin package had 3 handlers sharing one package -> renamed the register
    funcs to avoid collision: `RegisterConfigRoutes`, `RegisterUsersRoutes`,
    `RegisterJobsRoutes`. Jobs collaborators use prefixed package vars
    (`jobsScheduler`, `jobsFileWatcher`, `jobsScheduledIdx`, `jobsFrameManager`).
  - `items` dropped its unused `indexer` field entirely (it calls `indexing.*`
    package funcs directly).
  - server.go: `Server` struct slimmed to `{Router, Config}`. Added a `Deps`
    struct bundling collaborators; `New(cfg, deps, webFS)` + `setupRoutes(deps)`
    call each package's `RegisterRoutes`. Dropped the 18-param New and all
    `*Handler` fields. (Full package-level server is Phase 5.)
  - main.go: removed all `xHandler := ...NewHandler(...)` vars; builds a
    `server.Deps{...}` from the collaborators. `collections.OnCollectionChanged`
    set as package var. Dropped now-unused imports (admin, albums, authn,
    dashboard, items, search).
  - LESSON (again): sed `func (h *Handler) ` -> `func ` also rewrites the
    RegisterRoutes body's method-value route regs incorrectly is NOT the issue;
    the real gotcha was internal helper method calls (`h.permanentlyDeleteItems`,
    `h.handleAISearch`, `h.queryLibraryStats`) that sed's collaborator-prefix
    replacements miss. Always grep `\bh\.[a-zA-Z]` per file after conversion.
- NEXT: Phase 3 -- collapse the remaining Services to package funcs:
  `collections.Service` (already an empty delegating struct -> remove, callers
  use package funcs), `geo.Service`, `ml.Service`. Resolve `auth.Service`:
  make `auth.JWTSecret` a package var set at startup and convert methods to
  package funcs (CLI create-user/generate-token also use it). Update the handler
  package vars that currently hold `*Service` to call the package funcs instead,
  and drop the `svc`/`authService` indirection + the RegisterRoutes service
  params. Update server.Deps + main.go accordingly.

- Phase 3 DONE (compiles green: `go build`/`go vet -tags "fts5
  sqlite_math_functions" ./...` exit 0; `./build.sh` exit 0). grep confirms NO
  `type Service struct` / `func NewService` in collections/geo/ml/auth.
  - All 4 services collapsed to package-level funcs. Each package now holds its
    collaborators as package vars set once via an `Init(...)` func (auth, geo,
    ml) or uses globals directly (collections uses database.DB).
  - auth: `Init(secret)` sets package `jwtSecret`; `logger` is a package var.
    All Service methods -> package funcs (Login, RefreshAccessToken, Logout,
    VerifyAccessToken, CreateUser, UnlockUser, GenerateAPIToken, GetAllUsers,
    UpdateUserRole, CleanupExpiredTokens). Middleware `AuthMiddleware()` /
    `MediaAuthMiddleware(frameChecker)` dropped the `*Service` param.
  - geo: `Init(finalizer, queue)` sets package vars `finalizer`/`geoQueue`;
    Enqueue/EnqueueMany/Status/QueueSizes -> package funcs.
  - ml: `Init(client, faces, thumbs)` sets package vars; service methods ->
    package funcs.
  - collections: Service removed; validated `Create`/`Update` + `ListSubDirs`/
    `IsValidDir`/`SetIntakeStatus`/`SetAllIntakeStatus` are package funcs in
    service.go; passthroughs (Get/GetAll/GetDefault/GetSummary) call db funcs
    directly from the handler.
  - COLLISION RESOLUTION (recurring theme): where a service func and a db func
    shared a name in the same package, the raw db-layer func was renamed to an
    unexported name and the exported package func is the business entry point:
    * auth/db.go: CreateUser->insertUser, GetUserByUsername->getUserByUsername,
      IncrementFailedAttempts->incrementFailedAttempts, LockUser->lockUser,
      UnlockUser->clearUserLock, ResetFailedAttempts->resetFailedAttempts,
      SaveRefreshToken->saveRefreshToken, GetRefreshToken->getRefreshToken,
      DeleteRefreshToken->deleteRefreshToken,
      CleanupExpiredTokens->deleteExpiredTokens, GetAllUsers->getAllUsers,
      UpdateUserRole->updateUserRole. (Cross-package callers only use the
      exported service-level funcs, so this is safe.)
    * collections/db.go: Create->insertCollection, Update->updateCollectionRow,
      SetIntakeStatusByIndex->setIntakeStatusByIndex,
      SetAllIntakeStatus->setAllIntakeStatusRows. (Cross-package still uses
      exported Get/GetAll/GetByIntakePath/SetIntakeStatusByMethod.)
    * ml/db.go: GetItemForRecognition->getItemForRecognition,
      SaveFaceResults->saveFaceResults, GetFacesByUUID->getFacesByUUID,
      GetFacesByPerson->queryFacesByPerson (extra rename to dodge the handler's
      getFacesByPerson route func), NameFaceCluster->nameFaceClusterDB,
      UpdatePersonName->updatePersonNameDB, SearchPersonNames->searchPersonNamesDB,
      DismissCluster->dismissClusterDB, UndismissCluster->undismissClusterDB,
      DeleteFaceData->deleteFaceData.
  - indexing.Indexer: dropped `geoService`/`mlService` fields + SetGeoService/
    SetMLService; pipeline calls `geo.Enqueue` and `ml.ProcessFaceRecognition`
    directly. The old `!= nil` "is enrichment wired" guards were removed (geo/ml
    are always initialized now); the ML face-recognition guard keeps the
    `config.Rt.PerformFaceRecognition` check.
  - handlers: authn/admin.users drop authService var+param -> call `auth.*`;
    ml/geo drop `svc` var -> call package funcs; collections drops `svc`.
    RegisterRoutes signatures updated (no service params).
  - server.Deps: dropped AuthService, CollectionsSvc, MLService, GeoService.
    Middleware calls updated to no-param form. main.go: `auth.Init`, `geo.Init`,
    `ml.Init`; removed collectionsSvc/geoService/mlService vars; CLI uses
    `initAuthCLI()` + `auth.CreateUser/UnlockUser/GenerateAPIToken`; `closeDB()`
    is now no-arg.
  - LESSON: recursive self-call is the trap when a package func and the db func
    it wraps share a name after receiver-strip (e.g. `func UnlockUser` calling
    `UnlockUser`). Grep `return <Name>\(` / `:= <Name>\(` in the collapsed
    service file to catch these before compiling.
- NEXT: Phase 4 -- trim the genuine stateful constructors to drop db/config
  params now that both are global. Candidates: `indexing.Indexer`/`Organizer`
  and `jobs.*`/`frames.Manager` still take `*config.RuntimeConfig` (use
  `config.Rt`). `geo.NewRateLimiter` takes rtConfig too. Review each: replace
  the threaded `cfg`/`rtCfg` param with `config.Rt`. Keep the genuine runtime
  state (queues, watchers, cron, in-memory maps). Then Phase 5: internal/lifecycle
  + package-level server + slim main.go.

- Phase 4 DONE (compiles green: `go build`/`go vet -tags "fts5
  sqlite_math_functions" ./...` exit 0; `./build.sh` exit 0). grep confirms NO
  constructor takes `*config.RuntimeConfig` and NO struct field is of that type
  (only the `LoadRuntimeConfig(db *sql.DB)` loader signature + `config.Rt`
  reads remain).
  - Only 3 constructors still threaded `*config.RuntimeConfig` (db was already
    globalized in Phase 1): `geo.NewRateLimiter`, `indexing.NewIndexer`,
    `indexing.NewOrganizer`. Each dropped the field + param and now reads the
    `config.Rt` singleton at use time:
    * geo.RateLimiter: dropped `rtConfig` field; `Check`/status read
      `config.Rt.GeonamesHourlyLimit`/`GeonamesDailyLimit`.
    * indexing.Indexer: dropped `config` field; pipeline reads
      `config.Rt.VideoEncoder` / `config.Rt.PerformFaceRecognition`.
    * indexing.Organizer: dropped `config` field; reads `config.Rt.AuditFiles`.
  - main.go: `indexing.NewOrganizer()`, `indexing.NewIndexer(org, idxQ, vidQ,
    thumbsDir)`, `geo.NewRateLimiter(stateFile)` -- all lost their rtCfg arg.
    The local `rtCfg` (from LoadRuntimeConfig) is still used for one-time startup
    reads (MaxConcurrency, StartFileWatcher/ScheduledIndexingAtStartup); it is
    the same pointer as config.Rt. Left as-is; Phase 5 slims main further.
  - Genuine runtime state kept as struct+New: queue.Queue, scheduler.Scheduler,
    geo.RateLimiter (counters+state file), frames.Manager (in-memory frame
    state/SSE), jobs.FileWatcher/ScheduledIndexing (fsnotify/cron handles),
    indexing.Indexer/Organizer (queues, organizer collaborator).
- NEXT: Phase 5 -- add `internal/lifecycle` with StartupActions()/
  ShutdownCleanup() to move the startup/shutdown orchestration out of main
  (start watchers, schedule frames/token-cleanup cron; stop queues, save rate
  limiter). Slim `server` to package-level Setup/Run (drop the Server struct).
  Slim main.go to: load config -> set globals -> init vips/exiftool/db ->
  build collaborators -> lifecycle.StartupActions -> server.Run ->
  lifecycle.ShutdownCleanup. Also remove the temporary database.DBHandle alias
  and the dbHandle wrapper if nothing needs it after main is slimmed (main/CLI
  use db.Close()); consider returning just error from Open and exposing a
  package-level Close().

- Phase 5 DONE (compiles green: `go build`/`go vet -tags "fts5
  sqlite_math_functions" ./...` exit 0; `./build.sh` exit 0; `gofmt -l .` clean).
  MIGRATION COMPLETE.
  - Added `internal/lifecycle` (lifecycle.go): `Deps` bundles the stateful
    collaborators (scheduler, watchers, frame manager, rate limiter, 3 queues);
    `StartupActions(d, cleanupTokens func())` runs watcher/scheduled-indexing
    start-or-mark-stopped per config.Rt, LoadAllFrames, ScheduleAllFrameJobs,
    and registers the daily token-cleanup cron; `ShutdownCleanup(d)` stops
    scheduler/watchers/queues and saves the rate limiter.
  - server: dropped the `Server` struct. Package-level `router *gin.Engine` +
    `cfg *config.StartupConfig` vars set by `Setup(cfg, deps, webFS)`;
    `setupRoutes(deps)` is a package func; `Run()` is a package func. Deps
    struct unchanged (still threads the non-singleton collaborators that
    RegisterRoutes needs).
  - database: removed the temporary `dbHandle` struct + `DBHandle` alias.
    `Open(dbFile) error` now publishes the package-level `DB` and runs
    migrations (runMigrations is a package func using `DB`); added package-level
    `Close()`. main/CLI use `database.Open`/`database.Close`/`database.DB`.
  - main.go runServe is now a clean linear sequence: preflight -> load startup
    config -> init vips/exiftool -> database.Open -> LoadRuntimeConfig (sets
    config.Rt) -> auth.Init/geo.Init/ml.Init -> create queues/indexer/scheduler/
    frames/jobs -> wire collections.OnCollectionChanged -> resolve webFS ->
    server.Setup -> lifecycle.StartupActions -> server.Run ->
    lifecycle.ShutdownCleanup. Dropped the local rtCfg var (uses config.Rt);
    CLI initAuthCLI/closeDB use the package-level database API.
  - CLEANUP: ran `gofmt -w main.go internal/` to fix alignment/spacing drift
    left by earlier phases' sed edits (struct-tag alignment, redundant parens,
    blank lines). `gofmt -l .` now reports nothing.

## Final state

- `database.DB` (global *sql.DB) and `config.Rt` (singleton *RuntimeConfig) are
  the two global resources. No wrapper types.
- Handlers: package-level `RegisterRoutes(rg, ...deps)` + unexported funcs.
- Services: collapsed to package funcs; auth/geo/ml expose `Init(...)` to set
  their package-level collaborators; collections uses the db funcs directly.
- Genuine "classes" kept as struct+New: queue.Queue, scheduler.Scheduler,
  geo.RateLimiter, geo.Finalizer, frames.Manager, jobs.FileWatcher/
  ScheduledIndexing, indexing.Indexer/Organizer, ml.Client.
- server + lifecycle are package-level (Setup/Run, StartupActions/
  ShutdownCleanup). main.go is a lean linear boot sequence.
- Verification each phase and final: `go build` + `go vet -tags "fts5
  sqlite_math_functions" ./...` exit 0, `./build.sh` produces the binary,
  `gofmt -l .` clean. No automated tests exist (per project); user does manual
  runtime testing.

