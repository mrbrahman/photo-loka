# Go Server Architecture Reference

## Overview

The Go server is a complete port of the Node.js Photo-Loka backend. It compiles to a single 19 MB binary with no runtime dependencies (aside from exiftool and ffmpeg for media processing).

**Build:** `go build -tags "fts5" -o photo-loka .`

**Run modes:**
- `./photo-loka serve` - starts the HTTP server (default)
- `./photo-loka create-user --username X --password Y --role admin|user`
- `./photo-loka unlock-user --username X`
- `./photo-loka generate-token USERNAME [DAYS]`

**Key dependencies:**
- `gin` - HTTP framework
- `mattn/go-sqlite3` - SQLite with FTS5 support (requires `-tags "fts5"`)
- `golang-jwt/jwt` - JWT authentication
- `golang.org/x/crypto/bcrypt` - password hashing
- `lmittmann/tint` - colored structured logging
- `joho/godotenv` - .env file loading
- `fsnotify` - file system watching (replaces chokidar)
- `robfig/cron` - cron scheduling (replaces node-cron)
- `google/uuid` - UUID generation

---

## Package Map

### internal/config/

| File | Purpose |
|------|---------|
| `startup.go` | Loads .env via godotenv. Struct: DataDir, ThumbsDir, FacesDir, DBFile, JWTSecret, MLServiceURL, IndexerMode, GeonamesUsername, LogLevel, NoColor, Port. Validates required vars (DATA_DIR, JWT_SECRET). |
| `runtime.go` | Reads/writes runtime-config.json from DataDir. Thread-safe (RWMutex). Fields: StartFileWatcherAtStartup, StartScheduledIndexingAtStartup, ScanFilesForChangesAndIndexAtStartup, FilesDeletedThreshold, AuditFiles, GeonamesHourlyLimit, GeonamesDailyLimit, VideoEncoder, MaxConcurrency, PerformFaceRecognition. Update() modifies field by JSON key name using reflect and persists to file. |

### internal/database/

| File | Purpose |
|------|---------|
| `database.go` | Opens SQLite with WAL mode, NORMAL sync, 5s busy timeout. Creates parent dir if needed. Runs migrations based on PRAGMA user_version. Embeds SQL files via `//go:embed`. |
| `migrations/010-initial-schema.sql` | Full schema: collections, metadata (with indexes), FTS5 tables (porter + unicode), triggers (ai/ad/au for FTS sync), exif_updates, file_audit_log, backup_status, frames, users, refresh_tokens, face_recognition, face_recognition_unmatched, face_dismissed_clusters. |
| `migrations/011-geo-lookups.sql` | geo_lookups table (uuid, source, api_name, request_params, response_json). |
| `migrations/012-capture-time-columns.sql` | Adds capture_date, capture_time, capture_tz_offset, capture_tz_name to metadata. |

### internal/auth/

| File | Purpose |
|------|---------|
| `errors.go` | AppError struct (Message, Code, StatusCode). Pre-defined: ErrInvalidCredentials (401), ErrAccountLocked (403), ErrInvalidToken (401), ErrUserNotFound (404). |
| `db.go` | AuthDB wrapping *sql.DB. User and RefreshTokenRecord structs. CRUD for users table + refresh_tokens. Methods: CreateUser, GetUserByUsername, IncrementFailedAttempts, LockUser, UnlockUser, ResetFailedAttempts, SaveRefreshToken, GetRefreshToken (joins users, checks expiry), DeleteRefreshToken, CleanupExpiredTokens, GetAllUsers, UpdateUserRole. |
| `service.go` | Business logic. Constants: 15min access token, 30-day refresh, 5 max failed attempts, bcrypt cost 10. Methods: CreateUser (bcrypt hash), Login (validate + generate token pair), RefreshAccessToken (sliding expiration), Logout, VerifyAccessToken (jwt.ParseWithClaims), UnlockUser, GenerateAPIToken (long-lived JWT), GetAllUsers, UpdateUserRole, CleanupExpiredTokens. Helpers: generateAccessToken, generateRefreshToken (crypto/rand 64 bytes hex), hashToken (SHA-256). |
| `middleware.go` | AuthMiddleware: extracts Bearer token from Authorization header, falls back to refreshToken cookie (for image/media requests), verifies JWT, sets userId/username/role in gin.Context. AdminMiddleware: checks role == "admin". GetUserFromContext helper. |

