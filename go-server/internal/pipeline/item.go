package pipeline

import (
	"photo-loka/internal/collections"
	"photo-loka/internal/media"
)

// PipelineItem is the mutable state threaded through the orchestrated data
// flow. Each stage reads what it needs and populates outputs for downstreams
// (e.g. bring-to-collection sets UUID/ExifData/FinalFile/Mediatype;
// generate-image-thumbnails sets MLBuf). Standalone callers do not use this;
// they call stage functions with just a uuid (+ optional StageHint).
type PipelineItem struct {
	// Inputs known at submit time.
	Collection   *collections.Collection
	SourceFile   string // path as first seen (intake source or in-place path)
	ExistingUUID string // "" for a brand-new item; set when re-indexing
	InPlace      bool

	// Populated by bring-to-collection.
	UUID      string
	FinalFile string // path after placement in the collection
	Mediatype string
	ExifData  *media.ExifData

	// Populated by generate-image-thumbnails (or the video-frame path). Handed
	// to the ML stages so they skip a second file load.
	MLBuf *media.MLBuffer
}

// hint builds a StageHint snapshot from the item's current state, to hand to a
// stage's work function. The stage reads what it needs and writes outputs back
// into the same hint; absorb then pulls those outputs onto the item.
func (it *PipelineItem) hint() *StageHint {
	return &StageHint{
		Collection:   it.Collection,
		SourceFile:   it.SourceFile,
		ExistingUUID: it.ExistingUUID,
		InPlace:      it.InPlace,
		UUID:         it.UUID,
		Mediatype:    it.Mediatype,
		FinalFile:    it.FinalFile,
		ExifData:     it.ExifData,
		MLBuf:        it.MLBuf,
	}
}

// absorb copies a stage's outputs (written into the hint) back onto the item so
// downstream stages see them.
func (it *PipelineItem) absorb(h *StageHint) {
	if h == nil {
		return
	}
	if h.UUID != "" {
		it.UUID = h.UUID
	}
	if h.Mediatype != "" {
		it.Mediatype = h.Mediatype
	}
	if h.FinalFile != "" {
		it.FinalFile = h.FinalFile
	}
	if h.ExifData != nil {
		it.ExifData = h.ExifData
	}
	if h.MLBuf != nil {
		it.MLBuf = h.MLBuf
	}
}

// clone returns a shallow copy of the item. Pointer fields (ExifData, MLBuf,
// Collection) are shared, which is safe because downstream stages only read
// them; the copy exists so that assignments to the item's own fields (UUID,
// FinalFile, Mediatype, and the MLBuf/ExifData pointers themselves) in one
// branch do not race with another branch when a stage fans out.
func (it *PipelineItem) clone() *PipelineItem {
	c := *it
	return &c
}

// hasGPS reports whether the item's extracted metadata carries GPS coordinates,
// used to route to geo-lookup.
func (it *PipelineItem) hasGPS() bool {
	return it.ExifData != nil && it.ExifData.GPSLat != nil && it.ExifData.GPSLng != nil
}

// wantsCompression reports whether this (video) item should be compressed.
func (it *PipelineItem) wantsCompression() bool {
	return it.Collection != nil &&
		it.Collection.CompressVideos != nil && *it.Collection.CompressVideos == 1
}

// StageHint carries optional, already-computed inputs handed from one stage to
// the next in the orchestrated flow. Every field is optional: a nil hint (or an
// absent field) means the stage must fetch what it needs from the DB/disk by
// uuid. This is what makes each stage callable standalone.
//
// It is a single union struct rather than per-stage structs so the orchestrator
// can forward one value along an edge; each stage reads only the fields it uses
// and ignores the rest.
type StageHint struct {
	Collection   *collections.Collection
	SourceFile   string
	ExistingUUID string
	InPlace      bool

	// UUID is set by bring-to-collection (which generates/reuses it) so the
	// orchestrator can carry it onto the item for downstream stages.
	UUID string

	Mediatype string
	FinalFile string
	ExifData  *media.ExifData

	MLBuf *media.MLBuffer
}
