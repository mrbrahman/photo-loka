# Pipeline Design - Future Enhancement

## Current State

The indexing pipeline uses a single queue with priority levels (matching Node.js behavior):
- `indexQueue` (CPU-1 workers) - High: indexFile, Normal: face recognition, Low: video compression
- `geoQueue` (1 worker) - rate-limited geo API lookups (separate due to rate limiting)
- `videoQueue` exists but is currently unused (video compression was moved to indexQueue Low priority so it doesn't run concurrently with indexing)

The `internal/queue/Queue` struct supports:
- Three priority levels (High > Normal > Low, FIFO within each)
- Independent concurrency (configurable per queue)
- Pause/resume per queue
- Status/errors per queue
- Any `func() error` as a task

## Goal

Allow users to define a configurable processing pipeline. The diagram uses an
Airflow-like syntax, but note carefully what it does and does not describe:

```
[cpu, gpu]
cpu >> [bring-to-collection(5), thumbnail-extraction(5), geo-address(10)] >> video-compression(4)
gpu >> face-recognition(1) >> image-encoding(1)
```

**The diagram schedules resources. It does NOT define data flow.**

There are two orthogonal concerns layered on the same picture:

1. **Data flow (fixed, hardcoded in Go).** The set of stages is finite and known.
   The orchestrator already knows how an item moves between stages: every item
   enters at `bring-to-collection` first, and only after that does it fan out to
   the remaining stages. This routing is wired in Go code, not in the diagram or
   any config. The diagram never changes it.

2. **Resource scheduling (what the diagram expresses).** The `>>` operator and
   the `[...]` grouping describe *which stages may run at the same time as which*,
   based on resource contention (CPU vs GPU, or a stage that needs a resource to
   itself). This is the tunable part.

## Terminology

- **Stage** - a unit of work with its own queue and concurrency (e.g.
  `thumbnail-extraction(5)` = a stage with max concurrency 5). Stages are fixed.
- **Resource group** - a purely visual label (`cpu`, `gpu`) used to group stages
  that compete for the same resource. Groups have no runtime meaning of their own;
  they are documentation to make the diagram readable. The names can be anything.
- **Gate (`>>`)** - a one-directional resource-exclusion relationship. `A >> B`
  means "B must not run while A is running." See below for the precise rule.
- **Coexisting stages (`[a, b, c]`)** - stages listed together in a bracket may
  run concurrently with each other. They share the resource cooperatively (each
  has its own concurrency limit).
- **Busy** - a stage is *busy* when it has any task running OR any task pending
  (running + pending > 0). A stage is *fully drained* when it is not busy: nothing
  running and nothing queued. Gating keys off "busy," so a stage with only pending
  tasks still counts as busy and keeps its gated downstream closed.

## Gating semantics (the core of this change)

`A >> B` is about avoiding *concurrent execution*, not about data dependency and
not about pending work.

Precise rule:
- **B must not start a task while A is *busy*, where busy means A has any task
  running OR any task pending (running + pending > 0).** In other words, B waits
  until A is *fully drained* - nothing running and nothing queued.
- A pending B task is allowed to sit in B's queue. It simply is not *dispatched*
  (started) while A is busy.
- The gate is evaluated at **dispatch time** - the instant B is about to start a
  task, it checks whether any upstream gate (A) is busy. A pending B task becomes
  eligible only once A is fully drained, so the check cannot be done only at
  enqueue time.

Why "fully drained" and not merely "no running task": using running+pending avoids
a blip where A momentarily has zero running tasks (between two of its own items)
but still has queued work. Under a "no running task" rule, B could opportunistically
grab a slot in that gap and then overlap with A when A picks up its next pending
item. Requiring A to be fully drained removes that race: B only starts once A is
genuinely done.

Tradeoff (accepted): this is stricter / more throughput-conservative. Under a
continuous trickle of input (e.g. a live folder watch that keeps feeding an
upstream), the upstream may rarely reach empty, so a gated stage could be delayed
for a long time. For this app's common case - batch indexing a folder, draining it,
then compressing - "fully drained" is exactly the desired behavior and the trickle
concern does not apply. If steady-trickle starvation ever becomes a problem, revisit
per-gate configurability.

Directionality and tie-breaks (`>>` is one-directional; A has priority):
- **A never waits for B.** B yields to A.
- If A becomes busy again while B already has tasks running, those in-flight B
  tasks are **not** killed - they finish naturally. But no *new* B task is
  dispatched until A is fully drained again.
- So the invariant is "do not *start* B while A is busy." With the fully-drained
  rule this overlap is rare (B only started because A was empty, and A becoming
  busy again requires new input), but if it does occur, B's already-running work
  finishes rather than being killed. This is an accepted tradeoff.

Worked example:
```
cpu >> [bring-to-collection(5), thumbnail-extraction(5), geo-address(10)] >> video-compression(4)
```
- `bring-to-collection`, `thumbnail-extraction`, `geo-address` coexist - they run
  in parallel, each with its own concurrency.
- `video-compression` is gated behind that whole bracket: it will not *start* a
  new task while any of the three bracketed stages is busy. It waits until all
  three are fully drained (zero running AND zero pending across them), then
  dispatches.
- The `gpu` lane (`face-recognition >> image-encoding`) runs independently of the
  cpu lane, since they contend on a different resource. Within it, `image-encoding`
  will not start while `face-recognition` is busy (running or pending).

## Data flow (separate, hardcoded)

Independent of the diagram, the orchestrator knows the item routing in Go:
- An item always enters at `bring-to-collection`.
- After `bring-to-collection` completes for that item, it is forwarded to the
  downstream stages (thumbnail, geo, face-recognition, ...).
- Nothing else depends on any other stage for routing - `bring-to-collection` is
  the only hard predecessor.

This routing is fixed and lives in code. The diagram/config never edits it; it
only tunes concurrency and gating.

## Visual Representation (resource view)

```
resource: cpu
  +-- bring-to-collection (5) --+-- thumbnail-extraction (5) --+
  |                             +-- geo-address (10) ----------+---[gate]--> video-compression (4)
  |
resource: gpu
  +-- face-recognition (1) ---[gate]--> image-encoding (1)
```

The arrows here mean "gated behind," i.e. the right side does not start while the
left side is busy (running or pending). They are NOT data-flow arrows.

## Implementation Plan (tentative)

### 1. Each stage = a `queue.Queue` instance (already available)

Each stage gets its own queue with its own concurrency. The gate needs the
upstream's *busy* state (running + pending). The queue already exposes both via
`GetStatus()` (`Active` = running, `Pending` = queued), so no new counters are
required - the gate reads `Active + Pending > 0`.

### 2. Stage definition

```go
type Stage struct {
    Name        string
    Concurrency int
    Fn          func(item *PipelineItem) error // the actual work
    Queue       *queue.Queue

    // Data flow (hardcoded routing): where an item goes after this stage.
    Downstreams []*Stage

    // Resource gating: this stage must not START a task while any of these
    // upstream stages is busy (running or pending). Evaluated at dispatch time.
    GatedBy []*Stage
}
```

Note the two lists are separate on purpose: `Downstreams` is data flow,
`GatedBy` is resource scheduling. They are configured from different sources
(Downstreams from code; GatedBy derived from the diagram/config).

### 3. Gate evaluation

A stage is *busy* if its queue reports any running OR pending task. The gate for a
stage is "no upstream in `GatedBy` is busy" (all upstreams fully drained).

```go
func (s *Stage) upstreamBusy() bool {
    for _, up := range s.GatedBy {
        st := up.Queue.GetStatus()
        if st.Active > 0 || st.Pending > 0 {
            return true
        }
    }
    return false
}
```

Because the gate must be checked at dispatch time, the queue's dispatch loop needs
a way to defer starting a task when the gate is closed. Chosen approach:

- **Option A - gate hook in the queue (chosen).** Add an optional
  `CanDispatch func() bool` to `queue.Queue`. Before the dispatch loop starts a
  task, it calls the hook; if it returns false, it does not dispatch and waits for
  the next notify to re-check. The gate hook is
  `func() bool { return !stage.upstreamBusy() }`. This keeps gating logic out of
  the pipeline's item-forwarding path, and the queue never calls Pause/Resume for
  gating (those stay reserved for explicit admin control - see Control
  Responsibility below).

- **Option B - orchestrator-driven pause/resume (rejected).** The orchestrator
  watches upstream busy counts and calls `stage.Queue.Pause()` / `Resume()` as
  gates open and close. Rejected: it overloads the pause flag with two meanings
  (gating vs admin) and needs a polling watcher goroutine that is racier around
  the drained transition.

Option A makes the gate decision exactly at dispatch, closing the race where B
starts in the same instant A becomes busy. It requires a small, well-contained
change to the queue (a pre-dispatch predicate + an on-drained signal).

Re-checking (efficient trigger): the gate `!upstreamBusy()` can only flip from
closed to open when an upstream becomes **fully drained** - its running + pending
count reaches **zero**. Therefore the kick must fire on the upstream's
**busy -> drained transition**, NOT on every task completion.

- Kicking on every completion is wasteful: if an upstream has 5 tasks running (or
  more pending) and one finishes, the gate is still closed. The gated stage would
  wake, re-evaluate `CanDispatch()`, get false, and sleep again - a wasted wakeup.
- The only meaningful edge is the queue going empty: the last task completes AND no
  pending tasks remain. At that instant the orchestrator signals the notify
  channels of the stages that list this upstream in `GatedBy`.

Concretely: when a worker finishes a task and decrements the queue's active count,
the queue checks whether running + pending is now zero; if so it fires an "idle"
(drained) signal, which the orchestrator forwards to the dependent gated stages.

Because gating waits for full drain (running + pending == 0), the momentary-idle
blip does not arise: a gated stage only starts once its upstreams are genuinely
empty, and the one-directional rule handles the rare case where new input arrives
at an upstream just after it drained.

### Control Responsibility

- **The queue** decides moment-to-moment whether it may dispatch, by evaluating its
  `CanDispatch()` predicate at dispatch time. Gating never sets the queue's paused
  flag; a gated-closed queue is simply declining to dispatch, not paused.
- **The orchestrator** wires each gated stage's predicate
  (`CanDispatch = !upstreamBusy`) and delivers the drained-signal kicks to gated
  stages when an upstream empties. It does not read or flip pause state for gating.
- **`Pause()` / `Resume()`** remain reserved for explicit operator/admin control
  (the admin endpoints, manual stop). A stage can be gated-closed AND admin-paused
  independently; both must be clear before it dispatches (`!isPaused && CanDispatch()`).

### 4. Pipeline orchestrator

```go
type Pipeline struct {
    stages map[string]*Stage
    entry  *Stage // bring-to-collection
}

// Submit puts a new item at the entry stage. Routing to downstreams is
// hardcoded; gating is enforced by the queue's dispatch predicate.
func (p *Pipeline) Submit(item *PipelineItem) {
    p.enqueue(p.entry, item)
}

func (p *Pipeline) enqueue(stage *Stage, item *PipelineItem) {
    stage.Queue.Enqueue(queue.Task{
        Description: stage.Name,
        Fn: func() error {
            if err := stage.Fn(item); err != nil {
                return err
            }
            // Data flow: forward to hardcoded downstreams.
            for _, ds := range stage.Downstreams {
                p.enqueue(ds, item)
            }
            return nil
        },
    })
}
```

Note there is no `JoinTracker` here. The earlier design had a fan-in join because
it modeled `>>` as a per-item data dependency (video-compression waits for both
thumbnail AND geo *for the same item*). Under the corrected model, `>>` is a
*resource gate*, not a per-item join, so join tracking is not needed for
gating. If a genuine per-item fan-in dependency exists in the data flow, it would
be handled separately in the hardcoded routing - but the current stages do not
require it (bring-to-collection is the only predecessor).

### 5. Config format

Only the tunable parts (concurrency and gating) come from config. Data flow is
not configurable. A compact DSL mirroring the diagram:

```
[cpu, gpu]
cpu >> [bring-to-collection(5), thumbnail-extraction(5), geo-address(10)] >> video-compression(4)
gpu >> face-recognition(1) >> image-encoding(1)
```

Parsed into:
- per-stage concurrency (the `(N)`),
- `GatedBy` edges (from `>>`),
- resource-group labels are parsed but only retained for display/validation.

Equivalent explicit form:
```yaml
pipeline:
  stages:
    - name: bring-to-collection
      concurrency: 5
    - name: thumbnail-extraction
      concurrency: 5
    - name: geo-address
      concurrency: 10
    - name: video-compression
      concurrency: 4
      gated-by: [bring-to-collection, thumbnail-extraction, geo-address]
    - name: face-recognition
      concurrency: 1
    - name: image-encoding
      concurrency: 1
      gated-by: [face-recognition]
```

### 6. Runtime control APIs

```
GET  /api/admin/pipeline/status          -> status per stage (pending, running, gated?)
PUT  /api/admin/pipeline/stages/:name/concurrency/:n
PUT  /api/admin/pipeline/stages/:name/pause
PUT  /api/admin/pipeline/stages/:name/resume
```

Status should expose, per stage: pending, running, and whether it is currently
*gated closed* (an upstream is still busy - running or pending).

### 7. Conditional stages

Some stages only apply to certain media types:
- video-compression: only for video items
- face-recognition: only for images
- geo-address: only if GPS coordinates exist

The stage function handles this (returns nil immediately if not applicable), or we
add a `Condition func(*PipelineItem) bool` field to Stage. This is orthogonal to
gating.

## Migration Path

1. Phase 3 (done): Two hardcoded queues, pipeline logic in `indexing/pipeline.go`
2. Future step: Refactor pipeline.go to use Stage structs with hardcoded
   `Downstreams` routing (data flow), keeping current behavior.
3. Future step: Add the dispatch-time gate predicate (`CanDispatch`) and the
   on-drained signal to `queue.Queue` (Option A), then wire `GatedBy` +
   drained-transition re-check in the orchestrator.
4. Future step: Add config parsing (DSL or YAML) for concurrency + gating only.
5. Future step: Add per-stage status/control endpoints (including gated state).

## Confirmed Decisions

- **Gate condition (confirmed):** `A >> B` gates B until A is *fully drained*
  (running + pending == 0), not merely momentarily idle. This avoids the blip where
  A has zero running but still-queued work. Accepted tradeoff: stricter/more
  conservative; a continuous trickle into A could delay B. Fine for the batch-index
  workload; revisit per-gate config if trickle starvation ever appears.
- **Tie-break (confirmed):** `>>` is one-directional. A never waits for B; B yields
  to A. When A becomes busy again while B has tasks running, those in-flight B tasks
  finish naturally (they are never killed), but no new B task is dispatched until A
  is fully drained. Brief overlap of B's in-flight work with A's newly-arrived work is
  accepted.
- **Gate scope (confirmed):** gating pauses only the directly gated stage(s) and
  everything downstream of them - not the whole pipeline.
- **Drained re-check (confirmed, required):** the kick fires on an upstream's
  **busy -> drained transition** (running + pending reaches zero), NOT on every
  task completion. Kicking per-completion is wasteful because the gate stays closed
  while any upstream task is running or pending. When an upstream becomes fully
  drained, it signals the notify channel of each stage that lists it in `GatedBy`.
  A gated stage must not stall waiting for an unrelated notify, so this
  drained-transition kick is a hard requirement, not an optimization.

## Files to Create (when implementing)

```
go-server/internal/pipeline/
    stage.go       # Stage struct (Downstreams + GatedBy)
    pipeline.go    # Pipeline orchestrator, Submit, enqueue, gate re-check
    config.go      # Parse DSL/YAML into concurrency + gating (not data flow)
    handler.go     # Per-stage status/control endpoints
```

Queue changes (small, contained) to `internal/queue/queue.go` for Option A gating:
1. An optional pre-dispatch predicate `CanDispatch func() bool`, checked in the
   dispatch loop alongside the existing `isPaused` check (dispatch requires
   `!isPaused && (CanDispatch == nil || CanDispatch())`).
2. An on-drained signal: when a worker's `active.Add(-1)` brings running to zero
   and no pending tasks remain, fire a callback/channel so the orchestrator can
   kick the stages gated behind this queue. The queue already tracks `active` and
   pending counts, so this is a cheap check at task completion.
