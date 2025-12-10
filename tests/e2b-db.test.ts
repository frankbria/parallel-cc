/**
 * Tests for E2B database operations (v1.0)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionDB } from '../src/db.js';
import { SandboxStatus } from '../src/types.js';
import { randomUUID } from 'crypto';
import { existsSync, unlinkSync, readdirSync } from 'fs';
import path from 'path';

describe('E2B Database Operations', () => {
  let db: SessionDB;
  const testDbPath = './test-e2b.db';

  beforeEach(async () => {
    // Clean up any existing test database
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    db = new SessionDB(testDbPath);

    // Run migrations to get to v1.0.0 schema
    await db.migrateToV05();

    // Save current directory and switch to project root for migration
    const originalCwd = process.cwd();
    const projectRoot = path.resolve(__dirname, '..');
    process.chdir(projectRoot);

    try {
      await db.runMigration('1.0.0');
    } finally {
      process.chdir(originalCwd);
    }
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    // Clean up all backup files
    try {
      const files = readdirSync('.');
      const backupPattern = /test-e2b\.db.*\.backup$/;
      files.forEach((file: string) => {
        if (backupPattern.test(file)) {
          unlinkSync(file);
        }
      });
    } catch (error) {
      // Ignore errors during cleanup
    }
  });

  describe('createE2BSession', () => {
    it('should create an E2B session with all required fields', () => {
      const sessionId = randomUUID();
      const sandboxId = `sb_${randomUUID()}`;
      const prompt = 'Test task: implement feature X';

      const session = db.createE2BSession({
        id: sessionId,
        pid: 12345,
        repo_path: '/path/to/repo',
        worktree_path: '/path/to/worktree',
        worktree_name: 'parallel-e2b-123',
        sandbox_id: sandboxId,
        prompt: prompt
      });

      expect(session.id).toBe(sessionId);
      expect(session.execution_mode).toBe('e2b');
      expect(session.sandbox_id).toBe(sandboxId);
      expect(session.prompt).toBe(prompt);
      expect(session.status).toBe(SandboxStatus.INITIALIZING);
      expect(session.is_main_repo).toBe(false);
    });

    it('should create E2B session with custom status', () => {
      const sessionId = randomUUID();
      const sandboxId = `sb_${randomUUID()}`;

      const session = db.createE2BSession({
        id: sessionId,
        pid: 12345,
        repo_path: '/path/to/repo',
        worktree_path: '/path/to/worktree',
        worktree_name: null,
        sandbox_id: sandboxId,
        prompt: 'Test prompt',
        status: SandboxStatus.RUNNING
      });

      expect(session.status).toBe(SandboxStatus.RUNNING);
    });

    it('should set is_main_repo to false for E2B sessions', () => {
      const sessionId = randomUUID();
      const sandboxId = `sb_${randomUUID()}`;

      const session = db.createE2BSession({
        id: sessionId,
        pid: 12345,
        repo_path: '/path/to/repo',
        worktree_path: '/path/to/worktree',
        worktree_name: null,
        sandbox_id: sandboxId,
        prompt: 'Test prompt'
      });

      expect(session.is_main_repo).toBe(false);
    });
  });

  describe('updateE2BSessionStatus', () => {
    it('should update session status', () => {
      const sessionId = randomUUID();
      const sandboxId = `sb_${randomUUID()}`;

      db.createE2BSession({
        id: sessionId,
        pid: 12345,
        repo_path: '/path/to/repo',
        worktree_path: '/path/to/worktree',
        worktree_name: null,
        sandbox_id: sandboxId,
        prompt: 'Test prompt'
      });

      const updated = db.updateE2BSessionStatus(sandboxId, SandboxStatus.RUNNING);
      expect(updated).toBe(true);

      const session = db.getE2BSessionBySandboxId(sandboxId);
      expect(session?.status).toBe(SandboxStatus.RUNNING);
    });

    it('should update status and output log', () => {
      const sessionId = randomUUID();
      const sandboxId = `sb_${randomUUID()}`;

      db.createE2BSession({
        id: sessionId,
        pid: 12345,
        repo_path: '/path/to/repo',
        worktree_path: '/path/to/worktree',
        worktree_name: null,
        sandbox_id: sandboxId,
        prompt: 'Test prompt'
      });

      const outputLog = 'Task started\nExecuting command...\nSuccess!';
      const updated = db.updateE2BSessionStatus(sandboxId, SandboxStatus.COMPLETED, outputLog);
      expect(updated).toBe(true);

      const session = db.getE2BSessionBySandboxId(sandboxId);
      expect(session?.status).toBe(SandboxStatus.COMPLETED);
      expect(session?.output_log).toBe(outputLog);
    });

    it('should return false for non-existent sandbox', () => {
      const updated = db.updateE2BSessionStatus('sb_nonexistent', SandboxStatus.FAILED);
      expect(updated).toBe(false);
    });

    it('should update heartbeat timestamp when updating status', async () => {
      const sessionId = randomUUID();
      const sandboxId = `sb_${randomUUID()}`;

      const session = db.createE2BSession({
        id: sessionId,
        pid: 12345,
        repo_path: '/path/to/repo',
        worktree_path: '/path/to/worktree',
        worktree_name: null,
        sandbox_id: sandboxId,
        prompt: 'Test prompt'
      });

      const initialHeartbeat = session.last_heartbeat;

      // Wait to ensure timestamp changes (SQLite datetime precision is 1 second)
      await new Promise(resolve => setTimeout(resolve, 1100));

      db.updateE2BSessionStatus(sandboxId, SandboxStatus.RUNNING);
      const updated = db.getE2BSessionBySandboxId(sandboxId);
      expect(updated?.last_heartbeat).not.toBe(initialHeartbeat);
    });
  });

  describe('getE2BSessionBySandboxId', () => {
    it('should retrieve E2B session by sandbox ID', () => {
      const sessionId = randomUUID();
      const sandboxId = `sb_${randomUUID()}`;
      const prompt = 'Test task';

      db.createE2BSession({
        id: sessionId,
        pid: 12345,
        repo_path: '/path/to/repo',
        worktree_path: '/path/to/worktree',
        worktree_name: null,
        sandbox_id: sandboxId,
        prompt: prompt
      });

      const retrieved = db.getE2BSessionBySandboxId(sandboxId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.sandbox_id).toBe(sandboxId);
      expect(retrieved?.prompt).toBe(prompt);
    });

    it('should return null for non-existent sandbox ID', () => {
      const retrieved = db.getE2BSessionBySandboxId('sb_nonexistent');
      expect(retrieved).toBeNull();
    });

    it('should not return local sessions when querying by sandbox ID', () => {
      // Create a local session
      db.createSession({
        id: randomUUID(),
        pid: 11111,
        repo_path: '/path/to/repo',
        worktree_path: '/path/to/repo',
        worktree_name: null,
        is_main_repo: true
      });

      const retrieved = db.getE2BSessionBySandboxId('sb_any');
      expect(retrieved).toBeNull();
    });
  });

  describe('listE2BSessions', () => {
    it('should list all E2B sessions', () => {
      db.createE2BSession({
        id: randomUUID(),
        pid: 1,
        repo_path: '/repo1',
        worktree_path: '/worktree1',
        worktree_name: null,
        sandbox_id: `sb_${randomUUID()}`,
        prompt: 'Task 1'
      });

      db.createE2BSession({
        id: randomUUID(),
        pid: 2,
        repo_path: '/repo2',
        worktree_path: '/worktree2',
        worktree_name: null,
        sandbox_id: `sb_${randomUUID()}`,
        prompt: 'Task 2'
      });

      const sessions = db.listE2BSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.every(s => s.execution_mode === 'e2b')).toBe(true);
    });

    it('should filter E2B sessions by repo path', () => {
      db.createE2BSession({
        id: randomUUID(),
        pid: 1,
        repo_path: '/repo1',
        worktree_path: '/worktree1',
        worktree_name: null,
        sandbox_id: `sb_${randomUUID()}`,
        prompt: 'Task 1'
      });

      db.createE2BSession({
        id: randomUUID(),
        pid: 2,
        repo_path: '/repo2',
        worktree_path: '/worktree2',
        worktree_name: null,
        sandbox_id: `sb_${randomUUID()}`,
        prompt: 'Task 2'
      });

      const filtered = db.listE2BSessions('/repo1');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].repo_path).toBe('/repo1');
    });

    it('should not include local sessions in E2B session list', () => {
      // Create local session
      db.createSession({
        id: randomUUID(),
        pid: 99999,
        repo_path: '/repo1',
        worktree_path: '/repo1',
        worktree_name: null,
        is_main_repo: true
      });

      // Create E2B session
      db.createE2BSession({
        id: randomUUID(),
        pid: 1,
        repo_path: '/repo1',
        worktree_path: '/worktree1',
        worktree_name: null,
        sandbox_id: `sb_${randomUUID()}`,
        prompt: 'Task 1'
      });

      const e2bSessions = db.listE2BSessions('/repo1');
      expect(e2bSessions).toHaveLength(1);
      expect(e2bSessions[0].execution_mode).toBe('e2b');
    });

    it('should return sessions ordered by created_at DESC', async () => {
      const session1 = db.createE2BSession({
        id: randomUUID(),
        pid: 1,
        repo_path: '/repo1',
        worktree_path: '/worktree1',
        worktree_name: null,
        sandbox_id: `sb_${randomUUID()}`,
        prompt: 'Task 1'
      });

      // Wait to ensure different timestamps (SQLite datetime precision is 1 second)
      await new Promise(resolve => setTimeout(resolve, 1100));

      const session2 = db.createE2BSession({
        id: randomUUID(),
        pid: 2,
        repo_path: '/repo1',
        worktree_path: '/worktree2',
        worktree_name: null,
        sandbox_id: `sb_${randomUUID()}`,
        prompt: 'Task 2'
      });

      const sessions = db.listE2BSessions();
      expect(sessions[0].id).toBe(session2.id); // Most recent first
    });
  });

  describe('cleanupE2BSession', () => {
    it('should update status without deleting session', () => {
      const sessionId = randomUUID();
      const sandboxId = `sb_${randomUUID()}`;

      db.createE2BSession({
        id: sessionId,
        pid: 12345,
        repo_path: '/path/to/repo',
        worktree_path: '/path/to/worktree',
        worktree_name: null,
        sandbox_id: sandboxId,
        prompt: 'Test prompt'
      });

      const cleaned = db.cleanupE2BSession(sandboxId, SandboxStatus.COMPLETED, false);
      expect(cleaned).toBe(true);

      const session = db.getE2BSessionBySandboxId(sandboxId);
      expect(session).not.toBeNull();
      expect(session?.status).toBe(SandboxStatus.COMPLETED);
    });

    it('should delete session when deleteSession is true', () => {
      const sessionId = randomUUID();
      const sandboxId = `sb_${randomUUID()}`;

      db.createE2BSession({
        id: sessionId,
        pid: 12345,
        repo_path: '/path/to/repo',
        worktree_path: '/path/to/worktree',
        worktree_name: null,
        sandbox_id: sandboxId,
        prompt: 'Test prompt'
      });

      const cleaned = db.cleanupE2BSession(sandboxId, SandboxStatus.COMPLETED, true);
      expect(cleaned).toBe(true);

      const session = db.getE2BSessionBySandboxId(sandboxId);
      expect(session).toBeNull();
    });

    it('should handle cleanup of FAILED sessions', () => {
      const sessionId = randomUUID();
      const sandboxId = `sb_${randomUUID()}`;

      db.createE2BSession({
        id: sessionId,
        pid: 12345,
        repo_path: '/path/to/repo',
        worktree_path: '/path/to/worktree',
        worktree_name: null,
        sandbox_id: sandboxId,
        prompt: 'Test prompt'
      });

      const cleaned = db.cleanupE2BSession(sandboxId, SandboxStatus.FAILED, false);
      expect(cleaned).toBe(true);

      const session = db.getE2BSessionBySandboxId(sandboxId);
      expect(session?.status).toBe(SandboxStatus.FAILED);
    });

    it('should handle cleanup of TIMEOUT sessions', () => {
      const sessionId = randomUUID();
      const sandboxId = `sb_${randomUUID()}`;

      db.createE2BSession({
        id: sessionId,
        pid: 12345,
        repo_path: '/path/to/repo',
        worktree_path: '/path/to/worktree',
        worktree_name: null,
        sandbox_id: sandboxId,
        prompt: 'Test prompt'
      });

      const cleaned = db.cleanupE2BSession(sandboxId, SandboxStatus.TIMEOUT, false);
      expect(cleaned).toBe(true);

      const session = db.getE2BSessionBySandboxId(sandboxId);
      expect(session?.status).toBe(SandboxStatus.TIMEOUT);
    });

    it('should return false for non-existent sandbox', () => {
      const cleaned = db.cleanupE2BSession('sb_nonexistent', SandboxStatus.COMPLETED, false);
      expect(cleaned).toBe(false);
    });
  });

  describe('Backward Compatibility', () => {
    it('should allow creating local sessions without E2B fields', () => {
      const sessionId = randomUUID();
      const session = db.createSession({
        id: sessionId,
        pid: 12345,
        repo_path: '/path/to/repo',
        worktree_path: '/path/to/repo',
        worktree_name: null,
        is_main_repo: true
      });

      expect(session.id).toBe(sessionId);
      // After v1.0 migration, execution_mode defaults to 'local'
      expect(session.execution_mode).toBe('local');
      expect(session.sandbox_id).toBeUndefined();
      expect(session.prompt).toBeUndefined();
      expect(session.status).toBeUndefined();
    });

    it('should retrieve local sessions without E2B fields', () => {
      const sessionId = randomUUID();
      db.createSession({
        id: sessionId,
        pid: 12345,
        repo_path: '/path/to/repo',
        worktree_path: '/path/to/repo',
        worktree_name: null,
        is_main_repo: true
      });

      const retrieved = db.getSessionById(sessionId);
      expect(retrieved).not.toBeNull();
      // After v1.0 migration, execution_mode defaults to 'local'
      expect(retrieved?.execution_mode).toBe('local');
    });

    it('should list both local and E2B sessions with getAllSessions', () => {
      // Create local session
      db.createSession({
        id: randomUUID(),
        pid: 11111,
        repo_path: '/repo1',
        worktree_path: '/repo1',
        worktree_name: null,
        is_main_repo: true
      });

      // Create E2B session
      db.createE2BSession({
        id: randomUUID(),
        pid: 22222,
        repo_path: '/repo1',
        worktree_path: '/worktree1',
        worktree_name: null,
        sandbox_id: `sb_${randomUUID()}`,
        prompt: 'Test task'
      });

      const allSessions = db.getAllSessions();
      expect(allSessions).toHaveLength(2);
    });
  });

  describe('Type Safety', () => {
    it('should throw error for E2B session row without sandbox_id', () => {
      // This test validates that rowToE2BSession enforces required fields
      const sessionId = randomUUID();
      db.createE2BSession({
        id: sessionId,
        pid: 12345,
        repo_path: '/path/to/repo',
        worktree_path: '/path/to/worktree',
        worktree_name: null,
        sandbox_id: `sb_${randomUUID()}`,
        prompt: 'Test prompt'
      });

      // Manually corrupt data to test error handling
      db['db'].prepare('UPDATE sessions SET sandbox_id = NULL WHERE id = ?').run(sessionId);

      expect(() => {
        db.getSessionById(sessionId);
        // If it returns a session, try to convert it to E2B which should fail
      }).not.toThrow(); // Should not throw for local session

      // But listE2BSessions should fail if data is corrupt
      expect(() => {
        db.listE2BSessions();
      }).toThrow(/Invalid E2B session row/);
    });
  });
});
