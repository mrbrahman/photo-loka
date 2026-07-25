# Photo-Loka Go Server

A single-binary rewrite of the Photo-Loka Node.js server in Go.

## System Dependencies

Install these on the machine where Photo-Loka runs:

```bash
# Ubuntu/Debian
sudo apt install ffmpeg

# Fedora
sudo dnf install ffmpeg

# macOS
brew install ffmpeg exiftool
```

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

| Dependency | Purpose |
|-----------|---------|
| `ffmpeg` | Video thumbnail extraction (frame grab) and video compression |
| `exiftool` (12.78+) | EXIF metadata extraction, writing, GPS timezone resolution, and geolocation |

Note: `libvips` is linked at build time (compiled into the binary), so it is not needed on the machine where the binary runs — only where it is built.

## Build

```bash
cd go-server
./build.sh
```

Or manually:
```bash
go build -tags "fts5" -o photo-loka .
```

## Configuration

Create a `.env` file (or set environment variables):

```bash
# Required
DATA_DIR=/path/to/data/folder
JWT_SECRET=your-secret-key-change-this
GEONAMES_USERNAME=your-geonames-username

# Optional
ML_SERVICE_URL=http://localhost:8000    # default
PORT=9000                               # default
INDEXER_MODE=static                     # static or dynamic
LOG_LEVEL=info                          # debug, info, warn, error
NO_COLOR=                               # set to any value to disable colors
```

Also required: `runtime-config.json` in the DATA_DIR. See `../server/runtime-config.example.json`.

## Usage

```bash
# Start server
./photo-loka serve

# Create a user
./photo-loka create-user --username admin --password yourpassword --role admin

# Unlock a locked user
./photo-loka unlock-user --username admin

# Generate an API token
./photo-loka generate-token admin 365
```

## Development

### Additional build-time dependencies

These are needed only for compiling the binary (not at runtime):

```bash
# Ubuntu/Debian
sudo apt install build-essential pkg-config libvips-dev

# Fedora
sudo dnf install gcc pkg-config vips-devel

# macOS (already included with Xcode CLI tools + brew install above)
brew install pkg-config
```

| Dependency | Why |
|-----------|-----|
| `build-essential` (gcc) | C compiler needed to compile SQLite (CGO) and govips C bindings |
| `pkg-config` | Used by govips at build time to locate libvips headers and libraries |
| `libvips-dev` | Header files for libvips (the runtime `libvips` package doesn't include headers) |

### Setup

```bash
# Install Go 1.26+
curl -sL https://go.dev/dl/go1.26.0.linux-amd64.tar.gz | sudo tar -C /usr/local -xz
echo 'export PATH=/usr/local/go/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
go version  # verify

# Install build-time system dependencies (see above)
sudo apt install build-essential pkg-config libvips-dev

# Download Go dependencies
cd go-server
go mod tidy

# Build
./build.sh

# Run
DATA_DIR=/path/to/data JWT_SECRET=secret GEONAMES_USERNAME=user ./photo-loka serve
```

### Cross-platform builds

Due to CGO (SQLite + govips require C compilation), the binary is platform-specific. You must build on the target OS — cross-compilation from Linux to Mac (or vice versa) is not straightforward.

| Platform | How to build |
|----------|-------------|
| Linux x86_64 | Build on any Linux x86_64 machine (dev or prod) |
| Linux ARM64 | Build on an ARM64 machine (Raspberry Pi, ARM server) |
| macOS | Build on a Mac: `brew install go pkg-config libvips && ./build.sh` |

If dev and prod are the same architecture (e.g. both Linux x86_64), the binary built on dev runs directly on prod without rebuilding.

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

Build on your dev machine and transfer the binary. No Go or build tools needed on prod (only runtime deps: libvips, ffmpeg, exiftool).

```bash
# On dev machine
cd go-server
./build.sh
scp photo-loka prod-server:~/photo-loka/

# On prod
systemctl --user restart photo-loka
```

### Option 3: GitHub Releases

Attach the binary to a GitHub release, then pull on prod with curl:

```bash
# On dev: create a release
git tag v0.1.0
git push origin v0.1.0
gh release create v0.1.0 ./go-server/photo-loka --title "v0.1.0" --notes "Release notes"

# On prod: download and restart
curl -L -o photo-loka https://github.com/mrbrahman/photo-loka/releases/download/v0.1.0/photo-loka
chmod +x photo-loka
systemctl --user restart photo-loka
```

### systemd service file

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
```
