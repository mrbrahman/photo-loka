package authn

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"photo-loka/internal/auth"
)

// authService is the package-level auth service used by the route handlers.
// Set via RegisterRoutes. The auth.Service indirection is trimmed in a later phase.
var authService *auth.Service

// RegisterRoutes registers authentication routes on the given router group.
func RegisterRoutes(rg *gin.RouterGroup, authSvc *auth.Service) {
	authService = authSvc
	rg.POST("/login", login)
	rg.POST("/refresh", refresh)
	rg.POST("/logout", logout)
}

// login authenticates a user and returns tokens.
// POST /api/authn/login
func login(c *gin.Context) {
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

	tokenPair, err := authService.Login(body.Username, body.Password)
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
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     "refreshToken",
		Value:    tokenPair.RefreshToken,
		MaxAge:   30 * 24 * 3600,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})

	c.JSON(http.StatusOK, gin.H{
		"accessToken": tokenPair.AccessToken,
		"user":        tokenPair.User,
	})
}

// refresh issues a new token pair from a valid refresh token.
// POST /api/authn/refresh
func refresh(c *gin.Context) {
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

	tokenPair, err := authService.RefreshAccessToken(refreshToken)
	if err != nil {
		statusCode := http.StatusUnauthorized
		code := "REFRESH_FAILED"
		if appErr, ok := err.(*auth.AppError); ok {
			statusCode = appErr.StatusCode
			code = appErr.Code
		}

		// Clear the invalid cookie
		http.SetCookie(c.Writer, &http.Cookie{
			Name:     "refreshToken",
			Value:    "",
			MaxAge:   -1,
			Path:     "/",
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
		})

		c.JSON(statusCode, gin.H{
			"error": gin.H{
				"message": err.Error(),
				"code":    code,
			},
		})
		return
	}

	// Set new refresh token cookie (30 days)
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     "refreshToken",
		Value:    tokenPair.RefreshToken,
		MaxAge:   30 * 24 * 3600,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})

	c.JSON(http.StatusOK, gin.H{
		"accessToken": tokenPair.AccessToken,
		"user":        tokenPair.User,
	})
}

// logout invalidates the refresh token and clears the cookie.
// POST /api/authn/logout
func logout(c *gin.Context) {
	refreshToken, err := c.Cookie("refreshToken")
	if err == nil && refreshToken != "" {
		authService.Logout(refreshToken)
	}

	// Clear the cookie
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     "refreshToken",
		Value:    "",
		MaxAge:   -1,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})

	c.Status(http.StatusOK)
}
