package auth

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// AuthMiddleware returns a Gin middleware that validates JWT access tokens.
// It checks the Authorization header first, then falls back to the refreshToken
// cookie (for image/media requests that cannot send headers).
func AuthMiddleware(authService *Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var tokenStr string

		// Try Authorization header first
		authHeader := c.GetHeader("Authorization")
		if authHeader != "" {
			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
				tokenStr = parts[1]
			}
		}

		// Fallback: check refreshToken cookie (for image requests)
		if tokenStr == "" {
			cookie, err := c.Cookie("refreshToken")
			if err == nil && cookie != "" {
				// Validate refresh token via hash lookup
				tokenHash := hashToken(cookie)
				rec, err := authService.db.GetRefreshToken(tokenHash)
				if err == nil && rec != nil {
					c.Set("userId", rec.UserID)
					c.Set("username", rec.Username)
					c.Set("role", rec.Role)
					c.Next()
					return
				}
			}
		}

		if tokenStr == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": gin.H{
					"message": ErrInvalidToken.Message,
					"code":    ErrInvalidToken.Code,
				},
			})
			return
		}

		// Verify JWT
		claims, err := authService.VerifyAccessToken(tokenStr)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": gin.H{
					"message": ErrInvalidToken.Message,
					"code":    ErrInvalidToken.Code,
				},
			})
			return
		}

		c.Set("userId", claims.UserID)
		c.Set("username", claims.Username)
		c.Set("role", claims.Role)
		c.Next()
	}
}

// AdminMiddleware returns a Gin middleware that requires admin role.
func AdminMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		role, exists := c.Get("role")
		if !exists || role.(string) != "admin" {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"error": gin.H{
					"message": "Admin access required",
					"code":    "FORBIDDEN",
				},
			})
			return
		}
		c.Next()
	}
}

// GetUserFromContext extracts user information from the Gin context.
// Returns userId, username, role.
func GetUserFromContext(c *gin.Context) (int64, string, string) {
	userId, _ := c.Get("userId")
	username, _ := c.Get("username")
	role, _ := c.Get("role")

	uid, _ := userId.(int64)
	uname, _ := username.(string)
	r, _ := role.(string)

	return uid, uname, r
}
