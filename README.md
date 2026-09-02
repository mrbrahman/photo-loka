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

# How to install & use

The server is a single Go binary. You can either download a prebuilt release or
build it yourself.

- **Install runtime dependencies**
  - [ffmpeg](https://ffmpeg.org/download.html) (for video operations: thumbnail extraction, compression)
  - [exiftool](https://exiftool.org/) **12.78+** (for EXIF metadata, GPS timezone resolution, geolocation)
  - **libvips** shared library (for image operations and HEIC support). The Go
    binary links libvips dynamically (via govips/cgo), so `libvips.so` must be
    present at runtime, not just at build time. Package name is `libvips42t64`
    on recent Ubuntu/Debian and `libvips42` on older releases.

    The exiftool distro package is often outdated. Install a recent version and put it on your `PATH`:
    ```bash
    # ffmpeg + libvips runtime library
    sudo apt install ffmpeg libvips42t64   # older distros: libvips42
    # exiftool: download 12.78+ from https://exiftool.org/ if your distro version is older
    exiftool -ver   # verify >= 12.78
    ```

- **Get the code (to build from source)**
  ```bash
  git clone https://github.com/mrbrahman/photo-loka.git
  ```
  Or grab a prebuilt binary from the [Releases](https://github.com/mrbrahman/photo-loka/releases) page and skip the build step.

- **Build the binary**

  Build-time system dependencies (needed only to compile, not at runtime):
  ```bash
  sudo apt install build-essential pkg-config libvips-dev
  ```

  Then build:
  ```bash
  cd photo-loka/go-server
  go mod tidy
  ./build.sh
  ```

  `build.sh` compiles with the `fts5` and `sqlite_math_functions` SQLite build
  tags. On an exact release tag it also embeds the `web/` assets into the binary
  (`embed_web`); on dev builds the frontend is served from `../web` on disk.

  HEIC support is built in via libvips (no extra steps needed).

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

- **Start server**
  ```bash
  cd photo-loka/go-server
  ./photo-loka
  ```

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

  Alternatively, use the REST API (requires an [API token](#generate-api-token)):
  ```bash
  curl -X POST -H 'Content-Type: application/json' \
    -H "Authorization: Bearer <token>" \
    -d @c.json "http://localhost:9000/api/admin/createNewCollection"
  ```

  <details>
  <summary>Example JSON payloads for REST API</summary>

  Collection with real-time watcher:
  ```json
  {
    "collection_name":"Test",
    "collection_path":"/home/user/photos/",
    "album_type":"FOLDER_ALBUM",
    "intake_configs":[
      {
        "path":"/home/user/camera-import/",
        "method":"immediate",
        "config":{
          "awaitWriteFinish":true,
          "ignoreInitial":true
        }
      }
    ],
    "apply_folder_pattern":"{{yyyy}}/{{yyyy}}-{{mm}}-{{dd}} {{album}}",
    "placeholder_album_text":"TBD",
    "default_collection":1
  }
  ```

  Collection with scheduled cron indexing:
  ```json
  {
    "collection_name":"Test",
    "collection_path":"/home/user/photos/",
    "album_type":"FOLDER_ALBUM",
    "intake_configs":[
      {
        "path":"/home/user/bulk-import/",
        "method":"scheduled",
        "config":{
          "schedule":"0 2 * * *",
          "staleDays":2
        }
      }
    ],
    "apply_folder_pattern":"{{yyyy}}/{{yyyy}}-{{mm}}-{{dd}} {{album}}",
    "placeholder_album_text":"TBD",
    "default_collection":1
  }
  ```

  Collection with mixed watcher and cron paths:
  ```json
  {
    "collection_name":"Test",
    "collection_path":"/home/user/photos/",
    "album_type":"FOLDER_ALBUM",
    "intake_configs":[
      {
        "path":"/home/user/camera-import/",
        "method":"immediate",
        "config":{
          "awaitWriteFinish":true
        }
      },
      {
        "path":"/network/shared-photos/",
        "method":"scheduled",
        "config":{
          "schedule":"0 1 * * *",
          "staleDays":1
        }
      }
    ],
    "apply_folder_pattern":"{{yyyy}}/{{yyyy}}-{{mm}}-{{dd}} {{album}}",
    "placeholder_album_text":"TBD",
    "default_collection":1
  }
  ```
  </details>

  Start indexing (this will kick off indexer process in the background and return immediately)
  ```bash
  curl -X POST -H "Authorization: Bearer <token>" \
    'http://localhost:9000/api/startIndexingFirstTime?collection_id=1'
  ```
  
  Monitor progress
  ```bash
  curl -X GET -H "Authorization: Bearer <token>" \
    'http://localhost:9000/api/getIndexerStatus' | jq '.'
  ```

  ```bash
  # If you notice your system resources are not fully utilized, you can increase indexer concurrency
  # Suggest to increase by 1 at a time, until you see resources getting fully utilized
  curl -X PUT -H "Authorization: Bearer <token>" \
    'http://localhost:9000/api/updateIndexerConcurrency/2'
  ```
- Create a [user](#create-user) using the CLI commands as shown below
- Visit your photo-loka page http://localhost:9000
- Enjoy!

## User management

Use CLI commands below until there is a need to make a screen

### Create User
```bash
# Create admin user
./photo-loka create-user --username admin --password pass123 --role admin

# Create regular user
./photo-loka create-user --username john --password pass123 --role user
```

### Unlock Locked Account
```bash
./photo-loka unlock-user --username john
```

### Generate API Token
Generate long-lived tokens for API access (useful for curl commands, scripts, integrations):

```bash
# Generate token with 1 year expiry (default)
./photo-loka generate-token admin

# Generate token with custom expiry (in days)
./photo-loka generate-token admin 730  # 2 years
./photo-loka generate-token admin 36500  # 100 years (effectively never expires)
```

The token is a JWT that works with existing authentication. Use it in API calls:
```bash
curl -H "Authorization: Bearer <token>" http://localhost:9000/api/getIndexerStatus
```

Or place the authoriation in `.curlrc`

**Note**: API tokens are not stored in the database. They're self-contained JWTs that remain valid until expiry. If you need to revoke a token before expiry, you'll need to change the JWT_SECRET (which invalidates all tokens).


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

* Place .service file in `~/.config/systemd/user/photo-loka.service`
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
