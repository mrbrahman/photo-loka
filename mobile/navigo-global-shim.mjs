// esbuild inject shim (mobile build only).
//
// web/js/router.mjs does `import 'navigo'` (side-effect only) and then uses a
// bare global `Navigo` (as `new Navigo(...)`). That works in the browser build
// because the CDN ships navigo as a UMD script that sets window.Navigo. The
// npm package, when bundled, exposes its constructor as the module's default
// export and sets no global. This shim imports that default and assigns it to
// window.Navigo so router.mjs's global reference resolves. Injected via
// esbuild --inject in mobile/build.sh; never part of the browser build.
import Navigo from 'navigo';

if (typeof window !== 'undefined' && !window.Navigo) {
  window.Navigo = Navigo;
}
