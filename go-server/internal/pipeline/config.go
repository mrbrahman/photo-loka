package pipeline

import (
	"encoding/json"
	"fmt"

	"photo-loka/internal/database"
)

// PipelineConfig is the tunable configuration of the pipeline: per-stage
// concurrency, a system-level enable flag, and the resource-gating graph. Data
// flow is fixed in code and is not part of this config.
//
// It is persisted as a JSON blob under the runtime_config 'pipelineConfig' key
// and parsed/validated here (seeded by migration 014).
type PipelineConfig struct {
	Stages []StageConfig `json:"stages"`
}

// StageConfig is one stage's tunable settings. Concurrency and Enabled are
// pointers so an omitted field is distinguishable from a zero value and can
// take the documented default (concurrency 1, enabled true).
type StageConfig struct {
	Name        string   `json:"name"`
	Concurrency *int     `json:"concurrency,omitempty"`
	Enabled     *bool    `json:"enabled,omitempty"`
	GatedBy     []string `json:"gatedBy,omitempty"`
}

// allStages is the fixed set of stages; every one must appear exactly once in a
// valid config.
var allStages = []string{
	StageBringToCollection,
	StageGeoLookup,
	StageVideoThumbnail,
	StageImageThumbnails,
	StageFaceRecognition,
	StageImageEncoding,
	StageVideoCompression,
}

// structuralStages cannot be disabled: the pipeline cannot function without
// them (entry, and the thumbnail stages the ML stages depend on).
var structuralStages = map[string]bool{
	StageBringToCollection: true,
	StageImageThumbnails:   true,
	StageVideoThumbnail:    true,
}

// concurrency returns the configured concurrency or the default (1).
func (sc StageConfig) concurrency() int {
	if sc.Concurrency != nil && *sc.Concurrency >= 1 {
		return *sc.Concurrency
	}
	return 1
}

// enabled returns the configured enable flag or the default (true).
func (sc StageConfig) enabled() bool {
	if sc.Enabled != nil {
		return *sc.Enabled
	}
	return true
}

// DefaultPipelineConfig returns the built-in default used when no config is
// stored: concurrency 1 everywhere, all stages enabled, and heavy stages
// serialized via gates (nothing heavy starts until image thumbnails drain, then
// one heavy stage at a time). Mirrors migration 014's seed.
func DefaultPipelineConfig() PipelineConfig {
	t := true
	one := 1
	en := func() *bool { b := t; return &b }
	c := func() *int { n := one; return &n }
	return PipelineConfig{
		Stages: []StageConfig{
			{Name: StageBringToCollection, Concurrency: c()},
			{Name: StageGeoLookup, Concurrency: c(), Enabled: en()},
			{Name: StageVideoThumbnail, Concurrency: c()},
			{Name: StageImageThumbnails, Concurrency: c()},
			{Name: StageFaceRecognition, Concurrency: c(), Enabled: en(),
				GatedBy: []string{StageImageThumbnails}},
			{Name: StageImageEncoding, Concurrency: c(), Enabled: en(),
				GatedBy: []string{StageImageThumbnails, StageFaceRecognition}},
			{Name: StageVideoCompression, Concurrency: c(), Enabled: en(),
				GatedBy: []string{StageImageThumbnails, StageFaceRecognition, StageImageEncoding}},
		},
	}
}

// ParsePipelineConfig parses and validates the JSON blob. An empty/blank input
// returns the default config (so a missing row degrades gracefully).
func ParsePipelineConfig(raw string) (PipelineConfig, error) {
	if len(raw) == 0 {
		return DefaultPipelineConfig(), nil
	}
	var cfg PipelineConfig
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		return PipelineConfig{}, fmt.Errorf("parsing pipeline config: %w", err)
	}
	if err := cfg.Validate(); err != nil {
		return PipelineConfig{}, err
	}
	return cfg, nil
}

