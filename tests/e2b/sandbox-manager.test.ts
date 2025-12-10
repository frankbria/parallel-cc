/**
 * Tests for E2B SandboxManager class
 *
 * Tests the foundation of E2B sandbox integration including:
 * - Sandbox creation and termination
 * - Health monitoring and heartbeat checks
 * - Timeout enforcement (30min/50min warnings, 1-hour hard limit)
 * - Input validation (prompt sanitization, file path validation)
 * - Error handling (E2B API failures, network errors)
 *
 * All E2B SDK calls are mocked - no real cloud operations occur.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SandboxManager,
  sanitizePrompt,
  validateFilePath
} from '../../src/e2b/sandbox-manager.js';
import { SandboxStatus } from '../../src/types.js';
import type { Logger } from '../../src/logger.js';

// Mock E2B SDK
vi.mock('e2b', () => ({
  Sandbox: {
    create: vi.fn()
  }
}));

// Create mock logger
const createMockLogger = (): Logger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
});

describe('SandboxManager', () => {
  let manager: SandboxManager;
  let mockLogger: Logger;
  let mockSandbox: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create mock logger
    mockLogger = createMockLogger();

    // Create mock sandbox instance
    mockSandbox = {
      sandboxId: 'test-sandbox-123',
      close: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
      isRunning: vi.fn().mockResolvedValue(true),
      metadata: {}
    };

    // Setup E2B SDK mock
    const { Sandbox } = await import('e2b');
    vi.mocked(Sandbox.create).mockResolvedValue(mockSandbox);

    // Set environment variable for API key
    process.env.E2B_API_KEY = 'test-api-key-12345';

    // Create manager instance
    manager = new SandboxManager(mockLogger);
  });

  afterEach(() => {
    vi.clearAllTimers();
    delete process.env.E2B_API_KEY;
  });

  describe('constructor', () => {
    it('should create manager with default config', () => {
      const testManager = new SandboxManager(mockLogger);
      expect(testManager).toBeInstanceOf(SandboxManager);
    });

    it('should create manager with custom timeout', () => {
      const testManager = new SandboxManager(mockLogger, {
        timeoutMinutes: 30
      });
      expect(testManager).toBeInstanceOf(SandboxManager);
    });

    it('should create manager with custom warning thresholds', () => {
      const testManager = new SandboxManager(mockLogger, {
        warningThresholds: [15, 25]
      });
      expect(testManager).toBeInstanceOf(SandboxManager);
    });

    it('should create manager with custom sandbox image', () => {
      const testManager = new SandboxManager(mockLogger, {
        sandboxImage: 'custom-image'
      });
      expect(testManager).toBeInstanceOf(SandboxManager);
    });

    it('should use default config values when not provided', () => {
      const testManager = new SandboxManager(mockLogger, {});
      expect(testManager).toBeInstanceOf(SandboxManager);
    });
  });

  describe('createSandbox', () => {
    it('should create sandbox successfully with session ID', async () => {
      const result = await manager.createSandbox('session-123');

      expect(result.sandbox).toBe(mockSandbox);
      expect(result.sandboxId).toBe('test-sandbox-123');
      expect(result.status).toBe(SandboxStatus.INITIALIZING);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Creating E2B sandbox')
      );
    });

    it('should create sandbox with provided API key', async () => {
      const { Sandbox } = await import('e2b');

      await manager.createSandbox('session-123', 'custom-api-key');

      expect(Sandbox.create).toHaveBeenCalledWith(
        'base',
        expect.objectContaining({
          apiKey: 'custom-api-key'
        })
      );
    });

    it('should create sandbox with environment API key when not provided', async () => {
      const { Sandbox } = await import('e2b');

      await manager.createSandbox('session-123');

      expect(Sandbox.create).toHaveBeenCalledWith(
        'base',
        expect.objectContaining({
          apiKey: 'test-api-key-12345'
        })
      );
    });

    it('should throw error when API key not found', async () => {
      delete process.env.E2B_API_KEY;

      await expect(manager.createSandbox('session-123')).rejects.toThrow(
        /E2B/
      );
    });

    it('should include metadata in sandbox creation', async () => {
      const { Sandbox } = await import('e2b');

      await manager.createSandbox('session-123');

      expect(Sandbox.create).toHaveBeenCalledWith(
        'base',
        expect.objectContaining({
          metadata: expect.objectContaining({
            sessionId: 'session-123',
            createdAt: expect.any(String),
            timeoutMinutes: '60'
          })
        })
      );
    });

    it('should use custom sandbox image template', async () => {
      const { Sandbox } = await import('e2b');
      const customManager = new SandboxManager(mockLogger, {
        sandboxImage: 'custom-template'
      });

      await customManager.createSandbox('session-123');

      expect(Sandbox.create).toHaveBeenCalledWith(
        'custom-template',
        expect.any(Object)
      );
    });

    it('should handle E2B API authentication errors', async () => {
      const { Sandbox } = await import('e2b');
      vi.mocked(Sandbox.create).mockRejectedValueOnce(
        new Error('Invalid API key provided')
      );

      await expect(manager.createSandbox('session-123')).rejects.toThrow(
        /E2B authentication failed/
      );
    });

    it('should handle E2B quota exceeded errors', async () => {
      const { Sandbox } = await import('e2b');
      vi.mocked(Sandbox.create).mockRejectedValueOnce(
        new Error('Monthly quota exceeded for your plan')
      );

      await expect(manager.createSandbox('session-123')).rejects.toThrow(
        /E2B quota exceeded/
      );
    });

    it('should handle network timeout errors', async () => {
      const { Sandbox } = await import('e2b');
      vi.mocked(Sandbox.create).mockRejectedValueOnce(
        new Error('Request timeout connecting to E2B')
      );

      await expect(manager.createSandbox('session-123')).rejects.toThrow(
        /Network error connecting to E2B/
      );
    });

    it('should handle generic E2B errors', async () => {
      const { Sandbox } = await import('e2b');
      vi.mocked(Sandbox.create).mockRejectedValueOnce(
        new Error('Unknown E2B error')
      );

      await expect(manager.createSandbox('session-123')).rejects.toThrow(
        /E2B sandbox creation failed/
      );
    });

    it('should track sandbox in internal state', async () => {
      await manager.createSandbox('session-123');

      const sandbox = manager.getSandbox('test-sandbox-123');
      expect(sandbox).toBe(mockSandbox);
    });

    it('should track multiple sandboxes', async () => {
      mockSandbox.sandboxId = 'sandbox-1';
      await manager.createSandbox('session-1');

      mockSandbox = { ...mockSandbox, sandboxId: 'sandbox-2' };
      vi.mocked((await import('e2b')).Sandbox.create).mockResolvedValue(mockSandbox);
      await manager.createSandbox('session-2');

      expect(manager.getActiveSandboxIds()).toHaveLength(2);
    });
  });

  describe('monitorSandboxHealth', () => {
    beforeEach(async () => {
      await manager.createSandbox('session-123');
    });

    it('should return healthy status for active sandbox', async () => {
      const health = await manager.monitorSandboxHealth('test-sandbox-123');

      expect(health.isHealthy).toBe(true);
      expect(health.sandboxId).toBe('test-sandbox-123');
      expect(health.status).toBe(SandboxStatus.RUNNING);
      expect(health.lastHeartbeat).toBeInstanceOf(Date);
    });

    it('should return unhealthy status for missing sandbox', async () => {
      const health = await manager.monitorSandboxHealth('nonexistent');

      expect(health.isHealthy).toBe(false);
      expect(health.sandboxId).toBe('nonexistent');
      expect(health.status).toBe(SandboxStatus.FAILED);
      expect(health.error).toContain('not found');
    });

    it('should include health check message when healthy', async () => {
      const health = await manager.monitorSandboxHealth('test-sandbox-123');

      expect(health.message).toBe('Sandbox is healthy');
    });

    it('should update heartbeat timestamp on each check', async () => {
      const health1 = await manager.monitorSandboxHealth('test-sandbox-123');

      // Wait a tiny bit
      await new Promise(resolve => setTimeout(resolve, 10));

      const health2 = await manager.monitorSandboxHealth('test-sandbox-123');

      expect(health2.lastHeartbeat.getTime()).toBeGreaterThanOrEqual(
        health1.lastHeartbeat.getTime()
      );
    });
  });

  describe('enforceTimeout', () => {
    beforeEach(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
      await manager.createSandbox('session-123');
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return null when no warning threshold reached', async () => {
      // Advance 10 minutes (no threshold yet)
      vi.advanceTimersByTime(10 * 60 * 1000);

      const warning = await manager.enforceTimeout('test-sandbox-123');

      expect(warning).toBeNull();
    });

    it('should issue soft warning at 30 minute threshold', async () => {
      // Advance 30 minutes
      vi.advanceTimersByTime(30 * 60 * 1000);

      const warning = await manager.enforceTimeout('test-sandbox-123');

      expect(warning).not.toBeNull();
      expect(warning?.warningLevel).toBe('soft');
      expect(warning?.elapsedMinutes).toBe(30);
      expect(warning?.message).toContain('30 minutes');
    });

    it('should issue soft warning at 50 minute threshold', async () => {
      // Advance 50 minutes
      vi.advanceTimersByTime(50 * 60 * 1000);

      const warning = await manager.enforceTimeout('test-sandbox-123');

      expect(warning).not.toBeNull();
      expect(warning?.warningLevel).toBe('soft');
      expect(warning?.elapsedMinutes).toBe(50);
      expect(warning?.message).toContain('50 minutes');
    });

    it('should issue hard warning and terminate at 60 minute limit', async () => {
      // Advance 60 minutes
      vi.advanceTimersByTime(60 * 60 * 1000);

      const warning = await manager.enforceTimeout('test-sandbox-123');

      expect(warning).not.toBeNull();
      expect(warning?.warningLevel).toBe('hard');
      expect(warning?.elapsedMinutes).toBe(60);
      expect(warning?.message).toContain('HARD TIMEOUT');
      expect(mockSandbox.kill).toHaveBeenCalled();
    });

    it('should include cost estimate in warning', async () => {
      vi.advanceTimersByTime(30 * 60 * 1000);

      const warning = await manager.enforceTimeout('test-sandbox-123');

      expect(warning?.estimatedCost).toMatch(/\$\d+\.\d{2}/);
    });

    it('should only issue each warning once', async () => {
      // Advance to 30 minutes
      vi.advanceTimersByTime(30 * 60 * 1000);
      const warning1 = await manager.enforceTimeout('test-sandbox-123');
      expect(warning1).not.toBeNull();

      // Check again at 31 minutes (should not warn again)
      vi.advanceTimersByTime(1 * 60 * 1000);
      const warning2 = await manager.enforceTimeout('test-sandbox-123');
      expect(warning2).toBeNull();
    });

    it('should return null for nonexistent sandbox', async () => {
      const warning = await manager.enforceTimeout('nonexistent');
      expect(warning).toBeNull();
    });

    it('should log warnings to logger', async () => {
      vi.advanceTimersByTime(30 * 60 * 1000);
      await manager.enforceTimeout('test-sandbox-123');

      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should log hard timeout as error', async () => {
      vi.advanceTimersByTime(60 * 60 * 1000);
      await manager.enforceTimeout('test-sandbox-123');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('HARD TIMEOUT')
      );
    });
  });

  describe('terminateSandbox', () => {
    beforeEach(async () => {
      await manager.createSandbox('session-123');
    });

    it('should terminate sandbox successfully', async () => {
      const result = await manager.terminateSandbox('test-sandbox-123');

      expect(result.success).toBe(true);
      expect(result.sandboxId).toBe('test-sandbox-123');
      expect(result.cleanedUp).toBe(true);
      expect(mockSandbox.kill).toHaveBeenCalled();
    });

    it('should remove sandbox from internal tracking', async () => {
      await manager.terminateSandbox('test-sandbox-123');

      const sandbox = manager.getSandbox('test-sandbox-123');
      expect(sandbox).toBeNull();
    });

    it('should return error for nonexistent sandbox', async () => {
      const result = await manager.terminateSandbox('nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(result.cleanedUp).toBe(false);
    });

    it('should handle termination errors gracefully', async () => {
      mockSandbox.kill.mockRejectedValueOnce(new Error('Kill failed'));

      const result = await manager.terminateSandbox('test-sandbox-123');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Kill failed');
      expect(result.cleanedUp).toBe(true); // Cleanup still attempted
    });

    it('should cleanup tracking data even on error', async () => {
      mockSandbox.kill.mockRejectedValueOnce(new Error('Kill failed'));

      await manager.terminateSandbox('test-sandbox-123');

      // Should still be removed from tracking
      const sandbox = manager.getSandbox('test-sandbox-123');
      expect(sandbox).toBeNull();
    });

    it('should log termination', async () => {
      await manager.terminateSandbox('test-sandbox-123');

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Terminating E2B sandbox')
      );
    });
  });

  describe('getSandbox', () => {
    it('should return null for nonexistent sandbox', () => {
      const sandbox = manager.getSandbox('nonexistent');
      expect(sandbox).toBeNull();
    });

    it('should return sandbox instance when it exists', async () => {
      await manager.createSandbox('session-123');

      const sandbox = manager.getSandbox('test-sandbox-123');
      expect(sandbox).toBe(mockSandbox);
    });
  });

  describe('getElapsedMinutes', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return null for nonexistent sandbox', () => {
      const elapsed = manager.getElapsedMinutes('nonexistent');
      expect(elapsed).toBeNull();
    });

    it('should return 0 minutes for just-created sandbox', async () => {
      await manager.createSandbox('session-123');

      const elapsed = manager.getElapsedMinutes('test-sandbox-123');
      expect(elapsed).toBe(0);
    });

    it('should return elapsed minutes after time passes', async () => {
      await manager.createSandbox('session-123');

      vi.advanceTimersByTime(15 * 60 * 1000); // 15 minutes

      const elapsed = manager.getElapsedMinutes('test-sandbox-123');
      expect(elapsed).toBe(15);
    });

    it('should handle fractional minutes (floor to integer)', async () => {
      await manager.createSandbox('session-123');

      vi.advanceTimersByTime(2.5 * 60 * 1000); // 2.5 minutes

      const elapsed = manager.getElapsedMinutes('test-sandbox-123');
      expect(elapsed).toBe(2); // Floored
    });
  });

  describe('getActiveSandboxIds', () => {
    it('should return empty array when no sandboxes', () => {
      const ids = manager.getActiveSandboxIds();
      expect(ids).toEqual([]);
    });

    it('should return array with single sandbox ID', async () => {
      await manager.createSandbox('session-123');

      const ids = manager.getActiveSandboxIds();
      expect(ids).toEqual(['test-sandbox-123']);
    });

    it('should return all active sandbox IDs', async () => {
      mockSandbox.sandboxId = 'sandbox-1';
      await manager.createSandbox('session-1');

      mockSandbox = { ...mockSandbox, sandboxId: 'sandbox-2' };
      vi.mocked((await import('e2b')).Sandbox.create).mockResolvedValue(mockSandbox);
      await manager.createSandbox('session-2');

      const ids = manager.getActiveSandboxIds();
      expect(ids).toContain('sandbox-1');
      expect(ids).toContain('sandbox-2');
      expect(ids).toHaveLength(2);
    });

    it('should not include terminated sandboxes', async () => {
      await manager.createSandbox('session-123');
      await manager.terminateSandbox('test-sandbox-123');

      const ids = manager.getActiveSandboxIds();
      expect(ids).toEqual([]);
    });
  });

  describe('cleanupAll', () => {
    it('should cleanup all active sandboxes', async () => {
      mockSandbox.sandboxId = 'sandbox-1';
      await manager.createSandbox('session-1');

      mockSandbox = { ...mockSandbox, sandboxId: 'sandbox-2', close: vi.fn() };
      vi.mocked((await import('e2b')).Sandbox.create).mockResolvedValue(mockSandbox);
      await manager.createSandbox('session-2');

      await manager.cleanupAll();

      expect(manager.getActiveSandboxIds()).toEqual([]);
    });

    it('should log cleanup count', async () => {
      // Create first sandbox
      mockSandbox.sandboxId = 'sandbox-1';
      await manager.createSandbox('session-1');

      // Create second sandbox with new mock
      const sandbox2 = { ...mockSandbox, sandboxId: 'sandbox-2', close: vi.fn() };
      vi.mocked((await import('e2b')).Sandbox.create).mockResolvedValueOnce(sandbox2);
      await manager.createSandbox('session-2');

      vi.clearAllMocks(); // Clear previous logs

      await manager.cleanupAll();

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Cleaning up 2 active sandboxes')
      );
    });

    it('should handle cleanup errors gracefully', async () => {
      mockSandbox.kill.mockRejectedValueOnce(new Error('Kill failed'));
      await manager.createSandbox('session-123');

      await manager.cleanupAll();

      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should continue cleanup even if some sandboxes fail', async () => {
      mockSandbox.sandboxId = 'sandbox-1';
      mockSandbox.kill = vi.fn().mockRejectedValue(new Error('Fail'));
      await manager.createSandbox('session-1');

      mockSandbox = { ...mockSandbox, sandboxId: 'sandbox-2', kill: vi.fn().mockResolvedValue(undefined) };
      vi.mocked((await import('e2b')).Sandbox.create).mockResolvedValue(mockSandbox);
      await manager.createSandbox('session-2');

      await manager.cleanupAll();

      // Both should be removed from tracking
      expect(manager.getActiveSandboxIds()).toEqual([]);
    });
  });

  describe('sanitizePrompt', () => {
    it('should allow valid prompts', () => {
      const prompt = 'This is a valid prompt';
      expect(() => sanitizePrompt(prompt)).not.toThrow();
    });

    it('should throw on empty prompt', () => {
      expect(() => sanitizePrompt('')).toThrow(/non-empty string/);
    });

    it('should throw on null prompt', () => {
      expect(() => sanitizePrompt(null as any)).toThrow(/non-empty string/);
    });

    it('should throw on undefined prompt', () => {
      expect(() => sanitizePrompt(undefined as any)).toThrow(/non-empty string/);
    });

    it('should throw on non-string prompt', () => {
      expect(() => sanitizePrompt(123 as any)).toThrow(/non-empty string/);
    });

    it('should throw on prompt exceeding max length', () => {
      const longPrompt = 'a'.repeat(100001);
      expect(() => sanitizePrompt(longPrompt)).toThrow(/maximum length/);
    });

    it('should escape shell metacharacters', () => {
      const dangerous = 'test && rm -rf /';
      const sanitized = sanitizePrompt(dangerous);
      expect(sanitized).not.toBe(dangerous);
      expect(sanitized).toContain('\\&\\&');
    });

    it('should escape backticks', () => {
      const dangerous = 'test `whoami`';
      const sanitized = sanitizePrompt(dangerous);
      expect(sanitized).toContain('\\`');
    });

    it('should escape dollar signs', () => {
      const dangerous = 'test $(echo evil)';
      const sanitized = sanitizePrompt(dangerous);
      expect(sanitized).toContain('\\$');
    });

    it('should escape pipes', () => {
      const dangerous = 'test | grep secret';
      const sanitized = sanitizePrompt(dangerous);
      expect(sanitized).toContain('\\|');
    });

    it('should escape semicolons', () => {
      const dangerous = 'test; cat /etc/passwd';
      const sanitized = sanitizePrompt(dangerous);
      expect(sanitized).toContain('\\;');
    });

    it('should remove control characters except newlines and tabs', () => {
      const withControl = 'test\x00\x01\x02\nvalid\ttext';
      const sanitized = sanitizePrompt(withControl);
      expect(sanitized).not.toContain('\x00');
      expect(sanitized).toContain('\n');
      expect(sanitized).toContain('\t');
    });

    it('should preserve unicode characters', () => {
      const unicode = 'Test 中文 émojis 🚀';
      const sanitized = sanitizePrompt(unicode);
      expect(sanitized).toContain('中文');
      expect(sanitized).toContain('🚀');
    });
  });

  describe('validateFilePath', () => {
    it('should accept valid relative paths', () => {
      const paths = [
        'src/index.ts',
        'test/file.js',
        'docs/README.md',
        'a/b/c/d/e.txt'
      ];

      for (const path of paths) {
        expect(() => validateFilePath(path)).not.toThrow();
        expect(validateFilePath(path)).toBe(true);
      }
    });

    it('should throw on empty path', () => {
      expect(() => validateFilePath('')).toThrow(/non-empty string/);
    });

    it('should throw on null path', () => {
      expect(() => validateFilePath(null as any)).toThrow(/non-empty string/);
    });

    it('should throw on undefined path', () => {
      expect(() => validateFilePath(undefined as any)).toThrow(/non-empty string/);
    });

    it('should throw on non-string path', () => {
      expect(() => validateFilePath(123 as any)).toThrow(/non-empty string/);
    });

    it('should throw on directory traversal with ..', () => {
      const paths = [
        '../../../etc/passwd',
        'src/../../secret.txt',
        'test/../../../root.txt'
      ];

      for (const path of paths) {
        expect(() => validateFilePath(path)).toThrow(/directory traversal/);
      }
    });

    it('should throw on absolute paths', () => {
      const paths = [
        '/etc/passwd',
        '/root/secret.txt',
        '/usr/bin/bash'
      ];

      for (const path of paths) {
        expect(() => validateFilePath(path)).toThrow(/absolute paths not allowed/);
      }
    });

    it('should throw on null byte in path', () => {
      const path = 'test\x00file.txt';
      expect(() => validateFilePath(path)).toThrow(/null byte/);
    });

    it('should accept paths with dots in filename', () => {
      const paths = [
        'file.test.ts',
        'image.min.js',
        'style.module.css'
      ];

      for (const path of paths) {
        expect(() => validateFilePath(path)).not.toThrow();
      }
    });

    it('should accept paths with underscores and hyphens', () => {
      const paths = [
        'my_file.ts',
        'test-utils.js',
        'path/to/my-test_file.txt'
      ];

      for (const path of paths) {
        expect(() => validateFilePath(path)).not.toThrow();
      }
    });
  });

  describe('error handling edge cases', () => {
    it('should handle sandbox creation with invalid session ID format', async () => {
      // Should still work - session IDs are not validated
      const result = await manager.createSandbox('');
      expect(result).toBeDefined();
    });

    it('should handle concurrent sandbox operations', async () => {
      const promises = [
        manager.createSandbox('session-1'),
        manager.createSandbox('session-2'),
        manager.createSandbox('session-3')
      ];

      const results = await Promise.all(promises);
      expect(results).toHaveLength(3);
    });

    it('should handle health check during termination', async () => {
      await manager.createSandbox('session-123');

      // Start termination but don't await
      const terminatePromise = manager.terminateSandbox('test-sandbox-123');

      // Try health check during termination
      const health = await manager.monitorSandboxHealth('test-sandbox-123');

      await terminatePromise;

      // Health check should still complete (may show unhealthy)
      expect(health).toBeDefined();
    });

    it('should handle timeout enforcement after termination', async () => {
      vi.useFakeTimers();
      await manager.createSandbox('session-123');
      await manager.terminateSandbox('test-sandbox-123');

      vi.advanceTimersByTime(60 * 60 * 1000);
      const warning = await manager.enforceTimeout('test-sandbox-123');

      expect(warning).toBeNull();
      vi.useRealTimers();
    });
  });

  describe('integration scenarios', () => {
    it('should complete full lifecycle: create -> monitor -> timeout -> terminate', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));

      // Create
      const createResult = await manager.createSandbox('session-123');
      expect(createResult.status).toBe(SandboxStatus.INITIALIZING);

      // Monitor - should be healthy immediately after creation
      const health = await manager.monitorSandboxHealth('test-sandbox-123');
      expect(health.isHealthy).toBe(true);
      expect(health.sandboxId).toBe('test-sandbox-123');

      // Timeout warning
      vi.advanceTimersByTime(30 * 60 * 1000);
      const warning = await manager.enforceTimeout('test-sandbox-123');
      expect(warning?.warningLevel).toBe('soft');

      // Terminate
      const terminateResult = await manager.terminateSandbox('test-sandbox-123');
      expect(terminateResult.success).toBe(true);

      vi.useRealTimers();
    });

    it('should handle multiple sandboxes with different lifecycles', async () => {
      // Create two sandboxes
      mockSandbox.sandboxId = 'sandbox-1';
      await manager.createSandbox('session-1');

      mockSandbox = { ...mockSandbox, sandboxId: 'sandbox-2' };
      vi.mocked((await import('e2b')).Sandbox.create).mockResolvedValue(mockSandbox);
      await manager.createSandbox('session-2');

      // Terminate one
      await manager.terminateSandbox('sandbox-1');

      // Check remaining
      const ids = manager.getActiveSandboxIds();
      expect(ids).toEqual(['sandbox-2']);
    });

    it('should handle rapid create-terminate cycles', async () => {
      for (let i = 0; i < 10; i++) {
        mockSandbox.sandboxId = `sandbox-${i}`;
        await manager.createSandbox(`session-${i}`);
        await manager.terminateSandbox(`sandbox-${i}`);
      }

      expect(manager.getActiveSandboxIds()).toEqual([]);
    });
  });
});
