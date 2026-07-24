package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

const (
	AccessTokenExpiry      = 15 * time.Minute
	RefreshTokenExpiryDays = 30
	MaxFailedAttempts      = 5
	BcryptCost            = 10
)

// Service provides authentication business logic.
type Service struct {
	db        *AuthDB
	jwtSecret []byte
	logger    *slog.Logger
}

// TokenPair holds an access token, refresh token, and user info.
type TokenPair struct {
	AccessToken  string   `json:"accessToken"`
	RefreshToken string   `json:"refreshToken"`
	User         UserInfo `json:"user"`
}

// UserInfo is the public user information returned with tokens.
type UserInfo struct {
	UserID   int64  `json:"user_id"`
	Username string `json:"username"`
	Role     string `json:"role"`
}

// Claims represents the JWT claims for access tokens.
type Claims struct {
	UserID   int64  `json:"userId"`
	Username string `json:"username"`
	Role     string `json:"role"`
	jwt.RegisteredClaims
}

// NewService creates a new auth Service.
func NewService(db *AuthDB, jwtSecret string) *Service {
	return &Service{
		db:        db,
		jwtSecret: []byte(jwtSecret),
		logger:    slog.Default(),
	}
}

// CreateUser hashes the password and creates a new user.
func (s *Service) CreateUser(username, password, role string) (int64, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), BcryptCost)
	if err != nil {
		return 0, fmt.Errorf("hashing password: %w", err)
	}
	return s.db.CreateUser(username, string(hash), role)
}

// Login authenticates a user and returns a token pair.
func (s *Service) Login(username, password string) (*TokenPair, error) {
	user, err := s.db.GetUserByUsername(username)
	if err != nil {
		return nil, fmt.Errorf("looking up user: %w", err)
	}
	if user == nil {
		return nil, ErrInvalidCredentials
	}

	// Check if account is locked
	if user.LockedAt != nil {
		return nil, ErrAccountLocked
	}

	// Verify password
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		// Increment failed attempts
		_ = s.db.IncrementFailedAttempts(user.UserID)
		user.FailedLoginAttempts++

		// Lock if threshold exceeded
		if user.FailedLoginAttempts >= MaxFailedAttempts {
			_ = s.db.LockUser(user.UserID)
			s.logger.Warn("account locked due to failed attempts", "username", username)
			return nil, ErrAccountLocked
		}

		return nil, ErrInvalidCredentials
	}

	// Successful login - reset failed attempts
	if user.FailedLoginAttempts > 0 {
		_ = s.db.ResetFailedAttempts(user.UserID)
	}

	// Generate tokens
	accessToken, err := s.generateAccessToken(user)
	if err != nil {
		return nil, fmt.Errorf("generating access token: %w", err)
	}

	refreshToken := s.generateRefreshToken()
	tokenHash := hashToken(refreshToken)
	expiresAt := time.Now().Add(time.Duration(RefreshTokenExpiryDays) * 24 * time.Hour).Format("2006-01-02 15:04:05")

	if err := s.db.SaveRefreshToken(user.UserID, tokenHash, expiresAt); err != nil {
		return nil, fmt.Errorf("saving refresh token: %w", err)
	}

	return &TokenPair{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		User: UserInfo{
			UserID:   user.UserID,
			Username: user.Username,
			Role:     user.Role,
		},
	}, nil
}

// RefreshAccessToken validates a refresh token, deletes it, and issues a new token pair (sliding expiration).
func (s *Service) RefreshAccessToken(refreshToken string) (*TokenPair, error) {
	tokenHash := hashToken(refreshToken)

	rec, err := s.db.GetRefreshToken(tokenHash)
	if err != nil {
		return nil, fmt.Errorf("looking up refresh token: %w", err)
	}
	if rec == nil {
		return nil, ErrInvalidToken
	}

	// Delete old refresh token
	_ = s.db.DeleteRefreshToken(tokenHash)

	// Build a User struct for token generation
	user := &User{
		UserID:   rec.UserID,
		Username: rec.Username,
		Role:     rec.Role,
	}

	// Generate new token pair
	accessToken, err := s.generateAccessToken(user)
	if err != nil {
		return nil, fmt.Errorf("generating access token: %w", err)
	}

	newRefreshToken := s.generateRefreshToken()
	newTokenHash := hashToken(newRefreshToken)
	expiresAt := time.Now().Add(time.Duration(RefreshTokenExpiryDays) * 24 * time.Hour).Format("2006-01-02 15:04:05")

	if err := s.db.SaveRefreshToken(rec.UserID, newTokenHash, expiresAt); err != nil {
		return nil, fmt.Errorf("saving new refresh token: %w", err)
	}

	return &TokenPair{
		AccessToken:  accessToken,
		RefreshToken: newRefreshToken,
		User: UserInfo{
			UserID:   rec.UserID,
			Username: rec.Username,
			Role:     rec.Role,
		},
	}, nil
}

// Logout deletes the refresh token from the database.
func (s *Service) Logout(refreshToken string) {
	tokenHash := hashToken(refreshToken)
	_ = s.db.DeleteRefreshToken(tokenHash)
}

// VerifyAccessToken parses and validates a JWT access token.
func (s *Service) VerifyAccessToken(tokenStr string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return s.jwtSecret, nil
	})
	if err != nil {
		return nil, ErrInvalidToken
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, ErrInvalidToken
	}

	return claims, nil
}

// UnlockUser unlocks a user account by username.
func (s *Service) UnlockUser(username string) error {
	return s.db.UnlockUser(username)
}

// GenerateAPIToken creates a long-lived JWT for API access.
func (s *Service) GenerateAPIToken(username string, expiresInDays int) (string, error) {
	user, err := s.db.GetUserByUsername(username)
	if err != nil {
		return "", fmt.Errorf("looking up user: %w", err)
	}
	if user == nil {
		return "", ErrUserNotFound
	}

	claims := &Claims{
		UserID:   user.UserID,
		Username: user.Username,
		Role:     user.Role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Duration(expiresInDays) * 24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.jwtSecret)
}

// GetAllUsers returns all users.
func (s *Service) GetAllUsers() ([]User, error) {
	return s.db.GetAllUsers()
}

// UpdateUserRole changes the role of a user.
func (s *Service) UpdateUserRole(userID int64, role string) error {
	return s.db.UpdateUserRole(userID, role)
}

// CleanupExpiredTokens removes expired refresh tokens from the database.
func (s *Service) CleanupExpiredTokens() {
	count, err := s.db.CleanupExpiredTokens()
	if err != nil {
		s.logger.Error("failed to cleanup expired tokens", "error", err)
		return
	}
	if count > 0 {
		s.logger.Info("cleaned up expired refresh tokens", "count", count)
	}
}

// generateAccessToken creates a signed JWT access token.
func (s *Service) generateAccessToken(user *User) (string, error) {
	claims := &Claims{
		UserID:   user.UserID,
		Username: user.Username,
		Role:     user.Role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(AccessTokenExpiry)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.jwtSecret)
}

// generateRefreshToken creates a cryptographically random 64-byte hex token.
func (s *Service) generateRefreshToken() string {
	b := make([]byte, 64)
	if _, err := rand.Read(b); err != nil {
		// This should never happen; if it does, panic is appropriate
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	return hex.EncodeToString(b)
}

// hashToken returns the SHA-256 hex digest of a token string.
func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}
