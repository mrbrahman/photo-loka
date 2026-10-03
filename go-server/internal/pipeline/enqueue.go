package pipeline

import (
	"fmt"

	"photo-loka/internal/ml"
	"photo-loka/internal/queue"
)

// enqueueItem enqueues one stage's work for an item at the given priority, and
// on success forwards a fresh copy of the item to each applicable downstream.
//
// Ownership: each task owns its own *PipelineItem value. The stage's work
// function receives (uuid, hint); it writes outputs into the hint, which are
// absorbed into this task's item copy. When a stage fans out to multiple
// downstreams (e.g. bring-to-collection -> video-thumbnail AND
// video-compression), each downstream gets an independent copy, so concurrent
// branches never share mutable item state. The orchestrator always forwards at
// Normal; the priority parameter lets the same path serve the standalone API.
func (p *Pipeline) enqueueItem(stage *node, item *PipelineItem, priority queue.Priority) {
	hint := item.hint()
	st := stage
	it := item

	desc := st.Name
	if it.UUID != "" {
		desc = st.Name + ":" + it.UUID
	} else if it.SourceFile != "" {
		desc = st.Name + ":" + it.SourceFile
	}

	st.Queue.Enqueue(queue.Task{
		Priority:    priority,
		Description: desc,
		Fn: func() error {
			// The entry stage has no uuid yet; it sets it on the hint.
			if err := st.Fn(it.UUID, hint); err != nil {
				return err
			}
			it.absorb(hint) // pull stage outputs back onto this task's item
			// Data flow: forward an independent copy per downstream so parallel
			// branches do not share mutable item state.
			for _, ds := range p.routeDownstreams(st, it) {
				p.enqueueItem(ds, it.clone(), queue.Normal)
			}
			return nil
		},
	})
}

// routeDownstreams filters a node's candidate downstreams (from the pipeline's
// routing table p.routes) by media type and runtime applicability, implementing
// the fixed routing rules:
//   - bring-to-collection fans out to geo-lookup (if GPS) and the media branch:
//     video -> generate-video-thumbnail + video-compression (if enabled);
//     image -> generate-image-thumbnails.
//   - generate-video-thumbnail -> generate-image-thumbnails (unconditional).
//   - generate-image-thumbnails -> face-recognition + image-encoding
//     (each subject to its Enabled flag and ml.Available()).
//
// Optional stages (geo-lookup, video-compression, and the ML stages) run only
// when their node's Enabled flag is set AND the per-item applicability holds.
// Structural stages (thumbnails) are always enabled.
func (p *Pipeline) routeDownstreams(n *node, item *PipelineItem) []*node {
	switch n.Name {
	case StageBringToCollection:
		var out []*node
		if item.hasGPS() {
			if s := p.enabledNode(StageGeoCache); s != nil {
				out = append(out, s)
			}
		}
		switch item.Mediatype {
		case "video":
			if s := p.enabledNode(StageVideoThumbnail); s != nil {
				out = append(out, s)
			}
			if item.wantsCompression() {
				if s := p.enabledNode(StageVideoCompression); s != nil {
					out = append(out, s)
				}
			}
		case "image":
			if s := p.enabledNode(StageImageThumbnails); s != nil {
				out = append(out, s)
			}
		}
		return out

	case StageGeoCache:
		// Route to the address API phase only on a US cache miss (output-driven,
		// like the media-type branch): geo-cache set GeoNeedsAPI on the item.
		if item.GeoNeedsAPI {
			if s := p.enabledNode(StageGeoAddr); s != nil {
				return []*node{s}
			}
		}
		return nil

	case StageGeoAddr:
		// Route to the local city-cache phase only when the address lookup
		// reported an empty placename (GeoNeedsCity), carrying the parsed address.
		if item.GeoNeedsCity {
			if s := p.enabledNode(StageGeoCityCache); s != nil {
				return []*node{s}
			}
		}
		return nil

	case StageGeoCityCache:
		// Route to the city API phase only when the postal-code cache missed
		// (GeoNeedsCityAPI); a cache hit already wrote the final address.
		if item.GeoNeedsCityAPI {
			if s := p.enabledNode(StageGeoCity); s != nil {
				return []*node{s}
			}
		}
		return nil

	case StageVideoThumbnail:
		if s := p.enabledNode(StageImageThumbnails); s != nil {
			return []*node{s}
		}
		return nil

	case StageImageThumbnails:
		return p.mlDownstreams()

	default:
		// Terminal nodes (geo, ML, compression) have no downstreams.
		return nil
	}
}

// enabledNode returns the named node only if it exists and is enabled;
// otherwise nil. Used by routing to skip disabled optional stages. The Enabled
// read is guarded by the gate lock so a live Apply cannot race it. (The node
// set itself is fixed after construction, so the map lookup needs no lock.)
func (p *Pipeline) enabledNode(name string) *node {
	s, ok := p.stages[name]
	if !ok {
		return nil
	}
	p.gateMu.RLock()
	enabled := s.Enabled
	p.gateMu.RUnlock()
	if enabled {
		return s
	}
	return nil
}

// mlDownstreams returns the ML nodes that should run: enabled in config AND the
// ML client is available. face-recognition and image-encoding are independent.
func (p *Pipeline) mlDownstreams() []*node {
	if !ml.Available() {
		return nil
	}
	var out []*node
	if s := p.enabledNode(StageFaceRecognition); s != nil {
		out = append(out, s)
	}
	if s := p.enabledNode(StageImageEncoding); s != nil {
		out = append(out, s)
	}
	return out
}

// EnqueueStage is the standalone API: enqueue one stage's work for a uuid at a
// chosen priority, bypassing the orchestrated data flow (no downstream
// forwarding). hint may be nil, in which case the stage self-hydrates from the
// DB/disk by uuid. priority defaults to Normal when the zero value is passed
// explicitly by callers that do not care (Normal == 1 here, so pass it
// explicitly). Returns an error if the stage name is unknown.
//
// This serves external schedulers that want to (re)run a single stage - e.g.
// regenerate thumbnails, backfill image encodings - possibly at High or Low
// priority, independent of the indexer.
func (p *Pipeline) EnqueueStage(stageName, uuid string, hint *StageHint, priority queue.Priority) error {
	stage, ok := p.stages[stageName]
	if !ok {
		return fmt.Errorf("unknown pipeline stage %q", stageName)
	}
	if uuid == "" {
		return fmt.Errorf("uuid is required for stage %q", stageName)
	}
	uid := uuid
	h := hint
	st := stage
	st.Queue.Enqueue(queue.Task{
		Priority:    priority,
		Description: "standalone:" + st.Name + ":" + uid,
		Fn: func() error {
			return st.Fn(uid, h)
		},
	})
	return nil
}
