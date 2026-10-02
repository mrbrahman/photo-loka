package pipeline

import (
	"fmt"

	"photo-loka/internal/config"
	"photo-loka/internal/geo"
	"photo-loka/internal/indexing"
	"photo-loka/internal/media"
	"photo-loka/internal/ml"
)

// This file holds the stage work functions. Each has the StageFn shape
// func(uuid string, hint *StageHint) error and is standalone-capable: when the
// hint is nil or lacks a field, the stage fetches what it needs from the DB or
// disk by uuid. The orchestrator passes hints forward to avoid re-reads; an
// external caller can invoke any of these with just a uuid.

// stageBringToCollection is the entry stage: extract + place + insert. It reads
// the submit-time inputs from the hint and writes the generated uuid, final
// path, mediatype, and exif back into the hint for downstream routing.
//
// Standalone use is unusual (this stage needs a source file, not just a uuid),
// so it requires the hint to carry Collection + SourceFile.
func stageBringToCollection(_ string, h *StageHint) error {
	if h == nil || h.Collection == nil || h.SourceFile == "" {
		return fmt.Errorf("bring-to-collection requires collection and source file")
	}
	res, err := indexing.BringToCollection(h.Collection, h.SourceFile, h.ExistingUUID, h.InPlace)
	if err != nil {
		return err
	}
	h.UUID = res.UUID
	h.FinalFile = res.FinalFile
	h.Mediatype = res.Mediatype
	h.ExifData = res.ExifData
	return nil
}

// geoBudgetReserve consumes one geonames request unit, returning false when
// over budget. It is wired by newPipelineWithQueues to the geo rate gater's
// atomic Reserve. The geo API stage functions call it immediately before their
// geonames request so the consume happens exactly once per real call (the
// "rate" gate's IsOpen is a pure read and may be evaluated many times per
// dispatch attempt, so it cannot be the thing that consumes). A nil value
// (unwired, e.g. a stage fn used in isolation) means "no budget enforcement".
var geoBudgetReserve func() bool

// stageGeoCache runs the local (no-API) geo phase for a uuid: GPS/country
// derivation, non-US resolve, and US DB cache (exact/proximity). All terminal
// except a US cache miss, which sets GeoNeedsAPI + GeoLat/GeoLng on the hint so
// the pipeline routes to geo-lookup-addr. geo.ResolveLocal self-hydrates from
// the DB, so a bare uuid works (standalone).
func stageGeoCache(uuid string, h *StageHint) error {
	needsAPI, lat, lng, err := geo.ResolveLocal(uuid, nil, nil, nil)
	if err != nil {
		return err
	}
	if h != nil {
		h.GeoNeedsAPI = needsAPI
		h.GeoLat = lat
		h.GeoLng = lng
	}
	return nil
}

// stageGeoAddr runs the geonames findNearestAddress phase (rate-gated). It
// consumes one budget unit (geoBudgetReserve) before the call; if the budget
// was just exhausted it returns an error so the item is retried after the
// rollover (the queue's "rate" gate normally prevents dispatch while over
// budget, so this is the rare last-unit race). On a result that needs a city
// lookup it sets GeoNeedsCity + GeoParsedAddr on the hint so the pipeline routes
// to geo-lookup-city (no final write here, 2b); otherwise geo.LookupAddress
// writes the final address itself.
func stageGeoAddr(uuid string, h *StageHint) error {
	lat, lng, ok := geoAPICoords(uuid, h)
	if !ok {
		// Nothing to do (resolved locally or no GPS); not an error.
		return nil
	}
	if geoBudgetReserve != nil && !geoBudgetReserve() {
		return fmt.Errorf("geonames budget exhausted for %s (address lookup); will retry after rollover", uuid)
	}
	needsCity, parsed, err := geo.LookupAddress(uuid, lat, lng)
	if err != nil {
		return err
	}
	if h != nil {
		h.GeoNeedsCity = needsCity
		h.GeoParsedAddr = parsed
	}
	return nil
}

// stageGeoCity runs the geonames postalCodeLookup phase (rate-gated, terminal):
// it writes the final address using the parsed address carried from stageGeoAddr.
// It consumes one budget unit before the call. Standalone callers must supply
// the parsed address via the hint.
func stageGeoCity(uuid string, h *StageHint) error {
	if h == nil || h.GeoParsedAddr == "" {
		return fmt.Errorf("geo-lookup-city requires a parsed address (run geo-lookup-addr first)")
	}
	if geoBudgetReserve != nil && !geoBudgetReserve() {
		return fmt.Errorf("geonames budget exhausted for %s (city lookup); will retry after rollover", uuid)
	}
	return geo.LookupCity(uuid, h.GeoParsedAddr)
}

