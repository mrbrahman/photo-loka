# Photo-Loka Go Server

A single-binary rewrite of the Photo-Loka Node.js server in Go.

## System Dependencies

Install these on the machine where Photo-Loka runs:

```bash
# Ubuntu/Debian
sudo apt install libvips ffmpeg exiftool

# Fedora
sudo dnf install vips ffmpeg perl-Image-ExifTool

# macOS
brew install vips ffmpeg exiftool
```

| Dependency | Purpose |
|-----------|---------|
| `libvips` | Fast image resizing for thumbnails and on-the-fly resize (same library sharp uses in Node.js) |
| `ffmpeg` | Video thumbnail extraction (frame grab) and video compression |
| `exiftool` | EXIF metadata extraction and writing back to files |

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
