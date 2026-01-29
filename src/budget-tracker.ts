/**
 * Budget tracking and enforcement for parallel-cc
 *
 * Manages cost tracking by period, budget limits, and spending reports.
 */

import type { SessionDB } from './db.js';
import type { ConfigManager } from './config.js';
import type {
  BudgetPeriod,
  BudgetTracking,
  BudgetStatus
} from './types.js';

/**
 * Result of a budget check
 */
export interface BudgetCheckResult {
  allowed: boolean;
  currentSpent: number;
  estimatedCost: number;
  remaining?: number;
  limit?: number;
  message?: string;
}

/**
 * Budget warning when threshold is reached
 */
export interface BudgetThresholdWarning {
  threshold: number;
  percentUsed: number;
  currentSpent: number;
  limit: number;
  message: string;
}

/**
 * Result of session budget validation
 */
export interface SessionBudgetValidation {
  valid: boolean;
  message?: string;
  warning?: string;
}

/**
 * BudgetTracker - Manages budget tracking and enforcement
 *
 * Features:
 * - Period-based spending tracking (daily, weekly, monthly)
 * - Budget limit enforcement with configurable thresholds
 * - Session cost recording
 * - Budget status reports
 */
export class BudgetTracker {
  private db: SessionDB;
  private configManager: ConfigManager;
  private warningsIssued: Set<number> = new Set();

  constructor(db: SessionDB, configManager: ConfigManager) {
    this.db = db;
    this.configManager = configManager;
  }

