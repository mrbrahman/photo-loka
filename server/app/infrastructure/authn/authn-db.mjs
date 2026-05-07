// Uses the direct better-sqlite3 instance (synchronous) rather than the async db-pool.
// Token verification in auth middleware must be synchronous in the request path,
// and the rest of the auth operations follow suit for consistency, and are
// lightweight (use small tables that are indexed).
import { db } from '#db/sqlite-database';

export function createUser(username, passwordHash, role) {
  const stmt = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)');
  const result = stmt.run(username, passwordHash, role);
  return result.lastInsertRowid;
}

export function getUserByUsername(username) {
  const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
  return stmt.get(username);
}

export function getUserById(userId) {
  const stmt = db.prepare('SELECT user_id, username, role, failed_login_attempts, locked_at FROM users WHERE user_id = ?');
  return stmt.get(userId);
}

export function incrementFailedAttempts(userId) {
  const stmt = db.prepare('UPDATE users SET failed_login_attempts = failed_login_attempts + 1 WHERE user_id = ?');
  stmt.run(userId);
}

export function lockUser(userId) {
  const stmt = db.prepare("UPDATE users SET locked_at = datetime('now','localtime') WHERE user_id = ?");
  stmt.run(userId);
}

export function unlockUser(username) {
  const stmt = db.prepare('UPDATE users SET failed_login_attempts = 0, locked_at = NULL WHERE username = ?');
  stmt.run(username);
}

export function resetFailedAttempts(userId) {
  const stmt = db.prepare('UPDATE users SET failed_login_attempts = 0 WHERE user_id = ?');
  stmt.run(userId);
}

export function saveRefreshToken(userId, tokenHash, expiresAt) {
  const stmt = db.prepare('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)');
  stmt.run(userId, tokenHash, expiresAt);
}

export function getRefreshToken(tokenHash) {
  const stmt = db.prepare(`
    SELECT rt.*, u.username, u.role 
    FROM refresh_tokens rt 
    JOIN users u ON rt.user_id = u.user_id 
    WHERE rt.token_hash = ? AND rt.expires_at > datetime('now','localtime')
  `);
  return stmt.get(tokenHash);
}

export function deleteRefreshToken(tokenHash) {
  const stmt = db.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?');
  stmt.run(tokenHash);
}

export function deleteAllUserRefreshTokens(userId) {
  const stmt = db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?');
  stmt.run(userId);
}

export function cleanupExpiredTokens() {
  const stmt = db.prepare("DELETE FROM refresh_tokens WHERE expires_at <= datetime('now','localtime')");
  return stmt.run().changes;
}

export function getAllUsers() {
  const stmt = db.prepare('SELECT user_id, username, role, failed_login_attempts, locked_at, created_at FROM users ORDER BY created_at ASC');
  return stmt.all();
}

export function updateUserRole(userId, role) {
  const stmt = db.prepare('UPDATE users SET role = ? WHERE user_id = ?');
  return stmt.run(role, userId);
}