### internal/authn/

| File | Purpose |
|------|---------|
| `handler.go` | Public auth routes (no middleware). POST /login (sets httponly refreshToken cookie, returns accessToken + user). POST /refresh (reads cookie, issues new pair, sets new cookie). POST /logout (invalidates token, clears cookie). |

### internal/server/

| File | Purpose |
|------|---------|
| `server.go` | Server struct holds all handlers. New() sets gin.ReleaseMode, adds Recovery, request logger (skips thumbnail/asset requests), static file serving (../web with no-cache). setupRoutes() wires: public (/api/authn, /frame), authenticated (/api with auth middleware), admin (/api/admin with auth+admin). Run() starts listener with graceful shutdown on SIGINT/SIGTERM (10s timeout). Health and ping endpoints. |

### internal/collections/

| File | Purpose |
|------|---------|
| `db.go` | CollectionsDB. Collection struct (IntakeConfigs as json.RawMessage). CRUD: Create (with json() for intake_configs), Update, GetAll, Get, GetDefault, GetSummary, GetByIntakePath (json_each), SetIntakeStatusByIndex, SetAllIntakeStatus. |
| `service.go` | Validation layer. Validates: path exists + is dir, album_type in (FOLDER_ALBUM, VIRTUAL_ALBUM), intake methods in (immediate, scheduled, on-demand). ListSubDirs, IsValidDir helpers. |
| `handler.go` | Public: GET /collections (summary). Admin: GET /getAllCollections, POST /createNewCollection, PUT /updateCollection/:id, GET /listSubDirs, POST /validateFolderPattern, POST /setIntakeStatus/:collection_id/:intakeIndex, POST /setAllIntakeStatus/:collection_id. |

### internal/albums/

| File | Purpose |
|------|---------|
| `db.go` | AlbumsDB. SearchForExisting (FTS porter match on album_name, excludes placeholder, limit 10). UpdateAlbumName (direct rename + nested prefix rename, rewrites filename column). |
| `handler.go` | POST /updateAlbumName (body: collection_id, album_date, currAlbumName, newAlbumName). |

### internal/search/

| File | Purpose |
|------|---------|
| `query_builder.go` | Ports the FTS5 query parser. textCols (porter: album_name, description, keywords), metaCols (unicode: filename, mimetype, mediatype, faces, make, model, geo_address, album_date). Aliases map. BuildFilter(): splits by spaces (respecting quotes), resolves aliases, routes to broad/text/meta/other buckets, builds subquery pattern with rowid IN (SELECT rowid FROM fts_table WHERE MATCH ...). Supports: key:value, logical (AND/OR), rating, private, uuid, raw. |
| `db.go` | SearchDB. RunSearch: builds SQL with json_object() item select (albumDate, albumName, data:{ar, id, type, rating, dur, hasGps, hasDesc, hasTags, private, t, hasTime, localTime, tzOffset, tzName}). Supports day-grouped (CTE + json_group_array) and flat modes. Date range filter. GetItemInfo (full metadata + face_details subquery). GetGpsCoordinates (rounded, grouped). SearchByGps (bounding box via raw filter). |
| `handler.go` | GET /getAll (default 365-day window), POST /search, GET /getItemInfo, GET /getGpsCoordinates, GET /searchForExistingAlbums, POST /searchByGpsCoordinates, GET /getTrashedItems. |

### internal/media/

