/**
 * Merge detection polling logic for parallel-cc v0.4
 *
 * Polls git repositories to detect when subscribed branches are merged
 * to target branches (main/master).
 */

import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { logger } from './logger.js';
import type { SessionDB } from './db.js';
import type {
  MergeEvent,
  MergeDetectionResult,
  BranchStatus,
  Subscription
} from './types.js';

export interface MergeDetectorConfig {
  pollIntervalSeconds?: number;
  maxParallelChecks?: number;
}

const DEFAULT_CONFIG: Required<MergeDetectorConfig> = {
  pollIntervalSeconds: 60, // Poll every 60 seconds
  maxParallelChecks: 10 // Limit concurrent git operations
};

export class MergeDetector {
  private db: SessionDB;
  private config: Required<MergeDetectorConfig>;
  private pollInterval: NodeJS.Timeout | null = null;
  private isPolling = false;

  constructor(db: SessionDB, config?: MergeDetectorConfig) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start polling for merged branches
   */
  startPolling(): void {
    if (this.pollInterval) {
      logger.warn('Polling is already running');
      return;
    }

    logger.info(`Starting merge detection polling (interval: ${this.config.pollIntervalSeconds}s)`);

    // Run immediately, then on interval
    this.pollForMerges().catch(err => {
      logger.error('Initial poll failed', err);
    });

    this.pollInterval = setInterval(() => {
      if (!this.isPolling) {
        this.pollForMerges().catch(err => {
          logger.error('Poll iteration failed', err);
        });
      }
    }, this.config.pollIntervalSeconds * 1000);
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      logger.info('Stopped merge detection polling');
    }
  }

  /**
   * Perform a single poll iteration
   * Checks all active subscriptions for merged branches
   */
  async pollForMerges(): Promise<MergeDetectionResult> {
    if (this.isPolling) {
      logger.warn('Poll already in progress, skipping');
      return {
        newMerges: [],
        notificationsSent: 0,
        subscriptionsChecked: 0,
        errors: []
      };
    }

    this.isPolling = true;
    const result: MergeDetectionResult = {
      newMerges: [],
      notificationsSent: 0,
      subscriptionsChecked: 0,
      errors: []
    };

    try {
      const subscriptions = this.db.getActiveSubscriptions();
      result.subscriptionsChecked = subscriptions.length;

      if (subscriptions.length === 0) {
        logger.debug('No active subscriptions to check');
        return result;
      }

      logger.debug(`Checking ${subscriptions.length} subscription(s) for merged branches`);

      // Group subscriptions by repo/branch/target for efficient checking
      const grouped = this.groupSubscriptions(subscriptions);

      for (const [key, subs] of grouped.entries()) {
        const [repoPath, branchName, targetBranch] = key.split('::');

        try {
          // Check if already detected
          const existingEvent = this.db.getMergeEvent(repoPath, branchName, targetBranch);
          if (existingEvent) {
            logger.debug(`Merge already detected: ${branchName} -> ${targetBranch} in ${repoPath}`);
            continue;
          }

          // Check if branch is merged
          const isMerged = this.checkIfBranchMerged(repoPath, branchName, targetBranch);

          if (isMerged) {
            logger.info(`Detected merge: ${branchName} -> ${targetBranch} in ${repoPath}`);

            // Get commit information
            const branchStatus = this.getBranchStatus(repoPath, branchName);
            const targetCommit = this.getCurrentCommit(repoPath, targetBranch);

            if (!branchStatus || !targetCommit) {
              result.errors.push(`Failed to get commit info for ${branchName} in ${repoPath}`);
              continue;
            }

            // Create merge event
            const mergeEvent: Omit<MergeEvent, 'merged_at' | 'detected_at'> = {
              id: randomUUID(),
              repo_path: repoPath,
              branch_name: branchName,
              source_commit: branchStatus.commit,
              target_branch: targetBranch,
              target_commit: targetCommit,
              notification_sent: false
            };

            const createdEvent = this.db.createMergeEvent(mergeEvent);
            result.newMerges.push(createdEvent);

            // Mark subscriptions as notified
            const notified = this.db.markSubscriptionsNotified(repoPath, branchName, targetBranch);
            result.notificationsSent += notified;

            logger.info(`Created merge event ${createdEvent.id}, notified ${notified} subscription(s)`);
          }
        } catch (error) {
          const errMsg = `Failed to check ${branchName} -> ${targetBranch} in ${repoPath}: ${error}`;
          logger.error(errMsg, error);
          result.errors.push(errMsg);
        }
      }

      if (result.newMerges.length > 0) {
        logger.info(`Poll completed: ${result.newMerges.length} new merge(s), ${result.notificationsSent} notification(s)`);
      } else {
        logger.debug(`Poll completed: no new merges detected`);
      }

    } catch (error) {
      const errMsg = `Poll iteration failed: ${error}`;
      logger.error(errMsg, error);
      result.errors.push(errMsg);
    } finally {
      this.isPolling = false;
    }

    return result;
  }

  /**
   * Check if a branch has been merged into target branch
   * Returns true if the branch is fully merged
   */
  checkIfBranchMerged(repoPath: string, branchName: string, targetBranch = 'main'): boolean {
    try {
      if (!existsSync(repoPath)) {
        logger.warn(`Repository path does not exist: ${repoPath}`);
        return false;
      }

      // Use git merge-base and git rev-parse to check if branch is merged
      // A branch is merged if: merge-base(branch, target) == rev-parse(branch)
      const mergeBase = execSync(
        `git merge-base "${targetBranch}" "${branchName}"`,
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      const branchCommit = execSync(
        `git rev-parse "${branchName}"`,
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      // Branch is fully merged if merge-base equals branch commit
      const isMerged = mergeBase === branchCommit;

      // Additional check: ensure merge-base is in target branch history
      if (isMerged) {
        try {
          execSync(
            `git merge-base --is-ancestor "${branchCommit}" "${targetBranch}"`,
            { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] }
          );
          return true;
        } catch {
          // If ancestor check fails, branch is not fully merged
          return false;
        }
      }

      return false;
    } catch (error) {
      // If git commands fail (e.g., branch doesn't exist, not a git repo), return false
      logger.debug(`Failed to check merge status for ${branchName} in ${repoPath}: ${error}`);
      return false;
    }
  }

  /**
   * Get detailed status information for a branch
   */
  getBranchStatus(repoPath: string, branchName: string): BranchStatus | null {
    try {
      if (!existsSync(repoPath)) {
        return null;
      }

      // Get branch commit
      const commit = execSync(
        `git rev-parse "${branchName}"`,
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      // Get upstream branch (if exists)
      let upstreamBranch: string | null = null;
      try {
        upstreamBranch = execSync(
          `git rev-parse --abbrev-ref "${branchName}@{upstream}"`,
          { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
      } catch {
        // No upstream configured
      }

      // Check if merged to main
      let isMerged = false;
      try {
        execSync(
          `git merge-base --is-ancestor "${commit}" main`,
          { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        isMerged = true;
      } catch {
        // Try master if main doesn't exist
        try {
          execSync(
            `git merge-base --is-ancestor "${commit}" master`,
            { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] }
          );
          isMerged = true;
        } catch {
          isMerged = false;
        }
      }

      // Get ahead/behind counts (relative to main/master)
      let behindBy = 0;
      let aheadBy = 0;
      const targetBranch = this.getDefaultBranch(repoPath);

      if (targetBranch) {
        try {
          const counts = execSync(
            `git rev-list --left-right --count "${branchName}...${targetBranch}"`,
            { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
          ).trim();

          const [ahead, behind] = counts.split(/\s+/).map(Number);
          aheadBy = ahead || 0;
          behindBy = behind || 0;
        } catch {
          // Could not determine ahead/behind
        }
      }

      return {
        name: branchName,
        commit,
        upstreamBranch,
        isMerged,
        behindBy,
        aheadBy
      };
    } catch (error) {
      logger.debug(`Failed to get branch status for ${branchName} in ${repoPath}: ${error}`);
      return null;
    }
  }

  /**
   * Get the current commit hash for a branch
   */
  private getCurrentCommit(repoPath: string, branchName: string): string | null {
    try {
      const commit = execSync(
        `git rev-parse "${branchName}"`,
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      return commit;
    } catch (error) {
      logger.debug(`Failed to get commit for ${branchName} in ${repoPath}: ${error}`);
      return null;
    }
  }

  /**
   * Get the default branch for a repository (main or master)
   */
  private getDefaultBranch(repoPath: string): string | null {
    try {
      // Try to get symbolic ref for HEAD
      const defaultBranch = execSync(
        'git symbolic-ref refs/remotes/origin/HEAD',
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim().replace('refs/remotes/origin/', '');
      return defaultBranch;
    } catch {
      // Fallback to checking if main or master exists
      try {
        execSync('git rev-parse --verify main', { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
        return 'main';
      } catch {
        try {
          execSync('git rev-parse --verify master', { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] });
          return 'master';
        } catch {
          return null;
        }
      }
    }
  }

  /**
   * Group subscriptions by repo/branch/target for efficient checking
   * Key format: "repoPath::branchName::targetBranch"
   */
  private groupSubscriptions(subscriptions: Subscription[]): Map<string, Subscription[]> {
    const grouped = new Map<string, Subscription[]>();

    for (const sub of subscriptions) {
      const key = `${sub.repo_path}::${sub.branch_name}::${sub.target_branch}`;
      const existing = grouped.get(key) || [];
      existing.push(sub);
      grouped.set(key, existing);
    }

    return grouped;
  }

  /**
   * Get detector configuration
   */
  getConfig(): Required<MergeDetectorConfig> {
    return { ...this.config };
  }

  /**
   * Check if detector is currently polling
   */
  isActivelyPolling(): boolean {
    return this.pollInterval !== null;
  }
}
