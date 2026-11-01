#!/bin/bash
#
# Build the Capacitor Android app from the shared web/ frontend.
#
# Mirrors the copy/build/clean pattern of go-server/build.sh: stage the web
# assets (plus the mobile-only boot + intake screen) into mobile/www, sync into
# the native Android project, build the APK, then clean up the staging dir.
#
# Unlike the browser build (which loads shoelace/navigo/leaflet/etc. from a CDN
# via an import map), the mobile build is SELF-CONTAINED: those deps are
# npm-installed under mobile/ and bundled into js/main.mjs by esbuild, with
# Shoelace's icon assets and theme CSS + the web fonts vendored locally. A
# packaged app must not depend on reaching a CDN at runtime (that was the cause
# of the blank screen: CDN-unreachable -> sl-* never register -> hidden by
# :not(:defined)). web/ is untouched and still uses the CDN.
#
# The mobile-only pieces are mobile/index.html (loads the bundled boot, no CDN,
# no service worker), mobile-boot.mjs (reads the stored server URL / shows the
# intake screen and sets window.__API_BASE__), and pl-server-setup.mjs.
#
# Requirements: Node 22+ (for esbuild + cap), JDK 21, and the Android SDK
# (API 36) for the gradle build. Set ANDROID_HOME/ANDROID_SDK_ROOT. If the
# SDK/JDK is not present, run with --no-native to stage + sync only (produces
# mobile/www and the synced android/ project without compiling the APK).
# Capacitor 8 requires JDK 21, Android SDK 36, and Android Gradle Plugin 8.13.

set -euo pipefail

cd "$(dirname "$0")"

NATIVE=1
for arg in "$@"; do
  case "$arg" in
    --no-native) NATIVE=0 ;;
    *) echo "Unknown option: $arg" >&2; echo "Usage: $0 [--no-native]" >&2; exit 1 ;;
  esac
done

WEB=../web
WWW=www
SL=node_modules/@shoelace-style/shoelace/cdn

# Prefer the pinned local esbuild; fall back to a global one.
ESBUILD="./node_modules/.bin/esbuild"
[ -x "$ESBUILD" ] || ESBUILD="$(command -v esbuild || true)"
[ -n "$ESBUILD" ] || { echo "esbuild not found (run: npm install)"; exit 1; }

[ -d node_modules ] || { echo "node_modules missing (run: npm install)"; exit 1; }

echo "Staging web assets into $WWW ..."
rm -rf "$WWW"
mkdir -p "$WWW/js/styles" "$WWW/css" "$WWW/vendor"

# Mobile entry HTML (not web/index.html: loads the bundled boot, no CDN, no SW).
cp index.html "$WWW/index.html"

# Raw app assets and the app's own icon/images.
cp -r "$WEB/assets" "$WWW/assets"

# --- Local vendoring of runtime-global / non-ESM deps -----------------------
# Leaflet is a classic global script (sets window.L); pl-map uses window.L and
# markercluster plugs into it. Keep them as local <script> globals (like the web
# build's CDN <script>s, just local), not bundled into the ESM graph.
cp node_modules/leaflet/dist/leaflet.js                                  "$WWW/vendor/leaflet.js"
cp node_modules/leaflet/dist/leaflet.css                                 "$WWW/vendor/leaflet.css"
# Leaflet default marker icons. leaflet.css references images/marker-icon.png
# (etc.) relative to itself, and L.Icon.Default._detectIconPath resolves the
# marker <img> src from that. The vendored leaflet.css sits at vendor/, so the
# images must be at vendor/images/ or the pl-item-info location marker 404s and
# shows nothing. (pl-map uses L.DivIcon, which needs no image, so only the
# default-icon marker in pl-item-info was affected.)
cp -r node_modules/leaflet/dist/images                                   "$WWW/vendor/images"
cp node_modules/leaflet.markercluster/dist/leaflet.markercluster.js      "$WWW/vendor/leaflet.markercluster.js"
# MarkerCluster CSS modules imported by pl-map (markercluster-css /
# markercluster-default-css). Like leaflet.css they stay external and are
# loaded from these vendored files at runtime (aliased below).
cp node_modules/leaflet.markercluster/dist/MarkerCluster.css             "$WWW/vendor/MarkerCluster.css"
cp node_modules/leaflet.markercluster/dist/MarkerCluster.Default.css     "$WWW/vendor/MarkerCluster.Default.css"
# Shoelace lazy-loads icon SVGs at runtime from its base path. The bundled
# Shoelace components (in main.mjs) carry their own copy of the base-path module
# with the DEFAULT (empty) base path, which resolves icons to /assets/icons/.
# Calling setBasePath() from mobile-boot cannot change that (separate bundle =
# separate module instance). So instead of fighting it, we vendor the icons to
# exactly where the default path looks: www/assets/icons/. No setBasePath needed.
mkdir -p "$WWW/assets/icons"
cp -r "$SL/assets/icons/." "$WWW/assets/icons/"
# Shoelace light/dark theme CSS (loaded via <link> in index.html).
mkdir -p "$WWW/vendor/shoelace"
# Shoelace light/dark theme CSS (loaded via <link> in index.html).
cp "$SL/themes/light.css" "$WWW/vendor/shoelace/light.css"
cp "$SL/themes/dark.css"  "$WWW/vendor/shoelace/dark.css"

