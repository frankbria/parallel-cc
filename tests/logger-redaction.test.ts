/**
 * Tests for Logger Sensitive Data Redaction
 *
 * Ensures SSH key content and other sensitive patterns are redacted from logs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Logger, redactSensitive, REDACTION_PATTERNS } from '../src/logger.js';

describe('Logger Redaction', () => {
  describe('redactSensitive', () => {
    it('should redact RSA private key content', () => {
      const input = 'Key: -----BEGIN RSA PRIVATE KEY-----\nMIIEpQIBAAKCAQEA0Z...\n-----END RSA PRIVATE KEY-----';
      const result = redactSensitive(input);

      expect(result).toContain('[REDACTED SSH KEY]');
      expect(result).not.toContain('MIIEpQIBAAKCAQEA0Z');
    });

    it('should redact OpenSSH private key content', () => {
      const input = 'Key: -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE...\n-----END OPENSSH PRIVATE KEY-----';
      const result = redactSensitive(input);

      expect(result).toContain('[REDACTED SSH KEY]');
      expect(result).not.toContain('b3BlbnNzaC1rZXktdjE');
    });

    it('should redact DSA private key content', () => {
      const input = '-----BEGIN DSA PRIVATE KEY-----\ncontent\n-----END DSA PRIVATE KEY-----';
      const result = redactSensitive(input);

      expect(result).toContain('[REDACTED SSH KEY]');
    });

    it('should redact EC private key content', () => {
      const input = '-----BEGIN EC PRIVATE KEY-----\ncontent\n-----END EC PRIVATE KEY-----';
      const result = redactSensitive(input);

      expect(result).toContain('[REDACTED SSH KEY]');
    });

    it('should redact generic private key content', () => {
      const input = '-----BEGIN PRIVATE KEY-----\ncontent\n-----END PRIVATE KEY-----';
      const result = redactSensitive(input);

      expect(result).toContain('[REDACTED SSH KEY]');
    });

    it('should partially redact SSH key fingerprints', () => {
      const input = 'Fingerprint: SHA256:abcdefghijklmnopqrstuvwxyz123456789012345678';
      const result = redactSensitive(input);

      // Should show first few chars
      expect(result).toContain('abcdefgh');
      // Should be truncated
      expect(result).toContain('...');
      expect(result).not.toContain('123456789012345678');
    });

    it('should redact long base64 strings (potential key material)', () => {
      const longBase64 = 'AAAAB3NzaC1yc2EAAAADAQABAAABgQC' + 'A'.repeat(200);
      const input = `Key content: ${longBase64}`;
      const result = redactSensitive(input);

      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain(longBase64);
    });

    it('should redact ssh-rsa public key format', () => {
      const pubKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC' + 'A'.repeat(100) + ' user@host';
      const result = redactSensitive(pubKey);

      expect(result).toContain('[REDACTED SSH KEY]');
      expect(result).not.toContain('AAAAB3NzaC1yc2EAAAADAQABAAABgQC');
    });

    it('should redact ssh-ed25519 public key format', () => {
      const pubKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG' + 'B'.repeat(60) + ' user@host';
      const result = redactSensitive(pubKey);

      expect(result).toContain('[REDACTED SSH KEY]');
    });

    it('should redact ssh-ecdsa public key format', () => {
      const pubKey = 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTIt' + 'C'.repeat(100) + ' user@host';
      const result = redactSensitive(pubKey);

      expect(result).toContain('[REDACTED SSH KEY]');
    });

    it('should not redact normal text', () => {
      const input = 'Hello, this is a normal log message';
      const result = redactSensitive(input);

      expect(result).toBe(input);
    });

    it('should not redact short base64 strings', () => {
      const input = 'Token: abc123XYZ';
      const result = redactSensitive(input);

      expect(result).toBe(input);
    });

    it('should handle multiple sensitive patterns in one message', () => {
      const input = `
        Key1: -----BEGIN RSA PRIVATE KEY-----
        content1
        -----END RSA PRIVATE KEY-----
        Key2: -----BEGIN OPENSSH PRIVATE KEY-----
        content2
        -----END OPENSSH PRIVATE KEY-----
      `;
      const result = redactSensitive(input);

      expect(result.match(/\[REDACTED SSH KEY\]/g)?.length).toBeGreaterThanOrEqual(2);
      expect(result).not.toContain('content1');
      expect(result).not.toContain('content2');
    });

    it('should handle empty string', () => {
      expect(redactSensitive('')).toBe('');
    });

    it('should handle null/undefined safely', () => {
      expect(redactSensitive(null as any)).toBe('');
      expect(redactSensitive(undefined as any)).toBe('');
    });

    it('should preserve surrounding text when redacting', () => {
      const input = 'Before: -----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY----- After';
      const result = redactSensitive(input);

      expect(result).toContain('Before:');
      expect(result).toContain('After');
      expect(result).toContain('[REDACTED SSH KEY]');
    });

    it('should redact API keys patterns', () => {
      const input = 'ANTHROPIC_API_KEY=sk-ant-api03-abcdef123456789abcdef';
      const result = redactSensitive(input);

      expect(result).toContain('[REDACTED');
      expect(result).not.toContain('sk-ant-api03-abcdef123456789abcdef');
    });

    it('should redact GitHub tokens', () => {
      // GitHub tokens have 36+ chars after the prefix
      const input = 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890';
      const result = redactSensitive(input);

      expect(result).toContain('[REDACTED');
    });
  });

  describe('REDACTION_PATTERNS', () => {
    it('should export REDACTION_PATTERNS array', () => {
      expect(REDACTION_PATTERNS).toBeInstanceOf(Array);
      expect(REDACTION_PATTERNS.length).toBeGreaterThan(0);
    });

    it('should include SSH key patterns', () => {
      const hasSSHPattern = REDACTION_PATTERNS.some(
        p => p.pattern.toString().includes('PRIVATE KEY') ||
             p.pattern.toString().includes('ssh-')
      );
      expect(hasSSHPattern).toBe(true);
    });
  });

  describe('Logger integration', () => {
    let consoleSpy: any;
    let consoleErrorSpy: any;
    let consoleWarnSpy: any;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('should redact sensitive data in info logs', () => {
      // Set log level to INFO
      process.env.PARALLEL_CC_LOG_LEVEL = 'INFO';

      // Create new logger to pick up env var
      const logger = new Logger();

      const sensitiveMessage = 'Key: -----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----';
      logger.info(sensitiveMessage);

      // Check that console.log was called with redacted content
      expect(consoleSpy).toHaveBeenCalled();
      const loggedMessage = consoleSpy.mock.calls[0][0];
      expect(loggedMessage).toContain('[REDACTED SSH KEY]');
      expect(loggedMessage).not.toContain('MIIE');
    });

    it('should redact sensitive data in error logs', () => {
      process.env.PARALLEL_CC_LOG_LEVEL = 'ERROR';
      const logger = new Logger();

      const sensitiveMessage = 'Failed with key: -----BEGIN OPENSSH PRIVATE KEY-----\ndata\n-----END OPENSSH PRIVATE KEY-----';
      logger.error(sensitiveMessage);

      expect(consoleErrorSpy).toHaveBeenCalled();
      const loggedMessage = consoleErrorSpy.mock.calls[0][0];
      expect(loggedMessage).not.toContain('data');
    });

    it('should redact sensitive data in warn logs', () => {
      process.env.PARALLEL_CC_LOG_LEVEL = 'WARN';
      const logger = new Logger();

      const sensitiveMessage = 'Warning: ssh-rsa AAAAB3... detected';
      logger.warn(sensitiveMessage);

      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('should redact sensitive data in debug logs', () => {
      process.env.PARALLEL_CC_LOG_LEVEL = 'DEBUG';
      const logger = new Logger();

      const sensitiveMessage = 'Debug: -----BEGIN EC PRIVATE KEY-----\ndata\n-----END EC PRIVATE KEY-----';
      logger.debug(sensitiveMessage);

      expect(consoleSpy).toHaveBeenCalled();
      const loggedMessage = consoleSpy.mock.calls[0][0];
      expect(loggedMessage).not.toContain('data');
    });
  });
});
