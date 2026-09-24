package collections

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"photo-loka/internal/auth"
	"photo-loka/internal/utils"
)

// OnCollectionChanged is called after create/update to restart watchers/cron.
// Wired from main.
var OnCollectionChanged func(collectionID int64)

// RegisterPublicRoutes registers authenticated (non-admin) collection routes.
func RegisterPublicRoutes(rg *gin.RouterGroup) {
	rg.GET("/collections", getCollections)
}

// RegisterAdminRoutes registers admin-only collection routes.
func RegisterAdminRoutes(rg *gin.RouterGroup) {
	rg.GET("/getAllCollections", getAllCollections)
	rg.POST("/createNewCollection", createNewCollection)
	rg.PUT("/updateCollection/:id", updateCollection)
	rg.GET("/listSubDirs", listSubDirs)
	rg.POST("/validateFolderPattern", validateFolderPattern)
	rg.POST("/setIntakeStatus/:collection_id/:intakeIndex", setIntakeStatus)
	rg.POST("/setAllIntakeStatus/:collection_id", setAllIntakeStatus)
}

// getCollections returns the collection summary list for authenticated users.
func getCollections(c *gin.Context) {
	summaries, err := GetSummary()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	if summaries == nil {
		summaries = []CollectionSummary{}
	}

	c.JSON(http.StatusOK, summaries)
}

// getAllCollections returns all collections with full details (admin).
func getAllCollections(c *gin.Context) {
	collections, err := GetAll()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	if collections == nil {
		collections = []Collection{}
	}

	c.JSON(http.StatusOK, collections)
}

// createNewCollection creates a new collection (admin).
func createNewCollection(c *gin.Context) {
	var col Collection
	if err := c.ShouldBindJSON(&col); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "Invalid request body: " + err.Error(), "code": "VALIDATION_ERROR"},
		})
		return
	}

	id, err := Create(&col)
	if err != nil {
		if appErr, ok := err.(*auth.AppError); ok {
			c.JSON(appErr.StatusCode, gin.H{
				"error": gin.H{"message": appErr.Message, "code": appErr.Code},
			})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	c.JSON(http.StatusCreated, id)

	// Restart watchers/cron for the new collection
	if OnCollectionChanged != nil {
		go OnCollectionChanged(id)
	}
}

// updateCollection updates an existing collection (admin).
func updateCollection(c *gin.Context) {
	idStr := c.Param("id")
	collectionID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "Invalid collection ID", "code": "VALIDATION_ERROR"},
		})
		return
	}

	var col Collection
	if err := c.ShouldBindJSON(&col); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "Invalid request body: " + err.Error(), "code": "VALIDATION_ERROR"},
		})
		return
	}

	if err := Update(collectionID, &col); err != nil {
		if appErr, ok := err.(*auth.AppError); ok {
			c.JSON(appErr.StatusCode, gin.H{
				"error": gin.H{"message": appErr.Message, "code": appErr.Code},
			})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})

	// Restart watchers/cron for the updated collection
	if OnCollectionChanged != nil {
		go OnCollectionChanged(collectionID)
	}
}

// listSubDirs lists subdirectories of a given path (admin).
func listSubDirs(c *gin.Context) {
	dirPath := c.Query("path")
	if dirPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "path query parameter is required", "code": "VALIDATION_ERROR"},
		})
		return
	}

	if !IsValidDir(dirPath) {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "Path is not a valid directory", "code": "INVALID_PATH"},
		})
		return
	}

	dirs, err := ListSubDirs(dirPath)
	if err != nil {
		if appErr, ok := err.(*auth.AppError); ok {
			c.JSON(appErr.StatusCode, gin.H{
				"error": gin.H{"message": appErr.Message, "code": appErr.Code},
			})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	if dirs == nil {
		dirs = []string{}
	}

	c.JSON(http.StatusOK, dirs)
}

// validateFolderPatternRequest is the request body for pattern validation.
type validateFolderPatternRequest struct {
	Pattern string `json:"pattern"`
}

// validateFolderPattern validates a folder pattern string (admin).
func validateFolderPattern(c *gin.Context) {
	var req validateFolderPatternRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "Invalid request body: " + err.Error(), "code": "VALIDATION_ERROR"},
		})
		return
	}

	if req.Pattern == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "pattern is required", "code": "VALIDATION_ERROR"},
		})
		return
	}

	// Use the actual pattern engine to validate. If FormatPattern succeeds, the pattern is valid.
	sampleValues := map[string]string{
		"yyyy":  "2021",
		"yy":    "21",
		"mm":    "10",
		"dd":    "01",
		"album": "Trip to SVBF",
	}

	example, err := utils.FormatPattern(sampleValues, req.Pattern)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{
			"valid": false,
			"error": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"valid":   true,
		"example": example,
	})
}

// setIntakeStatus sets the status of a single intake config entry (admin).
func setIntakeStatus(c *gin.Context) {
	collectionIDStr := c.Param("collection_id")
	collectionID, err := strconv.ParseInt(collectionIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "Invalid collection_id", "code": "VALIDATION_ERROR"},
		})
		return
	}

	intakeIndexStr := c.Param("intakeIndex")
	intakeIndex, err := strconv.Atoi(intakeIndexStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "Invalid intakeIndex", "code": "VALIDATION_ERROR"},
		})
		return
	}

	var body struct {
		Status string `json:"status"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "Invalid request body: " + err.Error(), "code": "VALIDATION_ERROR"},
		})
		return
	}

	if err := SetIntakeStatus(collectionID, intakeIndex, body.Status); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	// Restart watchers/cron to reflect the status change
	if OnCollectionChanged != nil {
		go OnCollectionChanged(collectionID)
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}

// setAllIntakeStatus sets the status of all intake config entries (admin).
func setAllIntakeStatus(c *gin.Context) {
	collectionIDStr := c.Param("collection_id")
	collectionID, err := strconv.ParseInt(collectionIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "Invalid collection_id", "code": "VALIDATION_ERROR"},
		})
		return
	}

	var body struct {
		Status string `json:"status"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "Invalid request body: " + err.Error(), "code": "VALIDATION_ERROR"},
		})
		return
	}

	if err := SetAllIntakeStatus(collectionID, body.Status); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	// Restart watchers/cron to reflect the status change
	if OnCollectionChanged != nil {
		go OnCollectionChanged(collectionID)
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}
