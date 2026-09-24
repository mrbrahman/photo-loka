package auth

import (
	"database/sql"
	"fmt"

	"photo-loka/internal/database"
)

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

// insertUser inserts a new user and returns the new user ID.
func insertUser(username, passwordHash, role string) (int64, error) {
	result, err := database.DB.Exec(
		`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`,
		username, passwordHash, role,
	)
	if err != nil {
		return 0, fmt.Errorf("creating user: %w", err)
	}
	return result.LastInsertId()
}

// getUserByUsername retrieves a user by username. Returns nil, nil if not found.
func getUserByUsername(username string) (*User, error) {
	var u User
	err := database.DB.QueryRow(
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

// incrementFailedAttempts increments the failed_login_attempts counter for a user.
func incrementFailedAttempts(userID int64) error {
	_, err := database.DB.Exec(
		`UPDATE users SET failed_login_attempts = failed_login_attempts + 1 WHERE user_id = ?`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("incrementing failed attempts: %w", err)
	}
	return nil
}

// lockUser sets the locked_at timestamp for a user.
func lockUser(userID int64) error {
	_, err := database.DB.Exec(
		`UPDATE users SET locked_at = datetime('now', 'localtime') WHERE user_id = ?`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("locking user: %w", err)
	}
	return nil
}

// clearUserLock clears the lock and resets failed attempts for a user by username.
func clearUserLock(username string) error {
	result, err := database.DB.Exec(
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

// resetFailedAttempts resets the failed_login_attempts counter to 0.
func resetFailedAttempts(userID int64) error {
	_, err := database.DB.Exec(
		`UPDATE users SET failed_login_attempts = 0 WHERE user_id = ?`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("resetting failed attempts: %w", err)
	}
	return nil
}

// saveRefreshToken stores a hashed refresh token in the database.
func saveRefreshToken(userID int64, tokenHash, expiresAt string) error {
	_, err := database.DB.Exec(
		`INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
		userID, tokenHash, expiresAt,
	)
	if err != nil {
		return fmt.Errorf("saving refresh token: %w", err)
	}
	return nil
}

// getRefreshToken looks up a refresh token by hash, joining with users.
// Returns nil, nil if not found or expired.
func getRefreshToken(tokenHash string) (*RefreshTokenRecord, error) {
	var rec RefreshTokenRecord
	err := database.DB.QueryRow(
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

// deleteRefreshToken removes a refresh token by its hash.
func deleteRefreshToken(tokenHash string) error {
	_, err := database.DB.Exec(`DELETE FROM refresh_tokens WHERE token_hash = ?`, tokenHash)
	if err != nil {
		return fmt.Errorf("deleting refresh token: %w", err)
	}
	return nil
}

// deleteExpiredTokens deletes all expired refresh tokens and returns the count removed.
func deleteExpiredTokens() (int64, error) {
	result, err := database.DB.Exec(
		`DELETE FROM refresh_tokens WHERE expires_at <= datetime('now', 'localtime')`,
	)
	if err != nil {
		return 0, fmt.Errorf("cleaning up expired tokens: %w", err)
	}
	return result.RowsAffected()
}

// getAllUsers returns all users (without password hashes).
func getAllUsers() ([]User, error) {
	rows, err := database.DB.Query(
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

// updateUserRole changes the role of a user.
func updateUserRole(userID int64, role string) error {
	result, err := database.DB.Exec(`UPDATE users SET role = ? WHERE user_id = ?`, role, userID)
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
