-- Pipeline configuration, stored as a single JSON blob under the
-- 'pipelineConfig' key in the runtime_config table. Unlike the other
-- runtime_config rows (raw scalars), this value is a JSON document owned,
-- parsed, and validated by the pipeline package (internal/pipeline/config.go).
--
-- The config expresses only the TUNABLE parts of the pipeline: per-stage
-- concurrency, a per-stage system-level enable flag, and the resource-gating
-- graph (gatedBy). Data flow (routing between stages) is fixed in Go code and
-- is NOT configurable.
--
-- Defaults (sensible for a modest single box):
--   * concurrency 1 for every stage (no parallelism by default; raise per stage
--     as hardware allows).
--   * every stage enabled.
--   * heavy stages serialized via gates: nothing heavy starts until image
--     thumbnails are fully drained, then one heavy stage at a time
--     (face-recognition -> image-encoding -> video-compression). Each gate
--     lists ALL heavier-or-equal upstreams because the gate check is not
--     transitive (a stage only yields to the upstreams it explicitly names).
INSERT INTO runtime_config (key, value) VALUES
    ('pipelineConfig', '{
  "stages": [
    { "name": "bring-to-collection", "concurrency": 1 },
    { "name": "geo-lookup", "concurrency": 1, "enabled": true },
    { "name": "generate-video-thumbnail", "concurrency": 1 },
    { "name": "generate-image-thumbnails", "concurrency": 1 },
    { "name": "face-recognition", "concurrency": 1, "enabled": true, "gatedBy": ["generate-image-thumbnails"] },
    { "name": "image-encoding", "concurrency": 1, "enabled": true, "gatedBy": ["generate-image-thumbnails", "face-recognition"] },
    { "name": "video-compression", "concurrency": 1, "enabled": true, "gatedBy": ["generate-image-thumbnails", "face-recognition", "image-encoding"] }
  ]
}');

-- performFaceRecognition is superseded by the pipeline config's
-- face-recognition.enabled flag. Remove the now-unused scalar.
DELETE FROM runtime_config WHERE key = 'performFaceRecognition';
