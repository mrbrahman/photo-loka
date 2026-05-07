import { Router } from 'express';
import { AppError } from '../app/utils/app-error.mjs';
import * as authnService from '../app/infrastructure/authn/authn-service.mjs';

const router = Router();

// List all users
router.get('/users', function(req, res, next) {
  try {
    const users = authnService.getAllUsers();
    res.json({ users });
  } catch (error) {
    next(error);
  }
});

// Create a new user
router.post('/users', async function(req, res, next) {
  try {
    const { username, password, role } = req.body;

    if (!username || !password) {
      throw new AppError('Username and password are required', 'MISSING_FIELDS', 'MISSING_FIELDS', 400);
    }

    if (password.length < 8) {
      throw new AppError('Password must be at least 8 characters', 'PASSWORD_TOO_SHORT', 'PASSWORD_TOO_SHORT', 400);
    }

    if (role && !['admin', 'user'].includes(role)) {
      throw new AppError('Role must be either "admin" or "user"', 'INVALID_ROLE', 'INVALID_ROLE', 400);
    }

    const userId = await authnService.createUser(username, password, role || 'user');
    res.status(201).json({ user_id: userId, username, role: role || 'user' });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return next(new AppError('Username already exists', 'USERNAME_EXISTS', 'USERNAME_EXISTS', 409));
    }
    next(error);
  }
});

// Change user role
router.patch('/users/:userId/role', function(req, res, next) {
  try {
    const userId = parseInt(req.params.userId, 10);
    const { role } = req.body;

    // Prevent changing own role
    if (userId === req.userId) {
      throw new AppError('Cannot change your own role', 'SELF_ROLE_CHANGE', 'SELF_ROLE_CHANGE', 400);
    }

    authnService.updateUserRole(userId, role);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// Unlock a user
router.post('/users/:userId/unlock', function(req, res, next) {
  try {
    const userId = parseInt(req.params.userId, 10);
    const users = authnService.getAllUsers();
    const user = users.find(u => u.user_id === userId);

    if (!user) {
      throw new AppError('User not found', 'USER_NOT_FOUND', 'USER_NOT_FOUND', 404);
    }

    authnService.unlockUser(user.username);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// Generate API token for a user
router.post('/users/:userId/token', function(req, res, next) {
  try {
    const userId = parseInt(req.params.userId, 10);
    const { expiresInDays } = req.body;
    const days = expiresInDays ? parseInt(expiresInDays, 10) : 365;

    if (isNaN(days) || days <= 0) {
      throw new AppError('Expiry days must be a positive number', 'INVALID_EXPIRY', 'INVALID_EXPIRY', 400);
    }

    const users = authnService.getAllUsers();
    const user = users.find(u => u.user_id === userId);

    if (!user) {
      throw new AppError('User not found', 'USER_NOT_FOUND', 'USER_NOT_FOUND', 404);
    }

    const token = authnService.generateApiToken(user.username, days);
    res.json({ token, expiresInDays: days });
  } catch (error) {
    next(error);
  }
});

export default router;
