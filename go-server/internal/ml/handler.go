package ml

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// RegisterRoutes registers face-related routes on the given router group.
func RegisterRoutes(rg *gin.RouterGroup) {
	rg.POST("/recognizeFaces/:uuid", recognizeFaces)
	rg.GET("/getFaces/:uuid", getFaces)
	rg.GET("/getFacesByPerson", getFacesByPerson)
	rg.PUT("/nameFaceCluster/:clusterId", nameFaceCluster)
	rg.PUT("/updatePersonName", updatePersonName)
	rg.GET("/faceSuggestions/:clusterId", faceSuggestions)
	rg.GET("/searchPersonNames", searchPersonNames)
	rg.PUT("/dismissFaceCluster/:clusterId", dismissFaceCluster)
}

// recognizeFaces triggers face recognition for a media item.
// POST /recognizeFaces/:uuid
func recognizeFaces(c *gin.Context) {
	uuid := c.Param("uuid")
	if uuid == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "uuid is required",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	result, err := ProcessFaceRecognition(uuid, nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "face recognition failed: " + err.Error(),
			"code":    "ML_ERROR",
		}})
		return
	}

	c.JSON(http.StatusOK, result)
}

// getFaces returns all face records for a given uuid.
// GET /getFaces/:uuid
func getFaces(c *gin.Context) {
	uuid := c.Param("uuid")
	if uuid == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "uuid is required",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	faces, err := GetFacesByUUID(uuid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to get faces: " + err.Error(),
			"code":    "DB_ERROR",
		}})
		return
	}

	if faces == nil {
		faces = []map[string]interface{}{}
	}

	c.JSON(http.StatusOK, faces)
}

// getFacesByPerson returns all face records for a given person name.
// GET /getFacesByPerson?name=X
func getFacesByPerson(c *gin.Context) {
	name := c.Query("name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "name query parameter is required",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	faces, err := GetFacesByPerson(name)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to get faces by person: " + err.Error(),
			"code":    "DB_ERROR",
		}})
		return
	}

	if faces == nil {
		faces = []map[string]interface{}{}
	}

	c.JSON(http.StatusOK, faces)
}

// nameFaceCluster assigns a name to a face cluster.
// PUT /nameFaceCluster/:clusterId (body: {name})
func nameFaceCluster(c *gin.Context) {
	clusterID := c.Param("clusterId")
	if clusterID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "clusterId is required",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	var body struct {
		Name string `json:"name" binding:"required"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "name is required in request body: " + err.Error(),
			"code":    "INVALID_BODY",
		}})
		return
	}

	rowsAffected, err := NameFaceCluster(clusterID, body.Name)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to name face cluster: " + err.Error(),
			"code":    "ML_ERROR",
		}})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "count": rowsAffected})
}

// updatePersonName renames a person across all face records.
// PUT /updatePersonName (body: {oldName, newName})
func updatePersonName(c *gin.Context) {
	var body struct {
		OldName string `json:"oldName" binding:"required"`
		NewName string `json:"newName" binding:"required"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "oldName and newName are required: " + err.Error(),
			"code":    "INVALID_BODY",
		}})
		return
	}

	rowsAffected, err := UpdatePersonName(body.OldName, body.NewName)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to update person name: " + err.Error(),
			"code":    "ML_ERROR",
		}})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "count": rowsAffected})
}

// faceSuggestions returns name suggestions for a face cluster from the ML service.
// GET /faceSuggestions/:clusterId
func faceSuggestions(c *gin.Context) {
	clusterID := c.Param("clusterId")
	if clusterID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "clusterId is required",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	suggestions, err := GetFaceSuggestions(clusterID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to get face suggestions: " + err.Error(),
			"code":    "ML_ERROR",
		}})
		return
	}

	c.JSON(http.StatusOK, suggestions)
}

// searchPersonNames searches for person names matching a query string.
// GET /searchPersonNames?q=X
func searchPersonNames(c *gin.Context) {
	query := c.Query("q")
	if query == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "q query parameter is required",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	names, err := SearchPersonNames(query)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to search person names: " + err.Error(),
			"code":    "DB_ERROR",
		}})
		return
	}

	if names == nil {
		names = []string{}
	}

	c.JSON(http.StatusOK, gin.H{"names": names})
}

// dismissFaceCluster marks a face cluster as dismissed.
// PUT /dismissFaceCluster/:clusterId
func dismissFaceCluster(c *gin.Context) {
	clusterID := c.Param("clusterId")
	if clusterID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "clusterId is required",
			"code":    "INVALID_PARAM",
		}})
		return
	}

	if err := DismissCluster(clusterID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to dismiss cluster: " + err.Error(),
			"code":    "DB_ERROR",
		}})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}
