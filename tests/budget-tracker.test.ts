/**
 * Tests for BudgetTracker class
 *
 * TDD: These tests define the expected behavior of the BudgetTracker
 * before implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionDB } from '../src/db.js';
import { BudgetTracker } from '../src/budget-tracker.js';
import { ConfigManager } from '../src/config.js';
import type { BudgetPeriod } from '../src/types.js';

// Test fixtures directory - unique per process to avoid conflicts
const TEST_DIR = path.join(os.tmpdir(), 'parallel-cc-budget-test-' + process.pid);
const TEST_DB_PATH = path.join(TEST_DIR, 'test.db');
const TEST_CONFIG_PATH = path.join(TEST_DIR, 'config.json');

describe('BudgetTracker', () => {
  let db: SessionDB;
  let configManager: ConfigManager;
  let tracker: BudgetTracker;

  beforeEach(async () => {
    // Create test directory
    fs.mkdirSync(TEST_DIR, { recursive: true });
    db = new SessionDB(TEST_DB_PATH);

    // Run migrations to get budget_tracking table
    await db.migrateToLatest();

    configManager = new ConfigManager(TEST_CONFIG_PATH);
    tracker = new BudgetTracker(db, configManager);
  });

  afterEach(() => {
    // Cancel any pending debounced writes to avoid race conditions with directory cleanup
    configManager.cancelPendingWrites();
    // Close database and clean up
    db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ==========================================================================
  // Period Calculation Tests
  // ==========================================================================

  describe('getPeriodStart', () => {
    it('should calculate correct daily period start', () => {
      const now = new Date('2025-01-15T14:30:00Z');
      const start = tracker.getPeriodStart('daily', now);

      expect(start).toBe('2025-01-15');
    });

    it('should calculate correct weekly period start (Monday)', () => {
      const wednesday = new Date('2025-01-15T14:30:00Z'); // Wednesday
      const start = tracker.getPeriodStart('weekly', wednesday);

      // Monday of that week
      expect(start).toBe('2025-01-13');
    });

    it('should calculate correct monthly period start', () => {
      const midMonth = new Date('2025-01-15T14:30:00Z');
      const start = tracker.getPeriodStart('monthly', midMonth);

      expect(start).toBe('2025-01-01');
    });

    it('should handle month boundaries correctly', () => {
      const lastDayOfMonth = new Date('2025-01-31T23:59:59Z');
      const start = tracker.getPeriodStart('monthly', lastDayOfMonth);

      expect(start).toBe('2025-01-01');
    });
  });

  // ==========================================================================
  // Budget Tracking Record Tests
  // ==========================================================================

  describe('getOrCreatePeriodRecord', () => {
    it('should create new period record if none exists', () => {
      const record = tracker.getOrCreatePeriodRecord('monthly');

      expect(record).toBeDefined();
      expect(record.period).toBe('monthly');
      expect(record.spent).toBe(0);
    });

    it('should return existing period record', () => {
      const record1 = tracker.getOrCreatePeriodRecord('monthly');
      record1.spent = 5.00;

      // Update spent in the record
      tracker.recordCost(5.00, 'monthly');

      const record2 = tracker.getOrCreatePeriodRecord('monthly');

      expect(record2.id).toBe(record1.id);
      expect(record2.spent).toBe(5.00);
    });

    it('should create separate records for different periods', () => {
      const daily = tracker.getOrCreatePeriodRecord('daily');
      const monthly = tracker.getOrCreatePeriodRecord('monthly');

      expect(daily.id).not.toBe(monthly.id);
      expect(daily.period).toBe('daily');
      expect(monthly.period).toBe('monthly');
    });
  });

  // ==========================================================================
  // Recording Costs Tests
  // ==========================================================================

  describe('recordCost', () => {
    it('should record cost to current period', () => {
      tracker.recordCost(0.50, 'monthly');

      const record = tracker.getOrCreatePeriodRecord('monthly');
      expect(record.spent).toBe(0.50);
    });

    it('should accumulate costs', () => {
      tracker.recordCost(0.25, 'monthly');
      tracker.recordCost(0.35, 'monthly');
      tracker.recordCost(0.40, 'monthly');

      const record = tracker.getOrCreatePeriodRecord('monthly');
      expect(record.spent).toBeCloseTo(1.00, 2);
    });

    it('should track costs separately per period type', () => {
      tracker.recordCost(1.00, 'daily');
      tracker.recordCost(5.00, 'monthly');

      const daily = tracker.getOrCreatePeriodRecord('daily');
      const monthly = tracker.getOrCreatePeriodRecord('monthly');

      expect(daily.spent).toBe(1.00);
      expect(monthly.spent).toBe(5.00);
    });

    it('should throw on negative cost', () => {
      expect(() => tracker.recordCost(-0.50, 'monthly'))
        .toThrow('Cost must be a non-negative number');
    });

    it('should allow zero cost (no-op)', () => {
      expect(() => tracker.recordCost(0, 'monthly')).not.toThrow();

      const record = tracker.getOrCreatePeriodRecord('monthly');
      expect(record.spent).toBe(0);
    });
  });

  // ==========================================================================
  // recordSessionCost Tests
  // ==========================================================================

  describe('recordSessionCost', () => {
    it('should update session cost estimate', async () => {
      // Create a test E2B session first
      const session = db.createE2BSession({
        id: 'test-session-1',
        pid: 12345,
        repo_path: '/test/repo',
        worktree_path: '/test/worktree',
        worktree_name: 'test-branch',
        sandbox_id: 'sandbox-123',
        prompt: 'Test prompt'
      });

      tracker.recordSessionCost(session.id, 0.75);

      const updated = db.getSessionById(session.id);
      expect(updated?.cost_estimate).toBe(0.75);
    });

    it('should update both session and period tracking', async () => {
      const session = db.createE2BSession({
        id: 'test-session-2',
        pid: 12346,
        repo_path: '/test/repo',
        worktree_path: '/test/worktree',
        worktree_name: 'test-branch',
        sandbox_id: 'sandbox-456',
        prompt: 'Test prompt'
      });

      tracker.recordSessionCost(session.id, 1.25);

      const updated = db.getSessionById(session.id);
      expect(updated?.cost_estimate).toBe(1.25);

      const monthlyRecord = tracker.getOrCreatePeriodRecord('monthly');
      expect(monthlyRecord.spent).toBe(1.25);
    });
  });

  // ==========================================================================
  // Budget Check Tests
  // ==========================================================================

  describe('checkMonthlyBudget', () => {
    it('should return true when no monthly limit set', () => {
      const result = tracker.checkMonthlyBudget(10.00);
      expect(result.allowed).toBe(true);
    });

    it('should return true when under budget', () => {
      configManager.setBudgetConfig({ monthlyLimit: 10.00 });

      const result = tracker.checkMonthlyBudget(0.50);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(10.00);
    });

    it('should return false when would exceed budget', () => {
      configManager.setBudgetConfig({ monthlyLimit: 1.00 });

      // Already spent 0.75
      tracker.recordCost(0.75, 'monthly');

      // Trying to spend 0.50 more would exceed
      const result = tracker.checkMonthlyBudget(0.50);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0.25);
      expect(result.message).toContain('exceed');
    });

    it('should return true when exactly at limit', () => {
      configManager.setBudgetConfig({ monthlyLimit: 1.00 });
      tracker.recordCost(0.75, 'monthly');

      // Spending exactly to the limit
      const result = tracker.checkMonthlyBudget(0.25);
      expect(result.allowed).toBe(true);
    });

    it('should include spending details in result', () => {
      configManager.setBudgetConfig({ monthlyLimit: 10.00 });
      tracker.recordCost(3.00, 'monthly');

      const result = tracker.checkMonthlyBudget(2.00);

      expect(result.currentSpent).toBe(3.00);
      expect(result.estimatedCost).toBe(2.00);
      expect(result.remaining).toBe(7.00);
      expect(result.limit).toBe(10.00);
    });
  });

  // ==========================================================================
  // Budget Status Report Tests
  // ==========================================================================

  describe('generateBudgetStatus', () => {
    it('should generate status report with no sessions', () => {
      const status = tracker.generateBudgetStatus('monthly');

      expect(status.currentPeriod.period).toBe('monthly');
      expect(status.currentPeriod.spent).toBe(0);
      expect(status.sessions).toEqual([]);
      expect(status.totalSpent).toBe(0);
    });

    it('should include active E2B sessions', async () => {
      db.createE2BSession({
        id: 'session-1',
        pid: 12345,
        repo_path: '/test/repo',
        worktree_path: '/test/worktree',
        worktree_name: null,
        sandbox_id: 'sandbox-1',
        prompt: 'Task 1'
      });

      db.createE2BSession({
        id: 'session-2',
        pid: 12346,
        repo_path: '/test/repo',
        worktree_path: '/test/worktree2',
        worktree_name: null,
        sandbox_id: 'sandbox-2',
        prompt: 'Task 2'
      });

      const status = tracker.generateBudgetStatus('monthly');

      expect(status.sessions).toHaveLength(2);
      expect(status.sessions[0].sessionId).toBeDefined();
      expect(status.sessions[0].sandboxId).toBeDefined();
    });

    it('should include budget limit from config', () => {
      configManager.setBudgetConfig({ monthlyLimit: 25.00 });

      const status = tracker.generateBudgetStatus('monthly');

      expect(status.currentPeriod.limit).toBe(25.00);
      expect(status.remainingBudget).toBe(25.00);
    });

    it('should calculate remaining budget correctly', () => {
      configManager.setBudgetConfig({ monthlyLimit: 10.00 });
      tracker.recordCost(3.50, 'monthly');

      const status = tracker.generateBudgetStatus('monthly');

      expect(status.currentPeriod.spent).toBe(3.50);
      expect(status.currentPeriod.remaining).toBe(6.50);
      expect(status.totalSpent).toBe(3.50);
      expect(status.remainingBudget).toBe(6.50);
    });

    it('should include session cost estimates', async () => {
      const session = db.createE2BSession({
        id: 'session-cost',
        pid: 12347,
        repo_path: '/test/repo',
        worktree_path: '/test/worktree',
        worktree_name: null,
        sandbox_id: 'sandbox-cost',
        prompt: 'Cost test'
      });

      tracker.recordSessionCost(session.id, 0.75);

      const status = tracker.generateBudgetStatus('monthly');

      const sessionInfo = status.sessions.find(s => s.sessionId === session.id);
      expect(sessionInfo?.costEstimate).toBe(0.75);
    });
  });

  // ==========================================================================
  // getCurrentSpending Tests
  // ==========================================================================

  describe('getCurrentSpending', () => {
    it('should return 0 for fresh tracker', () => {
      expect(tracker.getCurrentSpending('monthly')).toBe(0);
      expect(tracker.getCurrentSpending('daily')).toBe(0);
    });

    it('should return accumulated spending', () => {
      tracker.recordCost(1.00, 'monthly');
      tracker.recordCost(2.00, 'monthly');

      expect(tracker.getCurrentSpending('monthly')).toBe(3.00);
    });

    it('should track different periods independently', () => {
      tracker.recordCost(1.00, 'daily');
      tracker.recordCost(5.00, 'monthly');

      expect(tracker.getCurrentSpending('daily')).toBe(1.00);
      expect(tracker.getCurrentSpending('monthly')).toBe(5.00);
    });
  });

  // ==========================================================================
  // Warning Threshold Tests
  // ==========================================================================

  describe('getWarningThresholds', () => {
    it('should return default thresholds', () => {
      const thresholds = tracker.getWarningThresholds();
      expect(thresholds).toEqual([0.5, 0.8]);
    });

    it('should return custom thresholds from config', () => {
      configManager.setBudgetConfig({ warningThresholds: [0.25, 0.5, 0.75] });

      const thresholds = tracker.getWarningThresholds();
      expect(thresholds).toEqual([0.25, 0.5, 0.75]);
    });
  });

  describe('checkWarningThresholds', () => {
    beforeEach(() => {
      configManager.setBudgetConfig({ monthlyLimit: 10.00 });
    });

    it('should return null when under first threshold', () => {
      tracker.recordCost(2.00, 'monthly'); // 20%

      const warning = tracker.checkWarningThresholds();
      expect(warning).toBeNull();
    });

    it('should return 50% warning when crossed', () => {
      tracker.recordCost(5.50, 'monthly'); // 55%

      const warning = tracker.checkWarningThresholds();
      expect(warning).toBeDefined();
      expect(warning?.threshold).toBe(0.5);
      expect(warning?.percentUsed).toBeCloseTo(0.55, 2);
    });

    it('should return 80% warning when crossed', () => {
      tracker.recordCost(8.50, 'monthly'); // 85%

      const warning = tracker.checkWarningThresholds();
      expect(warning).toBeDefined();
      expect(warning?.threshold).toBe(0.8);
    });

    it('should return null when no monthly limit set', () => {
      configManager.setBudgetConfig({ monthlyLimit: undefined });
      tracker.recordCost(100.00, 'monthly');

      const warning = tracker.checkWarningThresholds();
      expect(warning).toBeNull();
    });
  });

  // ==========================================================================
  // Per-Session Budget Tests
  // ==========================================================================

  describe('getPerSessionDefault', () => {
    it('should return undefined when not configured', () => {
      const defaultBudget = tracker.getPerSessionDefault();
      expect(defaultBudget).toBeUndefined();
    });

    it('should return configured per-session default', () => {
      configManager.setBudgetConfig({ perSessionDefault: 2.50 });

      const defaultBudget = tracker.getPerSessionDefault();
      expect(defaultBudget).toBe(2.50);
    });
  });

  describe('validateSessionBudget', () => {
    it('should accept any budget when no limits configured', () => {
      const result = tracker.validateSessionBudget(100.00);
      expect(result.valid).toBe(true);
    });

    it('should reject negative budget', () => {
      const result = tracker.validateSessionBudget(-5.00);
      expect(result.valid).toBe(false);
      expect(result.message).toContain('positive');
    });

    it('should warn when session budget exceeds remaining monthly budget', () => {
      configManager.setBudgetConfig({ monthlyLimit: 10.00 });
      tracker.recordCost(8.00, 'monthly');

      const result = tracker.validateSessionBudget(5.00); // Would exceed
      expect(result.valid).toBe(true); // Still valid, but...
      expect(result.warning).toContain('exceed');
    });
  });
});
