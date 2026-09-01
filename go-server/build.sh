#!/bin/bash

PS4='+$(date +%H:%M:%S.%3N) '
#set -x

VERSION=$(git describe --tags --always --dirty 2>/dev/null || echo "dev")

TAGS="fts5 sqlite_math_functions"

# If on an exact tag (release build), bundle+minify web assets into a temp web/
# dir and embed it into the binary. Dev builds serve ../web from disk unchanged.
if git describe --tags --exact-match HEAD &>/dev/null; then
    echo "Release build: bundling, minifying, and embedding web assets"

    # Fresh temp output dir (embedded via //go:embed all:web)
    rm -rf web
    mkdir -p web web/js/styles web/css

    # Static files and raw assets (copied as-is)
    cp ../web/index.html    web/index.html
    cp ../web/frame.html    web/frame.html
    cp ../web/manifest.json web/manifest.json
    cp -r ../web/assets     web/assets

    # Specifiers that must NOT be bundled:
    #  - shoelace/*, navigo, cronstrue, leaflet-css : resolved at runtime via the
    #    import map in index.html/frame.html (esbuild does not read HTML import maps)
    #  - *.css : component styles are CSS module scripts (import ... with {type:"css"}).
    #    Keeping them external preserves the browser's parse-once/dedupe behavior and
    #    leaves the import statements pointing at separate minified .css files.
    ESBUILD_EXTERNALS="--external:shoelace/* --external:navigo --external:cronstrue --external:leaflet-css --external:*.css"

    # JS module entrypoints -> .mjs so the emitted files match the <script src="js/*.mjs">
    # references in index.html (main.mjs) and frame.html (frame.mjs).
    esbuild ../web/js/main.mjs ../web/js/frame.mjs \
      --bundle --minify --format=esm $ESBUILD_EXTERNALS \
      --out-extension:.js=.mjs \
      --outdir=web --outbase=../web

    # Service worker must stay at /sw.js (pl-app-shell.js registers the literal
    # path '/sw.js'), so bundle it separately without the .mjs extension rewrite.
    esbuild ../web/sw.js \
      --bundle --minify --format=esm $ESBUILD_EXTERNALS \
      --outfile=web/sw.js

    # Component CSS: after bundling, all component CSS imports collapse to
    # "./styles/<name>.css" relative to the bundled web/js/main.mjs (and frame.mjs),
    # i.e. they resolve to web/js/styles/. Minify each source file into that flat dir.
    for f in ../web/js/components/styles/*.css; do
      esbuild "$f" --minify --outfile="web/js/styles/$(basename "$f")"
    done

    # Standalone theme-vars.css is loaded via <link href="css/theme-vars.css"> in
    # index.html (not through the JS module graph), so minify it separately.
    esbuild ../web/css/theme-vars.css --minify --outfile=web/css/theme-vars.css

    TAGS="$TAGS embed_web"
else
    echo "Dev build: web assets served from ../web at runtime"
fi

go build -tags "$TAGS" -ldflags "-X main.version=${VERSION}" -o photo-loka .

# Clean up if we copied web/
rm -rf web
