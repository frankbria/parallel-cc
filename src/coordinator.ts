/**
 * Core coordinator logic - manages parallel Claude Code sessions
 */

import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { SessionDB } from './db.js';
import { GtrWrapper } from './gtr.js';
import { logger } from './logger.js';
import type {
  RegisterResult,
  StatusResult,
  SessionInfo,
  CleanupResult,
  Config
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';

export class Coordinator {
  private db: SessionDB;
  private config: Config;
  
  constructor(config: Partial<Config> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = new SessionDB(this.config.dbPath);
  }
  
  /**
   * Register a new session. Creates worktree if parallel session exists.
   */
  register(repoPath: string, pid: number): RegisterResult {
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
    this.cleanupStaleSessions();

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
  release(pid: number): { released: boolean; worktreeRemoved: boolean } {
    const session = this.db.getSessionByPid(pid);
    if (!session) {
      return { released: false, worktreeRemoved: false };
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
  cleanup(): CleanupResult {
    const staleSessions = this.db.getStaleSessions(this.config.staleThresholdMinutes);
    const removedSessions: string[] = [];
    const worktreesRemoved: string[] = [];
    
    for (const session of staleSessions) {
      // Double-check process is actually dead
      if (!this.isProcessAlive(session.pid)) {
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
    
    return {
      removed: removedSessions.length,
      sessions: removedSessions,
      worktreesRemoved
    };
  }
  
  private cleanupStaleSessions(): void {
    // Silent cleanup during registration
    this.cleanup();
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
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}
