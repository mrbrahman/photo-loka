import { AsyncLocalStorage } from 'async_hooks';
import { verifyAccessToken } from './authn-service.mjs';
import * as authnDb from './authn-db.mjs';
import crypto from 'crypto';
import { AppError } from '#utils/app-error';

export const userContext = new AsyncLocalStorage();

export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];
  
  // If no Authorization header, try to use refresh token from cookie for image requests
  if (!token && req.cookies.refreshToken) {
    try {
      const tokenHash = crypto.createHash('sha256').update(req.cookies.refreshToken).digest('hex');
      const tokenRecord = authnDb.getRefreshToken(tokenHash);
      
      if (tokenRecord) {
        req.userId = tokenRecord.user_id;
        req.username = tokenRecord.username;
        req.role = tokenRecord.role;
        
        userContext.run({ userId: tokenRecord.user_id, username: tokenRecord.username }, () => {
          next();
        });
        return;
      }
    } catch (error) {
      // Refresh token invalid or expired, fall through to error
    }
  }
  
  if (!token) {
    return next(new AppError('Access token required', 'UNAUTHORIZED', 'UNAUTHORIZED', 401));
  }
  
  try {
    const decoded = verifyAccessToken(token);
    req.userId = decoded.userId;
    req.username = decoded.username;
    req.role = decoded.role;
    
    // Store user context for logging
    userContext.run({ userId: decoded.userId, username: decoded.username }, () => {
      next();
    });
  } catch (error) {
    next(new AppError(error.message, 'UNAUTHORIZED', 'UNAUTHORIZED', 401));
  }
}

export function requireAdmin(req, res, next) {
  if (req.role !== 'admin') {
    return next(new AppError('Admin access required', 'FORBIDDEN', 'FORBIDDEN', 403));
  }
  next();
}
