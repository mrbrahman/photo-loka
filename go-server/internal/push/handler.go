package push

import (
	"errors"
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
//	POST   /api/push/devices/test    -> push a test notification to one of the
//	                                    caller's own devices (by endpoint)
func RegisterRoutes(rg *gin.RouterGroup) {
	rg.GET("/push/vapidPublicKey", getVapidPublicKey)
	rg.POST("/push/devices", registerDevice)
	rg.DELETE("/push/devices", unregisterDevice)
	rg.POST("/push/devices/test", testDevice)
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

// unregisterDevice removes one of the caller's own subscriptions by endpoint
// (explicit client unsubscribe). Idempotent: removing an unknown endpoint, or
// one that belongs to another user, is a no-op that still returns 204.
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
	userID, _, _ := auth.GetUserFromContext(c)
	if err := deleteDeviceForUser(userID, body.Endpoint); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to unregister device",
			"code":    "INTERNAL_ERROR",
		}})
		return
	}
	c.Status(http.StatusNoContent)
}

// testDevice synchronously pushes the test notification to one of the caller's
// own devices and reports the push service's result, so the client can tell
// the user whether the send was accepted. The device must belong to the
// authenticated user (404 otherwise).
//
// Responses:
//
//	200 {result}  push service responded; result.status is its HTTP status
//	              (2xx accepted; result.pruned=true if it reported the
//	              subscription gone and the device was removed)
//	404           endpoint not registered for this user
//	502 {result}  transport failure reaching the push service
//	503           web push not initialized
func testDevice(c *gin.Context) {
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

	userID, _, _ := auth.GetUserFromContext(c)
	res, err := sendTest(userID, body.Endpoint)
	switch {
	case errors.Is(err, errDeviceNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": gin.H{
			"message": "this device is not registered for notifications",
			"code":    "NOT_FOUND",
		}})
		return
	case errors.Is(err, errNotInitialized):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": gin.H{
			"message": "notifications are not available on the server",
			"code":    "UNAVAILABLE",
		}})
		return
	case err != nil:
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{
			"message": "failed to send test notification",
			"code":    "INTERNAL_ERROR",
		}})
		return
	}

	if res.Err != "" {
		c.JSON(http.StatusBadGateway, gin.H{"result": res})
		return
	}
	c.JSON(http.StatusOK, gin.H{"result": res})
}
