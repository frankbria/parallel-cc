/**
 * Tests for FileClaimsManager (v0.5)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, readdirSync } from 'fs';
import { SessionDB } from '../src/db.js';
import { FileClaimsManager, ConflictError } from '../src/file-claims.js';
import type { Session } from '../src/types.js';

describe('FileClaimsManager', () => {
  let db: SessionDB;
  let manager: FileClaimsManager;
  const testDbPath = './test-file-claims.db';
  const repoPath = '/home/test/repo';

  // Test sessions
  let session1: Session;
  let session2: Session;

  // Helper to reset cleanup lock
  const resetCleanupLock = () => {
    db.transaction(() => {
      db['db'].prepare(`
        UPDATE schema_metadata
        SET value = datetime('now', '-10 minutes')
        WHERE key = 'last_claim_cleanup'
      `).run();
    })();
  };

  beforeEach(async () => {
    // Clean up any existing test database
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    db = new SessionDB(testDbPath);
    await db.migrateToV05();
    manager = new FileClaimsManager(db);

    // Create test sessions
    session1 = db.createSession({
      id: 'session-1',
      pid: 12345,
      repo_path: repoPath,
      worktree_path: repoPath,
      worktree_name: null,
      is_main_repo: true
    });

    session2 = db.createSession({
      id: 'session-2',
      pid: 12346,
      repo_path: repoPath,
      worktree_path: `${repoPath}-worktree`,
      worktree_name: 'worktree-1',
      is_main_repo: false
    });

    // Reset cleanup lock for each test
    resetCleanupLock();
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    // Clean up all backup files
    try {
      const files = readdirSync('.');
      const backupPattern = /test-file-claims\.db.*\.backup$/;
      files.forEach((file: string) => {
        if (backupPattern.test(file)) {
          unlinkSync(file);
        }
      });
    } catch (error) {
      // Ignore errors during cleanup
    }
  });

  describe('acquireClaim', () => {
    it('should acquire EXCLUSIVE claim successfully', async () => {
      const claim = await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE',
        reason: 'Refactoring auth'
      });

      expect(claim).toBeDefined();
      expect(claim.session_id).toBe(session1.id);
      expect(claim.file_path).toBe('src/app.ts');
      expect(claim.claim_mode).toBe('EXCLUSIVE');
      expect(claim.is_active).toBe(true);
    });

    it('should acquire SHARED claim successfully', async () => {
      const claim = await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/utils.ts',
        mode: 'SHARED',
        ttlHours: 2
      });

      expect(claim.claim_mode).toBe('SHARED');
      expect(claim.is_active).toBe(true);
    });

    it('should acquire INTENT claim successfully', async () => {
      const claim = await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/config.ts',
        mode: 'INTENT'
      });

      expect(claim.claim_mode).toBe('INTENT');
      expect(claim.is_active).toBe(true);
    });

    it('should throw ConflictError when EXCLUSIVE claim exists', async () => {
      // Session 1 acquires EXCLUSIVE
      await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE'
      });

      // Session 2 tries to acquire SHARED
      await expect(
        manager.acquireClaim({
          sessionId: session2.id,
          repoPath,
          filePath: 'src/app.ts',
          mode: 'SHARED'
        })
      ).rejects.toThrow(ConflictError);
    });

    it('should throw ConflictError when trying EXCLUSIVE on SHARED file', async () => {
      // Session 1 acquires SHARED
      await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/utils.ts',
        mode: 'SHARED'
      });

      // Session 2 tries to acquire EXCLUSIVE
      await expect(
        manager.acquireClaim({
          sessionId: session2.id,
          repoPath,
          filePath: 'src/utils.ts',
          mode: 'EXCLUSIVE'
        })
      ).rejects.toThrow(ConflictError);
    });

    it('should throw error if session not found', async () => {
      await expect(
        manager.acquireClaim({
          sessionId: 'nonexistent',
          repoPath,
          filePath: 'src/app.ts',
          mode: 'EXCLUSIVE'
        })
      ).rejects.toThrow('Session not found');
    });

    it('should throw error on path traversal attempt', async () => {
      await expect(
        manager.acquireClaim({
          sessionId: session1.id,
          repoPath,
          filePath: '../../../etc/passwd',
          mode: 'EXCLUSIVE'
        })
      ).rejects.toThrow('cannot contain ".."');
    });

    it('should throw error on absolute file path', async () => {
      await expect(
        manager.acquireClaim({
          sessionId: session1.id,
          repoPath,
          filePath: '/etc/passwd',
          mode: 'EXCLUSIVE'
        })
      ).rejects.toThrow('must be relative');
    });

    it('should allow same session to acquire multiple claims', async () => {
      const claim1 = await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE'
      });

      const claim2 = await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/utils.ts',
        mode: 'EXCLUSIVE'
      });

      expect(claim1.id).not.toBe(claim2.id);
      expect(claim1.file_path).toBe('src/app.ts');
      expect(claim2.file_path).toBe('src/utils.ts');
    });
  });

  describe('releaseClaim', () => {
    it('should release claim successfully', async () => {
      const claim = await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE'
      });

      const released = await manager.releaseClaim(claim.id, session1.id);
      expect(released).toBe(true);

      // Verify claim is no longer active
      const claims = manager.listClaims({ sessionId: session1.id });
      expect(claims).toHaveLength(0);
    });

    it('should return false if claim already released', async () => {
      const claim = await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE'
      });

      await manager.releaseClaim(claim.id, session1.id);
      const released = await manager.releaseClaim(claim.id, session1.id);
      expect(released).toBe(false);
    });

    it('should not release claim owned by another session without force', async () => {
      const claim = await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE'
      });

      const released = await manager.releaseClaim(claim.id, session2.id, false);
      expect(released).toBe(false);
    });

    it('should release claim owned by another session with force', async () => {
      const claim = await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE'
      });

      const released = await manager.releaseClaim(claim.id, session2.id, true);
      expect(released).toBe(true);
    });
  });

  describe('checkClaims (compatibility)', () => {
    it('should allow SHARED when SHARED exists', async () => {
      await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'SHARED'
      });

      const result = await manager.checkClaims({
        repoPath,
        filePaths: ['src/app.ts'],
        requestedMode: 'SHARED',
        excludeSessionId: session2.id
      });

      expect(result.available).toBe(true);
      expect(result.conflicts).toHaveLength(0);
    });

    it('should allow INTENT when SHARED exists', async () => {
      await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'SHARED'
      });

      const result = await manager.checkClaims({
        repoPath,
        filePaths: ['src/app.ts'],
        requestedMode: 'INTENT',
        excludeSessionId: session2.id
      });

      expect(result.available).toBe(true);
      expect(result.conflicts).toHaveLength(0);
    });

    it('should allow SHARED when INTENT exists', async () => {
      await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'INTENT'
      });

      const result = await manager.checkClaims({
        repoPath,
        filePaths: ['src/app.ts'],
        requestedMode: 'SHARED',
        excludeSessionId: session2.id
      });

      expect(result.available).toBe(true);
      expect(result.conflicts).toHaveLength(0);
    });

    it('should allow INTENT when INTENT exists', async () => {
      await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'INTENT'
      });

      const result = await manager.checkClaims({
        repoPath,
        filePaths: ['src/app.ts'],
        requestedMode: 'INTENT',
        excludeSessionId: session2.id
      });

      expect(result.available).toBe(true);
      expect(result.conflicts).toHaveLength(0);
    });

    it('should block all when EXCLUSIVE exists', async () => {
      await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE'
      });

      const sharedResult = await manager.checkClaims({
        repoPath,
        filePaths: ['src/app.ts'],
        requestedMode: 'SHARED',
        excludeSessionId: session2.id
      });
      expect(sharedResult.available).toBe(false);

      const intentResult = await manager.checkClaims({
        repoPath,
        filePaths: ['src/app.ts'],
        requestedMode: 'INTENT',
        excludeSessionId: session2.id
      });
      expect(intentResult.available).toBe(false);

      const exclusiveResult = await manager.checkClaims({
        repoPath,
        filePaths: ['src/app.ts'],
        requestedMode: 'EXCLUSIVE',
        excludeSessionId: session2.id
      });
      expect(exclusiveResult.available).toBe(false);
    });

    it('should block EXCLUSIVE when SHARED exists', async () => {
      await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'SHARED'
      });

      const result = await manager.checkClaims({
        repoPath,
        filePaths: ['src/app.ts'],
        requestedMode: 'EXCLUSIVE',
        excludeSessionId: session2.id
      });

      expect(result.available).toBe(false);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].reason).toContain('Incompatible SHARED claim');
    });

    it('should exclude own session when checking', async () => {
      await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE'
      });

      // Same session should be able to check
      const result = await manager.checkClaims({
        repoPath,
        filePaths: ['src/app.ts'],
        requestedMode: 'EXCLUSIVE',
        excludeSessionId: session1.id
      });

      expect(result.available).toBe(true);
    });

    it('should check multiple files', async () => {
      await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE'
      });

      const result = await manager.checkClaims({
        repoPath,
        filePaths: ['src/app.ts', 'src/utils.ts'],
        requestedMode: 'SHARED',
        excludeSessionId: session2.id
      });

      expect(result.available).toBe(false);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].filePath).toBe('src/app.ts');
    });
  });

  describe('listClaims', () => {
    it('should list all active claims', async () => {
      await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE'
      });

      await manager.acquireClaim({
        sessionId: session2.id,
        repoPath,
        filePath: 'src/utils.ts',
        mode: 'SHARED'
      });

      const claims = manager.listClaims();
      expect(claims).toHaveLength(2);
    });

    it('should filter by session', async () => {
      await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE'
      });

      await manager.acquireClaim({
        sessionId: session2.id,
        repoPath,
        filePath: 'src/utils.ts',
        mode: 'SHARED'
      });

      const claims = manager.listClaims({ sessionId: session1.id });
      expect(claims).toHaveLength(1);
      expect(claims[0].session_id).toBe(session1.id);
    });

    it('should filter by repo path', async () => {
      const otherRepo = '/home/test/other-repo';
      const session3 = db.createSession({
        id: 'session-3',
        pid: 12347,
        repo_path: otherRepo,
        worktree_path: otherRepo,
        worktree_name: null,
        is_main_repo: true
      });

      await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE'
      });

      await manager.acquireClaim({
        sessionId: session3.id,
        repoPath: otherRepo,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE'
      });

      const claims = manager.listClaims({ repoPath });
      expect(claims).toHaveLength(1);
      expect(claims[0].repo_path).toBe(repoPath);
    });

    it('should filter by file paths', async () => {
      await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE'
      });

      await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/utils.ts',
        mode: 'SHARED'
      });

      const claims = manager.listClaims({ filePaths: ['src/app.ts'] });
      expect(claims).toHaveLength(1);
      expect(claims[0].file_path).toBe('src/app.ts');
    });

    it('should not include released claims by default', async () => {
      const claim = await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE'
      });

      await manager.releaseClaim(claim.id, session1.id);

      const claims = manager.listClaims();
      expect(claims).toHaveLength(0);
    });
  });

  describe('escalateClaim', () => {
    it('should escalate INTENT to SHARED', async () => {
      const claim = await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'INTENT'
      });

      const escalated = await manager.escalateClaim(claim.id, 'SHARED');
      expect(escalated.claim_mode).toBe('SHARED');
      expect(escalated.escalated_from).toBe('INTENT');
    });

    it('should escalate INTENT to EXCLUSIVE', async () => {
      const claim = await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'INTENT'
      });

      const escalated = await manager.escalateClaim(claim.id, 'EXCLUSIVE');
      expect(escalated.claim_mode).toBe('EXCLUSIVE');
      expect(escalated.escalated_from).toBe('INTENT');
    });

    it('should escalate SHARED to EXCLUSIVE', async () => {
      const claim = await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'SHARED'
      });

      const escalated = await manager.escalateClaim(claim.id, 'EXCLUSIVE');
      expect(escalated.claim_mode).toBe('EXCLUSIVE');
      expect(escalated.escalated_from).toBe('SHARED');
    });

    it('should throw on invalid escalation path (downgrade)', async () => {
      const claim = await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE'
      });

      await expect(
        manager.escalateClaim(claim.id, 'SHARED')
      ).rejects.toThrow('Cannot escalate from EXCLUSIVE to SHARED');
    });

    it('should throw on lateral escalation', async () => {
      const claim = await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'SHARED'
      });

      await expect(
        manager.escalateClaim(claim.id, 'SHARED')
      ).rejects.toThrow('Cannot escalate from SHARED to SHARED');
    });

    it('should throw ConflictError if escalation blocked by other claim', async () => {
      const claim1 = await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'INTENT'
      });

      // Session 2 acquires SHARED
      await manager.acquireClaim({
        sessionId: session2.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'SHARED'
      });

      // Session 1 tries to escalate to EXCLUSIVE
      await expect(
        manager.escalateClaim(claim1.id, 'EXCLUSIVE')
      ).rejects.toThrow(ConflictError);
    });

    it('should throw if claim not found', async () => {
      await expect(
        manager.escalateClaim('nonexistent', 'EXCLUSIVE')
      ).rejects.toThrow('Claim not found');
    });
  });

  describe('cleanupStaleClaims', () => {
    it('should cleanup expired claims', async () => {
      // Acquire claim with expired timestamp by directly manipulating expires_at
      const claim = await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE',
        ttlHours: 24
      });

      // Manually expire the claim
      db['db'].prepare(`
        UPDATE file_claims
        SET expires_at = datetime('now', '-1 hour')
        WHERE id = ?
      `).run(claim.id);

      const cleaned = await manager.cleanupStaleClaims();
      expect(cleaned).toBeGreaterThan(0);

      // Query all claims including inactive ones by directly querying database
      const allClaims = db['db'].prepare(`
        SELECT * FROM file_claims WHERE id = ?
      `).get(claim.id) as any;

      expect(allClaims).toBeDefined();
      expect(allClaims.is_active).toBe(0); // SQLite stores false as 0
    });

    it('should cleanup claims for dead sessions', async () => {
      // This is tested more thoroughly in integration tests
      // Here we just verify the method exists and runs
      const cleaned = await manager.cleanupStaleClaims();
      expect(typeof cleaned).toBe('number');
    });

    it('should filter by repo path', async () => {
      const otherRepo = '/home/test/other-repo';
      const session3 = db.createSession({
        id: 'session-3',
        pid: 12347,
        repo_path: otherRepo,
        worktree_path: otherRepo,
        worktree_name: null,
        is_main_repo: true
      });

      const claim1 = await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE',
        ttlHours: 24
      });

      const claim2 = await manager.acquireClaim({
        sessionId: session3.id,
        repoPath: otherRepo,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE',
        ttlHours: 24
      });

      // Manually expire both claims
      db['db'].prepare(`
        UPDATE file_claims
        SET expires_at = datetime('now', '-1 hour')
        WHERE id IN (?, ?)
      `).run(claim1.id, claim2.id);

      // Reset lock to allow cleanup
      resetCleanupLock();

      const cleaned = await manager.cleanupStaleClaims(repoPath);
      expect(cleaned).toBe(1); // Only claims from repoPath
    });
  });

  describe('releaseAllForSession', () => {
    it('should release all claims for a session', async () => {
      await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/app.ts',
        mode: 'EXCLUSIVE'
      });

      await manager.acquireClaim({
        sessionId: session1.id,
        repoPath,
        filePath: 'src/utils.ts',
        mode: 'SHARED'
      });

      await manager.acquireClaim({
        sessionId: session2.id,
        repoPath,
        filePath: 'src/config.ts',
        mode: 'EXCLUSIVE'
      });

      const released = await manager.releaseAllForSession(session1.id);
      expect(released).toBe(2);

      const session1Claims = manager.listClaims({ sessionId: session1.id });
      expect(session1Claims).toHaveLength(0);

      const session2Claims = manager.listClaims({ sessionId: session2.id });
      expect(session2Claims).toHaveLength(1);
    });

    it('should return 0 if no claims to release', async () => {
      const released = await manager.releaseAllForSession(session1.id);
      expect(released).toBe(0);
    });
  });

  describe('compatibility matrix', () => {
    it('should test all mode combinations', async () => {
      const modes: Array<'EXCLUSIVE' | 'SHARED' | 'INTENT'> = ['EXCLUSIVE', 'SHARED', 'INTENT'];
      const expected = {
        EXCLUSIVE: { EXCLUSIVE: false, SHARED: false, INTENT: false },
        SHARED: { EXCLUSIVE: false, SHARED: true, INTENT: true },
        INTENT: { EXCLUSIVE: false, SHARED: true, INTENT: true }
      };

      for (const existingMode of modes) {
        for (const requestedMode of modes) {
          // Create fresh session and acquire initial claim
          const tempSession = db.createSession({
            id: `temp-${existingMode}-${requestedMode}`,
            pid: Math.floor(Math.random() * 100000),
            repo_path: repoPath,
            worktree_path: repoPath,
            worktree_name: null,
            is_main_repo: true
          });

          const filePath = `test-${existingMode}-${requestedMode}.ts`;

          await manager.acquireClaim({
            sessionId: tempSession.id,
            repoPath,
            filePath,
            mode: existingMode
          });

          const result = await manager.checkClaims({
            repoPath,
            filePaths: [filePath],
            requestedMode,
            excludeSessionId: session1.id
          });

          expect(result.available).toBe(expected[existingMode][requestedMode]);
        }
      }
    });
  });
});
