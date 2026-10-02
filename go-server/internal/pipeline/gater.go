package pipeline

import (
	"sync"
)

// Gater is a dispatch-gating strategy. It owns a condition and the queues it
// governs, and exposes a uniform contract so the pipeline can wire it onto
// those queues without knowing HOW the condition is computed:
//
//   - resource gating (resourceGater) decides from the busy state of upstream
//     queues (its internal gatedBy model);
//   - geo rate limiting (geo.RateGater) decides from a request budget.
//
// The pipeline, for each governed queue, registers a gate named GateName() with
// isOpen = IsOpen(queueName). Each gater manages its OWN kicking (re-evaluating
// a governed queue when its condition may have changed): the resource gater
// subscribes to upstream drained events; the rate gater uses a rollover timer.
// Kicking is deliberately NOT part of this interface -- it differs per gater
// and is set up in Attach.
//
// A queue may be governed by more than one gater (it carries multiple gates);
// the queue evaluates them short-circuit and the first closed one is the block
// reason.
type Gater interface {
	// GateName is the gate's label on the queue (also the block reason shown to
	// the UI), e.g. "resource" or "rate".
	GateName() string
	// Governs returns the names of the queues this gater gates.
	Governs() []string
	// IsOpen reports whether the named governed queue may dispatch right now.
	IsOpen(queueName string) bool
	// Attach wires the gater onto its governed queues (registers the gate and
	// starts any kicking). Called at startup and on every live re-wire; must be
	// idempotent.
	Attach(host gateHost)
}

// gateHost exposes the queue lookup a gater needs to attach itself (register
// its gate, subscribe for kicking). The pipeline implements it over its queues.
type gateHost interface {
	queueByName(name string) Queue
}

// busyFunc reports whether the named queue currently has running or pending
// work. The resource gater uses it to evaluate upstream busyness without
// knowing about the Stage/queue types directly.
type busyFunc func(queueName string) bool

// resourceGater implements Gater for resource scheduling: a governed queue must
// not dispatch while any of its gating upstreams is busy (running or pending).
// It owns the gatedBy model (queue name -> gating upstream queue names) and a
// busy lookup; this upstream-busy notion is the resource gater's private
// concept, not the pipeline's. This is the logic formerly inline in
// Pipeline.wireGates, extracted behind the Gater seam with no behavior change.
type resourceGater struct {
	mu      sync.RWMutex
	gatedBy map[string][]string // queue name -> gating upstream queue names
	busy    busyFunc            // reports a queue's running-or-pending state

	// subscriber lifecycle for drained-event kicking (one generation per
	// Attach; replaced on re-wire).
	subsStop chan struct{}
	subsWG   sync.WaitGroup
}

func newResourceGater(gatedBy map[string][]string, busy busyFunc) *resourceGater {
	return &resourceGater{gatedBy: gatedBy, busy: busy}
}

func (g *resourceGater) GateName() string { return "resource" }

// Governs returns the queues that have at least one gating upstream.
func (g *resourceGater) Governs() []string {
	g.mu.RLock()
	defer g.mu.RUnlock()
	var out []string
	for name, ups := range g.gatedBy {
		if len(ups) > 0 {
			out = append(out, name)
		}
	}
	return out
}

// IsOpen reports whether the named queue may dispatch: true unless a gating
// upstream is busy. Unknown or ungated queues are always open.
func (g *resourceGater) IsOpen(queueName string) bool {
	g.mu.RLock()
	ups := g.gatedBy[queueName]
	g.mu.RUnlock()
	for _, up := range ups {
		if g.busy(up) {
			return false
		}
	}
	return true
}

// rebuild swaps the gatedBy model (used by live Apply, which recomputes gates
// from a new config). Attach must be called afterward to re-register.
func (g *resourceGater) rebuild(gatedBy map[string][]string) {
	g.mu.Lock()
	g.gatedBy = gatedBy
	g.mu.Unlock()
}

// Attach registers the "resource" gate on every governed queue and starts the
// drained-event subscribers that kick dependents when a gating upstream drains.
// Idempotent and safe to call on every live Apply: it first tears down the
// previous subscriber generation and clears the resource gate from all
// governed/formerly-governed queues, then re-registers for the current graph.
func (g *resourceGater) Attach(host gateHost) {
	// Tear down previous subscriber generation.
	if g.subsStop != nil {
		close(g.subsStop)
		g.subsWG.Wait()
	}
	g.subsStop = make(chan struct{})
	stop := g.subsStop

	g.mu.RLock()
	gatedBy := make(map[string][]string, len(g.gatedBy))
	for k, v := range g.gatedBy {
		cp := make([]string, len(v))
		copy(cp, v)
		gatedBy[k] = cp
	}
	g.mu.RUnlock()

	// Clear the resource gate on every queue we might have touched, then
	// re-register for currently-gated queues. We clear via a per-name gate
	// removal so a queue's OTHER gates (e.g. geo "rate") are untouched.
	for name := range gatedBy {
		if q := host.queueByName(name); q != nil {
			q.ClearGate("resource")
		}
	}

	dependents := make(map[string][]string) // upstream -> gated queues
	for name, ups := range gatedBy {
		qname := name
		if len(ups) == 0 {
			continue
		}
		if q := host.queueByName(qname); q != nil {
			q.RegisterGate("resource", func() bool { return g.IsOpen(qname) })
		}
		for _, up := range ups {
			dependents[up] = append(dependents[up], qname)
		}
	}

	for upName, gated := range dependents {
		upQ := host.queueByName(upName)
		if upQ == nil {
			continue
		}
		kickees := gated
		ch := upQ.Subscribe()
		g.subsWG.Add(1)
		go func() {
			defer g.subsWG.Done()
			wasDrained := true
			for {
				select {
				case <-stop:
					return
				case ev, ok := <-ch:
					if !ok {
						return
					}
					nowDrained := ev.Status.Active == 0 && ev.Status.Pending == 0
					if nowDrained && !wasDrained {
						for _, k := range kickees {
							if q := host.queueByName(k); q != nil {
								q.Kick()
							}
						}
					}
					wasDrained = nowDrained
				}
			}
		}()
	}
}

// Stop tears down the drained-event subscribers (shutdown).
func (g *resourceGater) Stop() {
	g.mu.Lock()
	if g.subsStop != nil {
		close(g.subsStop)
		g.subsStop = nil
	}
	g.mu.Unlock()
	g.subsWG.Wait()
}

var _ Gater = (*resourceGater)(nil)
