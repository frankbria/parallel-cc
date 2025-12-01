/**
 * SQLite database operations for session tracking
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { homedir } from 'os';
import type {
  Session,
  SessionRow,
  Config,
  MergeEvent,
  MergeEventRow,
  Subscription,
  SubscriptionRow
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';

export class SessionDB {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = this.resolvePath(dbPath ?? DEFAULT_CONFIG.dbPath);

    // Ensure directory exists
    const dir = dirname(resolvedPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    // Set busy timeout for better concurrent access
    this.db.pragma('busy_timeout = 5000');
    this.init();
  }
  
  private resolvePath(path: string): string {
    if (path.startsWith('~')) {
      return path.replace('~', homedir());
    }
    return path;
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        repo_path TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        worktree_name TEXT,
        is_main_repo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_heartbeat TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo_path);
      CREATE INDEX IF NOT EXISTS idx_sessions_pid ON sessions(pid);
      CREATE INDEX IF NOT EXISTS idx_sessions_heartbeat ON sessions(last_heartbeat);
    `);

    // v0.4: Merge detection tables
    this.initMergeDetection();
  }

  /**
   * Initialize merge detection tables (v0.4)
   */
  private initMergeDetection(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS merge_events (
        id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        source_commit TEXT NOT NULL,
        target_branch TEXT NOT NULL DEFAULT 'main',
        target_commit TEXT NOT NULL,
        merged_at TEXT NOT NULL DEFAULT (datetime('now')),
        detected_at TEXT NOT NULL DEFAULT (datetime('now')),
        notification_sent INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        target_branch TEXT NOT NULL DEFAULT 'main',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        notified_at TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_merge_events_repo ON merge_events(repo_path);
      CREATE INDEX IF NOT EXISTS idx_merge_events_branch ON merge_events(branch_name);
      CREATE INDEX IF NOT EXISTS idx_merge_events_target ON merge_events(target_branch);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_session ON subscriptions(session_id);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_repo ON subscriptions(repo_path);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_active ON subscriptions(is_active);
    `);
  }
  
  createSession(session: Omit<Session, 'created_at' | 'last_heartbeat'>): Session {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, pid, repo_path, worktree_path, worktree_name, is_main_repo)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING *
    `);
    
    const row = stmt.get(
      session.id,
      session.pid,
      session.repo_path,
      session.worktree_path,
      session.worktree_name,
      session.is_main_repo ? 1 : 0
    ) as SessionRow;
    
    return this.rowToSession(row);
  }

  getSessionsByRepo(repoPath: string): Session[] {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions WHERE repo_path = ?
    `);
    const rows = stmt.all(repoPath) as SessionRow[];
    return rows.map(row => this.rowToSession(row));
  }
  
  getSessionByPid(pid: number): Session | null {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions WHERE pid = ?
    `);
    const row = stmt.get(pid) as SessionRow | undefined;
    return row ? this.rowToSession(row) : null;
  }
  
  getSessionById(id: string): Session | null {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions WHERE id = ?
    `);
    const row = stmt.get(id) as SessionRow | undefined;
    return row ? this.rowToSession(row) : null;
  }
  
  getAllSessions(): Session[] {
    const stmt = this.db.prepare(`SELECT * FROM sessions`);
    const rows = stmt.all() as SessionRow[];
    return rows.map(row => this.rowToSession(row));
  }

  updateHeartbeat(sessionId: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE sessions 
      SET last_heartbeat = datetime('now')
      WHERE id = ?
    `);
    const result = stmt.run(sessionId);
    return result.changes > 0;
  }
  
  updateHeartbeatByPid(pid: number): boolean {
    const stmt = this.db.prepare(`
      UPDATE sessions 
      SET last_heartbeat = datetime('now')
      WHERE pid = ?
    `);
    const result = stmt.run(pid);
    return result.changes > 0;
  }
  
  deleteSession(sessionId: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM sessions WHERE id = ?`);
    const result = stmt.run(sessionId);
    return result.changes > 0;
  }
  
  deleteSessionByPid(pid: number): Session | null {
    const session = this.getSessionByPid(pid);
    if (session) {
      this.deleteSession(session.id);
    }
    return session;
  }

  getStaleSessions(thresholdMinutes: number): Session[] {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions 
      WHERE datetime(last_heartbeat) < datetime('now', ? || ' minutes')
    `);
    const rows = stmt.all(`-${thresholdMinutes}`) as SessionRow[];
    return rows.map(row => this.rowToSession(row));
  }
  
  deleteStaleSessions(thresholdMinutes: number): Session[] {
    const stale = this.getStaleSessions(thresholdMinutes);
    for (const session of stale) {
      this.deleteSession(session.id);
    }
    return stale;
  }
  
  hasMainRepoSession(repoPath: string): boolean {
    const stmt = this.db.prepare(`
      SELECT 1 FROM sessions 
      WHERE repo_path = ? AND is_main_repo = 1
      LIMIT 1
    `);
    return stmt.get(repoPath) !== undefined;
  }
  
  private rowToSession(row: SessionRow): Session {
    return {
      ...row,
      is_main_repo: row.is_main_repo === 1
    };
  }

  /**
   * Execute a function within a transaction for atomicity
   */
  transaction<T>(fn: () => T): () => T {
    return this.db.transaction(fn);
  }

  // ============================================================================
  // Merge Events (v0.4)
  // ============================================================================

  /**
   * Create a new merge event record
   */
  createMergeEvent(event: Omit<MergeEvent, 'merged_at' | 'detected_at'>): MergeEvent {
    const stmt = this.db.prepare(`
      INSERT INTO merge_events (id, repo_path, branch_name, source_commit, target_branch, target_commit, notification_sent)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);

    const row = stmt.get(
      event.id,
      event.repo_path,
      event.branch_name,
      event.source_commit,
      event.target_branch,
      event.target_commit,
      event.notification_sent ? 1 : 0
    ) as MergeEventRow;

    return this.rowToMergeEvent(row);
  }

  /**
   * Get a merge event by repo, branch, and target
   */
  getMergeEvent(repoPath: string, branchName: string, targetBranch: string): MergeEvent | null {
    const stmt = this.db.prepare(`
      SELECT * FROM merge_events
      WHERE repo_path = ? AND branch_name = ? AND target_branch = ?
      ORDER BY detected_at DESC
      LIMIT 1
    `);
    const row = stmt.get(repoPath, branchName, targetBranch) as MergeEventRow | undefined;
    return row ? this.rowToMergeEvent(row) : null;
  }

  /**
   * Get all merge events for a repository
   */
  getMergeEventsByRepo(repoPath: string): MergeEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM merge_events WHERE repo_path = ?
      ORDER BY detected_at DESC
    `);
    const rows = stmt.all(repoPath) as MergeEventRow[];
    return rows.map(row => this.rowToMergeEvent(row));
  }

  /**
   * Get all merge events
   */
  getAllMergeEvents(): MergeEvent[] {
    const stmt = this.db.prepare(`SELECT * FROM merge_events ORDER BY detected_at DESC`);
    const rows = stmt.all() as MergeEventRow[];
    return rows.map(row => this.rowToMergeEvent(row));
  }

  /**
   * Mark a merge event as notified
   */
  markMergeEventNotified(eventId: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE merge_events
      SET notification_sent = 1
      WHERE id = ?
    `);
    const result = stmt.run(eventId);
    return result.changes > 0;
  }

  /**
   * Get unnotified merge events
   */
  getUnnotifiedMergeEvents(): MergeEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM merge_events WHERE notification_sent = 0
      ORDER BY detected_at DESC
    `);
    const rows = stmt.all() as MergeEventRow[];
    return rows.map(row => this.rowToMergeEvent(row));
  }

  /**
   * Delete a merge event
   */
  deleteMergeEvent(eventId: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM merge_events WHERE id = ?`);
    const result = stmt.run(eventId);
    return result.changes > 0;
  }

  private rowToMergeEvent(row: MergeEventRow): MergeEvent {
    return {
      ...row,
      notification_sent: row.notification_sent === 1
    };
  }

  // ============================================================================
  // Subscriptions (v0.4)
  // ============================================================================

  /**
   * Create a new subscription
   */
  createSubscription(sub: Omit<Subscription, 'created_at' | 'notified_at'>): Subscription {
    const stmt = this.db.prepare(`
      INSERT INTO subscriptions (id, session_id, repo_path, branch_name, target_branch, is_active)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING *
    `);

    const row = stmt.get(
      sub.id,
      sub.session_id,
      sub.repo_path,
      sub.branch_name,
      sub.target_branch,
      sub.is_active ? 1 : 0
    ) as SubscriptionRow;

    return this.rowToSubscription(row);
  }

  /**
   * Get subscriptions by session ID
   */
  getSubscriptionsBySession(sessionId: string): Subscription[] {
    const stmt = this.db.prepare(`
      SELECT * FROM subscriptions WHERE session_id = ? AND is_active = 1
    `);
    const rows = stmt.all(sessionId) as SubscriptionRow[];
    return rows.map(row => this.rowToSubscription(row));
  }

  /**
   * Get all active subscriptions
   */
  getActiveSubscriptions(): Subscription[] {
    const stmt = this.db.prepare(`
      SELECT * FROM subscriptions WHERE is_active = 1
    `);
    const rows = stmt.all() as SubscriptionRow[];
    return rows.map(row => this.rowToSubscription(row));
  }

  /**
   * Get subscriptions by repo and branch
   */
  getSubscriptionsByBranch(repoPath: string, branchName: string, targetBranch: string): Subscription[] {
    const stmt = this.db.prepare(`
      SELECT * FROM subscriptions
      WHERE repo_path = ? AND branch_name = ? AND target_branch = ? AND is_active = 1
    `);
    const rows = stmt.all(repoPath, branchName, targetBranch) as SubscriptionRow[];
    return rows.map(row => this.rowToSubscription(row));
  }

  /**
   * Mark subscriptions as notified for a specific merge
   */
  markSubscriptionsNotified(repoPath: string, branchName: string, targetBranch: string): number {
    const stmt = this.db.prepare(`
      UPDATE subscriptions
      SET notified_at = datetime('now'), is_active = 0
      WHERE repo_path = ? AND branch_name = ? AND target_branch = ? AND is_active = 1
    `);
    const result = stmt.run(repoPath, branchName, targetBranch);
    return result.changes;
  }

  /**
   * Deactivate a specific subscription
   */
  deactivateSubscription(subscriptionId: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE subscriptions SET is_active = 0 WHERE id = ?
    `);
    const result = stmt.run(subscriptionId);
    return result.changes > 0;
  }

  /**
   * Delete a subscription
   */
  deleteSubscription(subscriptionId: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM subscriptions WHERE id = ?`);
    const result = stmt.run(subscriptionId);
    return result.changes > 0;
  }

  /**
   * Get subscription by ID
   */
  getSubscriptionById(subscriptionId: string): Subscription | null {
    const stmt = this.db.prepare(`SELECT * FROM subscriptions WHERE id = ?`);
    const row = stmt.get(subscriptionId) as SubscriptionRow | undefined;
    return row ? this.rowToSubscription(row) : null;
  }

  private rowToSubscription(row: SubscriptionRow): Subscription {
    return {
      ...row,
      is_active: row.is_active === 1
    };
  }

  close(): void {
    this.db.close();
  }
}
