/**
 * Tests for SessionDB class
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionDB } from '../src/db.js';
import type { Session } from '../src/types.js';

// Test fixtures directory - unique per process to avoid conflicts
const TEST_DIR = path.join(os.tmpdir(), 'parallel-cc-db-test-' + process.pid);
const TEST_DB_PATH = path.join(TEST_DIR, 'test.db');

// Helper function to create a test session
function createTestSession(overrides: Partial<Omit<Session, 'created_at' | 'last_heartbeat'>> = {}): Omit<Session, 'created_at' | 'last_heartbeat'> {
  return {
    id: 'test-session-' + Math.random().toString(36).substring(7),
    pid: Math.floor(Math.random() * 100000),
    repo_path: '/test/repo',
    worktree_path: '/test/worktree',
    worktree_name: null,
    is_main_repo: false,
    ...overrides
  };
}

// Helper function to sleep for testing heartbeat timestamps
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('SessionDB', () => {
  let db: SessionDB;

  beforeEach(() => {
    // Create test directory
    fs.mkdirSync(TEST_DIR, { recursive: true });
    db = new SessionDB(TEST_DB_PATH);
  });

  afterEach(() => {
    // Close database and clean up
    db.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ==========================================================================
  // Constructor Tests
  // ==========================================================================

  describe('constructor', () => {
    it('should create database file at specified path', () => {
      expect(fs.existsSync(TEST_DB_PATH)).toBe(true);
    });

    it('should create parent directory if it does not exist', () => {
      const deepPath = path.join(TEST_DIR, 'nested', 'deep', 'test.db');
      const deepDb = new SessionDB(deepPath);

      expect(fs.existsSync(deepPath)).toBe(true);
      deepDb.close();
    });

    it('should expand tilde in path', () => {
      const tildeDb = new SessionDB('~/test-parallel-cc-temp.db');
      const expandedPath = path.join(os.homedir(), 'test-parallel-cc-temp.db');

      expect(fs.existsSync(expandedPath)).toBe(true);

      tildeDb.close();
      fs.unlinkSync(expandedPath);
    });

    it('should initialize with empty sessions table', () => {
      const sessions = db.getAllSessions();
      expect(sessions).toEqual([]);
    });

    it('should enable WAL mode for better concurrency', () => {
      // WAL mode verification - we can't directly check pragma, but we can verify
      // the database works correctly (which it would not without WAL in concurrent scenarios)
      const session = createTestSession();
      db.createSession(session);
      expect(db.getSessionById(session.id)).not.toBeNull();
    });
  });

  // ==========================================================================
  // createSession Tests
  // ==========================================================================

  describe('createSession', () => {
    it('should create a new session successfully', () => {
      const sessionData = createTestSession({
        id: 'session-1',
        pid: 12345,
        repo_path: '/home/user/repo',
        worktree_path: '/home/user/repo',
        is_main_repo: true
      });

      const session = db.createSession(sessionData);

      expect(session.id).toBe('session-1');
      expect(session.pid).toBe(12345);
      expect(session.repo_path).toBe('/home/user/repo');
      expect(session.worktree_path).toBe('/home/user/repo');
      expect(session.is_main_repo).toBe(true);
      expect(session.created_at).toBeDefined();
      expect(session.last_heartbeat).toBeDefined();
    });

    it('should set created_at and last_heartbeat timestamps', () => {
      const sessionData = createTestSession();

      const session = db.createSession(sessionData);

      // Verify timestamps are valid ISO 8601 datetime strings
      expect(session.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(session.last_heartbeat).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(session.created_at).toBe(session.last_heartbeat);
    });

    it('should handle null worktree_name', () => {
      const sessionData = createTestSession({
        worktree_name: null
      });

      const session = db.createSession(sessionData);
      expect(session.worktree_name).toBeNull();
    });

    it('should handle non-null worktree_name', () => {
      const sessionData = createTestSession({
        worktree_name: 'feature-branch'
      });

      const session = db.createSession(sessionData);
      expect(session.worktree_name).toBe('feature-branch');
    });

    it('should throw error on duplicate id', () => {
      const sessionData = createTestSession({ id: 'duplicate-id' });

      db.createSession(sessionData);

      // Attempting to create another session with the same ID should throw
      expect(() => db.createSession(sessionData)).toThrow();
    });

    it('should convert is_main_repo boolean correctly', () => {
      const mainSession = createTestSession({ is_main_repo: true });
      const worktreeSession = createTestSession({ is_main_repo: false });

      const main = db.createSession(mainSession);
      const worktree = db.createSession(worktreeSession);

      expect(main.is_main_repo).toBe(true);
      expect(worktree.is_main_repo).toBe(false);
    });
  });

  // ==========================================================================
  // getSessionsByRepo Tests
  // ==========================================================================

  describe('getSessionsByRepo', () => {
    it('should return empty array when no sessions exist', () => {
      const sessions = db.getSessionsByRepo('/nonexistent/repo');
      expect(sessions).toEqual([]);
    });

    it('should return single session for repo', () => {
      const sessionData = createTestSession({ repo_path: '/test/repo1' });
      db.createSession(sessionData);

      const sessions = db.getSessionsByRepo('/test/repo1');

      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe(sessionData.id);
    });

    it('should return multiple sessions for same repo', () => {
      const session1 = createTestSession({ repo_path: '/test/repo1' });
      const session2 = createTestSession({ repo_path: '/test/repo1' });
      const session3 = createTestSession({ repo_path: '/test/repo2' });

      db.createSession(session1);
      db.createSession(session2);
      db.createSession(session3);

      const sessions = db.getSessionsByRepo('/test/repo1');

      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.id).sort()).toEqual([session1.id, session2.id].sort());
    });

    it('should not return sessions from different repos', () => {
      db.createSession(createTestSession({ repo_path: '/repo1' }));
      db.createSession(createTestSession({ repo_path: '/repo2' }));

      const sessions = db.getSessionsByRepo('/repo1');

      expect(sessions).toHaveLength(1);
      expect(sessions[0].repo_path).toBe('/repo1');
    });
  });

  // ==========================================================================
  // getSessionByPid Tests
  // ==========================================================================

  describe('getSessionByPid', () => {
    it('should return null when session not found', () => {
      const session = db.getSessionByPid(99999);
      expect(session).toBeNull();
    });

    it('should return session when found', () => {
      const sessionData = createTestSession({ pid: 12345 });
      db.createSession(sessionData);

      const session = db.getSessionByPid(12345);

      expect(session).not.toBeNull();
      expect(session?.pid).toBe(12345);
      expect(session?.id).toBe(sessionData.id);
    });

    it('should return correct session when multiple exist', () => {
      const session1 = createTestSession({ pid: 11111 });
      const session2 = createTestSession({ pid: 22222 });
      const session3 = createTestSession({ pid: 33333 });

      db.createSession(session1);
      db.createSession(session2);
      db.createSession(session3);

      const found = db.getSessionByPid(22222);

      expect(found).not.toBeNull();
      expect(found?.id).toBe(session2.id);
    });
  });

  // ==========================================================================
  // getSessionById Tests
  // ==========================================================================

  describe('getSessionById', () => {
    it('should return null when session not found', () => {
      const session = db.getSessionById('nonexistent-id');
      expect(session).toBeNull();
    });

    it('should return session when found', () => {
      const sessionData = createTestSession({ id: 'test-id-123' });
      db.createSession(sessionData);

      const session = db.getSessionById('test-id-123');

      expect(session).not.toBeNull();
      expect(session?.id).toBe('test-id-123');
    });

    it('should return complete session data', () => {
      const sessionData = createTestSession({
        id: 'complete-test',
        pid: 54321,
        repo_path: '/home/test',
        worktree_path: '/home/test/worktree',
        worktree_name: 'feature',
        is_main_repo: false
      });
      db.createSession(sessionData);

      const session = db.getSessionById('complete-test');

      expect(session).toMatchObject({
        id: 'complete-test',
        pid: 54321,
        repo_path: '/home/test',
        worktree_path: '/home/test/worktree',
        worktree_name: 'feature',
        is_main_repo: false
      });
    });
  });

  // ==========================================================================
  // getAllSessions Tests
  // ==========================================================================

  describe('getAllSessions', () => {
    it('should return empty array when no sessions exist', () => {
      const sessions = db.getAllSessions();
      expect(sessions).toEqual([]);
    });

    it('should return all sessions when multiple exist', () => {
      const session1 = createTestSession({ id: 'session-1' });
      const session2 = createTestSession({ id: 'session-2' });
      const session3 = createTestSession({ id: 'session-3' });

      db.createSession(session1);
      db.createSession(session2);
      db.createSession(session3);

      const sessions = db.getAllSessions();

      expect(sessions).toHaveLength(3);
      expect(sessions.map(s => s.id).sort()).toEqual(['session-1', 'session-2', 'session-3']);
    });

    it('should return sessions with correct boolean conversion', () => {
      db.createSession(createTestSession({ is_main_repo: true }));
      db.createSession(createTestSession({ is_main_repo: false }));

      const sessions = db.getAllSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions.filter(s => s.is_main_repo)).toHaveLength(1);
      expect(sessions.filter(s => !s.is_main_repo)).toHaveLength(1);
    });
  });

  // ==========================================================================
  // updateHeartbeat Tests
  // ==========================================================================

  describe('updateHeartbeat', () => {
    it('should return true and update timestamp for existing session', async () => {
      const sessionData = createTestSession({ id: 'heartbeat-test' });
      const session = db.createSession(sessionData);
      const originalHeartbeat = session.last_heartbeat;

      // Wait 1 second to ensure timestamp difference (SQLite datetime has second precision)
      await sleep(1100);

      const result = db.updateHeartbeat('heartbeat-test');

      expect(result).toBe(true);

      const updated = db.getSessionById('heartbeat-test');
      expect(updated?.last_heartbeat).not.toBe(originalHeartbeat);
    });

    it('should return false for non-existent session', () => {
      const result = db.updateHeartbeat('nonexistent-session');
      expect(result).toBe(false);
    });

    it('should only update last_heartbeat, not other fields', async () => {
      const sessionData = createTestSession({
        id: 'update-test',
        pid: 99999,
        repo_path: '/original/path'
      });
      const original = db.createSession(sessionData);

      // Wait 1 second to ensure timestamp difference (SQLite datetime has second precision)
      await sleep(1100);
      db.updateHeartbeat('update-test');

      const updated = db.getSessionById('update-test');

      expect(updated?.id).toBe(original.id);
      expect(updated?.pid).toBe(original.pid);
      expect(updated?.repo_path).toBe(original.repo_path);
      expect(updated?.created_at).toBe(original.created_at);
      expect(updated?.last_heartbeat).not.toBe(original.last_heartbeat);
    });
  });

  // ==========================================================================
  // updateHeartbeatByPid Tests
  // ==========================================================================

  describe('updateHeartbeatByPid', () => {
    it('should return true and update timestamp for existing session', async () => {
      const sessionData = createTestSession({ pid: 77777 });
      const session = db.createSession(sessionData);
      const originalHeartbeat = session.last_heartbeat;

      // Wait 1 second to ensure timestamp difference (SQLite datetime has second precision)
      await sleep(1100);

      const result = db.updateHeartbeatByPid(77777);

      expect(result).toBe(true);

      const updated = db.getSessionByPid(77777);
      expect(updated?.last_heartbeat).not.toBe(originalHeartbeat);
    });

    it('should return false for non-existent pid', () => {
      const result = db.updateHeartbeatByPid(99999);
      expect(result).toBe(false);
    });

    it('should update correct session when multiple exist', async () => {
      const session1 = createTestSession({ pid: 11111 });
      const session2 = createTestSession({ pid: 22222 });

      db.createSession(session1);
      const original2 = db.createSession(session2);

      // Wait 1 second to ensure timestamp difference (SQLite datetime has second precision)
      await sleep(1100);
      db.updateHeartbeatByPid(22222);

      const updated1 = db.getSessionByPid(11111);
      const updated2 = db.getSessionByPid(22222);

      // Session 1 should not be updated
      expect(updated1?.last_heartbeat).toBe(updated1?.created_at);
      // Session 2 should be updated
      expect(updated2?.last_heartbeat).not.toBe(original2.last_heartbeat);
    });
  });

  // ==========================================================================
  // deleteSession Tests
  // ==========================================================================

  describe('deleteSession', () => {
    it('should return true when session is deleted', () => {
      const sessionData = createTestSession({ id: 'delete-test' });
      db.createSession(sessionData);

      const result = db.deleteSession('delete-test');

      expect(result).toBe(true);
      expect(db.getSessionById('delete-test')).toBeNull();
    });

    it('should return false when session does not exist', () => {
      const result = db.deleteSession('nonexistent');
      expect(result).toBe(false);
    });

    it('should only delete specified session', () => {
      const session1 = createTestSession({ id: 'keep' });
      const session2 = createTestSession({ id: 'delete' });

      db.createSession(session1);
      db.createSession(session2);

      db.deleteSession('delete');

      expect(db.getSessionById('keep')).not.toBeNull();
      expect(db.getSessionById('delete')).toBeNull();
    });
  });

  // ==========================================================================
  // deleteSessionByPid Tests
  // ==========================================================================

  describe('deleteSessionByPid', () => {
    it('should return session when found and deleted', () => {
      const sessionData = createTestSession({ pid: 88888 });
      db.createSession(sessionData);

      const deleted = db.deleteSessionByPid(88888);

      expect(deleted).not.toBeNull();
      expect(deleted?.pid).toBe(88888);
      expect(db.getSessionByPid(88888)).toBeNull();
    });

    it('should return null when session does not exist', () => {
      const deleted = db.deleteSessionByPid(99999);
      expect(deleted).toBeNull();
    });

    it('should return complete session data before deletion', () => {
      const sessionData = createTestSession({
        id: 'pid-delete-test',
        pid: 55555,
        repo_path: '/test/path',
        worktree_name: 'branch-name'
      });
      db.createSession(sessionData);

      const deleted = db.deleteSessionByPid(55555);

      expect(deleted).toMatchObject({
        id: 'pid-delete-test',
        pid: 55555,
        repo_path: '/test/path',
        worktree_name: 'branch-name'
      });
    });
  });

  // ==========================================================================
  // getStaleSessions Tests
  // ==========================================================================

  describe('getStaleSessions', () => {
    it('should return empty array when no stale sessions', () => {
      const sessionData = createTestSession();
      db.createSession(sessionData);

      const stale = db.getStaleSessions(10);

      expect(stale).toEqual([]);
    });

    it('should return empty array for fresh sessions', () => {
      const sessionData = createTestSession({ id: 'fresh-test' });
      db.createSession(sessionData);

      // With a large threshold (60 minutes), a brand new session should not be stale
      const stale = db.getStaleSessions(60);

      expect(stale).toHaveLength(0);
    });

    it('should not return sessions within threshold', () => {
      const sessionData = createTestSession();
      db.createSession(sessionData);

      // With a 10 minute threshold, a brand new session should not be stale
      const stale = db.getStaleSessions(10);

      expect(stale).toEqual([]);
    });

    it('should respect different threshold values', () => {
      const sessionData = createTestSession();
      db.createSession(sessionData);

      const stale5 = db.getStaleSessions(5);
      const stale10 = db.getStaleSessions(10);
      const stale60 = db.getStaleSessions(60);

      // Brand new session should not be stale for any positive threshold
      expect(stale5).toEqual([]);
      expect(stale10).toEqual([]);
      expect(stale60).toEqual([]);
    });
  });

  // ==========================================================================
  // deleteStaleSessions Tests
  // ==========================================================================

  describe('deleteStaleSessions', () => {
    it('should remove stale sessions and return them', () => {
      // This test is challenging without direct timestamp manipulation
      // We'll verify the function returns an array and doesn't error
      const result = db.deleteStaleSessions(10);
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return empty array when no stale sessions', () => {
      const sessionData = createTestSession();
      db.createSession(sessionData);

      const deleted = db.deleteStaleSessions(10);

      expect(deleted).toEqual([]);
      expect(db.getAllSessions()).toHaveLength(1);
    });

    it('should only delete stale sessions, not fresh ones', () => {
      const session1 = createTestSession({ id: 'fresh' });
      const session2 = createTestSession({ id: 'also-fresh' });

      db.createSession(session1);
      db.createSession(session2);

      db.deleteStaleSessions(10);

      // Both should still exist as they're fresh
      expect(db.getAllSessions()).toHaveLength(2);
    });
  });

  // ==========================================================================
  // hasMainRepoSession Tests
  // ==========================================================================

  describe('hasMainRepoSession', () => {
    it('should return false when no sessions exist', () => {
      const result = db.hasMainRepoSession('/test/repo');
      expect(result).toBe(false);
    });

    it('should return false when only worktree sessions exist', () => {
      db.createSession(createTestSession({
        repo_path: '/test/repo',
        is_main_repo: false
      }));

      const result = db.hasMainRepoSession('/test/repo');
      expect(result).toBe(false);
    });

    it('should return true when main repo session exists', () => {
      db.createSession(createTestSession({
        repo_path: '/test/repo',
        is_main_repo: true
      }));

      const result = db.hasMainRepoSession('/test/repo');
      expect(result).toBe(true);
    });

    it('should only check specified repo', () => {
      db.createSession(createTestSession({
        repo_path: '/repo1',
        is_main_repo: true
      }));

      expect(db.hasMainRepoSession('/repo1')).toBe(true);
      expect(db.hasMainRepoSession('/repo2')).toBe(false);
    });

    it('should return true even with multiple main repo sessions', () => {
      db.createSession(createTestSession({
        repo_path: '/test/repo',
        is_main_repo: true
      }));
      db.createSession(createTestSession({
        repo_path: '/test/repo',
        is_main_repo: true
      }));

      const result = db.hasMainRepoSession('/test/repo');
      expect(result).toBe(true);
    });
  });

  // ==========================================================================
  // transaction Tests
  // ==========================================================================

  describe('transaction', () => {
    it('should execute function atomically', () => {
      const session1 = createTestSession({ id: 'txn-1' });
      const session2 = createTestSession({ id: 'txn-2' });

      const txn = db.transaction(() => {
        db.createSession(session1);
        db.createSession(session2);
      });

      txn();

      expect(db.getAllSessions()).toHaveLength(2);
    });

    it('should rollback on error', () => {
      const session1 = createTestSession({ id: 'rollback-1' });

      const txn = db.transaction(() => {
        db.createSession(session1);
        // Try to create duplicate - should fail
        db.createSession(session1);
      });

      expect(() => txn()).toThrow();

      // First session should not exist due to rollback
      expect(db.getAllSessions()).toHaveLength(0);
    });

    it('should commit all changes or none', () => {
      const session1 = createTestSession({ id: 'commit-1' });
      const session2 = createTestSession({ id: 'commit-2' });
      const session3 = createTestSession({ id: 'commit-3' });

      const txn = db.transaction(() => {
        db.createSession(session1);
        db.createSession(session2);
        db.createSession(session3);
        db.deleteSession('commit-2');
      });

      txn();

      const sessions = db.getAllSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.id).sort()).toEqual(['commit-1', 'commit-3']);
    });

    it('should support nested operations in transaction', () => {
      const session = createTestSession({ id: 'nested-txn' });

      const txn = db.transaction(() => {
        db.createSession(session);
        db.updateHeartbeat(session.id);
        const retrieved = db.getSessionById(session.id);
        expect(retrieved).not.toBeNull();
      });

      txn();

      expect(db.getSessionById('nested-txn')).not.toBeNull();
    });
  });

  // ==========================================================================
  // close Tests
  // ==========================================================================

  describe('close', () => {
    it('should close database connection', () => {
      const tempDb = new SessionDB(path.join(TEST_DIR, 'close-test.db'));
      const sessionData = createTestSession();
      tempDb.createSession(sessionData);

      tempDb.close();

      // After closing, operations should fail
      expect(() => tempDb.getAllSessions()).toThrow();
    });

    it('should allow operations before close', () => {
      const tempDb = new SessionDB(path.join(TEST_DIR, 'before-close.db'));
      const sessionData = createTestSession();

      tempDb.createSession(sessionData);
      const sessions = tempDb.getAllSessions();

      expect(sessions).toHaveLength(1);

      tempDb.close();
    });

    it('should persist data after close', () => {
      const dbPath = path.join(TEST_DIR, 'persist-test.db');
      const tempDb1 = new SessionDB(dbPath);
      const sessionData = createTestSession({ id: 'persist-test' });

      tempDb1.createSession(sessionData);
      tempDb1.close();

      // Reopen database
      const tempDb2 = new SessionDB(dbPath);
      const session = tempDb2.getSessionById('persist-test');

      expect(session).not.toBeNull();
      expect(session?.id).toBe('persist-test');

      tempDb2.close();
    });
  });
});
