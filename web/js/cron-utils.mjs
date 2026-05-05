import cronstrue from 'cronstrue';

/**
 * Convert a cron expression to human-readable English.
 * Returns null if the expression is invalid.
 */
export function cronToHuman(expression) {
  if (!expression || !expression.trim()) return null;
  try {
    return cronstrue.toString(expression.trim());
  } catch (e) {
    return null;
  }
}

/**
 * Validate a cron expression.
 * Returns true if valid, false otherwise.
 */
export function isValidCron(expression) {
  if (!expression || !expression.trim()) return false;
  try {
    cronstrue.toString(expression.trim());
    return true;
  } catch (e) {
    return false;
  }
}
