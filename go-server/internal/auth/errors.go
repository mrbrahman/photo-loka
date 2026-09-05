package auth

import "net/http"

// AppError represents a structured application error with HTTP status code.
type AppError struct {
	Message    string `json:"message"`
	Code       string `json:"code"`
	StatusCode int    `json:"-"`
}

func (e *AppError) Error() string { return e.Message }

// Pre-defined errors
var (
	ErrInvalidCredentials = &AppError{
		Message:    "Invalid username or password",
		Code:       "INVALID_CREDENTIALS",
		StatusCode: http.StatusUnauthorized,
	}

	ErrAccountLocked = &AppError{
		Message:    "Account locked due to too many failed attempts",
		Code:       "ACCOUNT_LOCKED",
		StatusCode: http.StatusForbidden,
	}

	ErrAccountAlreadyLocked = &AppError{
		Message:    "Account is locked. Contact administrator.",
		Code:       "ACCOUNT_LOCKED",
		StatusCode: http.StatusForbidden,
	}

	ErrInvalidToken = &AppError{
		Message:    "Invalid or expired token",
		Code:       "INVALID_TOKEN",
		StatusCode: http.StatusUnauthorized,
	}

	ErrUserNotFound = &AppError{
		Message:    "User not found",
		Code:       "USER_NOT_FOUND",
		StatusCode: http.StatusNotFound,
	}
)
