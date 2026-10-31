# Photo-Loka mobile (Capacitor Android)

A thin Capacitor wrapper that runs the shared `web/` frontend as an Android app.
The web code is reused unchanged; the only mobile-specific pieces are:

- `index.html` - mobile entry page. Loads the bundled boot instead of
  `main.mjs` directly, and omits the service worker (the app is already
  "installed").
- `mobile-boot.mjs` - runs before the app boots: reads the stored server URL
  from Capacitor Preferences, sets `window.__API_BASE__`, then dynamically
  imports `js/main.mjs`. If no URL is stored, shows the intake screen first.
- `pl-server-setup.mjs` - the `<pl-server-setup>` intake screen (native web
  component, mirrors `pl-login-page`). Validates the URL against the public
  `/health` endpoint, then emits `pl-server-configured`.

Everything else (gallery, search, admin, auth) is the same web app. It works
cross-origin because of the earlier server prep: a configurable API base
(`apiUrl`), a header-based refresh token (`X-Refresh-Token`), an `access_token`
query param for header-less media/SSE, and CORS for the `http://localhost`
WebView origin.

## How the server URL flows

```
launch -> mobile-boot.boot()
  Preferences has serverUrl?
    yes -> window.__API_BASE__ = url -> import('./main.mjs') -> login/app
    no  -> <pl-server-setup> -> validate /health -> store -> set base -> import('./main.mjs')
```

Relaunch reuses the stored URL and the header refresh token, so the user lands
straight on the app (or the login screen if the refresh token has expired).

## Build

Prerequisites:
- Node 22+ (for esbuild + the Capacitor CLI)
- `esbuild` on PATH (`npm i -g esbuild`)
- JDK 21 and the Android SDK (API 36) for the native build (set `ANDROID_HOME`
  / `ANDROID_SDK_ROOT`). Capacitor 8 requires JDK 21, Android SDK 36, and
  Android Gradle Plugin 8.13.

First-time setup:
```bash
cd mobile
npm install
npx cap add android   # generates android/ (already done if android/ exists)
```

Build the APK (stage web -> bundle -> sync -> gradle -> clean):
```bash
./build.sh
# APK: mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Without the Android SDK/JDK, stage and sync only (no APK):
```bash
./build.sh --no-native   # produces www/ and the synced android/ project
```

`build.sh` mirrors `go-server/build.sh`: it stages `web/` + the mobile files
into `www/`, bundles with esbuild (same CDN externals as the web release build;
`@capacitor/*` is bundled in), runs `cap sync android`, builds the APK, then
removes `www/`.

## Local toolchain setup (Linux / WSL2 Ubuntu, no Android Studio)

What a bare machine needs for the native build, installed command-line only:

```bash
# 1. JDK 21 (system package)
sudo apt-get update && sudo apt-get install -y openjdk-21-jdk

# 2. Android command-line tools into ~/Android/Sdk
mkdir -p ~/Android/Sdk/cmdline-tools
cd /tmp
curl -fLO https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip -q commandlinetools-linux-11076708_latest.zip
mv cmdline-tools ~/Android/Sdk/cmdline-tools/latest

# 3. SDK packages matching Capacitor 8 (API 36) + accept licenses
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export ANDROID_HOME="$HOME/Android/Sdk"
SDKMGR="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
yes | "$SDKMGR" --sdk_root="$ANDROID_HOME" --licenses
"$SDKMGR" --sdk_root="$ANDROID_HOME" "platform-tools" "platforms;android-36" "build-tools;36.0.0"

# 4. Point gradle at the SDK (gitignored)
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
```

Persist the environment for future shells (append to `~/.bashrc`):
```bash
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
```
(Gradle needs `JAVA_HOME`; the SDK path also comes from `android/local.properties`.)

## Notes

- `androidScheme: http` (in `capacitor.config.json`) makes the WebView serve
  its page from `http://localhost`. This is deliberate: the self-hosted server
  typically runs over plain HTTP, and an `https://localhost` page calling an
  `http://` server is blocked as mixed content by the WebView (fetch, XHR, and
  images all fail). With an `http://localhost` origin the requests are
  same-scheme and are not blocked. The server's CORS allowlist includes
  `http://localhost` (and `https://localhost` for a future HTTPS build/server).
- iOS is not set up. Its origin is `capacitor://localhost`, which the server's
  CORS library rejects (non-http scheme); add via `AllowOriginFunc` if targeting
  iOS later.
- Hardware back button (`mobile-back.mjs`): our overlays and Shoelace's
  dialog/drawer/dropdown all dismiss via the web `CloseWatcher` API, which the
  Capacitor native back button does not reach (so back would otherwise exit the
  app). `initBackButton()` (called before `main.mjs` loads) wraps
  `window.CloseWatcher` into a LIFO stack and registers a `@capacitor/app`
  `backButton` listener that closes the topmost overlay, else `history.back()`,
  else `App.exitApp()`. No `web/` changes -- the shim transparently tracks every
  `CloseWatcher` both our code and Shoelace create.
