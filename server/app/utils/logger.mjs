import { basename } from 'path';
import { startupConfig } from '#startup-config';

// Simple logger with filename prefixes and optional colors
// Usage: const logger = createLogger(import.meta.url);
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const currentLevel = LOG_LEVELS[startupConfig.logLevel];
const useColors = !startupConfig.noColor;
// journalctl adds its own timestamps, so only show ours in TTY
const ts = () => process.stdout.isTTY ? `${timestamp()} ` : '';

const colors = {
  info: '\x1b[36m',   // cyan
  error: '\x1b[31m',  // red
  warn: '\x1b[33m',   // yellow
  debug: '\x1b[90m',  // gray
  trace: '\x1b[35m',  // magenta
  reset: '\x1b[0m'
};

const timestamp = () => {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

// Lazy import to avoid circular dependency during initialization
let userContext;

export function createLogger(fileUrl) {
  const filename = basename(new URL(fileUrl).pathname);
  const prefix = `[${filename}]`;
  
  const getUserPrefix = () => {
    try {
      // Lazy load userContext on first use
      if (!userContext) {
        import('../../middleware/authn-middleware.mjs').then(module => {
          userContext = module.userContext;
        });
      }
      const ctx = userContext?.getStore();
      return ctx ? `[user:${ctx.username}]` : '';
    } catch {
      return '';
    }
  };
  
  return {
    info: (...args) => {
      if (currentLevel >= LOG_LEVELS.info) {
        const level = useColors ? `${colors.info}INFO${colors.reset}` : 'INFO';
        console.log(`${ts()}${level}: ${prefix}${getUserPrefix()}`, ...args);
      }
    },
    error: (...args) => {
      if (currentLevel >= LOG_LEVELS.error) {
        const level = useColors ? `${colors.error}ERROR${colors.reset}` : 'ERROR';
        console.error(`${ts()}${level}: ${prefix}${getUserPrefix()}`, ...args);
      }
    },
    warn: (...args) => {
      if (currentLevel >= LOG_LEVELS.warn) {
        const level = useColors ? `${colors.warn}WARN${colors.reset}` : 'WARN';
        console.warn(`${ts()}${level}: ${prefix}${getUserPrefix()}`, ...args);
      }
    },
    debug: (...args) => {
      if (currentLevel >= LOG_LEVELS.debug) {
        const level = useColors ? `${colors.debug}DEBUG${colors.reset}` : 'DEBUG';
        console.log(`${ts()}${level}: ${prefix}${getUserPrefix()}`, ...args);
      }
    },
    trace: (...args) => {
      if (currentLevel >= LOG_LEVELS.trace) {
        const level = useColors ? `${colors.trace}TRACE${colors.reset}` : 'TRACE';
        console.log(`${ts()}${level}: ${prefix}${getUserPrefix()}`, ...args);
      }
    }
  };
}
