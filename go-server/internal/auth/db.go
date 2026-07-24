package auth

import (
	"database/sql"
	"fmt"
)

// AuthDB handles database operations for users and refresh tokens.
type AuthDB struct {
	db *sql.DB
}

// User represents a user record from the database.
type User struct {
	UserID              int64   `json:"user_id"`
	Username            string  `json:"username"`
	PasswordHash        string  `json:"-"`
	Role                string  `json:"role"`
	FailedLoginAttempts int     `json:"failed_login_attempts"`
	LockedAt            *string `json:"locked_at"`
	CreatedAt           *string `json:"created_at"`
}

// RefreshTokenRecord holds user info associated with a valid refresh token.
type RefreshTokenRecord struct {
	UserID   int64
	Username string
	Role     string
}

// NewAuthDB creates a new AuthDB instance.
func NewAuthDB(conn *sql.DB) *AuthDB {
	return &AuthDB{db: conn}
}

// CreateUser inserts a new user and returns the new user ID.
func (a *AuthDB) CreateUser(username, passwordHash, role string) (int64, error) {
	result, err := a.db.Exec(
		`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`,
		username, passwordHash, role,
	)
	if err != nil {
		return 0, fmt.Errorf("creating user: %w", err)
	}
	return result.LastInsertId()
}

// GetUserByUsername retrieves a user by username. Returns nil, nil if not found.
func (a *AuthDB) GetUserByUsername(username string) (*User, error) {
	var u User
	err := a.db.QueryRow(
		`SELECT user_id, username, password_hash, role, failed_login_attempts, locked_at, created_at
		 FROM users WHERE username = ?`,
		username,
	).Scan(&u.UserID, &u.Username, &u.PasswordHash, &u.Role, &u.FailedLoginAttempts, &u.LockedAt, &u.CreatedAt)

	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("querying user by username: %w", err)
	}
	return &u, nil
}

// IncrementFailedAttempts increments the failed_login_attempts counter for a user.
func (a *AuthDB) IncrementFailedAttempts(userID int64) error {
	_, err := a.db.Exec(
		`UPDATE users SET failed_login_attempts = failed_login_attempts + 1 WHERE user_id = ?`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("incrementing failed attempts: %w", err)
	}
	return nil
}

// LockUser sets the locked_at timestamp for a user.
func (a *AuthDB) LockUser(userID int64) error {
	_, err := a.db.Exec(
		`UPDATE users SET locked_at = datetime('now', 'localtime') WHERE user_id = ?`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("locking user: %w", err)
	}
	return nil
}

// UnlockUser clears the lock and resets failed attempts for a user by username.
func (a *AuthDB) UnlockUser(username string) error {
	result, err := a.db.Exec(
		`UPDATE users SET locked_at = NULL, failed_login_attempts = 0 WHERE username = ?`,
		username,
	)
	if err != nil {
		return fmt.Errorf("unlocking user: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrUserNotFound
	}
	return nil
}

// ResetFailedAttempts resets the failed_login_attempts counter to 0.
func (a *AuthDB) ResetFailedAttempts(userID int64) error {
	_, err := a.db.Exec(
		`UPDATE users SET failed_login_attempts = 0 WHERE user_id = ?`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("resetting failed attempts: %w", err)
	}
	return nil
}

// SaveRefreshToken stores a hashed refresh token in the database.
func (a *AuthDB) SaveRefreshToken(userID int64, tokenHash, expiresAt string) error {
	_, err := a.db.Exec(
		`INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
		userID, tokenHash, expiresAt,
	)
	if err != nil {
		return fmt.Errorf("saving refresh token: %w", err)
	}
	return nil
}

// GetRefreshToken looks up a refresh token by hash, joining with users.
// Returns nil, nil if not found or expired.
func (a *AuthDB) GetRefreshToken(tokenHash string) (*RefreshTokenRecord, error) {
	var rec RefreshTokenRecord
	err := a.db.QueryRow(
		`SELECT u.user_id, u.username, u.role
		 FROM refresh_tokens rt
		 JOIN users u ON u.user_id = rt.user_id
		 WHERE rt.token_hash = ? AND rt.expires_at > datetime('now', 'localtime')`,
		tokenHash,
	).Scan(&rec.UserID, &rec.Username, &rec.Role)

	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("querying refresh token: %w", err)
	}
	return &rec, nil
}

// DeleteRefreshToken removes a refresh token by its hash.
func (a *AuthDB) DeleteRefreshToken(tokenHash string) error {
	_, err := a.db.Exec(`DELETE FROM refresh_tokens WHERE token_hash = ?`, tokenHash)
	if err != nil {
		return fmt.Errorf("deleting refresh token: %w", err)
	}
	return nil
}

// CleanupExpiredTokens deletes all expired refresh tokens and returns the count removed.
func (a *AuthDB) CleanupExpiredTokens() (int64, error) {
	result, err := a.db.Exec(
		`DELETE FROM refresh_tokens WHERE expires_at <= datetime('now', 'localtime')`,
	)
	if err != nil {
		return 0, fmt.Errorf("cleaning up expired tokens: %w", err)
	}
	return result.RowsAffected()
}

// GetAllUsers returns all users (without password hashes).
func (a *AuthDB) GetAllUsers() ([]User, error) {
	rows, err := a.db.Query(
		`SELECT user_id, username, role, failed_login_attempts, locked_at, created_at FROM users ORDER BY created_at ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("querying all users: %w", err)
	}
	defer rows.Close()

	var users []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.UserID, &u.Username, &u.Role, &u.FailedLoginAttempts, &u.LockedAt, &u.CreatedAt); err != nil {
			return nil, fmt.Errorf("scanning user row: %w", err)
		}
		users = append(users, u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating user rows: %w", err)
	}
	return users, nil
}

// UpdateUserRole changes the role of a user.
func (a *AuthDB) UpdateUserRole(userID int64, role string) error {
	result, err := a.db.Exec(`UPDATE users SET role = ? WHERE user_id = ?`, role, userID)
	if err != nil {
		return fmt.Errorf("updating user role: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrUserNotFound
	}
	return nil
}
