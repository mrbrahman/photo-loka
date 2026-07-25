package admin

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"photo-loka/internal/auth"
)

// UsersHandler handles user management endpoints.
type UsersHandler struct {
	authService *auth.Service
}

// NewUsersHandler creates a new UsersHandler.
func NewUsersHandler(authSvc *auth.Service) *UsersHandler {
	return &UsersHandler{authService: authSvc}
}

// RegisterRoutes registers user management routes on the given router group.
func (h *UsersHandler) RegisterRoutes(rg *gin.RouterGroup) {
	rg.GET("/users", h.getUsers)
	rg.POST("/users", h.createUser)
	rg.PATCH("/users/:userId/role", h.updateRole)
	rg.POST("/users/:userId/unlock", h.unlockUser)
	rg.POST("/users/:userId/token", h.generateToken)
}

// getUsers returns all users.
// GET /api/admin/users
func (h *UsersHandler) getUsers(c *gin.Context) {
	users, err := h.authService.GetAllUsers()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{
				"message": err.Error(),
				"code":    "INTERNAL_ERROR",
			},
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{"users": users})
}

// createUser creates a new user.
// POST /api/admin/users
func (h *UsersHandler) createUser(c *gin.Context) {
	var body struct {
		Username string `json:"username" binding:"required"`
		Password string `json:"password" binding:"required"`
		Role     string `json:"role" binding:"required"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{
				"message": "username, password, and role are required",
				"code":    "INVALID_REQUEST",
			},
		})
		return
	}

	// Validate password length
	if len(body.Password) < 8 {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{
				"message": "Password must be at least 8 characters",
				"code":    "INVALID_PASSWORD",
			},
		})
		return
	}

	// Validate role
	if body.Role != "admin" && body.Role != "user" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{
				"message": "Role must be 'admin' or 'user'",
				"code":    "INVALID_ROLE",
			},
		})
		return
	}

	userID, err := h.authService.CreateUser(body.Username, body.Password, body.Role)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{
				"message": err.Error(),
				"code":    "CREATE_USER_FAILED",
			},
		})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"user_id":  userID,
		"username": body.Username,
		"role":     body.Role,
	})
}

// updateRole changes a user's role.
// PATCH /api/admin/users/:userId/role
func (h *UsersHandler) updateRole(c *gin.Context) {
	userIDParam := c.Param("userId")
	targetUserID, err := strconv.ParseInt(userIDParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{
				"message": "Invalid user ID",
				"code":    "INVALID_REQUEST",
			},
		})
		return
	}

	// Prevent self-role-change
	currentUserID, _, _ := auth.GetUserFromContext(c)
	if currentUserID == targetUserID {
		c.JSON(http.StatusForbidden, gin.H{
			"error": gin.H{
				"message": "Cannot change your own role",
				"code":    "SELF_ROLE_CHANGE",
			},
		})
		return
	}

	var body struct {
		Role string `json:"role" binding:"required"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{
				"message": "role is required",
				"code":    "INVALID_REQUEST",
			},
		})
		return
	}

	if body.Role != "admin" && body.Role != "user" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{
				"message": "Role must be 'admin' or 'user'",
				"code":    "INVALID_ROLE",
			},
		})
		return
	}

	if err := h.authService.UpdateUserRole(targetUserID, body.Role); err != nil {
		statusCode := http.StatusInternalServerError
		if appErr, ok := err.(*auth.AppError); ok {
			statusCode = appErr.StatusCode
		}
		c.JSON(statusCode, gin.H{
			"error": gin.H{
				"message": err.Error(),
				"code":    "UPDATE_ROLE_FAILED",
			},
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"user_id": targetUserID,
		"role":    body.Role,
	})
}

// unlockUser unlocks a locked user account.
// POST /api/admin/users/:userId/unlock
func (h *UsersHandler) unlockUser(c *gin.Context) {
	userIDParam := c.Param("userId")
	_, err := strconv.ParseInt(userIDParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{
				"message": "Invalid user ID",
				"code":    "INVALID_REQUEST",
			},
		})
		return
	}

	// UnlockUser in the service works by username, but here we have userId.
	// We need to look up the user first. For now, we'll use GetAllUsers and find the match.
	// However, the service's UnlockUser takes username. Let's use a different approach:
	// We'll add UnlockUserByID or look up all users.
	users, err := h.authService.GetAllUsers()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{
				"message": err.Error(),
				"code":    "INTERNAL_ERROR",
			},
		})
		return
	}

	targetUserID, _ := strconv.ParseInt(userIDParam, 10, 64)
	var username string
	for _, u := range users {
		if u.UserID == targetUserID {
			username = u.Username
			break
		}
	}

	if username == "" {
		c.JSON(http.StatusNotFound, gin.H{
			"error": gin.H{
				"message": "User not found",
				"code":    "USER_NOT_FOUND",
			},
		})
		return
	}

	if err := h.authService.UnlockUser(username); err != nil {
		statusCode := http.StatusInternalServerError
		if appErr, ok := err.(*auth.AppError); ok {
			statusCode = appErr.StatusCode
		}
		c.JSON(statusCode, gin.H{
			"error": gin.H{
				"message": err.Error(),
				"code":    "UNLOCK_FAILED",
			},
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "User unlocked successfully"})
}

// generateToken generates a long-lived API token for a user.
// POST /api/admin/users/:userId/token
func (h *UsersHandler) generateToken(c *gin.Context) {
	userIDParam := c.Param("userId")
	_, err := strconv.ParseInt(userIDParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{
				"message": "Invalid user ID",
				"code":    "INVALID_REQUEST",
			},
		})
		return
	}

	var body struct {
		ExpiresInDays int `json:"expiresInDays"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		// Default to 365 days if no body provided
		body.ExpiresInDays = 365
	}

	if body.ExpiresInDays <= 0 {
		body.ExpiresInDays = 365
	}

	// Look up username by userId
	users, err := h.authService.GetAllUsers()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{
				"message": err.Error(),
				"code":    "INTERNAL_ERROR",
			},
		})
		return
	}

	targetUserID, _ := strconv.ParseInt(userIDParam, 10, 64)
	var username string
	for _, u := range users {
		if u.UserID == targetUserID {
			username = u.Username
			break
		}
	}

	if username == "" {
		c.JSON(http.StatusNotFound, gin.H{
			"error": gin.H{
				"message": "User not found",
				"code":    "USER_NOT_FOUND",
			},
		})
		return
	}

	token, err := h.authService.GenerateAPIToken(username, body.ExpiresInDays)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{
				"message": err.Error(),
				"code":    "TOKEN_GENERATION_FAILED",
			},
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"token":         token,
		"expiresInDays": body.ExpiresInDays,
	})
}