// Validate checks structural correctness:
//   - every fixed stage appears exactly once, and no unknown stages;
//   - structural stages are not disabled;
//   - every gatedBy name is a known stage (and not self);
//   - the gate graph is acyclic (a cycle would deadlock, each stage waiting for
//     the other to drain).
func (cfg PipelineConfig) Validate() error {
	known := make(map[string]bool, len(allStages))
	for _, n := range allStages {
		known[n] = true
	}

	seen := make(map[string]bool, len(cfg.Stages))
	for _, s := range cfg.Stages {
		if !known[s.Name] {
			return fmt.Errorf("unknown stage %q in pipeline config", s.Name)
		}
		if seen[s.Name] {
			return fmt.Errorf("stage %q listed more than once", s.Name)
		}
		seen[s.Name] = true

		if s.Enabled != nil && !*s.Enabled && structuralStages[s.Name] {
			return fmt.Errorf("stage %q cannot be disabled (structural)", s.Name)
		}
		if s.Concurrency != nil && *s.Concurrency < 1 {
			return fmt.Errorf("stage %q concurrency must be >= 1", s.Name)
		}

		for _, g := range s.GatedBy {
			if !known[g] {
				return fmt.Errorf("stage %q gatedBy unknown stage %q", s.Name, g)
			}
			if g == s.Name {
				return fmt.Errorf("stage %q cannot be gated behind itself", s.Name)
			}
		}
	}

	for _, n := range allStages {
		if !seen[n] {
			return fmt.Errorf("stage %q missing from pipeline config", n)
		}
	}

	return cfg.checkAcyclic()
}

// checkAcyclic detects a cycle in the gate graph (edge s -> g means "s is gated
// behind g"). A cycle deadlocks, so it is rejected.
func (cfg PipelineConfig) checkAcyclic() error {
	edges := make(map[string][]string, len(cfg.Stages))
	for _, s := range cfg.Stages {
		edges[s.Name] = s.GatedBy
	}

	const (
		white = 0 // unvisited
		gray  = 1 // on the current DFS stack
		black = 2 // fully explored
	)
	color := make(map[string]int, len(edges))

	var visit func(n string) error
	visit = func(n string) error {
		color[n] = gray
		for _, m := range edges[n] {
			switch color[m] {
			case gray:
				return fmt.Errorf("pipeline gate graph has a cycle involving %q and %q", n, m)
			case white:
				if err := visit(m); err != nil {
					return err
				}
			}
		}
		color[n] = black
		return nil
	}

	for _, s := range cfg.Stages {
		if color[s.Name] == white {
			if err := visit(s.Name); err != nil {
				return err
			}
		}
	}
	return nil
}

// byName returns a name->StageConfig map for applying the config.
func (cfg PipelineConfig) byName() map[string]StageConfig {
	m := make(map[string]StageConfig, len(cfg.Stages))
	for _, s := range cfg.Stages {
		m[s.Name] = s
	}
	return m
}

// GetConfigJSON returns the currently stored pipeline config JSON (the raw
// runtime_config 'pipelineConfig' value). If no row exists, it returns the
// default config marshaled to JSON. For the admin getConfig endpoint.
func GetConfigJSON() (json.RawMessage, error) {
	var raw string
	err := database.DB.QueryRow(
		"SELECT value FROM runtime_config WHERE key = 'pipelineConfig'",
	).Scan(&raw)
	if err != nil {
		b, mErr := json.Marshal(DefaultPipelineConfig())
		if mErr != nil {
			return nil, mErr
		}
		return b, nil
	}
	return json.RawMessage(raw), nil
}

// SetConfigJSON validates and persists a new pipeline config JSON to
// runtime_config. It does NOT re-wire the running pipeline: config changes take
// effect on restart (static apply; dynamic re-wire is a later enhancement).
// Returns an error if the JSON is invalid or fails validation.
func SetConfigJSON(raw string) error {
	if _, err := ParsePipelineConfig(raw); err != nil {
		return err
	}
	// Store the canonical, re-marshaled form so we persist validated JSON.
	cfg, _ := ParsePipelineConfig(raw)
	return persistConfig(cfg)
}

// persistConfig writes the (already-validated) config to the runtime_config
// pipelineConfig row.
func persistConfig(cfg PipelineConfig) error {
	b, err := json.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("marshaling pipeline config: %w", err)
	}
	_, err = database.DB.Exec(
		`INSERT INTO runtime_config (key, value) VALUES ('pipelineConfig', ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		string(b),
	)
	if err != nil {
		return fmt.Errorf("persisting pipeline config: %w", err)
	}
	return nil
}

// persistStageConcurrency updates one stage's concurrency in the stored config
// blob (so a live concurrency change survives restart), leaving everything else
// intact. Concurrency is safe to persist independently because it does not
// affect the gate graph.
func persistStageConcurrency(name string, n int) error {
	raw, err := GetConfigJSON()
	if err != nil {
		return err
	}
	cfg, err := ParsePipelineConfig(string(raw))
	if err != nil {
		return err
	}
	found := false
	for i := range cfg.Stages {
		if cfg.Stages[i].Name == name {
			cfg.Stages[i].Concurrency = &n
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("unknown stage %q", name)
	}
	return persistConfig(cfg)
}
