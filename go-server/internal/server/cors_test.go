package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// corsTestRouter mounts the real corsConfig() (not a copy) on a bare engine
// with one route, so these tests pin the actual policy used in Setup and move
// with it if the policy changes.
func corsTestRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	// cors.New panics on an invalid origin scheme (how we caught that
	// gin-contrib/cors rejects capacitor://). Constructing it here means a
	// future bad origin fails this test instead of only at server startup.
	r.Use(cors.New(corsConfig()))
	r.GET("/api/ping", func(c *gin.Context) { c.Status(http.StatusOK) })
	return r
}

// A cross-origin preflight from the Android WebView origin is answered (204)
// with the origin echoed and credentials off.
func TestCORSPreflightAllowedOrigin(t *testing.T) {
	r := corsTestRouter(t)
	req := httptest.NewRequest(http.MethodOptions, "/api/ping", nil)
	req.Header.Set("Origin", "https://localhost")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "Authorization,X-Refresh-Token")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "https://localhost" {
		t.Fatalf("Allow-Origin = %q, want https://localhost", got)
	}
	if got := w.Header().Get("Access-Control-Allow-Credentials"); got != "" {
		t.Fatalf("Allow-Credentials = %q, want empty (no credentials)", got)
	}
}

// A real cross-origin request from the WebView origin gets the origin echoed.
func TestCORSActualRequestAllowedOrigin(t *testing.T) {
	r := corsTestRouter(t)
	req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
	req.Header.Set("Origin", "https://localhost")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "https://localhost" {
		t.Fatalf("Allow-Origin = %q, want https://localhost", got)
	}
}

// Same-origin browser requests send no Origin header; the middleware must add
// no CORS headers, guaranteeing zero behavior change for the existing web app.
func TestCORSSameOriginIsNoop(t *testing.T) {
	r := corsTestRouter(t)
	req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Allow-Origin = %q, want empty (no-op for same-origin)", got)
	}
}

// An origin outside the allowlist is not echoed back.
func TestCORSDisallowedOrigin(t *testing.T) {
	r := corsTestRouter(t)
	req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if got := w.Header().Get("Access-Control-Allow-Origin"); got == "https://evil.example.com" {
		t.Fatalf("disallowed origin was allowed: %q", got)
	}
}