// geoAPICoords returns the coordinates for the address lookup. In the
// orchestrated flow the hint carries them (set by stageGeoCache). For a
// standalone call with no hint, it re-runs the local phase to recover the
// cache-miss coordinates; if that resolves locally (no API needed) it returns
// ok=false.
func geoAPICoords(uuid string, h *StageHint) (lat, lng float64, ok bool) {
	if h != nil && h.GeoNeedsAPI {
		return h.GeoLat, h.GeoLng, true
	}
	if h != nil && (h.GeoLat != 0 || h.GeoLng != 0) {
		return h.GeoLat, h.GeoLng, true
	}
	needsAPI, lat, lng, err := geo.ResolveLocal(uuid, nil, nil, nil)
	if err != nil || !needsAPI {
		return 0, 0, false
	}
	return lat, lng, true
}

// stageVideoThumbnail extracts the first-frame JPEG for a video. Standalone:
// fetch the filename by uuid when the hint lacks it.
func stageVideoThumbnail(uuid string, h *StageHint) error {
	finalFile := ""
	if h != nil {
		finalFile = h.FinalFile
	}
	if finalFile == "" {
		fn, _, err := indexing.GetFileInfo(uuid)
		if err != nil {
			return err
		}
		finalFile = fn
	}
	if _, err := media.GenerateVideoThumbnail(uuid, finalFile, config.Startup.ThumbsDir); err != nil {
		// A failed frame extraction is a real stage failure: return it so it is
		// counted/recorded (visible on the indexer page). Downstream
		// image-thumbnails is not enqueued for this item -- correct, since it
		// has no extracted frame to work from.
		return fmt.Errorf("video thumbnail extraction failed for %s (%s): %w", uuid, finalFile, err)
	}
	return nil
}

// stageImageThumbnails creates all thumbnail sizes and the ML buffer. For
// videos the source is the extracted first-frame JPEG (VideoFramePath); for
// images it is the file itself. Standalone: fetch filename+mediatype by uuid.
// Writes the produced MLBuffer back into the hint for the ML stages.
func stageImageThumbnails(uuid string, h *StageHint) error {
	var srcFile, mediatype string
	if h != nil {
		srcFile = h.FinalFile
		mediatype = h.Mediatype
	}
	if srcFile == "" || mediatype == "" {
		fn, mt, err := indexing.GetFileInfo(uuid)
		if err != nil {
			return err
		}
		if srcFile == "" {
			srcFile = fn
		}
		if mediatype == "" {
			mediatype = mt
		}
	}

	// For videos, thumbnails are generated from the extracted frame, not the
	// container (libvips cannot open a video).
	thumbSource := srcFile
	if mediatype == "video" {
		thumbSource = media.VideoFramePath(uuid, config.Startup.ThumbsDir)
	}

	mlBuf, err := media.CreateImageThumbnails(uuid, thumbSource, config.Startup.ThumbsDir)
	if err != nil {
		// A thumbnail failure is a real stage failure: return it so the queue
		// counts it as failed and records it (visible on the indexer page). The
		// item is still catalogued (its DB row was written by bring-to-
		// collection); it just lacks a thumbnail. Downstream ML stages are not
		// enqueued for this item -- correct, since they operate on the image
		// libvips could not load and would fail the same way.
		return fmt.Errorf("thumbnail creation failed for %s (%s): %w", uuid, thumbSource, err)
	}
	if h != nil {
		h.MLBuf = mlBuf
	}
	return nil
}

// stageFaceRecognition runs face recognition. Delegates to
// ml.ProcessFaceRecognition, which self-hydrates the ML buffer from the file
// when nil, so a bare uuid works.
func stageFaceRecognition(uuid string, h *StageHint) error {
	var buf *media.MLBuffer
	if h != nil {
		buf = h.MLBuf
	}
	_, err := ml.ProcessFaceRecognition(uuid, buf)
	return err
}

// stageImageEncoding generates and stores a CLIP embedding. Delegates to
// ml.ProcessImageEncoding, which self-hydrates the buffer when nil.
func stageImageEncoding(uuid string, h *StageHint) error {
	var buf *media.MLBuffer
	if h != nil {
		buf = h.MLBuf
	}
	return ml.ProcessImageEncoding(uuid, buf)
}

// stageVideoCompression compresses a video into webm. Standalone: fetch the
// filename by uuid when the hint lacks it.
func stageVideoCompression(uuid string, h *StageHint) error {
	finalFile := ""
	if h != nil {
		finalFile = h.FinalFile
	}
	if finalFile == "" {
		fn, _, err := indexing.GetFileInfo(uuid)
		if err != nil {
			return err
		}
		finalFile = fn
	}
	encoder := ""
	if config.Runtime != nil {
		encoder = config.Runtime.VideoEncoder
	}
	if encoder == "" {
		encoder = media.EncoderVP9
	}
	return media.CompressVideo(uuid, finalFile, config.Startup.ThumbsDir, encoder)
}
