# Photo-Loka Go Server

The Go server is a single-binary rewrite of the original Photo-Loka Node.js
server (Gin + SQLite/FTS5 + govips + go-exiftool).

For building from source and local development (Go server + web frontend), see
the [Development](../README.md#development) section of the top-level README. For
end-user setup -- runtime dependencies, configuration, collections, users, and
running under systemd -- see the rest of the [top-level README](../README.md).

This document covers only **deployment** of the Go server: getting a built
binary onto a prod machine.

## Deployment

These were the deployment options considered. **Option 4 (GitHub Actions) is
what the project settled on** -- pushing a version tag builds and publishes the
binary automatically. Options 1-3 are kept here for reference and for cases
where you want to build/ship manually.

### Option 1: Build on prod (simplest)

If Go and the build-time deps are installed on your prod box:

```bash
cd ~/photo-loka/go-server
git pull
./build.sh
systemctl --user restart photo-loka
```

### Option 2: Build locally, copy binary

Build on your dev machine and transfer the binary. No Go or build tools needed on prod (only the runtime deps).

```bash
# On dev machine: tag so build.sh embeds web assets
git tag v1.0.0
cd go-server
./build.sh
scp photo-loka prod-server:~/.local/bin/
# Optionally push the tag to keep remote in sync: git push --tags

# On prod
systemctl --user restart photo-loka
```

### Option 3: GitHub Releases (manual upload)

Build locally, tag a release, and upload the binary to GitHub.

```bash
# On dev: tag, build, and upload
git describe --tags --abbrev=0   # check last tag (e.g. v0.1.0)
git tag v1.0.0
git push --tags                  # or: git push origin v1.0.0 (to push only this tag)
cd go-server
bash build.sh
gh release create v1.0.0 ./photo-loka --title "v1.0.0" --notes "Release notes"
```

The download experience for the person installing is covered in
[How to install and use](../README.md#how-to-install-and-use) (prebuilt binary into
`~/.local/bin`).

### Option 4: GitHub Actions (automated build on tag push) -- chosen

Pushing a tag triggers a build on GitHub's CI and publishes the binary
automatically. This is the active setup; the workflow lives at
[`.github/workflows/release.yml`](../.github/workflows/release.yml).

Key points from the workflow (see the file for the full definition):
- `go-version` must match `go.mod` (currently 1.25). A lower version fails with a toolchain error.
- `esbuild` is installed because `build.sh` bundles/minifies web assets when building on an exact tag; it is not preinstalled on the runner.
- `libsqlite3-dev` is NOT needed -- `mattn/go-sqlite3` compiles SQLite from bundled C source.
- The runner builds an x86_64/glibc binary dynamically linked to `libvips.so`, so the prod machine must have a compatible libvips installed (see the [top-level README](../README.md) runtime dependencies).

To cut a release:
```bash
git describe --tags --abbrev=0   # check last tag (e.g. v0.1.0)
git tag v1.0.0
git push --tags                  # or: git push origin v1.0.0 (to push only this tag)
# GitHub Actions builds and attaches the binary to the release page automatically
```

The download experience for others is identical to Option 3.
