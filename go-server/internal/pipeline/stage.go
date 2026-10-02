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
	RegisterGate(name string, isOpen func() bool)
	ClearGates()
	ClearGate(name string)
	Subscribe() <-chan queue.Event
	Kick()
}

// node is one entry in the pipeline's queue master list: a named work queue
// plus the work function and the system-level enable flag. The pipeline owns a
// map of these (by name) and the data-flow routing between them (a separate
// routing table over queue names -- see routeDownstreams); a node itself
// carries NO routing or gating state.
//
// Gating is owned entirely by the gaters (resource gating by resourceGater,
// geo rate limiting by the geo rate gater), which the pipeline attaches onto
// these nodes' queues. The node does not know whether or how it is gated.
type node struct {
	Name    string
	Fn      StageFn
	Queue   Queue

	// Enabled is the system-level (this-install) master switch for the node's
	// stage, set from PipelineConfig. A disabled optional stage is skipped
	// during routing regardless of per-item applicability. Structural stages
	// are always enabled (config validation forbids disabling them).
	Enabled bool
}

// StageFn is the actual work a stage performs for one item. uuid is mandatory;
// hint carries optional pre-computed inputs (e.g. an in-memory ML buffer). When
// hint is nil or a field is absent, the stage self-hydrates from the DB/disk by
// uuid, so every stage is callable standalone as well as from the orchestrator.
type StageFn func(uuid string, hint *StageHint) error
