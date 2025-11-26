/**
 * SQLite database operations for session tracking
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { homedir } from 'os';
import type { Session, SessionRow, Config } from './types.js';
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

  close(): void {
    this.db.close();
  }
}
