package collections

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"photo-loka/internal/auth"
)

// Handler provides HTTP handlers for collections.
type Handler struct {
	service *Service
}

// NewHandler creates a new collections Handler.
func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

// RegisterPublicRoutes registers authenticated (non-admin) collection routes.
func (h *Handler) RegisterPublicRoutes(rg *gin.RouterGroup) {
	rg.GET("/collections", h.getCollections)
}

// RegisterAdminRoutes registers admin-only collection routes.
func (h *Handler) RegisterAdminRoutes(rg *gin.RouterGroup) {
	rg.GET("/getAllCollections", h.getAllCollections)
	rg.POST("/createNewCollection", h.createNewCollection)
	rg.PUT("/updateCollection/:id", h.updateCollection)
	rg.GET("/listSubDirs", h.listSubDirs)
	rg.POST("/validateFolderPattern", h.validateFolderPattern)
	rg.POST("/setIntakeStatus/:collection_id/:intakeIndex", h.setIntakeStatus)
	rg.POST("/setAllIntakeStatus/:collection_id", h.setAllIntakeStatus)
}

// getCollections returns the collection summary list for authenticated users.
func (h *Handler) getCollections(c *gin.Context) {
	summaries, err := h.service.GetSummary()
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
func (h *Handler) getAllCollections(c *gin.Context) {
	collections, err := h.service.GetAll()
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
func (h *Handler) createNewCollection(c *gin.Context) {
	var col Collection
	if err := c.ShouldBindJSON(&col); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "Invalid request body: " + err.Error(), "code": "VALIDATION_ERROR"},
		})
		return
	}

	id, err := h.service.Create(&col)
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

	c.JSON(http.StatusCreated, gin.H{"collection_id": id})
}

// updateCollection updates an existing collection (admin).
func (h *Handler) updateCollection(c *gin.Context) {
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

	if err := h.service.Update(collectionID, &col); err != nil {
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
}

// listSubDirs lists subdirectories of a given path (admin).
func (h *Handler) listSubDirs(c *gin.Context) {
	dirPath := c.Query("path")
	if dirPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "path query parameter is required", "code": "VALIDATION_ERROR"},
		})
		return
	}

	if !h.service.IsValidDir(dirPath) {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{"message": "Path is not a valid directory", "code": "INVALID_PATH"},
		})
		return
	}

	dirs, err := h.service.ListSubDirs(dirPath)
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
func (h *Handler) validateFolderPattern(c *gin.Context) {
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

	// Validate that pattern contains valid tokens
	validTokens := regexp.MustCompile(`\{\{(yyyy|mm|dd|album)\}\}`)
	tokens := validTokens.FindAllString(req.Pattern, -1)

	// Check for invalid tokens (anything matching {{ ... }} that is not a valid token)
	allTokens := regexp.MustCompile(`\{\{[^}]*\}\}`)
	allFound := allTokens.FindAllString(req.Pattern, -1)

	var invalidTokens []string
	for _, t := range allFound {
		if !validTokens.MatchString(t) {
			invalidTokens = append(invalidTokens, t)
		}
	}

	if len(invalidTokens) > 0 {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{
				"message": "Invalid tokens in pattern: " + strings.Join(invalidTokens, ", "),
				"code":    "VALIDATION_ERROR",
			},
		})
		return
	}

	// album token must be last
	if len(tokens) > 0 {
		lastToken := tokens[len(tokens)-1]
		if lastToken != "{{album}}" {
			// Check if album token exists but is not last
			for _, t := range tokens {
				if t == "{{album}}" {
					c.JSON(http.StatusBadRequest, gin.H{
						"error": gin.H{
							"message": "{{album}} must be the last token in the pattern",
							"code":    "VALIDATION_ERROR",
						},
					})
					return
				}
			}
		}
	}

	// Generate a sample expansion
	sample := req.Pattern
	sample = strings.ReplaceAll(sample, "{{yyyy}}", "2021")
	sample = strings.ReplaceAll(sample, "{{mm}}", "10")
	sample = strings.ReplaceAll(sample, "{{dd}}", "01")
	sample = strings.ReplaceAll(sample, "{{album}}", "Trip to SVBF")

	c.JSON(http.StatusOK, gin.H{
		"valid":   true,
		"sample":  sample,
		"tokens":  tokens,
	})
}

// setIntakeStatus sets the status of a single intake config entry (admin).
func (h *Handler) setIntakeStatus(c *gin.Context) {
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

	if err := h.service.SetIntakeStatus(collectionID, intakeIndex, body.Status); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}

// setAllIntakeStatus sets the status of all intake config entries (admin).
func (h *Handler) setAllIntakeStatus(c *gin.Context) {
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

	if err := h.service.SetAllIntakeStatus(collectionID, body.Status); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}
