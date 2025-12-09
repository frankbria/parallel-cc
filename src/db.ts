/**
 * SQLite database operations for session tracking
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'fs';
import { dirname, join as pathJoin } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type {
  Session,
  SessionRow,
  Config,
  MergeEvent,
  MergeEventRow,
  Subscription,
  SubscriptionRow,
  FileClaim,
  FileClaimRow,
  ConflictResolution,
  ConflictResolutionRow,
  AutoFixSuggestion,
  AutoFixSuggestionRow,
  AcquireClaimParams,
  ClaimFilters,
  CreateConflictResolutionParams,
  ConflictFilters,
  CreateAutoFixSuggestionParams,
  SuggestionFilters,
  E2BSession,
  E2BSessionRow,
  ExecutionMode
} from './types.js';
import { SandboxStatus } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import {
  validateFilePath,
  validateClaimMode,
  validateConflictType,
  validateResolutionStrategy,
  validateConfidenceScore,
  validateTTL,
  sanitizeMetadata
} from './db-validators.js';
import { logger } from './logger.js';

/**
 * Safely parse JSON with error handling
 *
 * @param json - JSON string to parse
 * @returns Parsed object or undefined on error
 */
function safeParseJSON(json: string | null | undefined): any {
  if (!json) return undefined;

  try {
    return JSON.parse(json);
  } catch (error) {
    logger.warn(`Failed to parse JSON metadata: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

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
      is_main_repo: row.is_main_repo === 1,
      // Convert null to undefined for optional E2B fields
      sandbox_id: row.sandbox_id || undefined,
      prompt: row.prompt || undefined,
      status: row.status || undefined,
      output_log: row.output_log || undefined
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

  // ============================================================================
  // Database Migration (v0.5)
  // ============================================================================

  /**
   * Migrate database to v0.5.0 schema
   *
   * This migration adds:
   * - schema_metadata table for version tracking and distributed locks
   * - file_claims table for file access locks
   * - conflict_resolutions table for conflict history
   * - auto_fix_suggestions table for AI-generated solutions
   *
   * @throws Error if migration fails
   */
  async migrateToV05(): Promise<void> {
    try {
      logger.info('Starting migration to v0.5.0');

      // Check current version
      const currentVersion = this.getSchemaVersion();
      logger.info(`Current schema version: ${currentVersion || 'none'}`);

      if (currentVersion === '0.5.0') {
        logger.info('Already at v0.5.0, skipping migration');
        return;
      }

      // Create backup
      const dbPath = this.db.name;
      const backupPath = `${dbPath}.v${currentVersion || '0.4'}.backup`;
      logger.info(`Creating backup at: ${backupPath}`);
      copyFileSync(dbPath, backupPath);

      // Read migration SQL
      const migrationPath = pathJoin(process.cwd(), 'migrations', 'v0.5.0.sql');
      if (!existsSync(migrationPath)) {
        throw new Error(`Migration file not found: ${migrationPath}`);
      }

      const migrationSQL = readFileSync(migrationPath, 'utf-8');
      logger.info('Executing migration SQL');

      // Run migration (already wrapped in transaction in SQL file)
      this.db.exec(migrationSQL);

      // Verify tables were created
      const tables = this.db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name IN ('schema_metadata', 'file_claims', 'conflict_resolutions', 'auto_fix_suggestions')
      `).all() as { name: string }[];

      if (tables.length !== 4) {
        throw new Error(`Migration verification failed: expected 4 tables, got ${tables.length}`);
      }

      logger.info('Migration to v0.5.0 completed successfully');
    } catch (error) {
      logger.error('Migration failed', error);
      throw error;
    }
  }

  /**
   * Get current schema version from metadata table
   */
  private getSchemaVersion(): string | null {
    try {
      const row = this.db.prepare(`
        SELECT value FROM schema_metadata WHERE key = 'version'
      `).get() as { value: string } | undefined;
      return row?.value || null;
    } catch {
      return null;
    }
  }

  // ============================================================================
  // File Claims (v0.5)
  // ============================================================================

  /**
   * Acquire a file claim with transaction isolation
   *
   * Architecture Review Requirements Implemented:
   * - Transaction safety with BEGIN IMMEDIATE
   * - Path validation to prevent traversal attacks
   * - Enum validation for claim modes
   * - Conflict detection before acquiring claim
   *
   * @param params - Claim acquisition parameters
   * @returns The acquired file claim
   * @throws Error if claim cannot be acquired (conflicts, invalid path, etc.)
   */
  acquireClaim(params: AcquireClaimParams): FileClaim {
    // Validate inputs
    validateFilePath(params.repo_path, params.file_path);
    validateClaimMode(params.claim_mode);

    const ttlHours = params.ttl_hours ?? 24;
    validateTTL(ttlHours);

    const metadataJson = sanitizeMetadata(params.metadata);

    // Use transaction for atomicity
    return this.db.transaction(() => {
      // Check for conflicting claims
      const conflicts = this.db.prepare(`
        SELECT id, claim_mode, session_id, expires_at
        FROM file_claims
        WHERE repo_path = ? AND file_path = ? AND is_active = 1
          AND datetime(expires_at) > datetime('now')
          AND deleted_at IS NULL
      `).all(params.repo_path, params.file_path) as FileClaimRow[];

      // Validate compatibility
      for (const conflict of conflicts) {
        const isExpired = new Date(conflict.expires_at) < new Date();
        if (!isExpired) {
          if (params.claim_mode === 'EXCLUSIVE' || conflict.claim_mode === 'EXCLUSIVE') {
            throw new Error(
              `Cannot acquire ${params.claim_mode} claim: file has existing ${conflict.claim_mode} claim (${conflict.id})`
            );
          }
        }
      }

      // Insert new claim
      const claimId = randomUUID();
      const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

      const stmt = this.db.prepare(`
        INSERT INTO file_claims (id, session_id, repo_path, file_path, claim_mode, expires_at, escalated_from, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
      `);

      const row = stmt.get(
        claimId,
        params.session_id,
        params.repo_path,
        params.file_path,
        params.claim_mode,
        expiresAt,
        params.escalated_from || null,
        metadataJson
      ) as FileClaimRow;

      logger.info(`Acquired ${params.claim_mode} claim on ${params.file_path} for session ${params.session_id}`);
      return this.rowToFileClaim(row);
    })();
  }

  /**
   * Release a file claim
   *
   * @param claimId - ID of claim to release
   * @param force - Force release even if session mismatch
   * @returns true if claim was released
   */
  releaseClaim(claimId: string, force = false): boolean {
    const stmt = this.db.prepare(`
      UPDATE file_claims
      SET is_active = 0, released_at = datetime('now')
      WHERE id = ? AND is_active = 1
    `);

    const result = stmt.run(claimId);
    const released = result.changes > 0;

    if (released) {
      logger.info(`Released claim ${claimId}`);
    }

    return released;
  }

  /**
   * List file claims with optional filters
   *
   * @param filters - Query filters
   * @returns Array of matching claims
   */
  listClaims(filters?: ClaimFilters): FileClaim[] {
    let query = 'SELECT * FROM file_claims WHERE deleted_at IS NULL';
    const params: unknown[] = [];

    if (filters?.session_id) {
      query += ' AND session_id = ?';
      params.push(filters.session_id);
    }

    if (filters?.repo_path) {
      query += ' AND repo_path = ?';
      params.push(filters.repo_path);
    }

    if (filters?.file_path) {
      query += ' AND file_path = ?';
      params.push(filters.file_path);
    }

    if (filters?.claim_mode) {
      query += ' AND claim_mode = ?';
      params.push(filters.claim_mode);
    }

    if (filters?.is_active !== undefined) {
      query += ' AND is_active = ?';
      params.push(filters.is_active ? 1 : 0);
    }

    if (!filters?.include_stale) {
      query += ' AND datetime(expires_at) > datetime(\'now\')';
    }

    query += ' ORDER BY claimed_at DESC';

    const rows = this.db.prepare(query).all(...params) as FileClaimRow[];
    return rows.map(row => this.rowToFileClaim(row));
  }

  /**
   * Clean up stale claims (expired or with stale heartbeats)
   *
   * Architecture Review Requirement: Distributed lock to prevent concurrent cleanup
   *
   * @param repoPath - Optional repo path filter
   * @returns Number of claims cleaned up
   */
  cleanupStaleClaims(repoPath?: string): number {
    // Try to acquire distributed lock
    if (!this.acquireCleanupLock()) {
      logger.warn('Could not acquire cleanup lock, another process is cleaning up');
      return 0;
    }

    try {
      let query = `
        UPDATE file_claims
        SET is_active = 0, released_at = datetime('now'), deleted_reason = 'stale'
        WHERE is_active = 1 AND deleted_at IS NULL
        AND (
          datetime(expires_at) < datetime('now')
          OR datetime(last_heartbeat) < datetime('now', '-5 minutes')
        )
      `;

      const params: unknown[] = [];
      if (repoPath) {
        query += ' AND repo_path = ?';
        params.push(repoPath);
      }

      const result = this.db.prepare(query).run(...params);
      logger.info(`Cleaned up ${result.changes} stale claims`);
      return result.changes;
    } finally {
      this.releaseCleanupLock();
    }
  }

  /**
   * Acquire distributed cleanup lock
   *
   * Uses schema_metadata table to coordinate cleanup across processes
   *
   * @returns true if lock acquired, false otherwise
   */
  private acquireCleanupLock(): boolean {
    try {
      const stmt = this.db.prepare(`
        UPDATE schema_metadata
        SET value = datetime('now')
        WHERE key = 'last_claim_cleanup'
        AND datetime(value) < datetime('now', '-1 minute')
      `);
      const result = stmt.run();
      return result.changes > 0;
    } catch {
      return false;
    }
  }

  /**
   * Release distributed cleanup lock
   */
  private releaseCleanupLock(): void {
    this.db.prepare(`
      UPDATE schema_metadata
      SET value = datetime('now')
      WHERE key = 'last_claim_cleanup'
    `).run();
  }

  /**
   * Update claim fields (for escalation)
   *
   * @param claimId - Claim ID to update
   * @param updates - Partial updates to apply
   * @returns Updated file claim
   */
  updateClaim(claimId: string, updates: Partial<Pick<FileClaim, 'claim_mode' | 'escalated_from'>>): FileClaim {
    const updateFields: string[] = [];
    const updateValues: unknown[] = [];

    if (updates.claim_mode) {
      // Validate claim mode before updating
      validateClaimMode(updates.claim_mode);
      updateFields.push('claim_mode = ?');
      updateValues.push(updates.claim_mode);
    }

    if (updates.escalated_from !== undefined) {
      updateFields.push('escalated_from = ?');
      updateValues.push(updates.escalated_from);
    }

    if (updateFields.length === 0) {
      throw new Error('No fields to update');
    }

    updateValues.push(claimId);

    const stmt = this.db.prepare(`
      UPDATE file_claims
      SET ${updateFields.join(', ')}
      WHERE id = ? AND is_active = 1
    `);

    const result = stmt.run(...updateValues);

    if (result.changes === 0) {
      throw new Error(`Claim not found or inactive: ${claimId}`);
    }

    return this.getClaimById(claimId);
  }

  /**
   * Get claim by ID
   */
  private getClaimById(claimId: string): FileClaim {
    const row = this.db.prepare(`
      SELECT * FROM file_claims WHERE id = ? AND is_active = 1
    `).get(claimId) as FileClaimRow | undefined;

    if (!row) {
      throw new Error(`Claim not found: ${claimId}`);
    }

    return this.rowToFileClaim(row);
  }

  /**
   * Release all claims for a session
   *
   * @param sessionId - Session ID
   * @returns Number of claims released
   */
  releaseAllForSession(sessionId: string): number {
    const stmt = this.db.prepare(`
      UPDATE file_claims
      SET is_active = 0, released_at = datetime('now')
      WHERE session_id = ? AND is_active = 1
    `);

    const result = stmt.run(sessionId);
    return result.changes;
  }

  private rowToFileClaim(row: FileClaimRow): FileClaim {
    return {
      id: row.id,
      session_id: row.session_id,
      repo_path: row.repo_path,
      file_path: row.file_path,
      claim_mode: row.claim_mode,
      claimed_at: row.claimed_at,
      expires_at: row.expires_at,
      last_heartbeat: row.last_heartbeat,
      escalated_from: row.escalated_from || undefined,
      metadata: row.metadata ? safeParseJSON(row.metadata) : undefined,
      is_active: row.is_active === 1,
      released_at: row.released_at || undefined,
      deleted_at: row.deleted_at || undefined,
      deleted_reason: row.deleted_reason || undefined
    };
  }

  // ============================================================================
  // Conflict Resolutions (v0.5)
  // ============================================================================

  /**
   * Create a conflict resolution record
   *
   * @param params - Conflict resolution parameters
   * @returns The created conflict resolution
   */
  createConflictResolution(params: CreateConflictResolutionParams): ConflictResolution {
    // Validate inputs
    validateFilePath(params.repo_path, params.file_path);
    validateConflictType(params.conflict_type);
    validateResolutionStrategy(params.resolution_strategy);

    if (params.confidence_score !== undefined) {
      validateConfidenceScore(params.confidence_score);
    }

    const metadataJson = sanitizeMetadata(params.metadata);

    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO conflict_resolutions (
        id, session_id, repo_path, file_path, conflict_type,
        base_commit, source_commit, target_commit, resolution_strategy,
        confidence_score, conflict_markers, resolved_content,
        auto_fix_suggestion_id, metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);

    const row = stmt.get(
      id,
      params.session_id || null,
      params.repo_path,
      params.file_path,
      params.conflict_type,
      params.base_commit,
      params.source_commit,
      params.target_commit,
      params.resolution_strategy,
      params.confidence_score || null,
      params.conflict_markers,
      params.resolved_content || null,
      params.auto_fix_suggestion_id || null,
      metadataJson
    ) as ConflictResolutionRow;

    logger.info(`Created conflict resolution ${id} for ${params.file_path}`);
    return this.rowToConflictResolution(row);
  }

  /**
   * Update a conflict resolution
   *
   * @param id - Conflict resolution ID
   * @param updates - Fields to update
   */
  updateConflictResolution(id: string, updates: Partial<ConflictResolution>): void {
    const fields: string[] = [];
    const params: unknown[] = [];

    if (updates.resolution_strategy) {
      validateResolutionStrategy(updates.resolution_strategy);
      fields.push('resolution_strategy = ?');
      params.push(updates.resolution_strategy);
    }

    if (updates.confidence_score !== undefined) {
      validateConfidenceScore(updates.confidence_score);
      fields.push('confidence_score = ?');
      params.push(updates.confidence_score);
    }

    if (updates.resolved_content !== undefined) {
      fields.push('resolved_content = ?');
      params.push(updates.resolved_content);
    }

    if (updates.resolved_at !== undefined) {
      fields.push('resolved_at = ?');
      params.push(updates.resolved_at);
    }

    if (updates.auto_fix_suggestion_id !== undefined) {
      fields.push('auto_fix_suggestion_id = ?');
      params.push(updates.auto_fix_suggestion_id);
    }

    if (updates.metadata) {
      fields.push('metadata = ?');
      params.push(sanitizeMetadata(updates.metadata));
    }

    if (fields.length === 0) {
      return;
    }

    params.push(id);
    const query = `UPDATE conflict_resolutions SET ${fields.join(', ')} WHERE id = ?`;
    this.db.prepare(query).run(...params);

    logger.info(`Updated conflict resolution ${id}`);
  }

  /**
   * Get conflict resolutions with optional filters
   *
   * @param filters - Query filters
   * @returns Array of matching conflict resolutions
   */
  getConflictResolutions(filters?: ConflictFilters): ConflictResolution[] {
    let query = 'SELECT * FROM conflict_resolutions WHERE deleted_at IS NULL';
    const params: unknown[] = [];

    if (filters?.session_id) {
      query += ' AND session_id = ?';
      params.push(filters.session_id);
    }

    if (filters?.repo_path) {
      query += ' AND repo_path = ?';
      params.push(filters.repo_path);
    }

    if (filters?.file_path) {
      query += ' AND file_path = ?';
      params.push(filters.file_path);
    }

    if (filters?.conflict_type) {
      query += ' AND conflict_type = ?';
      params.push(filters.conflict_type);
    }

    if (filters?.resolution_strategy) {
      query += ' AND resolution_strategy = ?';
      params.push(filters.resolution_strategy);
    }

    if (filters?.is_resolved !== undefined) {
      if (filters.is_resolved) {
        query += ' AND resolved_at IS NOT NULL';
      } else {
        query += ' AND resolved_at IS NULL';
      }
    }

    if (filters?.min_confidence !== undefined) {
      query += ' AND confidence_score >= ?';
      params.push(filters.min_confidence);
    }

    query += ' ORDER BY detected_at DESC';

    const rows = this.db.prepare(query).all(...params) as ConflictResolutionRow[];
    return rows.map(row => this.rowToConflictResolution(row));
  }

  private rowToConflictResolution(row: ConflictResolutionRow): ConflictResolution {
    return {
      id: row.id,
      session_id: row.session_id || undefined,
      repo_path: row.repo_path,
      file_path: row.file_path,
      conflict_type: row.conflict_type,
      base_commit: row.base_commit,
      source_commit: row.source_commit,
      target_commit: row.target_commit,
      resolution_strategy: row.resolution_strategy,
      confidence_score: row.confidence_score || undefined,
      conflict_markers: row.conflict_markers,
      resolved_content: row.resolved_content || undefined,
      detected_at: row.detected_at,
      resolved_at: row.resolved_at || undefined,
      auto_fix_suggestion_id: row.auto_fix_suggestion_id || undefined,
      metadata: row.metadata ? safeParseJSON(row.metadata) : undefined,
      deleted_at: row.deleted_at || undefined,
      deleted_reason: row.deleted_reason || undefined
    };
  }

  // ============================================================================
  // Auto-Fix Suggestions (v0.5)
  // ============================================================================

  /**
   * Create an auto-fix suggestion
   *
   * @param params - Auto-fix suggestion parameters
   * @returns The created suggestion
   */
  createAutoFixSuggestion(params: CreateAutoFixSuggestionParams): AutoFixSuggestion {
    // Validate inputs
    validateFilePath(params.repo_path, params.file_path);
    validateConflictType(params.conflict_type);
    validateConfidenceScore(params.confidence_score);

    const metadataJson = sanitizeMetadata(params.metadata);

    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO auto_fix_suggestions (
        id, conflict_resolution_id, repo_path, file_path, conflict_type,
        suggested_resolution, confidence_score, explanation, strategy_used,
        base_content, source_content, target_content, metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);

    const row = stmt.get(
      id,
      params.conflict_resolution_id || null,
      params.repo_path,
      params.file_path,
      params.conflict_type,
      params.suggested_resolution,
      params.confidence_score,
      params.explanation,
      params.strategy_used,
      params.base_content,
      params.source_content,
      params.target_content,
      metadataJson
    ) as AutoFixSuggestionRow;

    logger.info(`Created auto-fix suggestion ${id} for ${params.file_path} (confidence: ${params.confidence_score})`);
    return this.rowToAutoFixSuggestion(row);
  }

  /**
   * Get auto-fix suggestions with optional filters
   *
   * @param filters - Query filters
   * @returns Array of matching suggestions
   */
  getAutoFixSuggestions(filters?: SuggestionFilters): AutoFixSuggestion[] {
    let query = 'SELECT * FROM auto_fix_suggestions WHERE deleted_at IS NULL';
    const params: unknown[] = [];

    if (filters?.id) {
      query += ' AND id = ?';
      params.push(filters.id);
    }

    if (filters?.conflict_resolution_id) {
      query += ' AND conflict_resolution_id = ?';
      params.push(filters.conflict_resolution_id);
    }

    if (filters?.repo_path) {
      query += ' AND repo_path = ?';
      params.push(filters.repo_path);
    }

    if (filters?.file_path) {
      query += ' AND file_path = ?';
      params.push(filters.file_path);
    }

    if (filters?.conflict_type) {
      query += ' AND conflict_type = ?';
      params.push(filters.conflict_type);
    }

    if (filters?.is_applied !== undefined) {
      if (filters.is_applied) {
        query += ' AND applied_at IS NOT NULL';
      } else {
        query += ' AND applied_at IS NULL';
      }
    }

    if (filters?.min_confidence !== undefined) {
      query += ' AND confidence_score >= ?';
      params.push(filters.min_confidence);
    }

    query += ' ORDER BY generated_at DESC';

    const rows = this.db.prepare(query).all(...params) as AutoFixSuggestionRow[];
    return rows.map(row => this.rowToAutoFixSuggestion(row));
  }

  /**
   * Mark a suggestion as applied
   *
   * @param id - Suggestion ID
   * @param wasAutoApplied - Whether it was auto-applied
   */
  markSuggestionApplied(id: string, wasAutoApplied: boolean): void {
    const stmt = this.db.prepare(`
      UPDATE auto_fix_suggestions
      SET applied_at = datetime('now'), was_auto_applied = ?
      WHERE id = ?
    `);

    stmt.run(wasAutoApplied ? 1 : 0, id);
    logger.info(`Marked suggestion ${id} as applied (auto: ${wasAutoApplied})`);
  }

  private rowToAutoFixSuggestion(row: AutoFixSuggestionRow): AutoFixSuggestion {
    return {
      id: row.id,
      conflict_resolution_id: row.conflict_resolution_id || undefined,
      repo_path: row.repo_path,
      file_path: row.file_path,
      conflict_type: row.conflict_type,
      suggested_resolution: row.suggested_resolution,
      confidence_score: row.confidence_score,
      explanation: row.explanation,
      strategy_used: row.strategy_used,
      base_content: row.base_content,
      source_content: row.source_content,
      target_content: row.target_content,
      generated_at: row.generated_at,
      applied_at: row.applied_at || undefined,
      was_auto_applied: row.was_auto_applied === 1,
      metadata: row.metadata ? safeParseJSON(row.metadata) : undefined,
      deleted_at: row.deleted_at || undefined,
      deleted_reason: row.deleted_reason || undefined
    };
  }

  // ============================================================================
  // E2B Session Operations (v1.0)
  // ============================================================================

  /**
   * Create an E2B sandbox session
   *
   * @param params - E2B session parameters
   * @returns The created E2B session
   */
  createE2BSession(params: {
    id: string;
    pid: number;
    repo_path: string;
    worktree_path: string;
    worktree_name: string | null;
    sandbox_id: string;
    prompt: string;
    status?: SandboxStatus;
  }): E2BSession {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (
        id, pid, repo_path, worktree_path, worktree_name, is_main_repo,
        execution_mode, sandbox_id, prompt, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);

    const row = stmt.get(
      params.id,
      params.pid,
      params.repo_path,
      params.worktree_path,
      params.worktree_name,
      0, // E2B sessions are never main repo
      'e2b',
      params.sandbox_id,
      params.prompt,
      params.status || SandboxStatus.INITIALIZING
    ) as E2BSessionRow;

    logger.info(`Created E2B session ${params.id} with sandbox ${params.sandbox_id}`);
    return this.rowToE2BSession(row);
  }

  /**
   * Update E2B session status and optional output log
   *
   * @param sandboxId - Sandbox ID
   * @param status - New status
   * @param outputLog - Optional output log to append/update
   * @returns true if session was updated
   */
  updateE2BSessionStatus(sandboxId: string, status: SandboxStatus, outputLog?: string): boolean {
    const fields: string[] = ['status = ?', 'last_heartbeat = datetime(\'now\')'];
    const params: unknown[] = [status];

    if (outputLog !== undefined) {
      fields.push('output_log = ?');
      params.push(outputLog);
    }

    params.push(sandboxId);

    const stmt = this.db.prepare(`
      UPDATE sessions
      SET ${fields.join(', ')}
      WHERE sandbox_id = ? AND execution_mode = 'e2b'
    `);

    const result = stmt.run(...params);
    const updated = result.changes > 0;

    if (updated) {
      logger.info(`Updated E2B session status: ${sandboxId} -> ${status}`);
    }

    return updated;
  }

  /**
   * Get E2B session by sandbox ID
   *
   * @param sandboxId - Sandbox ID
   * @returns E2B session or null if not found
   */
  getE2BSessionBySandboxId(sandboxId: string): E2BSession | null {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions
      WHERE sandbox_id = ? AND execution_mode = 'e2b'
    `);
    const row = stmt.get(sandboxId) as E2BSessionRow | undefined;
    return row ? this.rowToE2BSession(row) : null;
  }

  /**
   * List all E2B sessions, optionally filtered by repo path
   *
   * @param repoPath - Optional repo path filter
   * @returns Array of E2B sessions
   */
  listE2BSessions(repoPath?: string): E2BSession[] {
    let query = `SELECT * FROM sessions WHERE execution_mode = 'e2b'`;
    const params: unknown[] = [];

    if (repoPath) {
      query += ' AND repo_path = ?';
      params.push(repoPath);
    }

    query += ' ORDER BY created_at DESC';

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as E2BSessionRow[];
    return rows.map(row => this.rowToE2BSession(row));
  }

  /**
   * Clean up E2B session (mark as completed/failed and optionally delete)
   *
   * @param sandboxId - Sandbox ID
   * @param finalStatus - Final status (COMPLETED, FAILED, or TIMEOUT)
   * @param deleteSession - Whether to delete the session from database
   * @returns true if session was cleaned up
   */
  cleanupE2BSession(
    sandboxId: string,
    finalStatus: SandboxStatus.COMPLETED | SandboxStatus.FAILED | SandboxStatus.TIMEOUT,
    deleteSession = false
  ): boolean {
    if (deleteSession) {
      const session = this.getE2BSessionBySandboxId(sandboxId);
      if (session) {
        const deleted = this.deleteSession(session.id);
        if (deleted) {
          logger.info(`Deleted E2B session for sandbox ${sandboxId}`);
        }
        return deleted;
      }
      return false;
    } else {
      const updated = this.updateE2BSessionStatus(sandboxId, finalStatus);
      if (updated) {
        logger.info(`Cleaned up E2B session for sandbox ${sandboxId} with status ${finalStatus}`);
      }
      return updated;
    }
  }

  /**
   * Convert E2B session row to E2BSession model
   */
  private rowToE2BSession(row: E2BSessionRow): E2BSession {
    if (!row.sandbox_id || !row.prompt) {
      throw new Error(`Invalid E2B session row: missing required fields (sandbox_id: ${row.sandbox_id}, prompt: ${row.prompt})`);
    }

    return {
      id: row.id,
      pid: row.pid,
      repo_path: row.repo_path,
      worktree_path: row.worktree_path,
      worktree_name: row.worktree_name,
      is_main_repo: row.is_main_repo === 1,
      created_at: row.created_at,
      last_heartbeat: row.last_heartbeat,
      execution_mode: 'e2b',
      sandbox_id: row.sandbox_id,
      prompt: row.prompt,
      status: (row.status as SandboxStatus) || SandboxStatus.INITIALIZING,
      output_log: row.output_log || undefined
    };
  }

  // ============================================================================
  // Migration Runner (v1.0)
  // ============================================================================

  /**
   * Run a database migration with automatic backup
   *
   * @param version - Migration version (e.g., "1.0.0")
   * @throws Error if migration fails or file not found
   */
  async runMigration(version: string): Promise<void> {
    try {
      logger.info(`Starting migration to v${version}`);

      // Check current version
      const currentVersion = this.getSchemaVersion();
      logger.info(`Current schema version: ${currentVersion || 'none'}`);

      if (currentVersion === version) {
        logger.info(`Already at v${version}, skipping migration`);
        return;
      }

      // Create backup
      const dbPath = this.db.name;
      if (!existsSync(dbPath)) {
        throw new Error(`Database file not found: ${dbPath}`);
      }
      const backupPath = `${dbPath}.v${currentVersion || 'pre-migration'}.backup`;
      logger.info(`Creating backup at: ${backupPath}`);
      copyFileSync(dbPath, backupPath);

      // Read migration SQL
      const migrationPath = pathJoin(process.cwd(), 'migrations', `v${version}.sql`);
      if (!existsSync(migrationPath)) {
        throw new Error(`Migration file not found: ${migrationPath}`);
      }

      const migrationSQL = readFileSync(migrationPath, 'utf-8');
      logger.info('Executing migration SQL');

      // Run migration (already wrapped in transaction in SQL file)
      this.db.exec(migrationSQL);

      // Verify schema version was updated
      const newVersion = this.getSchemaVersion();
      if (newVersion !== version) {
        throw new Error(`Migration verification failed: expected version ${version}, got ${newVersion}`);
      }

      logger.info(`Migration to v${version} completed successfully`);
    } catch (error) {
      logger.error('Migration failed', error);
      throw error;
    }
  }

  /**
   * Rollback a migration by restoring from backup
   *
   * @param version - Version to rollback to (e.g., "0.5.0")
   * @throws Error if backup not found or restore fails
   */
  async rollbackMigration(version: string): Promise<void> {
    try {
      logger.warn(`Rolling back to v${version}`);

      const dbPath = this.db.name;
      const backupPath = `${dbPath}.v${version}.backup`;

      if (!existsSync(backupPath)) {
        throw new Error(`Backup file not found: ${backupPath}`);
      }

      // Close current database connection
      this.db.close();

      // Restore from backup
      logger.info(`Restoring database from: ${backupPath}`);
      copyFileSync(backupPath, dbPath);

      // Reconnect to database
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 5000');

      // Note: We don't call init() here because the restored database
      // already has all tables from the backup. init() would try to create
      // tables that already exist, which is safe due to IF NOT EXISTS,
      // but unnecessary.

      // Verify version
      const restoredVersion = this.getSchemaVersion();
      logger.info(`Rollback complete. Database restored to v${restoredVersion}`);
    } catch (error) {
      logger.error('Rollback failed', error);
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
