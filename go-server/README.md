# Photo-Loka Go Server

A single-binary rewrite of the Photo-Loka Node.js server in Go.

## System Dependencies

| Dependency | Purpose |
|-----------|---------|
| `exiftool` (12.78+) | EXIF metadata extraction, writing, GPS timezone resolution, and geolocation |
| `ffmpeg` | Video thumbnail extraction (frame grab) and video compression |
| `libvips` (shared library) | Image operations (thumbnails, resize) and HEIC support, via govips. Linked dynamically, so the shared library must be present at runtime. |

Install these on the machine where Photo-Loka runs:


### exiftool (version 12.78+ required)

The system package (`apt install exiftool`) is often outdated. Photo-Loka requires exiftool 12.78+ for GPS-based timezone resolution and geolocation features.

Install the latest version directly:

```bash
# Download
curl -L "https://sourceforge.net/projects/exiftool/files/Image-ExifTool-13.59.tar.gz/download" -o Image-ExifTool-13.59.tar.gz

# Extract
tar -xzf Image-ExifTool-13.59.tar.gz

# Add to PATH (add to ~/.bashrc for persistence)
export PATH=/path/to/Image-ExifTool-13.59:$PATH

# Verify
exiftool -ver  # should show 13.59
```

### ffmpeg

```bash
sudo apt install ffmpeg
```

### libvips (shared library)

govips links libvips dynamically (via cgo), so the `libvips.so` shared library
must be present at runtime, not only when building. Confirm with
`ldd ./photo-loka | grep vips`.

```bash
# Recent Ubuntu/Debian (time_t transition):
sudo apt install libvips42t64
# Older releases:
sudo apt install libvips42
```

Installing `libvips-dev` (build-time) also pulls in the runtime shared library,
so a build machine is already covered. A runtime-only machine needs just the
shared library above.

## Configuration

The server reads configuration from environment variables. A `.env` file in the working directory is loaded automatically if present, but is not required - you can set the variables any way you prefer (export, systemd `EnvironmentFile`, etc).

```bash
# Required
DATA_DIR=/path/to/data/folder
JWT_SECRET=your-secret-key-change-this
GEONAMES_USERNAME=your-geonames-username

# Optional
ML_SERVICE_URL=http://localhost:8000    # default
PORT=9000                               # default
LOG_LEVEL=info                          # debug, info, warn, error (not yet implemented, always info)
NO_COLOR=                               # set to any value to disable colors
```

`runtime-config.json` is auto-created in DATA_DIR on first run with sensible defaults. Settings can be changed via Admin > Settings page.

## Usage

```bash
# Show help
./photo-loka --help

# Show version
./photo-loka --version

# Start server
./photo-loka

# Create a user
./photo-loka create-user --username admin --password yourpassword --role admin

# Unlock a locked user
./photo-loka unlock-user --username admin

# Generate an API token
./photo-loka generate-token admin 365
```

## Running as a systemd service

Place in `~/.config/systemd/user/photo-loka.service`:

```ini
[Unit]
Description=Photo-Loka Server

[Service]
ExecStart=%h/photo-loka/photo-loka
WorkingDirectory=%h/photo-loka
EnvironmentFile=%h/photo-loka/.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable photo-loka
systemctl --user start photo-loka

# Enable lingering so service runs without an active login session
loginctl enable-linger $USER
```

### Useful aliases

Add to `~/.bashrc`:

```bash
alias start='systemctl --user start photo-loka.service'
alias stop='systemctl --user stop photo-loka.service'
alias rs='systemctl --user restart photo-loka.service'
alias log='journalctl --user -u photo-loka.service --all --no-hostname'
alias logs='journalctl --user -f -u photo-loka.service --all --no-hostname --lines 50'
alias lt='journalctl --user -u photo-loka.service --all --no-hostname --since today'
```

## Development

### Build-time dependencies

These are needed only for compiling the binary (not at runtime):

```bash
sudo apt install build-essential pkg-config libvips-dev
```

| Dependency | Why |
|-----------|-----|
| `build-essential` (gcc) | C compiler for SQLite (CGO) and govips C bindings |
| `pkg-config` | Used by govips at build time to locate libvips headers |
| `libvips-dev` | Header files for libvips |

