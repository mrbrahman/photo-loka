package pipeline

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// setP installs a fake-queue pipeline as the package singleton P for handler
// tests, restoring the previous value on cleanup.
func setP(t *testing.T) (*Pipeline, map[string]*fakeQueue) {
	t.Helper()
	prev := P
	p, fakes := fakePipeline(t, DefaultPipelineConfig())
	P = p
	t.Cleanup(func() { P = prev })
	return p, fakes
}

func newRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterRoutes(r.Group("/api/admin"))
	return r
}

func do(t *testing.T, r *gin.Engine, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func doBody(t *testing.T, r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestHandler_ValidateConfig(t *testing.T) {
	_, _ = setP(t)
	r := newRouter()

	// Valid config -> 200 {valid:true}.
	valid, _ := json.Marshal(DefaultPipelineConfig())
	w := doBody(t, r, http.MethodPost, "/api/admin/pipeline/config/validate", string(valid))
	if w.Code != http.StatusOK {
		t.Fatalf("valid config code = %d, want 200 (body=%s)", w.Code, w.Body.String())
	}
	var body struct {
		Valid bool `json:"valid"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if !body.Valid {
		t.Errorf("expected valid:true, got %s", w.Body.String())
	}

	// Cyclic gate graph -> 400.
	cyclic := `{"stages":[
		{"name":"bring-to-collection"},{"name":"geo-lookup"},
		{"name":"generate-video-thumbnail"},{"name":"generate-image-thumbnails"},
		{"name":"face-recognition","gatedBy":["image-encoding"]},
		{"name":"image-encoding","gatedBy":["face-recognition"]},
		{"name":"video-compression"}]}`
	if w := doBody(t, r, http.MethodPost, "/api/admin/pipeline/config/validate", cyclic); w.Code != http.StatusBadRequest {
		t.Errorf("cyclic config code = %d, want 400", w.Code)
	}

	// Empty body -> 400.
	if w := doBody(t, r, http.MethodPost, "/api/admin/pipeline/config/validate", ""); w.Code != http.StatusBadRequest {
		t.Errorf("empty body code = %d, want 400", w.Code)
	}
}

func TestHandler_Status(t *testing.T) {
	_, _ = setP(t)
	r := newRouter()

	w := do(t, r, http.MethodGet, "/api/admin/pipeline/status")
	if w.Code != http.StatusOK {
		t.Fatalf("status code = %d, want 200", w.Code)
	}
	var body struct {
		Stages map[string]map[string]interface{} `json:"stages"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := body.Stages[StageFaceRecognition]; !ok {
		t.Errorf("status response missing face-recognition; got %v", body.Stages)
	}
}

func TestHandler_PauseResume(t *testing.T) {
	_, fakes := setP(t)
	r := newRouter()

	if w := do(t, r, http.MethodPut, "/api/admin/pipeline/stages/"+StageVideoCompression+"/pause"); w.Code != http.StatusOK {
		t.Fatalf("pause code = %d, want 200", w.Code)
	}
	if !fakes[StageVideoCompression].paused {
		t.Error("video-compression should be paused after PUT pause")
	}
	if w := do(t, r, http.MethodPut, "/api/admin/pipeline/stages/"+StageVideoCompression+"/resume"); w.Code != http.StatusOK {
		t.Fatalf("resume code = %d, want 200", w.Code)
	}
	if fakes[StageVideoCompression].paused {
		t.Error("video-compression should be resumed after PUT resume")
	}
}

func TestHandler_UnknownStage404(t *testing.T) {
	_, _ = setP(t)
	r := newRouter()

	if w := do(t, r, http.MethodPut, "/api/admin/pipeline/stages/nope/pause"); w.Code != http.StatusNotFound {
		t.Errorf("unknown stage pause code = %d, want 404", w.Code)
	}
}

func TestHandler_InvalidConcurrency400(t *testing.T) {
	_, _ = setP(t)
	r := newRouter()

	// non-numeric and zero are both invalid; both return before touching the DB.
	if w := do(t, r, http.MethodPut, "/api/admin/pipeline/stages/"+StageFaceRecognition+"/concurrency/0"); w.Code != http.StatusBadRequest {
		t.Errorf("concurrency 0 code = %d, want 400", w.Code)
	}
}

func TestHandler_NotReady503(t *testing.T) {
	prev := P
	P = nil
	t.Cleanup(func() { P = prev })
	r := newRouter()

	if w := do(t, r, http.MethodGet, "/api/admin/pipeline/status"); w.Code != http.StatusServiceUnavailable {
		t.Errorf("status with nil P code = %d, want 503", w.Code)
	}
}
