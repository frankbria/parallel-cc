/**
 * Core coordinator logic - manages parallel Claude Code sessions
 */

import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { SessionDB } from './db.js';
import { GtrWrapper } from './gtr.js';
import { logger } from './logger.js';
import { FileClaimsManager } from './file-claims.js';
import type {
  RegisterResult,
  StatusResult,
  SessionInfo,
  CleanupResult,
  Config,
  MergeEvent,
  Subscription
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';

export class Coordinator {
  private db: SessionDB;
  private config: Config;
  private fileClaimsManager: FileClaimsManager;

  constructor(config: Partial<Config> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = new SessionDB(this.config.dbPath);
    this.fileClaimsManager = new FileClaimsManager(this.db, logger);
  }

  /**
   * Register a new session. Creates worktree if parallel session exists.
   */
  async register(repoPath: string, pid: number): Promise<RegisterResult> {
    // Validate inputs
    if (!repoPath || typeof repoPath !== 'string') {
      throw new Error('Invalid repository path');
    }
    if (!pid || pid <= 0 || pid > 2147483647) {
      throw new Error('Invalid process ID');
    }

    // Normalize repo path
    const normalizedRepo = this.normalizeRepoPath(repoPath);

    // Check for existing session with this PID (re-registration)
    const existing = this.db.getSessionByPid(pid);
    if (existing) {
      return {
        sessionId: existing.id,
        worktreePath: existing.worktree_path,
        worktreeName: existing.worktree_name,
        isNew: false,
        isMainRepo: existing.is_main_repo,
        parallelSessions: this.db.getSessionsByRepo(normalizedRepo).length
      };
    }

    // Clean up stale sessions first
    await this.cleanupStaleSessions();

    // CRITICAL: Use transaction to make check-then-create atomic
    // This prevents race condition where two sessions both think they're first
    return this.db.transaction(() => {
      // Check for parallel sessions in this repo (within transaction)
      const existingSessions = this.db.getSessionsByRepo(normalizedRepo)
        .filter(s => this.isProcessAlive(s.pid));

      const sessionId = randomUUID();
      let worktreePath = normalizedRepo;
      let worktreeName: string | null = null;
      let isMainRepo = true;

      if (existingSessions.length > 0) {
        // Parallel session exists - create a worktree
        const gtr = new GtrWrapper(normalizedRepo);
        worktreeName = GtrWrapper.generateWorktreeName(this.config.worktreePrefix);

        const result = gtr.createWorktree(worktreeName);
        if (result.success) {
          worktreePath = gtr.getWorktreePath(worktreeName) ?? normalizedRepo;
          isMainRepo = false;
          logger.info(`Created worktree: ${worktreeName} at ${worktreePath}`);
        } else {
          // Worktree creation failed - log but continue in main repo
          logger.error(`Could not create worktree: ${result.error}`);
          logger.warn('Continuing in main repo - be careful of conflicts!');
          console.error(`Warning: Could not create worktree: ${result.error}`);
          console.error('Continuing in main repo - be careful of conflicts!');
          worktreeName = null;
        }
      }

      // Create session record (within transaction)
      this.db.createSession({
        id: sessionId,
        pid,
        repo_path: normalizedRepo,
        worktree_path: worktreePath,
        worktree_name: worktreeName,
        is_main_repo: isMainRepo
      });

      return {
        sessionId,
        worktreePath,
        worktreeName,
        isNew: true,
        isMainRepo,
        parallelSessions: existingSessions.length + 1
      };
    })();
  }

  /**
   * Update heartbeat for a session
   */
  heartbeat(pid: number): boolean {
    return this.db.updateHeartbeatByPid(pid);
  }

  /**
   * Release a session and optionally cleanup worktree
   */
  async release(pid: number): Promise<{ released: boolean; worktreeRemoved: boolean }> {
    const session = this.db.getSessionByPid(pid);
    if (!session) {
      return { released: false, worktreeRemoved: false };
    }

    // Release all file claims for this session
    // Wrap in try-catch to ensure cleanup proceeds even if claim release fails
    try {
      await this.fileClaimsManager.releaseAllForSession(session.id);
    } catch (error) {
      logger.error(`Failed to release file claims for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
      // Continue with cleanup - don't let claim release failure block session cleanup
    }

    let worktreeRemoved = false;

    // Remove worktree if it was created for this session
    if (!session.is_main_repo && session.worktree_name && this.config.autoCleanupWorktrees) {
      const gtr = new GtrWrapper(session.repo_path);
      const result = gtr.removeWorktree(session.worktree_name, true);
      worktreeRemoved = result.success;
      if (result.success) {
        logger.info(`Removed worktree: ${session.worktree_name}`);
      } else {
        logger.error(`Failed to remove worktree ${session.worktree_name}: ${result.error}`);
      }
    }

    // Delete session record
    this.db.deleteSession(session.id);

    return { released: true, worktreeRemoved };
  }

  /**
   * Get status of all sessions for a repo
   */
  status(repoPath?: string): StatusResult {
    const normalizedRepo = repoPath ? this.normalizeRepoPath(repoPath) : null;

    const allSessions = normalizedRepo
      ? this.db.getSessionsByRepo(normalizedRepo)
      : this.db.getAllSessions();

    const sessions: SessionInfo[] = allSessions.map(s => {
      const isAlive = this.isProcessAlive(s.pid);
      const createdAt = new Date(s.created_at);
      const durationMinutes = Math.round((Date.now() - createdAt.getTime()) / 60000);

      return {
        sessionId: s.id,
        pid: s.pid,
        worktreePath: s.worktree_path,
        worktreeName: s.worktree_name,
        isMainRepo: s.is_main_repo,
        createdAt: s.created_at,
        lastHeartbeat: s.last_heartbeat,
        isAlive,
        durationMinutes
      };
    });

    return {
      repoPath: normalizedRepo ?? 'all',
      totalSessions: sessions.length,
      sessions
    };
  }

  /**
   * Cleanup stale sessions (no heartbeat for threshold period)
   */
  async cleanup(): Promise<CleanupResult> {
    const staleSessions = this.db.getStaleSessions(this.config.staleThresholdMinutes);
    const removedSessions: string[] = [];
    const worktreesRemoved: string[] = [];

    for (const session of staleSessions) {
      // Double-check process is actually dead
      if (!this.isProcessAlive(session.pid)) {
        // Release all file claims for this session
        await this.fileClaimsManager.releaseAllForSession(session.id);

        // Deactivate subscriptions for removed session
        try {
          const subscriptions = this.db.getSubscriptionsBySession(session.id);
          for (const sub of subscriptions) {
            this.db.deactivateSubscription(sub.id);
            logger.info(`Cleanup: Deactivated subscription ${sub.id} for stale session ${session.id}`);
          }
        } catch (error) {
          logger.error(`Cleanup: Failed to deactivate subscriptions for session ${session.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
        }

        // Remove worktree if applicable
        if (!session.is_main_repo && session.worktree_name && this.config.autoCleanupWorktrees) {
          const gtr = new GtrWrapper(session.repo_path);
          const result = gtr.removeWorktree(session.worktree_name, true);
          if (result.success) {
            worktreesRemoved.push(session.worktree_name);
            logger.info(`Cleanup: Removed stale worktree ${session.worktree_name}`);
          } else {
            logger.error(`Cleanup: Failed to remove worktree ${session.worktree_name}: ${result.error}`);
          }
        }

        this.db.deleteSession(session.id);
        removedSessions.push(session.id);
      }
    }

    // Cleanup stale file claims
    const staleClaims = await this.fileClaimsManager.cleanupStaleClaims();
    logger.info(`Cleanup: Cleaned up ${staleClaims} stale file claims`);

    return {
      removed: removedSessions.length,
      sessions: removedSessions,
      worktreesRemoved
    };
  }

  /**
   * Subscribe a session to receive notifications when a branch is merged
   * @param sessionId - Session ID to subscribe
   * @param branchName - Branch name to watch
   * @param targetBranch - Target branch (defaults to 'main')
   * @returns Subscription result with ID and status
   */
  subscribeToMerge(
    sessionId: string,
    branchName: string,
    targetBranch: string = 'main'
  ): { subscriptionId: string; success: boolean; message: string } {
    try {
      // Validate session exists
      const session = this.db.getSessionById(sessionId);
      if (!session) {
        return {
          subscriptionId: '',
          success: false,
          message: `Session ${sessionId} not found`
        };
      }

      // Create subscription
      const subscriptionId = randomUUID();
      this.db.createSubscription({
        id: subscriptionId,
        session_id: sessionId,
        repo_path: session.repo_path,
        branch_name: branchName,
        target_branch: targetBranch,
        is_active: true
      });

      logger.info(`Created merge subscription ${subscriptionId} for session ${sessionId}: ${branchName} -> ${targetBranch}`);

      return {
        subscriptionId,
        success: true,
        message: `Subscribed to merge notifications for ${branchName} -> ${targetBranch}`
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'unknown error';
      logger.error(`Failed to create merge subscription: ${errorMsg}`);
      return {
        subscriptionId: '',
        success: false,
        message: `Failed to create subscription: ${errorMsg}`
      };
    }
  }

  /**
   * Unsubscribe from a merge notification
   * @param subscriptionId - Subscription ID to deactivate
   * @returns Success status
   */
  unsubscribeFromMerge(subscriptionId: string): boolean {
    try {
      const success = this.db.deactivateSubscription(subscriptionId);
      if (success) {
        logger.info(`Deactivated subscription ${subscriptionId}`);
      }
      return success;
    } catch (error) {
      logger.error(`Failed to deactivate subscription ${subscriptionId}: ${error instanceof Error ? error.message : 'unknown error'}`);
      return false;
    }
  }

  /**
   * Get active subscriptions for a session
   * @param sessionId - Session ID to query
   * @returns Array of active subscriptions
   */
  getSessionSubscriptions(sessionId: string): Subscription[] {
    try {
      return this.db.getSubscriptionsBySession(sessionId);
    } catch (error) {
      logger.error(`Failed to get subscriptions for session ${sessionId}: ${error instanceof Error ? error.message : 'unknown error'}`);
      return [];
    }
  }

  /**
   * Check if a branch has been merged
   * @param repoPath - Repository path
   * @param branchName - Branch name to check
   * @param targetBranch - Target branch (defaults to 'main')
   * @returns Merge status and event details if merged
   */
  getBranchMergeStatus(
    repoPath: string,
    branchName: string,
    targetBranch: string = 'main'
  ): { isMerged: boolean; mergeEvent: MergeEvent | null } {
    try {
      const normalizedRepo = this.normalizeRepoPath(repoPath);
      const mergeEvent = this.db.getMergeEvent(normalizedRepo, branchName, targetBranch);

      return {
        isMerged: mergeEvent !== null,
        mergeEvent
      };
    } catch (error) {
      logger.error(`Failed to check merge status for ${branchName}: ${error instanceof Error ? error.message : 'unknown error'}`);
      return { isMerged: false, mergeEvent: null };
    }
  }

  /**
   * Get merge events, optionally filtered by repository
   * @param repoPath - Optional repository path to filter by
   * @returns Array of merge events
   */
  getMergeEvents(repoPath?: string): MergeEvent[] {
    try {
      if (repoPath) {
        const normalizedRepo = this.normalizeRepoPath(repoPath);
        return this.db.getMergeEventsByRepo(normalizedRepo);
      }
      return this.db.getAllMergeEvents();
    } catch (error) {
      logger.error(`Failed to get merge events: ${error instanceof Error ? error.message : 'unknown error'}`);
      return [];
    }
  }

  private async cleanupStaleSessions(): Promise<void> {
    // Silent cleanup during registration
    await this.cleanup();
  }

  /**
   * Check if a process is still running
   */
  private isProcessAlive(pid: number): boolean {
    try {
      // Sending signal 0 checks if process exists without killing it
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Normalize repo path to canonical form
   */
  private normalizeRepoPath(repoPath: string): string {
    try {
      // Get git root to normalize path
      const gitRoot = execSync('git rev-parse --show-toplevel', {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim();
      return gitRoot;
    } catch (error) {
      // Not a git repo or git not available - use as-is
      logger.warn(`Could not normalize repo path ${repoPath}: ${error instanceof Error ? error.message : 'unknown error'}`);
      return repoPath;
    }
  }

  /**
   * Get database instance (for MCP tools and testing)
   */
  getDB(): SessionDB {
    return this.db;
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}