| File | Purpose |
|------|---------|
| `handler.go` | Serves media files. GET /getThumbnail (uuid first 3 chars as subdirs, height bucket 100/250/500). GET /getImage (serves original from DB filename). GET /getVideo (range streaming via http.ServeContent, tries compressed variants first). GET /getFaceThumbnail (facesDir/cluster_id/uuid.jpg). |
| `exif.go` | ExifData struct with all metadata fields. ExtractMetadata: shells out to `exiftool -json -n -G -struct`, parses grouped keys (EXIF:Make, File:FileSize, etc.), handles aspect ratio correction for orientation. CaptureDateTime struct. WriteMetadata: shells out to exiftool with -overwrite_original. |
| `thumbnail.go` | Creates thumbnails via ffmpeg. 5 sizes (20/100/250/500 fit + 50x50 center). Output: thumbsDir/u/u/i/uuid_height_suffix.jpg. GenerateVideoThumbnail: ffmpeg -vframes 1. DeleteThumbnails. |
| `video.go` | CompressVideo: dispatches to VP8 (2-pass libvpx), VP9 (2-pass libvpx-vp9), Hardware H.264/H.265/AV1 (nvenc/qsv/amf), Software H.264 (libx264). ResolveVideoPath: checks compressed variants (vp9 2-pass > vp8 2-pass > compressed > original). DeleteCompressedVideo. runFFmpeg helper. |

### internal/dashboard/

| File | Purpose |
|------|---------|
| `handler.go` | GET /getStats. Runs two queries: library stats (total items/size/albums/trashed, counts by type using CASE WHEN) and collection stats (items + size per collection). Adds disk free space via syscall.Statfs. Returns LibraryStats JSON. |

### internal/queue/

| File | Purpose |
|------|---------|
| `queue.go` | Priority task queue. Three priority levels (High, Normal, Low) stored as slices. Buffered channel as semaphore for concurrency limiting. Dispatch goroutine dequeues highest priority, acquires sem slot, runs task in new goroutine. Pause/Resume (atomic bool + channel signaling). SetConcurrency (replaces sem channel). Status/Errors tracking. Errors capped at 100. |

### internal/utils/

| File | Purpose |
|------|---------|
| `pattern.go` | Folder pattern engine. Tokens: {{yyyy}}, {{yy}}, {{mm}}, {{dd}}, {{album}} (must be last, greedy). FormatPattern: replaces tokens with values, pads numeric, trims trailing whitespace if album empty. ParsePattern: builds regex from pattern, captures values. Returns nil if no match. |
| `filefilter.go` | ShouldIgnoreFile: returns true if basename starts with . or #, ends with __ or ~, or contains compressed_video. |

### internal/indexing/

| File | Purpose |
|------|---------|
| `db.go` | IndexingDB. InsertMetadata (dynamic SQL from map), UpdateMetadata, DeleteMetadata, GetIndexedFiles, GetFileName, GetFileNames, TrashItem, UntrashItem, MarkPrivate, UnmarkPrivate, UpdateDescription, UpdateFilename, UpdateRating (transactional), ScheduleExif (transactional insert into exif_updates), FileAudit, FileAuditBatch (transactional). |
| `organizer.go` | File placement and operations. PlaceFileInCollection: in-place (ParsePattern on folder) vs intake (FormatPattern + move file). RenameAlbumFolder (compute old/new paths via pattern, os.Rename). AlbumFolderAbsPath. MoveItem (os.Rename with EXDEV cross-device fallback: copy + delete). MoveFileToTrash (prefix with .Trash_). RestoreFromTrash (remove .Trash_ prefix). MarkFilePrivate (prefix with .). UnmarkFilePrivate. ListAllFiles (recursive walk). GetFilesMtime (filename -> unix mtime map). |
| `pipeline.go` | Indexer struct (holds DB, organizer, queues, config). IndexFile: the 7-step pipeline - extract exif, place file, generate UUID, derive capture fields (date/time/offset from CaptureDateTime), generate thumbnails (video: extract frame first), queue video compression on videoQueue, insert/update DB. RefreshMetadata. |
| `collection.go` | InitialIndexing: walk collection path, filter ignored, enqueue each file at High priority. ScanForChanges: compare disk mtime vs DB, enqueue added/changed files. RefreshMetadataForCollection: enqueue refresh for all indexed files. |
| `intake.go` | StartIntakeFileIndexing: find files older than staleDays in intake dir, enqueue with inPlace=false. findPendingFiles helper. |
| `metadata.go` | UpdateDescription: update DB + schedule exif write. UpdateRating: update DB + schedule exif write. Both set file_modified_at to prevent re-indexing. |
| `handler.go` | 10 admin endpoints: POST /startIndexingFirstTime, POST /scanForChanges/:id, POST /startIntakeFileIndexing, GET /getIndexerStatus, PUT /pauseIndexer, PUT /resumeIndexer, GET /getIndexerErrors, PUT /updateIndexerConcurrency/:n, POST /refreshMetadataForCollection/:id, POST /refreshMetadataForItem/:uuid. Async operations return 202. |

