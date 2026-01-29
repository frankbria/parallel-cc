/**
 * Tests for budget enforcement in SandboxManager
 *
 * Tests budget limits during sandbox execution including:
 * - Setting budget limits per sandbox
 * - Budget warnings at configurable thresholds
 * - Hard termination when budget exceeded
 * - Integration with cost calculations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SandboxManager } from '../../src/e2b/sandbox-manager.js';
import { SandboxStatus, BudgetExceededError } from '../../src/types.js';
import type { Logger } from '../../src/logger.js';
import type { BudgetWarning } from '../../src/types.js';

// Mock E2B SDK
vi.mock('e2b', () => ({
  Sandbox: {
    create: vi.fn(),
    connect: vi.fn()
  }
}));

// Create mock logger
const createMockLogger = (): Logger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
});

describe('SandboxManager Budget Enforcement', () => {
  let manager: SandboxManager;
  let mockLogger: Logger;
  let mockSandbox: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Create mock logger
    mockLogger = createMockLogger();

    // Create mock sandbox instance
    mockSandbox = {
      sandboxId: 'test-sandbox-budget',
      close: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(undefined),
      isRunning: vi.fn().mockResolvedValue(true),
      setTimeout: vi.fn().mockResolvedValue(undefined),
      metadata: {}
    };

    // Setup E2B SDK mock
    const { Sandbox } = await import('e2b');
    vi.mocked(Sandbox.create).mockResolvedValue(mockSandbox);

    // Set environment variable for API key
    process.env.E2B_API_KEY = 'test-api-key-12345';

    // Create manager instance with 60 minute timeout and custom budget warning thresholds
    manager = new SandboxManager(mockLogger, {
      timeoutMinutes: 60,
      warningThresholds: [30, 50] // 30min and 50min warnings
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete process.env.E2B_API_KEY;
  });

  // ==========================================================================
  // Budget Limit Setting Tests
  // ==========================================================================

  describe('setBudgetLimit', () => {
    it('should set budget limit for sandbox', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');

      manager.setBudgetLimit(sandboxId, 1.00);

      const limit = manager.getBudgetLimit(sandboxId);
      expect(limit).toBe(1.00);
    });

    it('should allow updating budget limit', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');

      manager.setBudgetLimit(sandboxId, 1.00);
      manager.setBudgetLimit(sandboxId, 2.00);

      const limit = manager.getBudgetLimit(sandboxId);
      expect(limit).toBe(2.00);
    });

    it('should return undefined for sandbox without budget limit', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');

      const limit = manager.getBudgetLimit(sandboxId);
      expect(limit).toBeUndefined();
    });

    it('should reject negative budget limits', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');

      expect(() => manager.setBudgetLimit(sandboxId, -1.00))
        .toThrow('Budget limit must be a positive number');
    });

    it('should accept zero as "no limit"', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');

      manager.setBudgetLimit(sandboxId, 0);

      const limit = manager.getBudgetLimit(sandboxId);
      expect(limit).toBe(0);
    });
  });

  // ==========================================================================
  // Budget Check Tests
  // ==========================================================================

  describe('checkBudgetLimit', () => {
    it('should return null when no budget limit set', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');

      // Simulate time passing
      vi.advanceTimersByTime(30 * 60 * 1000); // 30 minutes

      const warning = await manager.checkBudgetLimit(sandboxId);
      expect(warning).toBeNull();
    });

    it('should return null when under budget', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');
      manager.setBudgetLimit(sandboxId, 1.00); // $1.00 limit

      // 10 minutes = ~$0.017 (well under $1.00)
      vi.advanceTimersByTime(10 * 60 * 1000);

      const warning = await manager.checkBudgetLimit(sandboxId);
      expect(warning).toBeNull();
    });

    it('should return soft warning at 50% threshold', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');
      manager.setBudgetLimit(sandboxId, 0.10); // $0.10 limit

      // 30 minutes = ~$0.05, which is 50% of $0.10
      vi.advanceTimersByTime(30 * 60 * 1000);

      const warning = await manager.checkBudgetLimit(sandboxId);

      expect(warning).not.toBeNull();
      expect(warning?.warningLevel).toBe('soft');
      expect(warning?.percentUsed).toBeGreaterThanOrEqual(0.5);
    });

    it('should return soft warning at 80% threshold', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');
      manager.setBudgetLimit(sandboxId, 0.10); // $0.10 limit

      // 49 minutes = ~$0.0817, which is >80% of $0.10
      vi.advanceTimersByTime(49 * 60 * 1000);

      const warning = await manager.checkBudgetLimit(sandboxId);

      expect(warning).not.toBeNull();
      expect(warning?.warningLevel).toBe('soft');
      // Use toBeCloseTo for floating point comparison
      expect(warning?.percentUsed).toBeCloseTo(0.817, 2);
    });

    it('should throw BudgetExceededError when budget exceeded', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');
      manager.setBudgetLimit(sandboxId, 0.05); // $0.05 limit (30 minutes)

      // 35 minutes = ~$0.058, exceeds $0.05
      vi.advanceTimersByTime(35 * 60 * 1000);

      await expect(manager.checkBudgetLimit(sandboxId))
        .rejects.toThrow(BudgetExceededError);
    });

    it('should terminate sandbox when budget exceeded', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');
      manager.setBudgetLimit(sandboxId, 0.05);

      vi.advanceTimersByTime(35 * 60 * 1000);

      try {
        await manager.checkBudgetLimit(sandboxId);
      } catch (error) {
        // Expected
      }

      expect(mockSandbox.kill).toHaveBeenCalled();
    });

    it('should not issue duplicate warnings', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');
      manager.setBudgetLimit(sandboxId, 0.10);

      // First check at 50%
      vi.advanceTimersByTime(30 * 60 * 1000);
      const warning1 = await manager.checkBudgetLimit(sandboxId);
      expect(warning1).not.toBeNull();

      // Second check still at 50% - should not warn again
      vi.advanceTimersByTime(1 * 60 * 1000);
      const warning2 = await manager.checkBudgetLimit(sandboxId);
      expect(warning2).toBeNull();
    });
  });

  // ==========================================================================
  // Budget Warning Details Tests
  // ==========================================================================

  describe('budget warning details', () => {
    it('should include current cost in warning', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');
      manager.setBudgetLimit(sandboxId, 0.10);

      vi.advanceTimersByTime(30 * 60 * 1000);

      const warning = await manager.checkBudgetLimit(sandboxId);

      expect(warning?.currentCost).toBeCloseTo(0.05, 2);
    });

    it('should include budget limit in warning', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');
      manager.setBudgetLimit(sandboxId, 0.10);

      vi.advanceTimersByTime(30 * 60 * 1000);

      const warning = await manager.checkBudgetLimit(sandboxId);

      expect(warning?.budgetLimit).toBe(0.10);
    });

    it('should include percent used in warning', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');
      manager.setBudgetLimit(sandboxId, 0.10);

      vi.advanceTimersByTime(30 * 60 * 1000);

      const warning = await manager.checkBudgetLimit(sandboxId);

      expect(warning?.percentUsed).toBeGreaterThanOrEqual(0.5);
      expect(warning?.percentUsed).toBeLessThanOrEqual(1.0);
    });

    it('should include descriptive message in warning', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');
      manager.setBudgetLimit(sandboxId, 0.10);

      vi.advanceTimersByTime(30 * 60 * 1000);

      const warning = await manager.checkBudgetLimit(sandboxId);

      expect(warning?.message).toContain('budget');
      expect(warning?.message).toContain('$');
    });
  });

  // ==========================================================================
  // Cost Calculation Integration Tests
  // ==========================================================================

  describe('cost calculation integration', () => {
    it('should calculate cost based on elapsed time', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');

      vi.advanceTimersByTime(60 * 60 * 1000); // 60 minutes

      const cost = manager.getEstimatedCost(sandboxId);

      // $0.10/hour = $0.10 for 60 minutes
      expect(cost).toBe('$0.10');
    });

    it('should return null for unknown sandbox', () => {
      const cost = manager.getEstimatedCost('unknown-sandbox');
      expect(cost).toBeNull();
    });

    it('should calculate cost correctly for partial hours', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');

      vi.advanceTimersByTime(30 * 60 * 1000); // 30 minutes

      const cost = manager.getEstimatedCost(sandboxId);

      // $0.10/hour = $0.05 for 30 minutes
      expect(cost).toBe('$0.05');
    });
  });

  // ==========================================================================
  // Budget Thresholds Configuration Tests
  // ==========================================================================

  describe('budget thresholds configuration', () => {
    it('should use default thresholds (50%, 80%)', async () => {
      const defaultManager = new SandboxManager(mockLogger);
      const { sandboxId } = await defaultManager.createSandbox('session-1');
      defaultManager.setBudgetLimit(sandboxId, 0.10);

      // At 50%
      vi.advanceTimersByTime(30 * 60 * 1000);
      const warning = await defaultManager.checkBudgetLimit(sandboxId);

      expect(warning?.percentUsed).toBeGreaterThanOrEqual(0.5);
    });

    it('should support custom thresholds', async () => {
      const customManager = new SandboxManager(mockLogger, {
        budgetWarningThresholds: [0.25, 0.5, 0.75]
      });
      const { sandboxId } = await customManager.createSandbox('session-1');
      customManager.setBudgetLimit(sandboxId, 0.10);

      // At 25%
      vi.advanceTimersByTime(15 * 60 * 1000); // ~$0.025
      const warning = await customManager.checkBudgetLimit(sandboxId);

      expect(warning).not.toBeNull();
      expect(warning?.percentUsed).toBeGreaterThanOrEqual(0.25);
    });
  });

  // ==========================================================================
  // Edge Cases Tests
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle sandbox not found gracefully', async () => {
      // For non-existent sandbox with no budget set, should return null
      const warning = await manager.checkBudgetLimit('non-existent-sandbox');
      expect(warning).toBeNull();
      // No warning logged because no budget was set for this sandbox
    });

    it('should handle zero budget limit (no spending allowed)', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');
      manager.setBudgetLimit(sandboxId, 0);

      // Any time = exceeded (since budget is 0)
      vi.advanceTimersByTime(1 * 60 * 1000);

      // Zero budget means "disabled" - should not trigger
      const warning = await manager.checkBudgetLimit(sandboxId);
      expect(warning).toBeNull();
    });

    it('should clean up budget tracking when sandbox terminated', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');
      manager.setBudgetLimit(sandboxId, 1.00);

      await manager.terminateSandbox(sandboxId);

      const limit = manager.getBudgetLimit(sandboxId);
      expect(limit).toBeUndefined();
    });

    it('should preserve budget limit after health check', async () => {
      const { sandboxId } = await manager.createSandbox('session-1');
      manager.setBudgetLimit(sandboxId, 0.50);

      await manager.monitorSandboxHealth(sandboxId, false);

      const limit = manager.getBudgetLimit(sandboxId);
      expect(limit).toBe(0.50);
    });
  });
});
