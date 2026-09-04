# Photo-Loka: Your world in photos!

Photo-Loka is (planned to be) a no frills, self-hosted photos app that helps in organizing and more importantly searching your photos.

![Screenshot](web/assets/Screen-Sizes.jpg)

Currently this project is very much a work-in-progress.

Also, many things are rough around the edges, simply because I'm the sole user & developer. In case someone else comes along that finds this beneficial and can contribute, at that time we can make things more 'user-friendly'! :-)

# Philosophy

1. We don't want to use cloud providers for personal photo collection.
2. Some of us really care about our media in folders that we have meticulously curated from a long time. With any tool, we want the ability to continue to manage pics in folders.
3. The single source of truth is the photo itself (*). Hence, we want all metadata, including user tags, ML based face / objects labels etc., to go back to the photo, to the extent possible.
4. In the same vein, we also want the tool to utlize the metadata already existing in the photos (updated by device / other tools).
5. In other words, we don't want to be locked-down by any one particular tool (including this one!).
6. Some kind of sensible, not too constrained search is needed, even though it may (will) not be as good as Google.

(*) For those who are not aware, a photo/video taken by a modern camera/phone not only stores the image/video content, but also metadata about the photo/video. For e.g. GPS coordinates, dimensions, orientation, duration for videos etc. There are also provisions to update metadata when they are discovered. For e.g. recognized faces, address based on reverse geo-coding etc.

