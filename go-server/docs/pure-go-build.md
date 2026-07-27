# Future: Pure Go Build (no CGO)

The current build requires CGO (C compiler + system libraries) because of:
- `mattn/go-sqlite3` — compiles SQLite from C source
- `govips` — binds to libvips C library

This makes cross-compilation difficult and requires build-time deps (gcc, pkg-config, libvips-dev).

## Pure Go alternatives

| Current (CGO) | Pure Go alternative | Performance cost |
|---|---|---|
| `mattn/go-sqlite3` | `modernc.org/sqlite` | ~2x slower (negligible for this workload) |
| `govips` (libvips) | `disintegration/imaging` | ~4-8x slower for image resize |

## What switching would enable

- **No C compiler needed** — `go build` just works on any machine
- **True cross-compilation** — build for Linux/Mac/Windows/ARM from any platform
- **Simpler CI** — no `apt install` step in GitHub Actions
- **Single command install** — users just `go install` or download a pre-built binary

## Migration path

1. Replace `mattn/go-sqlite3` with `modernc.org/sqlite` (API is nearly identical, mostly import path changes)
2. Replace `govips` with `disintegration/imaging` for thumbnail generation
3. For on-the-fly `getImage` resize: either accept slower resize (~50-100ms instead of ~10-20ms) or pre-generate a "view size" (1920px) thumbnail during indexing so `getImage` just serves a file
4. Remove `-tags "fts5 sqlite_math_functions"` build flag (`modernc.org/sqlite` enables FTS5 and math functions by default)
5. Remove `build-essential`, `pkg-config`, `libvips-dev` from prerequisites

## When to do this

When distribution to other users becomes a priority. For single-server personal use, the current CGO approach gives best performance with no downside.
