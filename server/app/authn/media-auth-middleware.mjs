import { authenticateToken } from './authn-middleware.mjs';
import { allFrames } from '#frame/frame-manager';

export function authenticateMediaAccess(req, res, next) {
  const ip = req.ip.startsWith('::ffff:') ? req.ip.substring(7) : req.ip;
  
  if (ip in allFrames) {
    return next();
  }
  
  return authenticateToken(req, res, next);
}