# Key Terms
1. **Item**: The individual media item (photo / video / audio)
2. **Album**: A group of related media items, identified by a date and a descriptive name. For e.g. (`2021-10-01`, `Trip to SVBF`). On disk, these become folders like `2021/2021-10-01 Trip to SVBF` (configurable via the collection's folder pattern).
3. **Collection**: A set of related albums. For e.g. "My family pics", "My small-business pics" etc.
4. **Indexing**: The process of reading media and cataloging metadata to help with search. Also thumbnail generation.

# Current Features

## Media Management
- Support for existing folders and files: Read existing folder structure (specificed during collection creation) and index the files found (if any) under respective collections
- Support for new files: 
    * Immediate indexing - Watch one or more 'listen' folders for new files, and as new files become available, bring them into the respective collection and index them
    * Delayed indexing - Schedule a daily 'cron' to watch the setup 'intake' folders, to bring in files to the collection that are 'x' days stale
- Rename albums (similar to renaming folders on a File Explorer program)
- Select files and move them to a different album
- Select files and trash them (with cleanup of associated ML data)
- Mark items as private (search for `private:true` to find them)
- Backup helper: A helper utility that *incrementally* backs-up all the files into the 'registered' backup drives. See [Backup helper](#backup-helper) section for more information

## Metadata management
- Index media photos, videos and audio
  - Extract key exif data (metadata), and store in SQLite db
  - Thumbnail generation
  - Compress video files into smaller webm files
  - Indexer has the ability to run and gather metadata for multiple files at the same time. See `updateIndexerConcurrency` below
- Mark as favorite / stars (there is no favorite in exif, but there is a 'rating' field)
- Optimize write of metadata to files by delaying the write. This enables grouping all the changes together and writing to file at one go

## Enrichments
- Lookup GPS location
    * First using geolocation api (that comes with exiftool)
    * For US based addresses, use [findNearestAdderss](https://www.geonames.org/maps/us-reverse-geocoder.html#findNearestAddress) API (need a registered username)
- Face recognition
    * Detect and cluster faces in photos
    * Name recognized faces (with auto-suggestions from ML and existing names)
    * Rename a known face or reassign a cluster to a different person

## UI features
- Timeline gallery: a Google-Photos-style day-grouped view with sticky day and album sub-headers, items in reverse chronological order. Album names are editable in place; albums whose name matches the collection's placeholder text (e.g. `TBD`) render in a distinct color so you can find unsorted folders.
- Cluster photos on a map
- Slideshow
- Item info panel - view camera, dates, location (with map), recognized faces, and keywords. Edit filename and description
- View Trash and empty/restore
- Search photos based on their metadata, using SQLite FTS5
    1. Github *like* search features (key value pairs)
       e.g. `album_name:trip camera:samsung type:video` (`album:` is also accepted as an alias for `album_name:`)
    2. When multiple conditions are prsent, by default they are "AND"ed.
        e.g. `album_name:trip camera:samsung type:video`
        will translate as
        `{album_name}: "trip"* AND {camera}: "samsung"* AND {type}: "video"*`
    3. This can be overwritten using the "logical" or "l" input. E.g. `l:or`
    4. The input from "logical" keyword applies to all conditions
        e.g. `album_name:trip camera:samsung type:video l:or`
        will translate as
        `{album_name}: "trip"* OR {camera}: "samsung"* OR {type}: "video"*`
    5. Any un-prefixed condition will be applied to/restricted to all [search-enabled columns](go-server/internal/search/query_builder.go#L15)
    6. For advanced needs (including querying non restricted columns - for e.g. `capture_time`), use the "raw"
       input using SQLite FTS syntax. Thich will be used as-is in the filter.
        e.g.
          - `raw:"metadata match '{album_name}: (states* AND trip*)'"`
          - `raw:"strftime('%W',capture_time)=strftime('%W',date()) and strftime('%Y',capture_time) != strftime('%Y',date())"` (all 'past' photos of current week)
    7. "raw" can be clubbled with other filters, if needed
    8. AI-powered semantic search using image embeddings
       e.g. `ai:"sunset on a beach"` to find visually similar photos

## Flagship feature - Digital Photo Frames!

We take thousands of photos and videos — and rarely see them again.

Traditional digital frames help, but they’re limited by SD cards and manual updates. Content becomes static and quickly outdated.

This system turns any web browser into a centrally managed digital photo frame.

* No SD cards.
* No file copying.
* No device lock-in.

If a device can open a browser — TV, tablet, old laptop, Android TV box — it can become a live photo frame.

All that you do is register the "frame"

![Frame Setup](web/assets/frame-setup.png)

Specify the 
* IP address
* A search crieteria (refer to 'search photos' in [UI features](#ui-features))
* A reset schedule (crontab format) - to auto-refresh the playlist for the frame
* Dailay Pause range - to auto pause the frame during that time period

The frame is setup, and available at `http://<server-ip>/frame.html`

Traditional frames are static and manual. This is dynamic, automated, and server-controlled.

Your memories don’t sit in storage — they stay alive!

## Backup helper

This module helps take backup of the collections to external drives.

When the folders are renamed, backup utilities like `rsync` see them as file-deletions and file-additions. That's a waste of resources especially on large video files. A simple thing could be to just perform `mv` operation on the target backups as well.

That's exactly what this setup aims to help with.

- Register backup device(s) (with UUID of the device)
- All file opertions on a collection are noted in a table
- When it is time to backup to a specific device, all 'delta' operations are determined and applied to the set of files eligible for backup.
- The 'last_backup_id' is noted for each backup.

TODO - sync timestamps on +2 level folders

# Features TODO
**Near future**
- Add/change "tags" (keywords)

**After near future**
- ~~An actual form to setup collections~~ Done!
- ~~Form to update config and save it to persistent storage (file?)~~ Done!
- ~~Monitor indexer progress~~ Done!
- Enable multiple collections
- Ability to upload photos from device
- Intelligent scrollbar (folder levels?)
- Authorization (role-based access control)
- Sharing photos/albums
- In-app self-update: detect a newer release (compare embedded version against
  the latest GitHub release), notify the admin on login (and via email once
  email config exists), then self-replace the binary and exit so systemd
  restarts into the new version (the systemd unit already uses
  `Restart=always`; see [Run the server using systemd](#run-the-server-using-systemd)). Resolve
  the real binary path via `os.Executable()` + `filepath.EvalSymlinks` (so it
  works wherever it is installed, including symlinks) and check that path is
  user-writable first -- warn the admin to update manually if not (e.g. a
  root-owned `/usr/bin` install). This is why `~/.local/bin` is recommended: a
  user service can rewrite it without root.

  Library options to evaluate at build time (the problem has two layers --
  find/compare/fetch the release, and atomically swap the binary):
  - **All-in-one (detect + download + apply):**
    - `creativeprojects/go-selfupdate` -- actively maintained; GitHub/GitLab/Gitea
      releases, semver compare, asset selection, checksums/signatures. Use
      `DetectLatest` for the login/email notification and `UpdateSelf` only on
      an explicit admin action. Caveat: confirm its asset-name filter matches
      the bare `photo-loka` asset (no OS/arch suffix).
    - `rhysd/go-github-selfupdate` -- the older, well-known predecessor; similar
      idea but less actively maintained (creativeprojects is a maintained fork).
  - **Swap only (you fetch the bytes yourself):**
    - `minio/selfupdate` -- atomic replace with rollback and optional
      checksum/signature verification; maintained fork of the classic
      `inconshreveable/go-update`. Pair with a plain HTTP GET of the release
      asset. Best if we want to fully own the detection/notification UX and
      delegate only the risky file swap.
  - **Version compare only (build detection ourselves):**
    - `Masterminds/semver` or `hashicorp/go-version` -- robust semver parsing
      (handles the `v` prefix, prerelease ordering) for comparing the latest
      GitHub `tag_name` against the embedded `main.version`. The GitHub API call
      (`GET /repos/.../releases/latest`) is trivial, so detection may need no
      library beyond this.

  All of these require the target file to be writable by the process (no
  privilege escalation), so the "warn to update manually" path is needed
  regardless of choice.

# How to install and use

The server is a single Go binary. You can either download a prebuilt release or
build it yourself.

- **Install runtime dependencies** (needed on the machine where Photo-Loka runs)

  Photo-Loka shells out to ffmpeg and exiftool, and links the libvips shared
  library at runtime:

  | Dependency | Purpose |
  |-----------|---------|
  | [ffmpeg](https://ffmpeg.org/download.html) | Video thumbnail extraction and compression |
  | [exiftool](https://exiftool.org/) 12.78+ | EXIF metadata read/write, GPS timezone resolution, geolocation |
  | libvips (shared library) | Image operations (thumbnails, resize) and HEIC support, via govips |

  Most of these come straight from your package manager:
  ```bash
  # ffmpeg + libvips runtime library (libvips42t64 on recent Ubuntu/Debian; libvips42 on older)
  sudo apt install ffmpeg libvips42t64
  ```

  **exiftool 12.78+**: the distro package is often too old. Check with
  `exiftool -ver`; if it is below 12.78, install a recent build and put it on
  your `PATH`:
  ```bash
  curl -L "https://sourceforge.net/projects/exiftool/files/Image-ExifTool-13.59.tar.gz/download" -o Image-ExifTool-13.59.tar.gz
  tar -xzf Image-ExifTool-13.59.tar.gz
  export PATH=/path/to/Image-ExifTool-13.59:$PATH   # add to ~/.bashrc to persist
  exiftool -ver   # should show 13.59
  ```

  Note on libvips: it is linked dynamically (via govips/cgo), so the shared
  library must be present at runtime, not just when building. `libvips-dev`
  (build-time) pulls it in too, so a build machine is already covered.

- **Install the binary**

  Grab a prebuilt binary from the [Releases](https://github.com/mrbrahman/photo-loka/releases)
  page. A good location is `~/.local/bin` (usually on `PATH`, no root needed):
  ```bash
  mkdir -p ~/.local/bin
  # Latest release (always resolves to the newest stable release):
  curl -L -o ~/.local/bin/photo-loka https://github.com/mrbrahman/photo-loka/releases/latest/download/photo-loka
  # Or pin a specific version:
  # curl -L -o ~/.local/bin/photo-loka https://github.com/mrbrahman/photo-loka/releases/download/v1.0.0/photo-loka
  chmod +x ~/.local/bin/photo-loka
  # ensure it's on PATH (most distros already include ~/.local/bin):
  command -v photo-loka || { echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc; source ~/.bashrc; }
  photo-loka --help
  ```
  Config lives in `DATA_DIR` (`runtime-config.json` is created there), and env
  vars can come from a `.env`, exported variables, or systemd -- so the binary
  is standalone and nothing needs to sit beside it.

  Prebuilt binaries are x86_64 Linux (glibc) and still require the runtime
  dependencies above (ffmpeg, exiftool, libvips). On other platforms (ARM,
  musl/Alpine, macOS, Windows), build from source instead (see
  [Development](#development)).

- **Configure**

  The server reads config from environment variables (a `.env` file in the
  working directory is loaded automatically if present):
  ```bash
  # Required
  DATA_DIR=/path/to/data/folder
  JWT_SECRET=your-secret-key-change-this
  GEONAMES_USERNAME=your-geonames-username

  # Optional
  ML_SERVICE_URL=http://localhost:8000    # default
  PORT=9000                               # default
  ```
  `runtime-config.json` is auto-created in `DATA_DIR` on first run and can be
  edited via the Admin > Settings page.

- **Create a user**

  Create an admin account so you can log in (this is a CLI command and does not
  need the server running -- it uses the same `DATA_DIR`/`JWT_SECRET` config):
  ```bash
  photo-loka create-user --username admin --password pass123 --role admin
  ```
  See [User management](#user-management) for regular users, unlocking accounts,
  and generating API tokens.

- **Start server**
  ```bash
  photo-loka
  ```
  (If you installed to `~/.local/bin` it is on your `PATH`. For a source build,
  run `./photo-loka` from `go-server/` instead.)

  The server listens on `PORT` (default 9000).

  To run Photo-Loka as a background service that starts on boot, see
  [Run the server using systemd](#run-the-server-using-systemd).

- **Open Photo-Loka and log in**

  Visit http://localhost:9000 (or your server's address on `PORT`) and log in
  with the admin account you created above.

- **Setup Collection & Start Indexing**

  Navigate to the Admin > Collections page in the UI and click "New Collection". Fill in:
  - **Collection Name** and **Collection Path** (must be an existing directory)
  - **Album Type**: FOLDER_ALBUM (files organized in date folders) or VIRTUAL_ALBUM
  - **Folder Pattern**: moustache-style format with tokens `{{yyyy}}`, `{{mm}}`, `{{dd}}`, and `{{album}}` (must be the last token). Example: `{{yyyy}}/{{yyyy}}-{{mm}}-{{dd}} {{album}}` produces folders like `2021/2021-01-01 New Year`.
  - **Placeholder Album Name**: text to use as the album name when intake creates a new folder for files with no obvious album (e.g. `TBD`). Albums matching this text are highlighted in the gallery as needing review. Empty disables the placeholder.
  - **Intake Paths**: one or more paths where new files arrive, with a method:
    - *Immediate* - watches the folder in real-time (fsnotify)
    - *Scheduled* - runs on a cron schedule for files that are N days stale
    - *On-demand* - only indexes when manually triggered

  When you save the collection, choose **Save and Start Indexing** to create it
  and kick off indexing immediately (or **Save Only** to create it without
  indexing). Watch live progress on the Admin > Indexer page, which also has
  pause/resume and concurrency controls.

  Tip: if you notice your system resources are not fully utilized during
  indexing, increase the indexer concurrency (raise it by 1 at a time until
  resources are fully utilized).

## User management

Use CLI commands below until there is a need to make a screen

### Create User
```bash
# Create admin user
photo-loka create-user --username admin --password pass123 --role admin

# Create regular user
photo-loka create-user --username john --password pass123 --role user
```

### Unlock Locked Account
```bash
photo-loka unlock-user --username john
```

### Generate API Token
Generate long-lived tokens for API access (useful for curl commands, scripts, integrations):

```bash
# Generate token with 1 year expiry (default)
photo-loka generate-token admin

# Generate token with custom expiry (in days)
photo-loka generate-token admin 730  # 2 years
photo-loka generate-token admin 36500  # 100 years (effectively never expires)
```

The token is a JWT that works with existing authentication. Use it in API calls:
```bash
curl -H "Authorization: Bearer <token>" http://localhost:9000/api/getIndexerStatus
```

Or place the authoriation in `.curlrc`

**Note**: API tokens are not stored in the database. They're self-contained JWTs that remain valid until expiry. If you need to revoke a token before expiry, you'll need to change the JWT_SECRET (which invalidates all tokens).


# Development

Photo-Loka has two parts: the Go server (`go-server/`) and the web frontend
(`web/`). The whole thing is built and released as a single binary.

## Get the code
```bash
git clone https://github.com/mrbrahman/photo-loka.git
cd photo-loka
```

## Go server

Install Go (1.25+, matching `go-server/go.mod`). The official instructions are
at https://go.dev/doc/install; a quick install:
```bash
curl -sL https://go.dev/dl/go1.25.0.linux-amd64.tar.gz | sudo tar -C /usr/local -xz
echo 'export PATH=/usr/local/go/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

Build-time system dependencies (needed only to compile, not at runtime):
```bash
sudo apt install build-essential pkg-config libvips-dev
```
(SQLite is compiled from bundled C source and libvips is linked via cgo, so a C
toolchain is required. `libvips-dev` also pulls in the runtime libvips shared
library.)

Then build and run:
```bash
cd go-server
go mod tidy
./build.sh
./photo-loka
```

`build.sh` compiles with the `fts5` and `sqlite_math_functions` SQLite build
tags. On an exact release tag it also bundles/minifies and embeds the `web/`
assets into the binary (`embed_web`); on dev builds the frontend is served from
`../web` on disk, so edits are picked up without rebuilding.

Because of cgo, the binary is platform-specific (x86_64/glibc when built on a
typical Linux box). It runs on a prod machine of the same architecture with a
compatible libvips installed; for other platforms, build on the target.

See [go-server/README.md](go-server/README.md) for deployment options (build on
prod, copy binary, GitHub Releases, GitHub Actions).

## Web frontend

The frontend is plain ES modules and native Web Components with no build step --
`build.sh` serves `web/` from disk on dev builds, so you just edit files and
reload. `esbuild` is only invoked on release-tag builds to bundle and minify the
assets that get embedded into the binary.

Any change under `web/` should bump the `VERSION` constant in `web/sw.mjs` so the
service worker triggers the PWA "new version available" update on installed
clients.

# Architecture
## Main
- Go server (single binary, Gin framework)
- SQLite 3 database
- Native web components for front end

## Supporting
- Sqlite3 provided FTS5 for searches
- libvips (via govips) for image operations
- go-exiftool (wraps external exiftool) for metadata read / write
- Use browser native features (HTML5) to play videos

# Notes

## Run the server using systemd

Run Photo-Loka as a **user** service (`systemctl --user`) rather than a
system/root service:

- **Least privilege**: it only needs your photos and `DATA_DIR`, so running as
  root gives it far more access (and blast radius) than it needs.
- **File ownership stays sane**: media, thumbnails, and the database are owned
  by your user, not root, matching the folders you already curate.
- **No root, self-contained**: binary in `~/.local/bin`, unit in
  `~/.config/systemd/user/` -- setup, updates, and logs never need `sudo`, and
  uninstalling is just removing your files.

The examples below are for a **user** service (note the `--user` flag and the
`~/.config/systemd/user/` path). Lingering is enabled so the service runs
without an active login session.

* Create/edit the unit with `systemctl --user edit`, so you do not have to
  remember where the file lives (systemd writes it to the right place and runs
  `daemon-reload` for you on save):
  ```bash
  systemctl --user edit --force --full photo-loka.service
  ```
  The `--full` flag edits the entire unit (not just a drop-in override) and
  `--force` lets you create it if it does not exist yet. Paste the following
  into the editor and save:
  ```ini
  [Unit]
  Description=Photo-Loka Server

  [Service]
  ExecStart=%h/.local/bin/photo-loka
  # Config via Environment= lines (values quoted for safety). Required:
  Environment="DATA_DIR=/path/to/data/folder"
  Environment="JWT_SECRET=your-secret-key-change-this"
  Environment="GEONAMES_USERNAME=your-geonames-username"
  # Optional (defaults shown):
  Environment="ML_SERVICE_URL=http://localhost:8000"
  Environment="PORT=9000"
  # Alternative: use a .env file instead of the Environment= lines above.
  # Uncomment both -- the .env is loaded from WorkingDirectory, and the leading
  # '-' makes systemd tolerate a missing file.
  # WorkingDirectory=%h/photo-loka
  # EnvironmentFile=-%h/photo-loka/.env
  Restart=always
  RestartSec=5

  [Install]
  WantedBy=default.target
  ```
* Enable and start it (enable lingering so it runs without an active login):
  ```bash
  systemctl --user enable --now photo-loka.service
  loginctl enable-linger $USER
  ```
* Use the following commands to start/restart/stop etc
  ```bash
  alias start='systemctl --user start photo-loka.service'
  alias stop='systemctl --user stop photo-loka.service'
  alias rs='systemctl --user restart photo-loka.service'
  ```
* Use the follwing for checking logs in `journalctl`
  ```bash
  # logs from the start of the service
  alias log='journalctl --user -u photo-loka.service --all --no-hostname'
  # similar to `tail -50f`
  alias logs='journalctl --user -f -u photo-loka.service --all --no-hostname --lines 50'
  # just logs from today
  alias lt='journalctl --user -u photo-loka.service --all --no-hostname --since today'
  ```
