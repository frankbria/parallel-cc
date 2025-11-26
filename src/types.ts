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
