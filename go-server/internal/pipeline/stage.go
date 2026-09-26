package pipeline

import (
	"photo-loka/internal/queue"
)

// Queue is the narrow view of a work queue that the pipeline needs. It is
// declared here (in the consumer) per Go idiom, so the queue package stays
// unaware of the pipeline. The concrete *queue.Queue satisfies it structurally;
// tests substitute a fake to drive gating deterministically without goroutines.
//
// The method set is exactly what the orchestrator calls: enqueue work, read
// state (for gating and status), install the gate hooks, and admin control.
type Queue interface {
	Enqueue(task queue.Task)
	GetStatus() queue.Status
	QueueSizes() (high, normal, low int)
	GetErrors() []queue.Error
	SetConcurrency(n int)
	Pause()
	Resume()
	Stop()
	SetCanDispatch(fn func() bool)
	SetOnDrained(fn func())
	Kick()
}

// Stage is one unit of pipeline work with its own queue and concurrency.
//
// Two relationships are tracked, deliberately kept separate (see
// docs/pipeline-dag-design.md):
//   - Downstreams: DATA FLOW. Where an item goes after this stage finishes.
//     Hardcoded in code (buildStages); not configurable.
//   - GatedBy: RESOURCE SCHEDULING. This stage must not START a task while any
//     of these upstream stages is busy (running or pending). Derived from the
//     user's scheduling config; may name any stage regardless of data flow.
type Stage struct {
	Name        string
	Fn          StageFn
	Queue       Queue
	Downstreams []*Stage
	GatedBy     []*Stage

	// Enabled is the system-level (this-install) master switch for the stage,
	// set from PipelineConfig. A disabled optional stage is skipped during
	// routing regardless of per-item applicability. Structural stages are
	// always enabled (config validation forbids disabling them).
	Enabled bool
}

// StageFn is the actual work a stage performs for one item. uuid is mandatory;
// hint carries optional pre-computed inputs (e.g. an in-memory ML buffer). When
// hint is nil or a field is absent, the stage self-hydrates from the DB/disk by
// uuid, so every stage is callable standalone as well as from the orchestrator.
type StageFn func(uuid string, hint *StageHint) error

// upstreamBusy reports whether any stage in GatedBy is busy (running OR
// pending). The gate is closed while this is true: the queue's CanDispatch
// predicate (set to !upstreamBusy) declines to start tasks until all gating
// upstreams are fully drained.
func (s *Stage) upstreamBusy() bool {
	for _, up := range s.GatedBy {
		st := up.Queue.GetStatus()
		if st.Active > 0 || st.Pending > 0 {
			return true
		}
	}
	return false
}
