# Pipeline DAG Design - Future Enhancement

## Current State

Two independent queues exist (implemented in Phase 3):
- `indexQueue` (CPU-1 workers) — handles metadata extraction + thumbnails
- `videoQueue` (2 workers) — handles video compression

Both use the same `internal/queue/Queue` struct which supports:
- Independent concurrency (configurable per queue)
- Pause/resume per queue
- Status/errors per queue
- Any `func() error` as a task

## Goal

Allow users to define a configurable processing pipeline using a DAG (directed acyclic graph) syntax inspired by Airflow:

```
bring-to-collection >> [cpu, gpu]
cpu >> [thumbnail-extraction(5), geo-address(10)] >> video-compression(4)
gpu >> face-recognition(1) >> image-encoding(1)
```

This means:
- `>>` = sequential dependency (B starts after A completes for the same item)
- `[a, b]` = fork (run in parallel)
- `(N)` = max concurrency for that stage
- A join stage (e.g. video-compression after both thumbnail + geo) waits for ALL upstreams

## Visual Representation

```
                          +-- thumbnail-extraction (5 workers) --+
bring-to-collection --+--|                                       |-- video-compression (4 workers)
                      |  +-- geo-address (10 workers) -----------+
                      |
                      +---- face-recognition (1 worker) ---- image-encoding (1 worker)
```

## Implementation Plan

### 1. Each stage = a `queue.Queue` instance (already done)

No changes to `internal/queue/queue.go` needed. Each stage gets its own queue with its own concurrency.

### 2. Stage definition

```go
type Stage struct {
    Name        string
    Concurrency int
    Fn          func(item *PipelineItem) error  // the actual work
    Queue       *queue.Queue
    Downstreams []*Stage                        // where to send after completion
    JoinCount   int                             // how many upstreams must complete before this runs (0 = no join)
}
```

### 3. Join (fan-in) tracking

For stages that require multiple upstreams to complete (e.g. video-compression waits for thumbnail AND geo):

```go
type JoinTracker struct {
    mu       sync.Mutex
    pending  map[string]int  // item UUID -> count of completed upstreams
    required int             // how many upstreams must complete
}

func (j *JoinTracker) Arrive(uuid string) bool {
    j.mu.Lock()
    defer j.mu.Unlock()
    j.pending[uuid]++
    if j.pending[uuid] >= j.required {
        delete(j.pending, uuid)
        return true  // ready to proceed
    }
    return false
}
```

### 4. Pipeline orchestrator

```go
type Pipeline struct {
    stages map[string]*Stage
    entry  *Stage  // first stage
}

func (p *Pipeline) Submit(item *PipelineItem) {
    p.entry.Queue.Enqueue(queue.Task{
        Fn: func() error {
            if err := p.entry.Fn(item); err != nil {
                return err
            }
            // Fan out to downstreams
            for _, ds := range p.entry.Downstreams {
                p.forward(item, ds)
            }
            return nil
        },
    })
}

func (p *Pipeline) forward(item *PipelineItem, stage *Stage) {
    if stage.JoinCount > 0 {
        // Check if all upstreams are done for this item
        if !stage.joinTracker.Arrive(item.UUID) {
            return  // not ready yet
        }
    }
    stage.Queue.Enqueue(queue.Task{
        Fn: func() error {
            if err := stage.Fn(item); err != nil {
                return err
            }
            for _, ds := range stage.Downstreams {
                p.forward(item, ds)
            }
            return nil
        },
    })
}
```

### 5. Config format (YAML or JSON in runtime-config)

```yaml
pipeline:
  stages:
    - name: bring-to-collection
      concurrency: 1
      next: [thumbnail-extraction, geo-address, face-recognition]

    - name: thumbnail-extraction
      concurrency: 5
      next: [video-compression]

    - name: geo-address
      concurrency: 10
      next: [video-compression]

    - name: video-compression
      concurrency: 4
      join: 2  # wait for 2 upstreams (thumbnail + geo)

    - name: face-recognition
      concurrency: 1
      next: [image-encoding]

    - name: image-encoding
      concurrency: 1
```

Or the compact Airflow-like DSL (parsed into the same structure):
```
bring-to-collection >> [cpu, gpu]
cpu >> [thumbnail-extraction(5), geo-address(10)] >> video-compression(4)
gpu >> face-recognition(1) >> image-encoding(1)
```

### 6. Runtime control APIs

```
GET  /api/admin/pipeline/status          -> status per stage
PUT  /api/admin/pipeline/stages/:name/concurrency/:n
PUT  /api/admin/pipeline/stages/:name/pause
PUT  /api/admin/pipeline/stages/:name/resume
```

### 7. Conditional stages

Some stages only apply to certain media types:
- video-compression: only for video items
- face-recognition: only for images
- geo-address: only if GPS coordinates exist

The stage function itself handles this (returns nil immediately if not applicable), or we add a `Condition func(*PipelineItem) bool` field to Stage.

## Migration Path

1. Phase 3 (done): Two hardcoded queues, pipeline logic in `indexing/pipeline.go`
2. Future step: Refactor pipeline.go to use Stage structs with functions
3. Future step: Add Pipeline orchestrator with fan-out/join
4. Future step: Add config parsing (YAML or DSL)
5. Future step: Add per-stage API endpoints

The `queue.Queue` struct needs NO changes throughout this evolution.

## Files to Create (when implementing)

```
go-server/internal/pipeline/
    stage.go       # Stage struct, JoinTracker
    pipeline.go    # Pipeline orchestrator, Submit, forward
    config.go      # Parse YAML/DSL into stage graph
    handler.go     # Per-stage status/control endpoints
```
