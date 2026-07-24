package authn

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"photo-loka/internal/auth"
)

// Handler provides HTTP route handlers for authentication (public, no auth required).
type Handler struct {
	authService *auth.Service
}

// NewHandler creates a new authn Handler.
func NewHandler(authSvc *auth.Service) *Handler {
	return &Handler{authService: authSvc}
}

// RegisterRoutes registers authentication routes on the given router group.
func (h *Handler) RegisterRoutes(rg *gin.RouterGroup) {
	rg.POST("/login", h.login)
	rg.POST("/refresh", h.refresh)
	rg.POST("/logout", h.logout)
}

// login authenticates a user and returns tokens.
// POST /api/authn/login
func (h *Handler) login(c *gin.Context) {
	var body struct {
		Username string `json:"username" binding:"required"`
		Password string `json:"password" binding:"required"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": gin.H{
				"message": "username and password are required",
				"code":    "INVALID_REQUEST",
			},
		})
		return
	}

	tokenPair, err := h.authService.Login(body.Username, body.Password)
	if err != nil {
		statusCode := http.StatusUnauthorized
		code := "LOGIN_FAILED"
		if appErr, ok := err.(*auth.AppError); ok {
			statusCode = appErr.StatusCode
			code = appErr.Code
		}
		c.JSON(statusCode, gin.H{
			"error": gin.H{
				"message": err.Error(),
				"code":    code,
			},
		})
		return
	}

	// Set refresh token as httponly cookie (30 days)
	c.SetCookie("refreshToken", tokenPair.RefreshToken, 30*24*3600, "/", "", false, true)

	c.JSON(http.StatusOK, gin.H{
		"accessToken": tokenPair.AccessToken,
		"user":        tokenPair.User,
	})
}

// refresh issues a new token pair from a valid refresh token.
// POST /api/authn/refresh
func (h *Handler) refresh(c *gin.Context) {
	refreshToken, err := c.Cookie("refreshToken")
	if err != nil || refreshToken == "" {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": gin.H{
				"message": "No refresh token provided",
				"code":    "NO_REFRESH_TOKEN",
			},
		})
		return
	}

	tokenPair, err := h.authService.RefreshAccessToken(refreshToken)
	if err != nil {
		statusCode := http.StatusUnauthorized
		code := "REFRESH_FAILED"
		if appErr, ok := err.(*auth.AppError); ok {
			statusCode = appErr.StatusCode
			code = appErr.Code
		}

		// Clear the invalid cookie
		c.SetCookie("refreshToken", "", -1, "/", "", false, true)

		c.JSON(statusCode, gin.H{
			"error": gin.H{
				"message": err.Error(),
				"code":    code,
			},
		})
		return
	}

	// Set new refresh token cookie (30 days)
	c.SetCookie("refreshToken", tokenPair.RefreshToken, 30*24*3600, "/", "", false, true)

	c.JSON(http.StatusOK, gin.H{
		"accessToken": tokenPair.AccessToken,
		"user":        tokenPair.User,
	})
}

// logout invalidates the refresh token and clears the cookie.
// POST /api/authn/logout
func (h *Handler) logout(c *gin.Context) {
	refreshToken, err := c.Cookie("refreshToken")
	if err == nil && refreshToken != "" {
		h.authService.Logout(refreshToken)
	}

	// Clear the cookie
	c.SetCookie("refreshToken", "", -1, "/", "", false, true)

	c.JSON(http.StatusOK, gin.H{"message": "Logged out successfully"})
}
