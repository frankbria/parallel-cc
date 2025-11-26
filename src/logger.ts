/**
 * Simple logging utility for parallel-cc
 */

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3
}

class Logger {
  private level: LogLevel;

  constructor() {
    // Default to WARN, allow override via env var
    const envLevel = process.env.PARALLEL_CC_LOG_LEVEL?.toUpperCase();
    switch (envLevel) {
      case 'ERROR':
        this.level = LogLevel.ERROR;
        break;
      case 'WARN':
        this.level = LogLevel.WARN;
        break;
      case 'INFO':
        this.level = LogLevel.INFO;
        break;
      case 'DEBUG':
        this.level = LogLevel.DEBUG;
        break;
      default:
        this.level = LogLevel.WARN;
    }
  }

  error(message: string, error?: Error | unknown): void {
    if (this.level >= LogLevel.ERROR) {
      const timestamp = new Date().toISOString();
      console.error(`[${timestamp}] ERROR: ${message}`);
      if (error instanceof Error) {
        console.error(`  ${error.message}`);
        if (this.level >= LogLevel.DEBUG && error.stack) {
          console.error(error.stack);
        }
      } else if (error) {
        console.error(`  ${String(error)}`);
      }
    }
  }

  warn(message: string): void {
    if (this.level >= LogLevel.WARN) {
      const timestamp = new Date().toISOString();
      console.warn(`[${timestamp}] WARN: ${message}`);
    }
  }

  info(message: string): void {
    if (this.level >= LogLevel.INFO) {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] INFO: ${message}`);
    }
  }

  debug(message: string, data?: unknown): void {
    if (this.level >= LogLevel.DEBUG) {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] DEBUG: ${message}`);
      if (data !== undefined) {
        console.log(`  ${JSON.stringify(data, null, 2)}`);
      }
    }
  }
}

export const logger = new Logger();