Note: `libvips-dev` provides the headers and pkg-config file used when compiling.
The libvips **shared library** itself (`libvips.so`) is linked dynamically and is
required at runtime as well - see [System Dependencies](#system-dependencies).

### Setup

```bash
# Install Go (preferred method: https://go.dev/doc/install)
curl -sL https://go.dev/dl/go1.23.0.linux-amd64.tar.gz | sudo tar -C /usr/local -xz
echo 'export PATH=/usr/local/go/bin:$PATH' >> ~/.bashrc
source ~/.bashrc

# Install build-time system dependencies
sudo apt install build-essential pkg-config libvips-dev

# Download Go dependencies
cd go-server
go mod tidy

# Build
./build.sh

# Run
./photo-loka
```

### Cross-platform note

Due to CGO (SQLite + govips require C compilation), the binary is platform-specific. If dev and prod are the same architecture (e.g. both Linux x86_64), the binary built on dev runs directly on prod without rebuilding.

## Deployment

### Option 1: Build on prod (simplest)

If Go and build deps are installed on your prod box:

```bash
cd ~/photo-loka/go-server
git pull
./build.sh
systemctl --user restart photo-loka
```

### Option 2: Build locally, copy binary

Build on your dev machine and transfer the binary. No Go or build tools needed on prod (only runtime deps: ffmpeg, exiftool).

```bash
# On dev machine: tag so build.sh embeds web assets
git tag v1.0.0
cd go-server
./build.sh
scp photo-loka prod-server:~/photo-loka/
# Optionally push the tag to keep remote in sync: git push --tags

# On prod
systemctl --user restart photo-loka
```

### Option 3: GitHub Releases (manual upload)

Build locally, tag a release, and upload the binary to GitHub. Others can download with a single curl command.

```bash
# On dev: tag, build, and upload
git describe --tags --abbrev=0   # check last tag (e.g. v0.1.0)
git tag v1.0.0
git push --tags                  # or: git push origin v1.0.0 (to push only this tag)
cd go-server
bash build.sh
gh release create v1.0.0 ./photo-loka --title "v1.0.0" --notes "Release notes"
```

Note: `build.sh` detects the exact tag and automatically embeds web assets into the binary.

For the person downloading:
```bash
# Latest release (always resolves to the newest stable release):
curl -L -o photo-loka https://github.com/mrbrahman/photo-loka/releases/latest/download/photo-loka
# Or pin a specific version:
curl -L -o photo-loka https://github.com/mrbrahman/photo-loka/releases/download/v1.0.0/photo-loka
chmod +x photo-loka
./photo-loka --help
```

Refer to [System Dependencies](#system-dependencies) and [Configuration](#configuration) sections above for setup.

### Option 4: GitHub Actions (automated build on tag push)

Automate Option 3 so that pushing a tag triggers a build on GitHub's CI and publishes the binary automatically.

Create `.github/workflows/release.yml`:
```yaml
name: Build & Release
on:
  push:
    tags: ['v*']

permissions:
  contents: write        # required by action-gh-release to publish the release

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # build.sh runs `git describe --tags`; need full history + tags
      - uses: actions/setup-go@v5
        with:
          go-version: '1.25'   # must match go.mod
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install build tools
        run: |
          sudo apt-get update
          sudo apt-get install -y libvips-dev   # headers for govips (pulls in runtime lib too)
          npm install -g esbuild                # build.sh bundles/minifies web assets on tags
      - name: Build
        run: bash build.sh
        working-directory: go-server
      - name: Upload release artifact
        uses: softprops/action-gh-release@v2
        with:
          files: go-server/photo-loka
```

Notes:
- `go-version` must match `go.mod` (currently 1.25). A lower version fails with a toolchain error.
- `esbuild` is required because `build.sh` bundles/minifies web assets when building on an exact tag; it is not preinstalled on the runner.
- `libsqlite3-dev` is NOT needed -- `mattn/go-sqlite3` compiles SQLite from bundled C source.
- The runner builds an x86_64/glibc binary dynamically linked to `libvips.so`, so the prod machine must have a compatible libvips installed (see [System Dependencies](#system-dependencies)).

Then to release:
```bash
git describe --tags --abbrev=0   # check last tag (e.g. v0.1.0)
git tag v1.0.0
git push --tags                  # or: git push origin v1.0.0 (to push only this tag)
# GitHub Actions builds and attaches binary to the release page automatically
```

The download experience for others is identical to Option 3.
