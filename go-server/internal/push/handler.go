package push

import (
	"net/http"

	"photo-loka/internal/auth"

	"github.com/gin-gonic/gin"
)

// RegisterRoutes mounts the push endpoints on the authenticated (non-admin)
// API group: enabling notifications is a per-user feature available to any
// logged-in family member, not an admin action.
//
//	GET    /api/push/vapidPublicKey  -> the server VAPID public key
//	POST   /api/push/devices         -> register this browser's subscription
//	DELETE /api/push/devices         -> remove a subscription by endpoint
func RegisterRoutes(rg *gin.RouterGroup) {
	rg.GET("/push/vapidPublicKey", getVapidPublicKey)
	rg.POST("/push/devices", registerDevice)
	rg.DELETE("/push/devices", unregisterDevice)
}

// getVapidPublicKey returns the server's VAPID public key so the browser can
// call pushManager.subscribe({ applicationServerKey }).
func getVapidPublicKey(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"publicKey": PublicKey()})
}

// subscriptionBody is the browser PushSubscription as the client posts it: the
// endpoint plus the encryption keys. userAgent is optional and only used so a
// user can tell their devices apart later.
type subscriptionBody struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
	UserAgent string `json:"userAgent"`
}

// registerDevice upserts the posted subscription for the authenticated user.
func registerDevice(c *gin.Context) {
	var body subscriptionBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "invalid subscription body: " + err.Error(),
			"code":    "VALIDATION_ERROR",
		}})
		return
	}
	if body.Endpoint == "" || body.Keys.P256dh == "" || body.Keys.Auth == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "endpoint and keys (p256dh, auth) are required",
			"code":    "VALIDATION_ERROR",
		}})
		return
	}

	userID, _, _ := auth.GetUserFromContext(c)
	if err := upsertDevice(userID, body.Endpoint, body.Keys.P256dh, body.Keys.Auth, body.UserAgent); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to register device",
			"code":    "INTERNAL_ERROR",
		}})
		return
	}
	c.Status(http.StatusNoContent)
}

// unregisterDevice removes a subscription by endpoint (explicit client
// unsubscribe). Idempotent: removing an unknown endpoint still returns 204.
func unregisterDevice(c *gin.Context) {
	var body struct {
		Endpoint string `json:"endpoint"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.Endpoint == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": gin.H{
			"message": "endpoint is required",
			"code":    "VALIDATION_ERROR",
		}})
		return
	}
	if err := deleteDeviceByEndpoint(body.Endpoint); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to unregister device",
			"code":    "INTERNAL_ERROR",
		}})
		return
	}
	c.Status(http.StatusNoContent)
}