  /**
   * Calculate the start date for a given period
   *
   * @param period - Budget period type
   * @param date - Reference date (default: now)
   * @returns ISO date string (YYYY-MM-DD)
   */
  getPeriodStart(period: BudgetPeriod, date: Date = new Date()): string {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const day = date.getUTCDate();

    switch (period) {
      case 'daily':
        return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

      case 'weekly': {
        // Get Monday of the current week
        const dayOfWeek = date.getUTCDay();
        const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const monday = new Date(date);
        monday.setUTCDate(day - daysFromMonday);
        return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(monday.getUTCDate()).padStart(2, '0')}`;
      }

      case 'monthly':
        return `${year}-${String(month + 1).padStart(2, '0')}-01`;

      default:
        throw new Error(`Unknown budget period: ${period}`);
    }
  }

  /**
   * Get or create a budget tracking record for the current period
   *
   * @param period - Budget period type
   * @returns Budget tracking record
   */
  getOrCreatePeriodRecord(period: BudgetPeriod): BudgetTracking {
    const periodStart = this.getPeriodStart(period);
    const budgetConfig = this.configManager.getBudgetConfig();

    // Get budget limit for this period type
    let budgetLimit: number | undefined;
    if (period === 'monthly' && budgetConfig.monthlyLimit !== undefined) {
      budgetLimit = budgetConfig.monthlyLimit;
    }

    return this.db.getOrCreateBudgetTrackingRecord(period, periodStart, budgetLimit);
  }

  /**
   * Record a cost to a period
   *
   * @param cost - Cost in USD
   * @param period - Budget period type (default: monthly)
   */
  recordCost(cost: number, period: BudgetPeriod = 'monthly'): void {
    if (cost < 0) {
      throw new Error('Cost must be a non-negative number');
    }

    if (cost === 0) {
      return;
    }

    const record = this.getOrCreatePeriodRecord(period);
    this.db.updateBudgetSpent(record.id, cost);
  }

  /**
   * Record cost for a specific session
   *
   * Updates both the session's cost_estimate and the monthly budget tracking.
   *
   * @param sessionId - Session ID
   * @param cost - Cost in USD
   */
  recordSessionCost(sessionId: string, cost: number): void {
    // Update session cost estimate
    this.db.updateSessionCost(sessionId, cost);

    // Update monthly tracking
    this.recordCost(cost, 'monthly');
  }

  /**
   * Check if adding a cost would exceed the monthly budget
   *
   * @param estimatedCost - Estimated cost to add
   * @returns Budget check result
   */
  checkMonthlyBudget(estimatedCost: number): BudgetCheckResult {
    const budgetConfig = this.configManager.getBudgetConfig();
    const monthlyLimit = budgetConfig.monthlyLimit;

    const currentSpent = this.getCurrentSpending('monthly');

    // No limit configured
    if (monthlyLimit === undefined || monthlyLimit === null) {
      return {
        allowed: true,
        currentSpent,
        estimatedCost
      };
    }

    const remaining = monthlyLimit - currentSpent;
    const wouldExceed = currentSpent + estimatedCost > monthlyLimit;

    return {
      allowed: !wouldExceed,
      currentSpent,
      estimatedCost,
      remaining,
      limit: monthlyLimit,
      message: wouldExceed
        ? `Adding $${estimatedCost.toFixed(2)} would exceed monthly budget. ` +
          `Current: $${currentSpent.toFixed(2)}, Limit: $${monthlyLimit.toFixed(2)}, ` +
          `Remaining: $${remaining.toFixed(2)}`
        : undefined
    };
  }

  /**
   * Get current spending for a period
   *
   * @param period - Budget period type
   * @returns Current spending amount
   */
  getCurrentSpending(period: BudgetPeriod): number {
    const record = this.getOrCreatePeriodRecord(period);
    return record.spent;
  }

  /**
   * Generate a budget status report
   *
   * @param period - Budget period type (default: monthly)
   * @returns Budget status report
   */
  generateBudgetStatus(period: BudgetPeriod = 'monthly'): BudgetStatus {
    const periodRecord = this.getOrCreatePeriodRecord(period);
    const budgetConfig = this.configManager.getBudgetConfig();

    // Get E2B sessions with full data (including cost fields)
    const e2bSessions = this.db.listE2BSessions();

    // Build session info - get full session data to include cost fields
    const sessions = e2bSessions.map(e2bSession => {
      // Get full session data which includes cost fields
      const fullSession = this.db.getSessionById(e2bSession.id);
      return {
        sessionId: e2bSession.id,
        sandboxId: e2bSession.sandbox_id,
        budgetLimit: fullSession?.budget_limit ?? undefined,
        costEstimate: fullSession?.cost_estimate ?? undefined,
        status: e2bSession.status ?? undefined,
        createdAt: e2bSession.created_at
      };
    });

    // Calculate totals
    const totalSpent = periodRecord.spent;
    const limit = period === 'monthly' ? budgetConfig.monthlyLimit : undefined;
    const remaining = limit !== undefined ? limit - totalSpent : undefined;

    return {
      currentPeriod: {
        period,
        start: periodRecord.periodStart,
        limit,
        spent: totalSpent,
        remaining
      },
      sessions,
      totalSpent,
      remainingBudget: remaining
    };
  }

  /**
   * Get warning thresholds from config
   *
   * @returns Array of threshold percentages (e.g., [0.5, 0.8])
   */
  getWarningThresholds(): number[] {
    const budgetConfig = this.configManager.getBudgetConfig();
    return budgetConfig.warningThresholds ?? [0.5, 0.8];
  }

  /**
   * Check if any warning thresholds have been crossed
   *
   * @returns Warning info if threshold crossed, null otherwise
   */
  checkWarningThresholds(): BudgetThresholdWarning | null {
    const budgetConfig = this.configManager.getBudgetConfig();
    const monthlyLimit = budgetConfig.monthlyLimit;

    // No limit means no warnings
    if (monthlyLimit === undefined || monthlyLimit === null || monthlyLimit === 0) {
      return null;
    }

    const currentSpent = this.getCurrentSpending('monthly');
    const percentUsed = currentSpent / monthlyLimit;
    const thresholds = this.getWarningThresholds().sort((a, b) => b - a); // Sort descending

    // Find the highest threshold that has been crossed but not yet warned about
    for (const threshold of thresholds) {
      if (percentUsed >= threshold && !this.warningsIssued.has(threshold)) {
        this.warningsIssued.add(threshold);

        return {
          threshold,
          percentUsed,
          currentSpent,
          limit: monthlyLimit,
          message: `Budget warning: ${(percentUsed * 100).toFixed(0)}% of monthly limit used ` +
            `($${currentSpent.toFixed(2)} / $${monthlyLimit.toFixed(2)})`
        };
      }
    }

    return null;
  }

  /**
   * Get the default per-session budget from config
   *
   * @returns Per-session default or undefined if not configured
   */
  getPerSessionDefault(): number | undefined {
    const budgetConfig = this.configManager.getBudgetConfig();
    return budgetConfig.perSessionDefault;
  }

  /**
   * Validate a session budget amount
   *
   * @param budget - Proposed session budget
   * @returns Validation result
   */
  validateSessionBudget(budget: number): SessionBudgetValidation {
    if (budget < 0) {
      return {
        valid: false,
        message: 'Session budget must be a positive number'
      };
    }

    // Check if this would likely exceed the monthly budget
    const budgetConfig = this.configManager.getBudgetConfig();
    const monthlyLimit = budgetConfig.monthlyLimit;

    if (monthlyLimit !== undefined && monthlyLimit !== null) {
      const currentSpent = this.getCurrentSpending('monthly');
      const remaining = monthlyLimit - currentSpent;

      if (budget > remaining) {
        return {
          valid: true, // Still valid, but warn
          warning: `Session budget ($${budget.toFixed(2)}) would exceed remaining monthly budget ` +
            `($${remaining.toFixed(2)}). Total monthly limit: $${monthlyLimit.toFixed(2)}`
        };
      }
    }

    return { valid: true };
  }

  /**
   * Reset warning tracking (for new sessions)
   */
  resetWarnings(): void {
    this.warningsIssued.clear();
  }
}
