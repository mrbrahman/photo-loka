import { Router } from 'express';
import { AppError } from '../app/utils/app-error.mjs';
import { startupConfig } from '#startup-config';
import * as authnService from '../app/infrastructure/authn/authn-service.mjs';

const router = Router();

router.post('/login', async function(req, res, next) {
  try {
    const { username, password } = req.body;
    const result = await authnService.login(username, password);
    
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: startupConfig.nodeEnv === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
    
    res.json({ accessToken: result.accessToken, user: result.user });
  } catch (error) {
    next(error);
  }
});

router.post('/refresh', async function(req, res, next) {
  try {
    const refreshToken = req.cookies.refreshToken;
    if (!refreshToken) {
      throw new AppError('Refresh token required', 'NO_REFRESH_TOKEN', 'NO_REFRESH_TOKEN', 401);
    }
    
    const result = authnService.refreshAccessToken(refreshToken);
    
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: startupConfig.nodeEnv === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
    
    res.json({ accessToken: result.accessToken, user: result.user });
  } catch (error) {
    res.clearCookie('refreshToken');
    next(error);
  }
});

router.post('/logout', function(req, res) {
  const refreshToken = req.cookies.refreshToken;
  authnService.logout(refreshToken);
  res.clearCookie('refreshToken');
  res.sendStatus(200);
});

export default router;
