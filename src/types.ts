/**
 * Core type definitions for parallel-cc
 */

export interface Session {
  id: string;
  pid: number;
  repo_path: string;
  worktree_path: string;
  worktree_name: string | null;
  is_main_repo: boolean;
  created_at: string;
  last_heartbeat: string;
}

export interface SessionRow {
  id: string;
  pid: number;
  repo_path: string;
  worktree_path: string;
  worktree_name: string | null;
  is_main_repo: number; // SQLite stores booleans as 0/1
  created_at: string;
  last_heartbeat: string;
}

export interface RegisterResult {
  sessionId: string;
  worktreePath: string;
  worktreeName: string | null;
  isNew: boolean;
  isMainRepo: boolean;
  parallelSessions: number;
}

export interface StatusResult {
  repoPath: string;
  totalSessions: number;
  sessions: SessionInfo[];
}

export interface SessionInfo {
  sessionId: string;
  pid: number;
  worktreePath: string;
  worktreeName: string | null;
  isMainRepo: boolean;
  createdAt: string;
  lastHeartbeat: string;
  isAlive: boolean;
  durationMinutes: number;
}

export interface CleanupResult {
  removed: number;
  sessions: string[];
  worktreesRemoved: string[];
}

export interface GtrResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface GtrListEntry {
  branch: string;
  path: string;
  isMain: boolean;
}

// Configuration
export interface Config {
  dbPath: string;
  staleThresholdMinutes: number;
  autoCleanupWorktrees: boolean;
  worktreePrefix: string;
}

export const DEFAULT_CONFIG: Config = {
  dbPath: '~/.parallel-cc/coordinator.db',
  staleThresholdMinutes: 10,
  autoCleanupWorktrees: true,
  worktreePrefix: 'parallel-'
};

// ============================================================================
// Merge Detection Types (v0.4)
// ============================================================================

/**
 * Database row for merge_events table
 */
export interface MergeEventRow {
  id: string;
  repo_path: string;
  branch_name: string;
  source_commit: string;
  target_branch: string;
  target_commit: string;
  merged_at: string;
  detected_at: string;
  notification_sent: number; // SQLite boolean (0/1)
}

/**
 * Merge event model (TypeScript booleans)
 */
export interface MergeEvent {
  id: string;
  repo_path: string;
  branch_name: string;
  source_commit: string;
  target_branch: string;
  target_commit: string;
  merged_at: string;
  detected_at: string;
  notification_sent: boolean;
}

/**
 * Database row for subscriptions table
 */
export interface SubscriptionRow {
  id: string;
  session_id: string;
  repo_path: string;
  branch_name: string;
  target_branch: string;
  created_at: string;
  notified_at: string | null;
  is_active: number; // SQLite boolean (0/1)
}

/**
 * Subscription model (TypeScript booleans)
 */
export interface Subscription {
  id: string;
  session_id: string;
  repo_path: string;
  branch_name: string;
  target_branch: string;
  created_at: string;
  notified_at: string | null;
  is_active: boolean;
}

/**
 * Result of merge detection poll
 */
export interface MergeDetectionResult {
  newMerges: MergeEvent[];
  notificationsSent: number;
  subscriptionsChecked: number;
  errors: string[];
}

/**
 * Conflict detection result
 */
export interface ConflictInfo {
  hasConflicts: boolean;
  conflictingFiles: string[];
  summary: string;
}

/**
 * Rebase assistance result
 */
export interface RebaseResult {
  success: boolean;
  output: string;
  conflicts?: ConflictInfo;
  error?: string;
}

/**
 * Branch status information
 */
export interface BranchStatus {
  name: string;
  commit: string;
  upstreamBranch: string | null;
  isMerged: boolean;
  behindBy: number;
  aheadBy: number;
}