### internal/geo/

| File | Purpose |
|------|---------|
| `db.go` | GeoDB. Cache lookups: GetGeoContext (GPS + country from metadata+geo_lookups), FindExactGeoMatch (ROUND to 4 decimals), FindProximityGeoMatch (haversine < 10m), FindPostalCodeMatch. InsertGeoLookup. UpdateGeoFields (COALESCE for country/country_code to preserve existing). UpdateGeoStatus. |
| `ratelimiter.go` | RateLimiter with hourly+daily counters, auto-reset on hour/day change. Persists state to JSON file. Check() returns false when limits reached. Increment(). Save(). Status(). |
| `finalizer.go` | FinalizeGeo: derives missing fields from DB, routes US vs non-US. Non-US: reads exiftool geolocation from geo_lookups, builds "City, Subregion, Region, Code, Country" address. US: exact match -> proximity match -> geonames findNearestAddress API -> postal code lookup for city resolution. Stores all API responses in geo_lookups for caching. |
| `service.go` | Queue wrapper. Enqueue/EnqueueMany wrap finalizer calls as Tasks on a dedicated geoQueue (concurrency=1 due to rate limits). Status() returns queue status. |
| `handler.go` | GET /getReverseGeoEncodingStatus, POST /enqueueReverseGeoEncoding, POST /enqueueManyReverseGeoEncoding. |

### internal/ml/

| File | Purpose |
|------|---------|
| `client.go` | HTTP client to external ML service. RecognizeFaces (POST /faces/recognize), NameFaceCluster (PUT /faces/:id), UpdatePersonName (POST /faces/update-name), GetFaceSuggestions (GET /faces/suggestions), SearchByText (POST /search/text), CleanupMLData (DELETE /images/:uuid, log-only on failure). |
| `db.go` | MLDB. SaveFaceResults (delete old + insert faces + unmatched + update metadata.faces). GetFacesByUUID/Person. NameFaceCluster (update face_recognition + metadata.faces). UpdatePersonName (same). SearchPersonNames (LIKE, limit 20). DismissCluster/UndismissCluster. DeleteFaceData (returns cluster_ids for thumbnail cleanup). |
| `service.go` | Orchestrates ML client + DB. ProcessFaceRecognition (get item from DB, call client, save results). All face operations: name, rename, suggest, search, dismiss/undismiss. CleanupMLData (DB delete + client cleanup). |
| `handler.go` | 8 endpoints: POST /recognizeFaces/:uuid, GET /getFaces/:uuid, GET /getFacesByPerson, PUT /nameFaceCluster/:clusterId, PUT /updatePersonName, GET /faceSuggestions/:clusterId, GET /searchPersonNames, PUT /dismissFaceCluster/:clusterId. |

### internal/items/

| File | Purpose |
|------|---------|
| `handler.go` | 10 endpoints for item operations. PUT /updateRating (DB + schedule exif). PUT /updateDescription (DB + schedule exif). PUT /renameFile (move file + update DB). PUT /refreshThumbs/:uuid (regenerate, handles video). PUT /compressVideo/:uuid (trigger compression). DELETE /trashItems (prefix .Trash_). PUT /togglePrivate (prefix/unprefix dot). PUT /restoreFromTrash. DELETE /cleanupTrash (delete file + thumbnails + compressed video + ML data + DB row). DELETE /emptyTrash. |

### internal/frames/

