/**
 * Simple logger with configurable verbosity levels.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const levels: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Create a logger instance with the specified minimum log level.
 */
export function createLogger(configLevel: LogLevel): Logger {
  const threshold = levels[configLevel];

  return {
    debug: (...args: unknown[]) => {
      if (threshold <= levels.debug) console.log(...args);
    },
    info: (...args: unknown[]) => {
      if (threshold <= levels.info) console.log(...args);
    },
    warn: (...args: unknown[]) => {
      if (threshold <= levels.warn) console.warn(...args);
    },
    error: (...args: unknown[]) => {
      if (threshold <= levels.error) console.error(...args);
    },
  };
}

/**
 * Parse log level from string, defaulting to "info" if invalid.
 */
export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.toLowerCase();
  if (normalized && normalized in levels) {
    return normalized as LogLevel;
  }
  return "info";
}
