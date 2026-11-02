package com.photoloka.app;

import android.os.Build;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;

import com.getcapacitor.BridgeActivity;

/**
 * Adds a tiny native bridge, window.PLImmersive, with enter()/exit() to toggle
 * Android immersive-sticky fullscreen (hide the status + navigation bars, with
 * swipe-to-reveal). There is no Capacitor/first-party API for the navigation
 * bar or the sticky behavior, so we call WindowInsetsController directly.
 *
 * The JS side (mobile/mobile-fullscreen.mjs) polyfills the web Fullscreen API
 * on top of this, so the shared web slideshow code (which calls
 * element.requestFullscreen()) drives real fullscreen in the app unchanged.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onStart() {
        super.onStart();
        // Register the bridge after the Capacitor WebView exists.
        getBridge().getWebView().addJavascriptInterface(new ImmersiveBridge(), "PLImmersive");
    }

    private class ImmersiveBridge {
        @JavascriptInterface
        public void enter() {
            runOnUiThread(() -> applyImmersive(true));
        }

        @JavascriptInterface
        public void exit() {
            runOnUiThread(() -> applyImmersive(false));
        }
    }

    // Named applyImmersive (not setImmersive) to avoid clashing with the
    // public Activity.setImmersive(boolean) method, which we must not weaken.
    private void applyImmersive(boolean on) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // API 30+: WindowInsetsController. Sticky = transient bars on swipe.
            WindowInsetsController c = getWindow().getInsetsController();
            if (c == null) return;
            if (on) {
                c.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
            } else {
                c.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
            }
        } else {
            // API 24-29: legacy system-UI flags (IMMERSIVE_STICKY).
            View decor = getWindow().getDecorView();
            if (on) {
                decor.setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                                | View.SYSTEM_UI_FLAG_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
            } else {
                decor.setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
            }
        }
    }
}
