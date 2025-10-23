import { basename } from 'path';

// Simple logger with filename prefixes and optional colors
// Usage: const logger = createLogger(import.meta.url);
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;
// Colors auto-disable in systemd/pipes to avoid ANSI codes in logs
const useColors = process.env.NO_COLOR !== '1' && process.stdout.isTTY;

const colors = {
  info: '\x1b[36m',   // cyan
  error: '\x1b[31m',  // red
  warn: '\x1b[33m',   // yellow
  debug: '\x1b[90m',  // gray
  trace: '\x1b[35m',  // magenta
  reset: '\x1b[0m'
};

export function createLogger(fileUrl) {
  const filename = basename(new URL(fileUrl).pathname);
  const prefix = `[${filename}]`;
  
  return {
    info: (...args) => {
      if (currentLevel >= LOG_LEVELS.info) {
        const level = useColors ? `${colors.info}INFO${colors.reset}` : 'INFO';
        console.log(`${level}: ${prefix}`, ...args);
      }
    },
    error: (...args) => {
      if (currentLevel >= LOG_LEVELS.error) {
        const level = useColors ? `${colors.error}ERROR${colors.reset}` : 'ERROR';
        console.error(`${level}: ${prefix}`, ...args);
      }
    },
    warn: (...args) => {
      if (currentLevel >= LOG_LEVELS.warn) {
        const level = useColors ? `${colors.warn}WARN${colors.reset}` : 'WARN';
        console.warn(`${level}: ${prefix}`, ...args);
      }
    },
    debug: (...args) => {
      if (currentLevel >= LOG_LEVELS.debug) {
        const level = useColors ? `${colors.debug}DEBUG${colors.reset}` : 'DEBUG';
        console.log(`${level}: ${prefix}`, ...args);
      }
    },
    trace: (...args) => {
      if (currentLevel >= LOG_LEVELS.trace) {
        const level = useColors ? `${colors.trace}TRACE${colors.reset}` : 'TRACE';
        console.log(`${level}: ${prefix}`, ...args);
      }
    }
  };
}
