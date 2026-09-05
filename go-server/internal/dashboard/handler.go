package dashboard

import (
	"database/sql"
	"fmt"
	"net/http"
	"syscall"

	"github.com/gin-gonic/gin"
)

// Handler provides HTTP handlers for the admin dashboard.
type Handler struct {
	db *sql.DB
}

// LibraryStats holds the overall library statistics.
type LibraryStats struct {
	TotalItems   int64               `json:"totalItems"`
	TotalSize    int64               `json:"totalSize"`
	Albums       int64               `json:"albums"`
	TrashedItems int64               `json:"trashedItems"`
	ByType       map[string]TypeStat `json:"byType"`
	Collections  []CollectionStat    `json:"collections"`
}

// TypeStat holds count and size for a media type.
type TypeStat struct {
	Count int64 `json:"count"`
	Size  int64 `json:"size"`
}

// CollectionStat holds per-collection stats.
type CollectionStat struct {
	CollectionID   int64  `json:"collection_id"`
	CollectionName string `json:"collection_name"`
	CollectionPath string `json:"collection_path"`
	Items          int64  `json:"items"`
	TotalSize      int64  `json:"totalSize"`
	FreeSpace      *int64 `json:"freeSpace"`
}

// NewHandler creates a new dashboard Handler.
func NewHandler(conn *sql.DB) *Handler {
	return &Handler{db: conn}
}

// RegisterRoutes registers dashboard routes on the given router group.
func (h *Handler) RegisterRoutes(rg *gin.RouterGroup) {
	rg.GET("/dashboard/stats", h.getStats)
}

// getStats returns library and collection statistics.
func (h *Handler) getStats(c *gin.Context) {
	stats, err := h.queryLibraryStats()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	collStats, err := h.queryCollectionStats()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	stats.Collections = collStats

	c.JSON(http.StatusOK, stats)
}

// queryLibraryStats runs the aggregate query for overall library stats.
func (h *Handler) queryLibraryStats() (*LibraryStats, error) {
	query := `
		SELECT
			count(*) filter (where coalesce(is_trashed, 0) = 0) as totalItems,
			cast(coalesce(sum(filesize) filter (where coalesce(is_trashed, 0) = 0), 0) as integer) as totalSize,
			count(distinct album_date || '|' || coalesce(album_name, '')) filter (where coalesce(is_trashed, 0) = 0) as albums,
			count(*) filter (where coalesce(is_trashed, 0) = 1) as trashedItems,
			count(*) filter (where coalesce(is_trashed, 0) = 0 and mediatype = 'image') as imageCount,
			cast(coalesce(sum(filesize) filter (where coalesce(is_trashed, 0) = 0 and mediatype = 'image'), 0) as integer) as imageSize,
			count(*) filter (where coalesce(is_trashed, 0) = 0 and mediatype = 'video') as videoCount,
			cast(coalesce(sum(filesize) filter (where coalesce(is_trashed, 0) = 0 and mediatype = 'video'), 0) as integer) as videoSize,
			count(*) filter (where coalesce(is_trashed, 0) = 0 and mediatype = 'audio') as audioCount,
			cast(coalesce(sum(filesize) filter (where coalesce(is_trashed, 0) = 0 and mediatype = 'audio'), 0) as integer) as audioSize,
			count(*) filter (where coalesce(is_trashed, 0) = 0 and mediatype not in ('image', 'video', 'audio')) as otherCount,
			cast(coalesce(sum(filesize) filter (where coalesce(is_trashed, 0) = 0 and mediatype not in ('image', 'video', 'audio')), 0) as integer) as otherSize
		FROM metadata`

	var stats LibraryStats
	var imageCount, imageSize, videoCount, videoSize, audioCount, audioSize, otherCount, otherSize int64

	err := h.db.QueryRow(query).Scan(
		&stats.TotalItems,
		&stats.TotalSize,
		&stats.Albums,
		&stats.TrashedItems,
		&imageCount,
		&imageSize,
		&videoCount,
		&videoSize,
		&audioCount,
		&audioSize,
		&otherCount,
		&otherSize,
	)
	if err != nil {
		return nil, fmt.Errorf("querying library stats: %w", err)
	}

	stats.ByType = make(map[string]TypeStat)
	if imageCount > 0 {
		stats.ByType["image"] = TypeStat{Count: imageCount, Size: imageSize}
	}
	if videoCount > 0 {
		stats.ByType["video"] = TypeStat{Count: videoCount, Size: videoSize}
	}
	if audioCount > 0 {
		stats.ByType["audio"] = TypeStat{Count: audioCount, Size: audioSize}
	}
	if otherCount > 0 {
		stats.ByType["other"] = TypeStat{Count: otherCount, Size: otherSize}
	}

	return &stats, nil
}

// queryCollectionStats returns per-collection item counts and disk info.
func (h *Handler) queryCollectionStats() ([]CollectionStat, error) {
	query := `
		SELECT
			c.collection_id,
			c.collection_name,
			c.collection_path,
			count(m.uuid) as items,
			cast(coalesce(sum(m.filesize), 0) as integer) as totalSize
		FROM collections c
		INNER JOIN metadata m ON m.collection_id = c.collection_id
		WHERE coalesce(m.is_trashed, 0) = 0
		GROUP BY c.collection_id`

	rows, err := h.db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("querying collection stats: %w", err)
	}
	defer rows.Close()

	var results []CollectionStat
	for rows.Next() {
		var cs CollectionStat
		if err := rows.Scan(
			&cs.CollectionID,
			&cs.CollectionName,
			&cs.CollectionPath,
			&cs.Items,
			&cs.TotalSize,
		); err != nil {
			return nil, fmt.Errorf("scanning collection stat: %w", err)
		}

		// Compute free disk space for the collection path
		freeSpace := getDiskFreeSpace(cs.CollectionPath)
		if freeSpace >= 0 {
			cs.FreeSpace = &freeSpace
		}

		results = append(results, cs)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating collection stats: %w", err)
	}

	if results == nil {
		results = []CollectionStat{}
	}

	return results, nil
}

// getDiskFreeSpace returns the available bytes on the filesystem containing path.
// Returns -1 if the stat call fails.
func getDiskFreeSpace(path string) int64 {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return -1
	}
	// Available blocks * block size
	return int64(stat.Bavail) * int64(stat.Bsize)
}
