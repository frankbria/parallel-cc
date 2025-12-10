/**
 * Integration test for Claude Runner
 *
 * Note: These tests require E2B API key and actual sandbox creation
 * Run with: E2B_API_KEY=xxx npm test -- tests/e2b/claude-runner-integration.test.ts
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

// Skip tests if E2B API key not provided
const skipE2B = !process.env.E2B_API_KEY;

describe('Claude Runner Integration Tests', () => {
  let logger: Logger;
  let sandboxManager: SandboxManager;
  let sandbox: Sandbox | null = null;
  let sandboxId: string | null = null;

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
    it.skipIf(skipE2B)('should update Claude to latest version', async () => {
      expect(sandbox).toBeDefined();
      if (!sandbox) return;

      const result = await runClaudeUpdate(sandbox, logger);

      expect(result.success).toBe(true);
      expect(result.version).toBeTruthy();
      expect(result.output).toBeTruthy();
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
    }, 60000); // 60 second timeout
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
    }, 120000); // 2 minute timeout
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
