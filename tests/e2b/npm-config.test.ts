/**
 * Tests for NPM Configuration in E2B Sandboxes
 *
 * Tests NPM token injection for private package access:
 * - configureNpmAuth method validation
 * - .npmrc file creation with correct format
 * - Registry URL handling (default and custom)
 * - Token security (never logged)
 * - Error handling
 *
 * All E2B operations are mocked - no real sandbox operations occur.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Sandbox } from 'e2b';

// Mock logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
};

describe('NPM Configuration for E2B Sandboxes', () => {
  let mockSandbox: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock sandbox with E2B-like API
    mockSandbox = {
      files: {
        write: vi.fn().mockResolvedValue(undefined),
        read: vi.fn().mockResolvedValue(Buffer.from(''))
      },
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
      }
    };
  });

  describe('configureNpmAuth', () => {
    it('should create .npmrc file with token for default registry', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      const result = await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        'npm_test_token_123'
      );

      expect(result).toBe(true);
      expect(mockSandbox.files.write).toHaveBeenCalledWith(
        '/root/.npmrc',
        expect.stringContaining('//registry.npmjs.org/:_authToken=npm_test_token_123')
      );
    });

    it('should include registry line in .npmrc', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      await manager.configureNpmAuth(mockSandbox as Sandbox, 'npm_token');

      expect(mockSandbox.files.write).toHaveBeenCalledWith(
        '/root/.npmrc',
        expect.stringContaining('registry=https://registry.npmjs.org')
      );
    });

    it('should handle custom registry URL', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      const result = await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        'npm_token_456',
        'https://npm.company.com'
      );

      expect(result).toBe(true);
      expect(mockSandbox.files.write).toHaveBeenCalledWith(
        '/root/.npmrc',
        expect.stringContaining('//npm.company.com/:_authToken=npm_token_456')
      );
      expect(mockSandbox.files.write).toHaveBeenCalledWith(
        '/root/.npmrc',
        expect.stringContaining('registry=https://npm.company.com')
      );
    });

    it('should handle registry URL with trailing slash', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        'npm_token',
        'https://npm.company.com/'  // Trailing slash
      );

      // Should strip trailing slash for hostname extraction
      expect(mockSandbox.files.write).toHaveBeenCalledWith(
        '/root/.npmrc',
        expect.stringContaining('//npm.company.com/:_authToken=')
      );
    });

    it('should reject empty token', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      const result = await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        ''
      );

      expect(result).toBe(false);
      expect(mockSandbox.files.write).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringMatching(/invalid.*npm.*token/i)
      );
    });

    it('should reject whitespace-only token', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      const result = await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        '   '
      );

      expect(result).toBe(false);
      expect(mockSandbox.files.write).not.toHaveBeenCalled();
    });

    it('should reject invalid registry URL format', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      const result = await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        'npm_token',
        'not-a-valid-url'
      );

      expect(result).toBe(false);
      expect(mockSandbox.files.write).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringMatching(/invalid.*registry.*url/i)
      );
    });

    it('should handle file write errors gracefully', async () => {
      mockSandbox.files.write.mockRejectedValueOnce(new Error('Permission denied'));

      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      const result = await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        'npm_token'
      );

      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringMatching(/failed.*npm.*config/i)
      );
    });

    it('should log success without exposing token', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        'npm_super_secret_token'
      );

      // Verify info was logged
      expect(mockLogger.info).toHaveBeenCalled();

      // Verify token is NOT in any log message
      const allLogCalls = [
        ...mockLogger.info.mock.calls,
        ...mockLogger.debug.mock.calls,
        ...mockLogger.warn.mock.calls,
        ...mockLogger.error.mock.calls
      ];

      const logMessages = allLogCalls.map(call => call[0]);
      logMessages.forEach(msg => {
        expect(msg).not.toContain('npm_super_secret_token');
      });
    });

    it('should handle registry with port number', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        'npm_token',
        'https://npm.company.com:8080'
      );

      expect(mockSandbox.files.write).toHaveBeenCalledWith(
        '/root/.npmrc',
        expect.stringContaining('//npm.company.com:8080/:_authToken=')
      );
    });

    it('should handle registry URL with path', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        'npm_token',
        'https://artifacts.company.com/npm/registry'
      );

      expect(mockSandbox.files.write).toHaveBeenCalledWith(
        '/root/.npmrc',
        expect.stringContaining('//artifacts.company.com/npm/registry/:_authToken=')
      );
    });
  });

  describe('Registry URL validation', () => {
    it('should accept https URLs', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      const result = await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        'token',
        'https://registry.example.com'
      );

      expect(result).toBe(true);
    });

    it('should accept http URLs (for private registries)', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      const result = await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        'token',
        'http://internal.registry.local'
      );

      expect(result).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/http.*insecure|insecure.*http/i)
      );
    });

    it('should reject non-http(s) URLs', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      const result = await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        'token',
        'ftp://invalid.registry.com'
      );

      expect(result).toBe(false);
    });
  });

  describe('.npmrc content format', () => {
    it('should generate correct .npmrc for default npm registry', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      await manager.configureNpmAuth(mockSandbox as Sandbox, 'my_token_123');

      const expectedContent = [
        '//registry.npmjs.org/:_authToken=my_token_123',
        'registry=https://registry.npmjs.org'
      ].join('\n');

      expect(mockSandbox.files.write).toHaveBeenCalledWith(
        '/root/.npmrc',
        expect.stringContaining('//registry.npmjs.org/:_authToken=my_token_123')
      );
    });

    it('should handle tokens with special characters safely', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      // NPM tokens can contain alphanumeric and some special chars
      const specialToken = 'npm_abc123-XYZ_456';

      const result = await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        specialToken
      );

      expect(result).toBe(true);
      expect(mockSandbox.files.write).toHaveBeenCalledWith(
        '/root/.npmrc',
        expect.stringContaining(`_authToken=${specialToken}`)
      );
    });
  });

  describe('Integration with sandbox lifecycle', () => {
    it('should configure npm auth before npm operations', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      // Configure npm auth
      const configResult = await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        'npm_token'
      );

      expect(configResult).toBe(true);

      // Simulate npm install
      mockSandbox.commands.run.mockResolvedValueOnce({
        stdout: 'added 100 packages',
        stderr: '',
        exitCode: 0
      });

      const installResult = await mockSandbox.commands.run('npm install');
      expect(installResult.exitCode).toBe(0);
    });

    it('should not block sandbox execution on npm config failure', async () => {
      mockSandbox.files.write.mockRejectedValueOnce(new Error('Write failed'));

      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      // NPM config fails
      const result = await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        'npm_token'
      );

      expect(result).toBe(false);

      // But sandbox should still be usable
      mockSandbox.commands.run.mockResolvedValueOnce({
        stdout: 'ok',
        stderr: '',
        exitCode: 0
      });

      const echoResult = await mockSandbox.commands.run('echo "sandbox works"');
      expect(echoResult.exitCode).toBe(0);
    });
  });

  describe('Edge cases', () => {
    it('should handle null sandbox gracefully', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      const result = await manager.configureNpmAuth(
        null as any,
        'npm_token'
      );

      expect(result).toBe(false);
    });

    it('should handle sandbox without files API', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      const brokenSandbox = { commands: { run: vi.fn() } };

      const result = await manager.configureNpmAuth(
        brokenSandbox as any,
        'npm_token'
      );

      expect(result).toBe(false);
    });

    it('should handle very long tokens', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      const longToken = 'npm_' + 'a'.repeat(1000);

      const result = await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        longToken
      );

      expect(result).toBe(true);
      expect(mockSandbox.files.write).toHaveBeenCalledWith(
        '/root/.npmrc',
        expect.stringContaining(longToken)
      );
    });

    it('should handle registry hostname with $ character', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      // Registry with $ in path (edge case for String.replace)
      const result = await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        'npm_token',
        'https://registry.example.com/$npm'
      );

      expect(result).toBe(true);
      // Verify $ is preserved literally, not interpreted as replacement pattern
      expect(mockSandbox.files.write).toHaveBeenCalledWith(
        '/root/.npmrc',
        expect.stringContaining('//registry.example.com/$npm/:_authToken=')
      );
    });

    it('should strip query and fragment from registry URL', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      // Registry URL with query and fragment (should be stripped)
      const result = await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        'npm_token',
        'https://registry.example.com/npm?foo=bar#section'
      );

      expect(result).toBe(true);
      // Auth scope should not contain query/fragment
      expect(mockSandbox.files.write).toHaveBeenCalledWith(
        '/root/.npmrc',
        expect.stringContaining('//registry.example.com/npm/:_authToken=')
      );
      // registry= line should also be normalized
      expect(mockSandbox.files.write).toHaveBeenCalledWith(
        '/root/.npmrc',
        expect.stringContaining('registry=https://registry.example.com/npm')
      );
      // Should NOT contain query or fragment
      const writeCall = mockSandbox.files.write.mock.calls[0];
      expect(writeCall[1]).not.toContain('?foo=bar');
      expect(writeCall[1]).not.toContain('#section');
    });

    it('should handle token with newlines (sanitization)', async () => {
      const { SandboxManager } = await import('../../src/e2b/sandbox-manager.js');
      const manager = new SandboxManager(mockLogger as any);

      // Token with embedded newline (malicious attempt)
      const maliciousToken = 'npm_token\n//evil.com/:_authToken=stolen';

      const result = await manager.configureNpmAuth(
        mockSandbox as Sandbox,
        maliciousToken
      );

      // Should either reject or sanitize
      if (result) {
        // If accepted, newlines must be removed
        const writeCall = mockSandbox.files.write.mock.calls[0];
        expect(writeCall[1]).not.toContain('evil.com');
      } else {
        // Or reject entirely
        expect(result).toBe(false);
      }
    });
  });
});
