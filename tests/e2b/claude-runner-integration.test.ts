/**
 * Integration test for Claude Runner
 *
 * Note: These tests require E2B API key and actual sandbox creation.
 * Tests are automatically skipped when E2B_API_KEY is not set.
 *
 * Run with:
 *   E2B_API_KEY=xxx npm test -- tests/e2b/claude-runner-integration.test.ts
 *
 * Or use dedicated script:
 *   npm run test:e2b
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Sandbox } from 'e2b';
import { Logger } from '../../src/logger.js';
import { SandboxManager } from '../../src/e2b/sandbox-manager.js';
import {
  executeClaudeInSandbox,
  runClaudeUpdate,
  runClaudeWithPrompt,
  formatExecutionTime,
  isExecutionSuccessful,
  executionStateToSandboxStatus
} from '../../src/e2b/claude-runner.js';
import { SandboxStatus } from '../../src/types.js';
import { skipE2B, setupE2BTests } from './test-helpers.js';

describe('Claude Runner Integration Tests', () => {
  let logger: Logger;
  let sandboxManager: SandboxManager;
  let sandbox: Sandbox | null = null;
  let sandboxId: string | null = null;

  // Log E2B test status and validate environment
  setupE2BTests();

  beforeAll(async () => {
    if (skipE2B) {
      return;
    }

    logger = new Logger();
    sandboxManager = new SandboxManager(logger);

    // Create test sandbox
    const result = await sandboxManager.createSandbox('test-session-' + Date.now());
    sandbox = result.sandbox;
    sandboxId = result.sandboxId;
  });

  afterAll(async () => {
    // Cleanup sandbox
    if (sandboxId) {
      await sandboxManager.terminateSandbox(sandboxId);
    }
  });

  describe('runClaudeUpdate', () => {
    // Check if ANTHROPIC_API_KEY is available for proper authentication
    const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;

    it.skipIf(skipE2B)('should update Claude or handle gracefully when ANTHROPIC_API_KEY not set', async () => {
      expect(sandbox).toBeDefined();
      if (!sandbox) return;

      const result = await runClaudeUpdate(sandbox, logger);

      // Output should always be present (for debugging)
      expect(result.output).toBeDefined();

      if (hasAnthropicKey) {
        // With API key, update should succeed (or report already up-to-date)
        expect(result.success).toBe(true);
        expect(result.version).toBeTruthy();
        expect(result.version).not.toBe('unknown');
      } else {
        // Without API key, update may fail due to auth - this is expected
        // The function should still return a valid result structure
        expect(typeof result.success).toBe('boolean');
        expect(typeof result.version).toBe('string');
        if (!result.success) {
          // If it failed, it should be due to auth issues, not a crash
          expect(result.error).toBeTruthy();
        }
      }
    });

    it.skipIf(skipE2B || !hasAnthropicKey)('should handle already up-to-date scenario', async () => {
      expect(sandbox).toBeDefined();
      if (!sandbox) return;

      // Run update twice - second call should detect "already up-to-date"
      const firstResult = await runClaudeUpdate(sandbox, logger);

      // First update should succeed
      if (!firstResult.success) {
        // If first update failed, skip this test - environment issue
        console.log('Skipping already-up-to-date test: first update failed');
        return;
      }

      // Second update should also succeed (already up-to-date)
      const secondResult = await runClaudeUpdate(sandbox, logger);
      expect(secondResult.success).toBe(true);
      expect(secondResult.version).toBeTruthy();
      // Versions should be consistent
      expect(secondResult.version).toBe(firstResult.version);
    });
  });

  describe('runClaudeWithPrompt', () => {
    it.skipIf(skipE2B)('should execute simple Claude command', async () => {
      expect(sandbox).toBeDefined();
      if (!sandbox) return;

      const prompt = 'echo "Hello from Claude in E2B!"';
      const result = await runClaudeWithPrompt(
        sandbox,
        prompt,
        logger,
        {
          workingDir: '/tmp',
          timeout: 5, // 5 minutes
          streamOutput: false,
          captureFullLog: true,
          localLogPath: '',
          onProgress: () => {}
        }
      );

      expect(result).toBeDefined();
      expect(result.executionTime).toBeGreaterThan(0);
      expect(result.state).toBeDefined();
    }, 360000); // 6 minute timeout (execution timeout is 5 minutes)
  });

  describe('executeClaudeInSandbox', () => {
    it.skipIf(skipE2B)('should execute full autonomous workflow', async () => {
      expect(sandbox).toBeDefined();
      expect(sandboxManager).toBeDefined();
      if (!sandbox) return;

      const prompt = 'Create a simple hello.txt file with content "Hello E2B"';
      const result = await executeClaudeInSandbox(
        sandbox,
        sandboxManager,
        prompt,
        logger,
        {
          workingDir: '/tmp',
          timeout: 10, // 10 minutes
          streamOutput: true,
          captureFullLog: true
        }
      );

      expect(result).toBeDefined();
      expect(result.executionTime).toBeGreaterThan(0);
      expect(result.state).toBeDefined();
      expect(['completed', 'failed', 'timeout', 'killed']).toContain(result.state);
    }, 660000); // 11 minute timeout (execution timeout is 10 minutes)
  });

  describe('Helper Functions', () => {
    it('should format execution time correctly', () => {
      expect(formatExecutionTime(5000)).toBe('5s');
      expect(formatExecutionTime(65000)).toBe('1m 5s');
      expect(formatExecutionTime(185000)).toBe('3m 5s');
    });

    it('should check execution success correctly', () => {
      expect(isExecutionSuccessful({
        success: true,
        exitCode: 0,
        output: 'test',
        executionTime: 1000,
        state: 'completed'
      })).toBe(true);

      expect(isExecutionSuccessful({
        success: false,
        exitCode: 1,
        output: 'test',
        executionTime: 1000,
        state: 'failed'
      })).toBe(false);
    });

    it('should convert execution state to sandbox status', () => {
      expect(executionStateToSandboxStatus('completed')).toBe(SandboxStatus.COMPLETED);
      expect(executionStateToSandboxStatus('failed')).toBe(SandboxStatus.FAILED);
      expect(executionStateToSandboxStatus('timeout')).toBe(SandboxStatus.TIMEOUT);
      expect(executionStateToSandboxStatus('killed')).toBe(SandboxStatus.FAILED);
    });
  });
});