| File | Purpose |
|------|---------|
| `db.go` | FramesDB. Frame struct. CRUD: Create, GetAll, GetByID, Update, Delete. |
| `manager.go` | In-memory frame state (map[ip]*FrameState). FrameState: Items, CurrIdx, AutoPause, ManualPause. LoadAllFrames (from DB, init state, schedule jobs). GetNextItem/GetPrevItem (check pause, cycle index). CreateFrame/UpdateFrame/DeleteFrame (DB + state + jobs). PauseFrame/ResumeFrame (manual). SetAutoPause (cron-driven). ReloadItemsForFrame (runs search query). SSE client management (RegisterSSEClient/UnregisterSSEClient/notifySSE). isInPauseWindow (HH:mm-HH:mm range check, supports overnight). |
| `handler.go` | Public (/frame): GET /getNext, GET /getPrev, GET /events (SSE). Admin: POST /createNewFrame, POST /loadAllFrames, GET /getAllFrames, PUT /updateFrame/:id, DELETE /deleteFrame/:id, POST /pauseFrame/:id, POST /resumeFrame/:id. |

### internal/jobs/

| File | Purpose |
|------|---------|
| `watcher.go` | FileWatcher using fsnotify. Watches immediate intake paths. On Create event: small delay for write completion, filter ignored files, enqueue indexFile at High priority. Start/Stop per collection. StartForAllCollections. ListAll (returns active watchers). |
| `scheduled.go` | ScheduledIndexing using scheduler (cron). For each collection's scheduled intakes, adds cron job. Job handler checks indexer is idle before triggering StartIntakeFileIndexing. Schedule/Stop per collection. ScheduleAll. StopAll. |

### internal/scheduler/

| File | Purpose |
|------|---------|
| `scheduler.go` | Wraps robfig/cron. AddJob (name, cron pattern, handler). DeleteJob. DeleteAllJobs. ListAllJobs (returns name + pattern). Stop (stops cron runner). |

### internal/admin/

| File | Purpose |
|------|---------|
| `config_handler.go` | GET /getConfig (returns runtime config JSON). PUT /updateConfig (body: {key, value}, calls RuntimeConfig.Update). |
| `users_handler.go` | GET /users. POST /users (create, validates password >= 8). PATCH /users/:userId/role (prevents self-change). POST /users/:userId/unlock. POST /users/:userId/token (generate API token, default 365 days). |
| `jobs_handler.go` | GET /jobs (builds {watchers, scheduled, frame, system} from collections + scheduler + fileWatcher state). POST /startAllWatchers. POST /stopAllWatchers. |

---

## Startup Sequence

1. Init logging (tint, timestamp based on INVOCATION_ID env)
2. Load startup config (.env)
3. Load runtime config (JSON)
4. Open database (SQLite, run migrations)
5. Create auth service
6. Create queues: indexQueue (CPU-1), videoQueue (2), geoQueue (1)
7. Create all services and handlers
8. Create and start HTTP server
9. Startup activities:
   - Start file watchers (if configured)
   - Schedule cron jobs (if configured)
   - Load all frames
10. Wait for shutdown signal

## Shutdown Sequence

1. Receive SIGINT/SIGTERM
2. Stop HTTP server (10s grace period)
3. Stop scheduler (cron)
4. Stop file watchers
5. Stop scheduled indexing
6. Stop queues (index, video, geo)
7. Close database
8. Exit

## Queue Architecture

Three independent queues, each a `queue.Queue` instance:
- **indexQueue** (CPU-1 workers): metadata extraction, thumbnails, DB insert
- **videoQueue** (2 workers): video compression (heavy, long-running)
- **geoQueue** (1 worker): rate-limited API calls to geonames

Future: configurable DAG pipeline (see docs/pipeline-dag-design.md).

## Route Groups

| Group | Middleware | Purpose |
|-------|-----------|---------|
| `/api/authn` | None | Login, refresh, logout |
| `/frame` | None (IP-based auth for frames) | Frame getNext/getPrev/events |
| `/api` | AuthMiddleware | All authenticated user endpoints |
| `/api/admin` | AuthMiddleware + AdminMiddleware | Admin-only operations |
| `/health` | None | Health check |
| `/ping` | None | Latency check (204) |
| `/*` (static) | None | Serves ../web directory |
