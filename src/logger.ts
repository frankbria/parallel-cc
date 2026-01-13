/**
 * Simple logging utility for parallel-cc
 *
 * Features:
 * - Configurable log levels via PARALLEL_CC_LOG_LEVEL env var
 * - Automatic redaction of sensitive data (SSH keys, API keys, tokens)
 */

// ============================================================================
// Redaction Patterns
// ============================================================================

/**
 * Pattern configuration for sensitive data redaction
 */
export interface RedactionPattern {
  /** Regex pattern to match sensitive content */
  pattern: RegExp;
  /** Replacement text or function */
  replacement: string | ((match: string, ...args: any[]) => string);
}

/**
 * Patterns for detecting and redacting sensitive data in logs
 */
export const REDACTION_PATTERNS: RedactionPattern[] = [
  // SSH Private Key blocks (RSA, DSA, ECDSA, OpenSSH, generic)
  {
    pattern: /-----BEGIN (RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/gi,
    replacement: '[REDACTED SSH KEY]'
  },
  // SSH public keys (ssh-rsa, ssh-ed25519, ecdsa-sha2-*)
  {
    pattern: /(ssh-rsa|ssh-ed25519|ssh-dss|ecdsa-sha2-\S+)\s+[A-Za-z0-9+/=]{40,}(\s+\S+)?/gi,
    replacement: '[REDACTED SSH KEY]'
  },
  // SSH key fingerprints (SHA256:...)
  {
    pattern: /SHA256:[A-Za-z0-9+/=]{8}[A-Za-z0-9+/=]+/gi,
    replacement: (match: string) => {
      // Keep first 8 chars for identification
      const prefix = match.substring(0, 15);
      return `${prefix}...`;
    }
  },
  // Anthropic API keys (sk-ant-...)
  {
    pattern: /sk-ant-[A-Za-z0-9-]{20,}/gi,
    replacement: '[REDACTED API KEY]'
  },
  // GitHub tokens (ghp_..., gho_..., ghs_...)
  {
    pattern: /gh[pors]_[A-Za-z0-9]{36,}/gi,
    replacement: '[REDACTED GITHUB TOKEN]'
  },
  // Generic API key patterns (API_KEY=value, api-key: value)
  {
    pattern: /(API[_-]?KEY|SECRET[_-]?KEY|AUTH[_-]?TOKEN|BEARER[_-]?TOKEN)[=:\s]+['"]?[A-Za-z0-9_-]{20,}['"]?/gi,
    replacement: (match: string) => {
      const key = match.split(/[=:\s]/)[0];
      return `${key}=[REDACTED]`;
    }
  },
  // Long base64 strings (potential key material, 100+ chars)
  {
    pattern: /(?:^|[\s=])([A-Za-z0-9+/]{100,}={0,2})(?:$|[\s])/gm,
    replacement: ' [REDACTED] '
  }
];

/**
 * Redact sensitive data from a string
 *
 * Applies all redaction patterns to remove:
 * - SSH private/public keys
 * - SSH key fingerprints (partial redaction)
 * - API keys (Anthropic, GitHub, generic)
 * - Long base64 strings (potential key material)
 *
 * @param message - The message to redact
 * @returns The message with sensitive data redacted
 */
export function redactSensitive(message: string): string {
  if (!message || typeof message !== 'string') {
    return '';
  }

  let result = message;

  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    if (typeof replacement === 'function') {
      result = result.replace(pattern, replacement);
    } else {
      result = result.replace(pattern, replacement);
    }
  }

  return result;
}

// ============================================================================
// Log Levels
// ============================================================================

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3
}

// ============================================================================
// Logger Class
// ============================================================================

export class Logger {
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
      const redactedMessage = redactSensitive(message);
      console.error(`[${timestamp}] ERROR: ${redactedMessage}`);
      if (error instanceof Error) {
        const redactedError = redactSensitive(error.message);
        console.error(`  ${redactedError}`);
        if (this.level >= LogLevel.DEBUG && error.stack) {
          const redactedStack = redactSensitive(error.stack);
          console.error(redactedStack);
        }
      } else if (error) {
        const redactedError = redactSensitive(String(error));
        console.error(`  ${redactedError}`);
      }
    }
  }

  warn(message: string): void {
    if (this.level >= LogLevel.WARN) {
      const timestamp = new Date().toISOString();
      const redactedMessage = redactSensitive(message);
      console.warn(`[${timestamp}] WARN: ${redactedMessage}`);
    }
  }

  info(message: string): void {
    if (this.level >= LogLevel.INFO) {
      const timestamp = new Date().toISOString();
      const redactedMessage = redactSensitive(message);
      console.log(`[${timestamp}] INFO: ${redactedMessage}`);
    }
  }

  debug(message: string, data?: unknown): void {
    if (this.level >= LogLevel.DEBUG) {
      const timestamp = new Date().toISOString();
      const redactedMessage = redactSensitive(message);
      console.log(`[${timestamp}] DEBUG: ${redactedMessage}`);
      if (data !== undefined) {
        const dataStr = JSON.stringify(data, null, 2);
        const redactedData = redactSensitive(dataStr);
        console.log(`  ${redactedData}`);
      }
    }
  }
}

export const logger = new Logger();
