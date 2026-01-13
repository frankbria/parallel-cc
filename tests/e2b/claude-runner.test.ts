/**
 * Unit Tests for Claude Runner
 *
 * Tests the runClaudeUpdate function's resilience to various
 * sandbox environment scenarios:
 * - Successful updates
 * - "Already up-to-date" scenarios (non-zero exit code but success)
 * - Version parsing from output
 * - Error handling
 *
 * All sandbox calls are mocked - no real E2B operations occur.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runClaudeUpdate } from '../../src/e2b/claude-runner.js';
import type { Logger } from '../../src/logger.js';
import type { Sandbox } from 'e2b';

// Create mock logger
const createMockLogger = (): Logger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
});

// Create mock sandbox
const createMockSandbox = (runResults: Map<string, any>): Sandbox => {
  return {
    sandboxId: 'test-sandbox-123',
    commands: {
      run: vi.fn().mockImplementation((cmd: string) => {
        // Find matching result by checking if any key is contained in the command
        for (const [key, result] of runResults.entries()) {
          if (cmd.includes(key)) {
            return Promise.resolve(result);
          }
        }
        // Default failure
        return Promise.resolve({
          exitCode: 1,
          stdout: '',
          stderr: 'Command not found'
        });
      })
    }
  } as unknown as Sandbox;
};

describe('runClaudeUpdate', () => {
  let mockLogger: Logger;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    mockLogger = createMockLogger();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('successful update scenarios', () => {
    it('should return success when update succeeds with exit code 0', async () => {
      const runResults = new Map<string, any>();
      runResults.set('--version', {
        exitCode: 0,
        stdout: '1.2.3',
        stderr: ''
      });
      runResults.set('update', {
        exitCode: 0,
        stdout: 'Claude Code updated to version 1.2.4',
        stderr: ''
      });

      const mockSandbox = createMockSandbox(runResults);
      const result = await runClaudeUpdate(mockSandbox, mockLogger);

      expect(result.success).toBe(true);
      expect(result.version).toBe('1.2.4');
      expect(result.error).toBeUndefined();
    });
  });

  describe('already up-to-date scenarios', () => {
    it('should return success when Claude reports already at latest version', async () => {
      const runResults = new Map<string, any>();
      runResults.set('--version', {
        exitCode: 0,
        stdout: '1.2.4',
        stderr: ''
      });
      runResults.set('update', {
        exitCode: 1,  // Non-zero exit code
        stdout: 'Already at latest version 1.2.4',
        stderr: ''
      });

      const mockSandbox = createMockSandbox(runResults);
      const result = await runClaudeUpdate(mockSandbox, mockLogger);

      // Should be treated as success
      expect(result.success).toBe(true);
      expect(result.version).toBe('1.2.4');
      expect(result.error).toBeUndefined();
    });

    it('should return success when Claude reports no updates available', async () => {
      const runResults = new Map<string, any>();
      runResults.set('--version', {
        exitCode: 0,
        stdout: '1.2.4',
        stderr: ''
      });
      runResults.set('update', {
        exitCode: 1,
        stdout: 'No updates available. Claude Code is up to date.',
        stderr: ''
      });

      const mockSandbox = createMockSandbox(runResults);
      const result = await runClaudeUpdate(mockSandbox, mockLogger);

      expect(result.success).toBe(true);
      expect(result.version).toBe('1.2.4');
    });

    it('should return success when Claude reports up to date in stderr', async () => {
      const runResults = new Map<string, any>();
      runResults.set('--version', {
        exitCode: 0,
        stdout: '1.2.4',
        stderr: ''
      });
      runResults.set('update', {
        exitCode: 1,
        stdout: '',
        stderr: 'Claude Code is already up to date'
      });

      const mockSandbox = createMockSandbox(runResults);
      const result = await runClaudeUpdate(mockSandbox, mockLogger);

      expect(result.success).toBe(true);
      expect(result.version).toBe('1.2.4');
    });

    it('should use version from --version check when update output lacks version', async () => {
      const runResults = new Map<string, any>();
      runResults.set('--version', {
        exitCode: 0,
        stdout: '1.2.4',
        stderr: ''
      });
      runResults.set('update', {
        exitCode: 1,
        stdout: 'Already up-to-date',
        stderr: ''
      });

      const mockSandbox = createMockSandbox(runResults);
      const result = await runClaudeUpdate(mockSandbox, mockLogger);

      expect(result.success).toBe(true);
      expect(result.version).toBe('1.2.4');  // From pre-check
    });
  });

  describe('genuine failure scenarios', () => {
    it('should return failure when update genuinely fails', async () => {
      const runResults = new Map<string, any>();
      runResults.set('--version', {
        exitCode: 0,
        stdout: '1.2.3',
        stderr: ''
      });
      runResults.set('update', {
        exitCode: 1,
        stdout: '',
        stderr: 'Permission denied: cannot write to /usr/local/bin'
      });

      const mockSandbox = createMockSandbox(runResults);
      const result = await runClaudeUpdate(mockSandbox, mockLogger);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return failure when Claude CLI is not found', async () => {
      const runResults = new Map<string, any>();
      runResults.set('--version', {
        exitCode: 127,
        stdout: '',
        stderr: 'claude: command not found'
      });
      runResults.set('update', {
        exitCode: 127,
        stdout: '',
        stderr: 'claude: command not found'
      });

      const mockSandbox = createMockSandbox(runResults);
      const result = await runClaudeUpdate(mockSandbox, mockLogger);

      expect(result.success).toBe(false);
    });

    it('should return failure when network error occurs', async () => {
      const runResults = new Map<string, any>();
      runResults.set('--version', {
        exitCode: 0,
        stdout: '1.2.3',
        stderr: ''
      });
      runResults.set('update', {
        exitCode: 1,
        stdout: '',
        stderr: 'Network error: unable to reach update server'
      });

      const mockSandbox = createMockSandbox(runResults);
      const result = await runClaudeUpdate(mockSandbox, mockLogger);

      expect(result.success).toBe(false);
    });
  });

  describe('version parsing', () => {
    it('should parse version from "updated to version X.Y.Z" format', async () => {
      const runResults = new Map<string, any>();
      runResults.set('--version', {
        exitCode: 0,
        stdout: '1.2.3',
        stderr: ''
      });
      runResults.set('update', {
        exitCode: 0,
        stdout: 'Claude Code updated to version 1.2.5',
        stderr: ''
      });

      const mockSandbox = createMockSandbox(runResults);
      const result = await runClaudeUpdate(mockSandbox, mockLogger);

      expect(result.version).toBe('1.2.5');
    });

    it('should parse version from "already at latest version X.Y.Z" format', async () => {
      const runResults = new Map<string, any>();
      runResults.set('--version', {
        exitCode: 0,
        stdout: '1.2.4',
        stderr: ''
      });
      runResults.set('update', {
        exitCode: 1,
        stdout: 'Already at latest version 1.2.4',
        stderr: ''
      });

      const mockSandbox = createMockSandbox(runResults);
      const result = await runClaudeUpdate(mockSandbox, mockLogger);

      expect(result.version).toBe('1.2.4');
    });

    it('should fall back to pre-check version when parsing fails', async () => {
      const runResults = new Map<string, any>();
      runResults.set('--version', {
        exitCode: 0,
        stdout: '1.2.4',
        stderr: ''
      });
      runResults.set('update', {
        exitCode: 0,
        stdout: 'Update complete!',  // No version in output
        stderr: ''
      });

      const mockSandbox = createMockSandbox(runResults);
      const result = await runClaudeUpdate(mockSandbox, mockLogger);

      expect(result.success).toBe(true);
      // Should fall back to pre-check version
      expect(result.version).not.toBe('unknown');
    });
  });

  describe('authentication modes', () => {
    it('should use ANTHROPIC_API_KEY for api-key mode', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key-12345';

      const runResults = new Map<string, any>();
      runResults.set('--version', {
        exitCode: 0,
        stdout: '1.2.3',
        stderr: ''
      });
      runResults.set('update', {
        exitCode: 0,
        stdout: 'Updated to version 1.2.4',
        stderr: ''
      });

      const mockSandbox = createMockSandbox(runResults);
      await runClaudeUpdate(mockSandbox, mockLogger, 'api-key');

      // Verify the command included the API key
      const runCalls = (mockSandbox.commands.run as any).mock.calls;
      const updateCall = runCalls.find((call: any) => call[0].includes('update'));
      expect(updateCall[0]).toContain('ANTHROPIC_API_KEY=');
    });

    it('should not include API key for oauth mode', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key-12345';

      const runResults = new Map<string, any>();
      runResults.set('--version', {
        exitCode: 0,
        stdout: '1.2.3',
        stderr: ''
      });
      runResults.set('update', {
        exitCode: 0,
        stdout: 'Updated to version 1.2.4',
        stderr: ''
      });

      const mockSandbox = createMockSandbox(runResults);
      await runClaudeUpdate(mockSandbox, mockLogger, 'oauth');

      // Verify the command did NOT include the API key
      const runCalls = (mockSandbox.commands.run as any).mock.calls;
      const updateCall = runCalls.find((call: any) => call[0].includes('update'));
      expect(updateCall[0]).not.toContain('ANTHROPIC_API_KEY=');
    });
  });

  describe('--yes flag usage', () => {
    it('should use --yes flag to auto-accept prompts', async () => {
      const runResults = new Map<string, any>();
      runResults.set('--version', {
        exitCode: 0,
        stdout: '1.2.3',
        stderr: ''
      });
      runResults.set('update', {
        exitCode: 0,
        stdout: 'Updated to version 1.2.4',
        stderr: ''
      });

      const mockSandbox = createMockSandbox(runResults);
      await runClaudeUpdate(mockSandbox, mockLogger);

      // Verify the command used --yes flag
      const runCalls = (mockSandbox.commands.run as any).mock.calls;
      const updateCall = runCalls.find((call: any) => call[0].includes('update'));
      expect(updateCall[0]).toContain('--yes');
    });
  });
});
