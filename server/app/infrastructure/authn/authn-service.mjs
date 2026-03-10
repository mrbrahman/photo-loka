import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { config } from '#config';
import { createLogger } from '#utils/logger';
import * as authnDb from './authn-db.mjs';

const logger = createLogger(import.meta.url);

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 30;
const MAX_FAILED_ATTEMPTS = 5;

import { AppError } from '#utils/app-error';

export async function createUser(username, password, role = 'user') {
  const passwordHash = await bcrypt.hash(password, 10);
  const userId = authnDb.createUser(username, passwordHash, role);
  logger.info(`User created: ${username} (${role})`);
  return userId;
}

export async function login(username, password) {
  const user = authnDb.getUserByUsername(username);
  
  if (!user) {
    throw new AppError('Invalid username or password', 'INVALID_CREDENTIALS', 'INVALID_CREDENTIALS', 401);
  }
  
  if (user.locked_at) {
    throw new AppError('Account is locked. Contact administrator.', 'ACCOUNT_LOCKED', 'ACCOUNT_LOCKED', 403);
  }
  
  const validPassword = await bcrypt.compare(password, user.password_hash);
  
  if (!validPassword) {
    authnDb.incrementFailedAttempts(user.user_id);
    
    if (user.failed_login_attempts + 1 >= MAX_FAILED_ATTEMPTS) {
      authnDb.lockUser(user.user_id);
      logger.warn(`Account locked due to failed attempts: ${username}`);
      throw new AppError('Account locked due to too many failed attempts', 'ACCOUNT_LOCKED', 'ACCOUNT_LOCKED', 403);
    }
    
    throw new AppError('Invalid username or password', 'INVALID_CREDENTIALS', 'INVALID_CREDENTIALS', 401);
  }
  
  authnDb.resetFailedAttempts(user.user_id);
  
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken();
  
  const tokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  authnDb.saveRefreshToken(user.user_id, tokenHash, expiresAt);
  
  logger.info(`User logged in: ${username}`);
  
  return {
    accessToken,
    refreshToken,
    user: { user_id: user.user_id, username: user.username, role: user.role }
  };
}

export function refreshAccessToken(refreshToken) {
  const tokenHash = hashToken(refreshToken);
  const tokenRecord = authnDb.getRefreshToken(tokenHash);
  
  if (!tokenRecord) {
    throw new AppError('Invalid or expired refresh token', 'INVALID_TOKEN', 'INVALID_TOKEN', 401);
  }
  
  // Sliding expiration: delete old token and issue new one
  authnDb.deleteRefreshToken(tokenHash);
  
  const newAccessToken = generateAccessToken({
    user_id: tokenRecord.user_id,
    username: tokenRecord.username,
    role: tokenRecord.role
  });
  
  const newRefreshToken = generateRefreshToken();
  const newTokenHash = hashToken(newRefreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  authnDb.saveRefreshToken(tokenRecord.user_id, newTokenHash, expiresAt);
  
  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    user: { user_id: tokenRecord.user_id, username: tokenRecord.username, role: tokenRecord.role }
  };
}

export function logout(refreshToken) {
  if (refreshToken) {
    const tokenHash = hashToken(refreshToken);
    authnDb.deleteRefreshToken(tokenHash);
  }
}

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (error) {
    throw new AppError('Invalid or expired access token', 'INVALID_TOKEN', 'INVALID_TOKEN', 401);
  }
}

export function validateRefreshTokenForAuth(tokenHash) {
  const tokenRecord = authnDb.getRefreshToken(tokenHash);
  
  if (!tokenRecord) {
    return null;
  }
  
  return {
    user_id: tokenRecord.user_id,
    username: tokenRecord.username,
    role: tokenRecord.role
  };
}

export function unlockUser(username) {
  authnDb.unlockUser(username);
  logger.info(`User unlocked: ${username}`);
}

export function generateApiToken(username, expiresInDays = 365) {
  const user = authnDb.getUserByUsername(username);
  if (!user) {
    throw new AppError('User not found', 'USER_NOT_FOUND', 'USER_NOT_FOUND', 404);
  }
  
  const token = jwt.sign(
    { userId: user.user_id, username: user.username, role: user.role },
    config.jwtSecret,
    { expiresIn: `${expiresInDays}d` }
  );
  
  logger.info(`API token generated for user: ${username} (expires in ${expiresInDays} days)`);
  return token;
}

function generateAccessToken(user) {
  return jwt.sign(
    { userId: user.user_id, username: user.username, role: user.role },
    config.jwtSecret,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

function generateRefreshToken() {
  return crypto.randomBytes(64).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Cleanup expired tokens periodically
setInterval(() => {
  const deleted = authnDb.cleanupExpiredTokens();
  if (deleted > 0) {
    logger.info(`Cleaned up ${deleted} expired refresh tokens`);
  }
}, 24 * 60 * 60 * 1000); // Daily
