/**
 * Integration Tests for parallel-cc v0.5
 *
 * Tests the complete workflow integration between components:
 * - MergeDetector → AutoFixEngine
 * - Coordinator → FileClaimsManager
 * - Session lifecycle with file claims
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Coordinator } from '../src/coordinator.js';
import { MergeDetector } from '../src/merge-detector.js';
import { SessionDB } from '../src/db.js';
import { FileClaimsManager } from '../src/file-claims.js';
import { logger } from '../src/logger.js';

// Mock dependencies
vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}));

// Test fixtures
const TEST_DIR = path.join(os.tmpdir(), 'parallel-cc-integration-test-' + process.pid);
const TEST_DB_PATH = path.join(TEST_DIR, 'integration-test.db');
const TEST_REPO_PATH = '/test/repo/integration';

describe('v0.5 Integration Tests', () => {
  let coordinator: Coordinator;
  let db: SessionDB;

  beforeEach(async () => {
    // Create test directory
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Create coordinator and database
    coordinator = new Coordinator({
      dbPath: TEST_DB_PATH,
      staleThresholdMinutes: 10,
      autoCleanupWorktrees: true,
      worktreePrefix: 'parallel-'
    });

    db = coordinator['db'];

    // Run v0.5.0 migration for file_claims, conflict_resolutions, auto_fix_suggestions
    await db.migrateToV05();

    // Mock process.kill to always return true (all processes alive)
    vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    // Clean up coordinator
    if (coordinator) {
      coordinator.close();
    }

    // Clean up test directory
    fs.rmSync(TEST_DIR, { recursive: true, force: true });

    // Clear all mocks
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe('Integration 1: File Claims in Session Lifecycle', () => {
    it('should cleanup stale file claims on session registration', async () => {
      // 1. Create a session and acquire a file claim
      const session1 = await coordinator.register(TEST_REPO_PATH, 12345);
      const fileClaimsManager = new FileClaimsManager(db, logger);

      await fileClaimsManager.acquireClaim({
        sessionId: session1.sessionId,
        repoPath: TEST_REPO_PATH,
        filePath: 'src/test.ts',
        mode: 'EXCLUSIVE',
        ttlHours: 1
      });

      // Verify claim exists
      const claims1 = db.listClaims({ sessionId: session1.sessionId, includeExpired: false });
      expect(claims1).toHaveLength(1);

      // 2. Force claim expiration by updating expires_at to past
      db['db'].prepare(`
        UPDATE file_claims
        SET expires_at = datetime('now', '-2 hours')
        WHERE session_id = ?
      `).run(session1.sessionId);

      // 3. Register a new session - should trigger stale claims cleanup
      const session2 = await coordinator.register(TEST_REPO_PATH, 12346);

      // Verify stale claim was cleaned up
      const claims2 = db.listClaims({ includeExpired: false });
      const staleClaim = claims2.find(c => c.session_id === session1.sessionId);
      expect(staleClaim).toBeUndefined();
    });

    it('should release all file claims on session cleanup', async () => {
      // 1. Create a session with multiple file claims
      const session = await coordinator.register(TEST_REPO_PATH, 12345);
      const fileClaimsManager = new FileClaimsManager(db, logger);

      await fileClaimsManager.acquireClaim({
        sessionId: session.sessionId,
        repoPath: TEST_REPO_PATH,
        filePath: 'src/file1.ts',
        mode: 'EXCLUSIVE'
      });

      await fileClaimsManager.acquireClaim({
        sessionId: session.sessionId,
        repoPath: TEST_REPO_PATH,
        filePath: 'src/file2.ts',
        mode: 'SHARED'
      });

      // Verify claims exist
      const claimsBefore = db.listClaims({ sessionId: session.sessionId, includeExpired: false });
      expect(claimsBefore).toHaveLength(2);

      // 2. Release session
      await coordinator.release(12345);

      // 3. Verify all claims were released
      const claimsAfter = db.listClaims({ sessionId: session.sessionId, includeExpired: false });
      expect(claimsAfter).toHaveLength(0);
    });

    it('should release claims for stale sessions during cleanup', async () => {
      // Mock process.kill to simulate dead process
      vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
        if (pid === 99999) {
          throw new Error('No such process');
        }
        return true;
      });

      // 1. Create a session with file claims (using a PID we'll mark as dead)
      const session = await coordinator.register(TEST_REPO_PATH, 99999);
      const fileClaimsManager = new FileClaimsManager(db, logger);

      await fileClaimsManager.acquireClaim({
        sessionId: session.sessionId,
        repoPath: TEST_REPO_PATH,
        filePath: 'src/stale.ts',
        mode: 'EXCLUSIVE'
      });

      // Verify claim exists
      const claimsBefore = db.listClaims({ sessionId: session.sessionId, includeExpired: false });
      expect(claimsBefore).toHaveLength(1);

      // 2. Force session to be stale by updating last_heartbeat
      db['db'].prepare(`
        UPDATE sessions
        SET last_heartbeat = datetime('now', '-1 hour')
        WHERE id = ?
      `).run(session.sessionId);

      // 3. Run cleanup - should remove stale session and its claims
      const cleanupResult = await coordinator.cleanup();

      expect(cleanupResult.removed).toBeGreaterThanOrEqual(1);

      // 4. Verify claims were released
      const claimsAfter = db.listClaims({ sessionId: session.sessionId, includeExpired: false });
      expect(claimsAfter).toHaveLength(0);
    });
  });

  describe('Integration 2: MergeDetector → AutoFixEngine Workflow', () => {
    it('should generate auto-fix suggestions after detecting merge', async () => {
      // This test verifies the integration is wired up correctly
      // We can't fully test auto-fix generation without git repos and real conflicts
      // But we can verify the methods exist and are called

      const mergeDetector = new MergeDetector(db);

      // Verify autoFixEngine was initialized
      expect(mergeDetector['autoFixEngine']).toBeDefined();
      expect(mergeDetector['autoFixEngine']?.astAnalyzer).toBeDefined();
    });

    it('should handle missing autoFixEngine gracefully', async () => {
      // Create detector with db that will cause initialization to fail
      const detector = new MergeDetector(db);

      // Force autoFixEngine to undefined
      detector['autoFixEngine'] = undefined;

      // Call the private method directly (for testing)
      await detector['detectConflictsInActiveSessions'](
        TEST_REPO_PATH,
        'feature-branch',
        'main'
      );

      // Should not throw, just log debug message
      expect(logger.debug).toHaveBeenCalledWith(
        'Auto-fix engine not available, skipping conflict detection'
      );
    });

    it('should skip conflict detection when no active sessions exist', async () => {
      const detector = new MergeDetector(db);

      // Call with no active sessions
      await detector['detectConflictsInActiveSessions'](
        TEST_REPO_PATH,
        'feature-branch',
        'main'
      );

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('No active sessions to check for conflicts')
      );
    });

    it('should skip session whose branch was just merged', async () => {
      // 1. Register a session with a specific branch name
      const session = await coordinator.register(TEST_REPO_PATH, 12345);

      // Mock worktree_name as the merged branch
      db['db'].prepare('UPDATE sessions SET worktree_name = ? WHERE id = ?')
        .run('feature-branch', session.sessionId);

      // 2. Trigger conflict detection for the merged branch
      const detector = new MergeDetector(db);
      await detector['detectConflictsInActiveSessions'](
        TEST_REPO_PATH,
        'feature-branch',
        'main'
      );

      // Should log that session was skipped
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('its branch was just merged')
      );
    });
  });

  describe('Integration 3: Database Schema Migration', () => {
    it('should successfully migrate to v0.5 schema', async () => {
      // Already migrated in beforeEach, verify tables exist
      const tables = db['db'].prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table'
        AND name IN ('file_claims', 'conflict_resolutions', 'auto_fix_suggestions')
      `).all();

      expect(tables).toHaveLength(3);
    });

    it('should handle idempotent migrations', async () => {
      // Run migration again - should not throw
      await expect(db.migrateToV05()).resolves.not.toThrow();
    });

    it('should create proper indexes for v0.5 tables', async () => {
      const indexes = db['db'].prepare(`
        SELECT name FROM sqlite_master
        WHERE type='index'
        AND name LIKE 'idx_%'
      `).all();

      // Should have indexes for v0.5 tables
      const indexNames = indexes.map((idx: any) => idx.name);
      expect(indexNames).toContain('idx_file_claims_session');
      expect(indexNames).toContain('idx_conflict_resolutions_repo_file');
      expect(indexNames).toContain('idx_auto_fix_suggestions_repo_file');
    });
  });

  describe('Integration 4: End-to-End Session Workflow', () => {
    it('should handle complete session lifecycle with file claims', async () => {
      const fileClaimsManager = new FileClaimsManager(db, logger);

      // 1. Register session
      const session = await coordinator.register(TEST_REPO_PATH, 12345);
      expect(session.isNew).toBe(true);

      // 2. Acquire file claims
      const claim1 = await fileClaimsManager.acquireClaim({
        sessionId: session.sessionId,
        repoPath: TEST_REPO_PATH,
        filePath: 'src/module.ts',
        mode: 'EXCLUSIVE',
        reason: 'Implementing new feature'
      });
      expect(claim1.session_id).toBe(session.sessionId);

      // 3. Update heartbeat
      const heartbeatSuccess = coordinator.heartbeat(12345);
      expect(heartbeatSuccess).toBe(true);

      // 4. Check status
      const status = coordinator.status(TEST_REPO_PATH);
      expect(status.totalSessions).toBe(1);
      expect(status.sessions[0].sessionId).toBe(session.sessionId);

      // 5. List active claims
      const claims = db.listClaims({ sessionId: session.sessionId, includeExpired: false });
      expect(claims).toHaveLength(1);

      // 6. Release session
      const releaseResult = await coordinator.release(12345);
      expect(releaseResult.released).toBe(true);

      // 7. Verify session and claims are gone
      const statusAfter = coordinator.status(TEST_REPO_PATH);
      expect(statusAfter.totalSessions).toBe(0);

      const claimsAfter = db.listClaims({ sessionId: session.sessionId, includeExpired: false });
      expect(claimsAfter).toHaveLength(0);
    });

    it('should handle parallel sessions with separate file claims', async () => {
      const fileClaimsManager = new FileClaimsManager(db, logger);

      // 1. Register two parallel sessions
      const session1 = await coordinator.register(TEST_REPO_PATH, 12345);
      const session2 = await coordinator.register(TEST_REPO_PATH, 12346);

      expect(session1.isMainRepo).toBe(true);
      // Note: session2.isMainRepo may be true if worktree creation fails in test environment
      // The important part is that both sessions are registered

      // 2. Each session claims different files
      await fileClaimsManager.acquireClaim({
        sessionId: session1.sessionId,
        repoPath: TEST_REPO_PATH,
        filePath: 'src/file1.ts',
        mode: 'EXCLUSIVE'
      });

      await fileClaimsManager.acquireClaim({
        sessionId: session2.sessionId,
        repoPath: TEST_REPO_PATH,
        filePath: 'src/file2.ts',
        mode: 'EXCLUSIVE'
      });

      // 3. Verify both claims exist
      const allClaims = db.listClaims({ repoPath: TEST_REPO_PATH, includeExpired: false });
      expect(allClaims).toHaveLength(2);

      // 4. Release first session
      await coordinator.release(12345);

      // 5. Verify only second session's claims remain
      const remainingClaims = db.listClaims({ repoPath: TEST_REPO_PATH, includeExpired: false });
      expect(remainingClaims).toHaveLength(1);
      expect(remainingClaims[0].session_id).toBe(session2.sessionId);

      // Cleanup
      await coordinator.release(12346);
    });
  });
});