# --- esbuild bundling -------------------------------------------------------
# Everything that the browser build resolves via the CDN import map is now
# bundled from node_modules. The app lives in ../web (a sibling of mobile/ with
# no node_modules of its own), so point esbuild at mobile/node_modules via
# NODE_PATH for bare specifiers (navigo, cronstrue, @dagrejs/dagre, d3-*).
# Shoelace needs an ABSOLUTE directory alias (not the package specifier) so
# esbuild resolves its deep cdn/ files directly and bypasses the package's
# "exports" map, which does not expose those paths. leaflet-css is the CSS
# module specifier pl-map imports. Component styles ("./styles/<name>.css" with
# {type:"css"}) stay external and are minified separately below.
export NODE_PATH="$PWD/node_modules"
SL_ABS="$PWD/$SL"
# leaflet-css is imported as a CSS module (import ... with {type:"css"}) in
# pl-map/pl-item-info. esbuild cannot inline CSS modules, so (like the web
# build) all CSS modules stay EXTERNAL and are loaded by the browser's native
# CSS-module support from real files. The component styles resolve to
# ./styles/<name>.css (minified below). leaflet-css is aliased to a runtime
# path that points at the vendored copy relative to js/main.mjs
# (www/js/main.mjs -> ../vendor/leaflet.css).
ALIASES="--alias:shoelace=$SL_ABS --alias:leaflet-css=../vendor/leaflet.css --alias:markercluster-css=../vendor/MarkerCluster.css --alias:markercluster-default-css=../vendor/MarkerCluster.Default.css"
EXTERNALS="--external:./styles/* --external:*.css --external:../vendor/leaflet.css --external:../vendor/MarkerCluster.css --external:../vendor/MarkerCluster.Default.css"

echo "Bundling app (main.mjs) ..."
# --inject the navigo global shim: web/js/router.mjs uses a bare global `Navigo`
# (CDN UMD set window.Navigo); the bundled npm package does not, so the shim
# assigns it. Injected only here (mobile), never in the browser build.
"$ESBUILD" "$WEB/js/main.mjs" \
  --bundle --minify --format=esm $ALIASES $EXTERNALS \
  --inject:"$PWD/navigo-global-shim.mjs" \
  --out-extension:.js=.mjs \
  --outdir="$WWW" --outbase="$WEB"

# Mobile boot entrypoint: mobile-boot.mjs + pl-server-setup.mjs + @capacitor/*.
# main.mjs stays external (bundled above; loaded via the sibling dynamic import).
echo "Bundling mobile boot (mobile-boot.mjs) ..."
"$ESBUILD" mobile-boot.mjs \
  --bundle --minify --format=esm $ALIASES $EXTERNALS --external:./main.mjs \
  --outfile="$WWW/js/mobile-boot.mjs"

# Component CSS modules: after bundling, imports collapse to ./styles/<name>.css
# relative to js/main.mjs (js/styles/). Minify each source file into that dir.
for f in "$WEB"/js/components/styles/*.css; do
  "$ESBUILD" "$f" --minify --outfile="$WWW/js/styles/$(basename "$f")"
done

# Standalone theme-vars.css loaded via <link> in index.html.
"$ESBUILD" "$WEB/css/theme-vars.css" --minify --outfile="$WWW/css/theme-vars.css"

echo "Syncing into Android project ..."
npx cap sync android

if [ "$NATIVE" = "1" ]; then
  echo "Building APK (assembleDebug) ..."
  (cd android && ./gradlew assembleDebug)
  echo "APK at: mobile/android/app/build/outputs/apk/debug/app-debug.apk"
else
  echo "Skipping native build (--no-native). Staged www/ and synced android/."
fi

echo "Cleaning up $WWW ..."
rm -rf "$WWW"

echo "Done."
