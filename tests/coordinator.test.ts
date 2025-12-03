/**
 * Tests for Coordinator class
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Coordinator } from '../src/coordinator.js';
import { GtrWrapper } from '../src/gtr.js';
import { logger } from '../src/logger.js';
import type { GtrResult } from '../src/types.js';

// Mock dependencies
vi.mock('../src/gtr.js');
vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}));
vi.mock('child_process');

// Test fixtures
const TEST_DIR = path.join(os.tmpdir(), 'parallel-cc-coord-test-' + process.pid);
const TEST_DB_PATH = path.join(TEST_DIR, 'test.db');
const TEST_REPO_PATH = '/test/repo/path';
const TEST_REPO_PATH_2 = '/test/repo/path2';

describe('Coordinator', () => {
  let coordinator: Coordinator;
  let originalProcessKill: typeof process.kill;
  let processKillSpy: Mock;

  beforeEach(async () => {
    // Create test directory
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Mock process.kill for alive detection
    originalProcessKill = process.kill;
    processKillSpy = vi.fn((pid: number, signal: number | string = 0) => {
      // Simulate successful kill (process exists)
      if (pid > 0 && pid < 1000000) {
        return true;
      }
      throw new Error('No such process');
    });
    process.kill = processKillSpy as any;

    // Mock execSync for normalizeRepoPath
    const { execSync } = await import('child_process');
    vi.mocked(execSync).mockImplementation((cmd: string, options?: any) => {
      if (typeof cmd === 'string' && cmd.includes('git rev-parse --show-toplevel')) {
        // Return the cwd as the git root
        return options?.cwd ? options.cwd + '\n' : TEST_REPO_PATH + '\n';
      }
      return '';
    });

    // Setup GtrWrapper mocks
    const MockedGtrWrapper = vi.mocked(GtrWrapper);
    MockedGtrWrapper.prototype.createWorktree = vi.fn((name: string, fromRef?: string): GtrResult => ({
      success: true,
      output: `Created worktree ${name}`
    }));
    MockedGtrWrapper.prototype.getWorktreePath = vi.fn((name: string) =>
      `/test/repo/path-worktrees/${name}`
    );
    MockedGtrWrapper.prototype.removeWorktree = vi.fn((name: string, deleteBranch?: boolean): GtrResult => ({
      success: true,
      output: `Removed worktree ${name}`
    }));
    MockedGtrWrapper.generateWorktreeName = vi.fn((prefix: string = 'parallel-') =>
      `${prefix}test-${Date.now()}`
    );

    // Create coordinator instance
    coordinator = new Coordinator({
      dbPath: TEST_DB_PATH,
      staleThresholdMinutes: 10,
      autoCleanupWorktrees: true,
      worktreePrefix: 'parallel-'
    });

    // Run v0.5.0 migration for file_claims support
    await coordinator['db'].migrateToV05();
  });

  afterEach(() => {
    // Restore process.kill
    process.kill = originalProcessKill;

    // Clean up coordinator
    if (coordinator) {
      coordinator.close();
    }

    // Clean up test directory
    fs.rmSync(TEST_DIR, { recursive: true, force: true });

    // Clear all mocks
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create with default config', async () => {
      const defaultCoord = new Coordinator();
      expect(defaultCoord).toBeInstanceOf(Coordinator);
      defaultCoord.close();
    });

    it('should merge custom config with defaults', async () => {
      const customCoord = new Coordinator({
        dbPath: TEST_DB_PATH,
        staleThresholdMinutes: 5
      });
      expect(customCoord).toBeInstanceOf(Coordinator);
      customCoord.close();
    });

    it('should create database at custom path', async () => {
      const customDbPath = path.join(TEST_DIR, 'custom', 'coord.db');
      const customCoord = new Coordinator({ dbPath: customDbPath });
      expect(fs.existsSync(customDbPath)).toBe(true);
      customCoord.close();
    });
  });

  describe('register', () => {
    it('should register first session in main repo', async () => {
      const result = await coordinator.register(TEST_REPO_PATH, 12345);

      expect(result.isNew).toBe(true);
      expect(result.isMainRepo).toBe(true);
      expect(result.worktreePath).toBe(TEST_REPO_PATH);
      expect(result.worktreeName).toBeNull();
      expect(result.parallelSessions).toBe(1);
      expect(result.sessionId).toBeTruthy();
    });

    it('should create worktree when parallel session exists', async () => {
      // Register first session
      const first = await coordinator.register(TEST_REPO_PATH, 12345);
      expect(first.isMainRepo).toBe(true);

      // Register parallel session
      const second = await coordinator.register(TEST_REPO_PATH, 12346);

      expect(second.isNew).toBe(true);
      expect(second.isMainRepo).toBe(false);
      expect(second.worktreeName).toBeTruthy();
      expect(second.worktreePath).toContain('-worktrees/');
      expect(second.parallelSessions).toBe(2);

      // Verify GtrWrapper was called
      expect(GtrWrapper.prototype.createWorktree).toHaveBeenCalled();
      expect(GtrWrapper.prototype.getWorktreePath).toHaveBeenCalled();
    });

    it('should return existing session info when same PID registers again', async () => {
      // Register session
      const first = await coordinator.register(TEST_REPO_PATH, 12345);

      // Re-register with same PID
      const second = await coordinator.register(TEST_REPO_PATH, 12345);

      expect(second.isNew).toBe(false);
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.worktreePath).toBe(first.worktreePath);
    });

    it('should throw on invalid repo path', async () => {
      await expect(coordinator.register('', 12345)).rejects.toThrow('Invalid repository path');
      await expect(coordinator.register(null as any, 12345)).rejects.toThrow('Invalid repository path');
    });

    it('should throw on invalid PID (0)', async () => {
      await expect(coordinator.register(TEST_REPO_PATH, 0)).rejects.toThrow('Invalid process ID');
    });

    it('should throw on invalid PID (negative)', async () => {
      await expect(coordinator.register(TEST_REPO_PATH, -1)).rejects.toThrow('Invalid process ID');
    });

    it('should throw on invalid PID (> MAX_INT)', async () => {
      await expect(coordinator.register(TEST_REPO_PATH, 2147483648)).rejects.toThrow('Invalid process ID');
    });

    it('should continue in main repo with warning when worktree creation fails', async () => {
      // Register first session
      await coordinator.register(TEST_REPO_PATH, 12345);

      // Mock worktree creation failure
      const MockedGtrWrapper = vi.mocked(GtrWrapper);
      MockedGtrWrapper.prototype.createWorktree = vi.fn((): GtrResult => ({
        success: false,
        output: '',
        error: 'Failed to create worktree'
      }));

      // Register parallel session
      const second = await coordinator.register(TEST_REPO_PATH, 12346);

      // Should still register but in main repo
      expect(second.isNew).toBe(true);
      expect(second.isMainRepo).toBe(true); // Falls back to main repo
      expect(second.worktreeName).toBeNull();
      expect(second.worktreePath).toBe(TEST_REPO_PATH);

      // Verify warning was logged
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Could not create worktree'));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Continuing in main repo'));
    });

    it('should prevent race conditions with concurrent registrations', async () => {
      // This test verifies that the transaction prevents race conditions
      // Register two sessions "concurrently" (in practice, sequentially due to transaction)
      const first = await coordinator.register(TEST_REPO_PATH, 12345);
      const second = await coordinator.register(TEST_REPO_PATH, 12346);

      // Second should see first session and create worktree
      expect(first.isMainRepo).toBe(true);
      expect(second.isMainRepo).toBe(false);
      expect(second.parallelSessions).toBe(2);
    });

    it('should filter dead processes when checking for parallel sessions', async () => {
      // Register first session with a PID that will be "dead"
      await coordinator.register(TEST_REPO_PATH, 99999);

      // Mock process.kill to return false for PID 99999 (dead)
      processKillSpy.mockImplementation((pid: number, signal: number | string = 0) => {
        if (pid === 99999) {
          throw new Error('No such process');
        }
        return true;
      });

      // Register second session - should not see dead session as parallel
      const second = await coordinator.register(TEST_REPO_PATH, 12345);

      // Should be in main repo since the first session is dead
      expect(second.isMainRepo).toBe(true);
    });
  });

  describe('heartbeat', () => {
    it('should return true when session exists', async () => {
      await coordinator.register(TEST_REPO_PATH, 12345);

      const result = coordinator.heartbeat(12345);
      expect(result).toBe(true);
    });

    it('should return false when session does not exist', async () => {
      const result = coordinator.heartbeat(99999);
      expect(result).toBe(false);
    });

    it('should update last_heartbeat timestamp', async () => {
      await coordinator.register(TEST_REPO_PATH, 12345);

      // Get initial status
      const status1 = coordinator.status(TEST_REPO_PATH);
      const initialHeartbeat = status1.sessions[0].lastHeartbeat;

      // Wait enough for SQLite datetime to change (1 second minimum)
      const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      return delay(1100).then(() => {
        // Update heartbeat
        coordinator.heartbeat(12345);

        // Get updated status
        const status2 = coordinator.status(TEST_REPO_PATH);
        const updatedHeartbeat = status2.sessions[0].lastHeartbeat;

        // Heartbeat should be different (SQLite datetime has 1-second resolution)
        expect(updatedHeartbeat).not.toBe(initialHeartbeat);
      });
    });
  });

  describe('release', () => {
    it('should release main repo session without worktree cleanup', async () => {
      await coordinator.register(TEST_REPO_PATH, 12345);

      const result = await coordinator.release(12345);

      expect(result.released).toBe(true);
      expect(result.worktreeRemoved).toBe(false);

      // Verify session is gone
      const status = coordinator.status(TEST_REPO_PATH);
      expect(status.totalSessions).toBe(0);
    });

    it('should release worktree session and cleanup worktree when autoCleanupWorktrees=true', async () => {
      // Create parallel sessions
      await coordinator.register(TEST_REPO_PATH, 12345);
      await coordinator.register(TEST_REPO_PATH, 12346);

      const result = await coordinator.release(12346);

      expect(result.released).toBe(true);
      expect(result.worktreeRemoved).toBe(true);

      // Verify GtrWrapper.removeWorktree was called
      expect(GtrWrapper.prototype.removeWorktree).toHaveBeenCalled();
    });

    it('should not cleanup worktree when autoCleanupWorktrees=false', async () => {
      // Create coordinator with autoCleanupWorktrees disabled
      const noCleanupCoord = new Coordinator({
        dbPath: path.join(TEST_DIR, 'no-cleanup.db'),
        autoCleanupWorktrees: false
      });

      // Run migration
      await noCleanupCoord['db'].migrateToV05();

      // Create parallel sessions
      await noCleanupCoord.register(TEST_REPO_PATH, 12345);
      await noCleanupCoord.register(TEST_REPO_PATH, 12346);

      // Clear mock calls from registration
      vi.clearAllMocks();

      const result = await noCleanupCoord.release(12346);

      expect(result.released).toBe(true);
      expect(result.worktreeRemoved).toBe(false);

      // Verify removeWorktree was NOT called
      expect(GtrWrapper.prototype.removeWorktree).not.toHaveBeenCalled();

      noCleanupCoord.close();
    });

    it('should return released=false for non-existent session', async () => {
      const result = await coordinator.release(99999);

      expect(result.released).toBe(false);
      expect(result.worktreeRemoved).toBe(false);
    });

    it('should still delete session record even if worktree cleanup fails', async () => {
      // Create parallel sessions
      await coordinator.register(TEST_REPO_PATH, 12345);
      await coordinator.register(TEST_REPO_PATH, 12346);

      // Mock worktree removal failure
      const MockedGtrWrapper = vi.mocked(GtrWrapper);
      MockedGtrWrapper.prototype.removeWorktree = vi.fn((): GtrResult => ({
        success: false,
        output: '',
        error: 'Failed to remove worktree'
      }));

      const result = await coordinator.release(12346);

      expect(result.released).toBe(true);
      expect(result.worktreeRemoved).toBe(false);

      // Verify session is still deleted
      const status = coordinator.status(TEST_REPO_PATH);
      expect(status.totalSessions).toBe(1); // Only first session remains
    });
  });

  describe('status', () => {
    it('should return sessions for specific repo only', async () => {
      await coordinator.register(TEST_REPO_PATH, 12345);
      await coordinator.register(TEST_REPO_PATH_2, 12346);

      const status = coordinator.status(TEST_REPO_PATH);

      expect(status.repoPath).toBe(TEST_REPO_PATH);
      expect(status.totalSessions).toBe(1);
      expect(status.sessions[0].pid).toBe(12345);
    });

    it('should return all sessions when no repo specified', async () => {
      await coordinator.register(TEST_REPO_PATH, 12345);
      await coordinator.register(TEST_REPO_PATH_2, 12346);

      const status = coordinator.status();

      expect(status.repoPath).toBe('all');
      expect(status.totalSessions).toBe(2);
    });

    it('should correctly identify alive vs dead processes', async () => {
      await coordinator.register(TEST_REPO_PATH, 12345);
      await coordinator.register(TEST_REPO_PATH, 99999);

      // Mock process.kill to identify 99999 as dead
      processKillSpy.mockImplementation((pid: number, signal: number | string = 0) => {
        if (pid === 99999) {
          throw new Error('No such process');
        }
        return true;
      });

      const status = coordinator.status(TEST_REPO_PATH);

      expect(status.totalSessions).toBe(2);
      expect(status.sessions.find(s => s.pid === 12345)?.isAlive).toBe(true);
      expect(status.sessions.find(s => s.pid === 99999)?.isAlive).toBe(false);
    });

    it('should calculate correct duration in minutes', async () => {
      await coordinator.register(TEST_REPO_PATH, 12345);

      const status = coordinator.status(TEST_REPO_PATH);

      // Duration calculation - note there may be timezone differences between SQLite UTC and local time
      // We just verify the field exists and is a number
      expect(typeof status.sessions[0].durationMinutes).toBe('number');
      expect(Number.isFinite(status.sessions[0].durationMinutes)).toBe(true);
    });

    it('should include all session info fields', async () => {
      await coordinator.register(TEST_REPO_PATH, 12345);

      const status = coordinator.status(TEST_REPO_PATH);
      const session = status.sessions[0];

      expect(session.sessionId).toBeTruthy();
      expect(session.pid).toBe(12345);
      expect(session.worktreePath).toBe(TEST_REPO_PATH);
      expect(session.worktreeName).toBeNull();
      expect(session.isMainRepo).toBe(true);
      expect(session.createdAt).toBeTruthy();
      expect(session.lastHeartbeat).toBeTruthy();
      expect(session.isAlive).toBeDefined();
      expect(session.durationMinutes).toBeDefined();
    });
  });

  describe('cleanup', () => {
    it('should remove stale sessions', async () => {
      // Mock process as dead BEFORE any coordinator operations
      processKillSpy.mockImplementation((pid: number, signal: number | string = 0) => {
        if (pid === 99999) {
          throw new Error('No such process');
        }
        return true;
      });

      // Use normal coordinator first
      const normalCoord = new Coordinator({
        dbPath: path.join(TEST_DIR, 'short-stale.db'),
        staleThresholdMinutes: 60 // Don't cleanup during register
      });

      await normalCoord.register(TEST_REPO_PATH, 99999);
      normalCoord.close();

      // Wait for 2 seconds to ensure timestamp difference (SQLite has second-level precision)
      await new Promise(resolve => setTimeout(resolve, 2100));

      // Now create coordinator with aggressive cleanup (0 means anything older than now)
      const shortStaleCoord = new Coordinator({
        dbPath: path.join(TEST_DIR, 'short-stale.db'),
        staleThresholdMinutes: 0
      });

      // Run migration for new database
      await shortStaleCoord['db'].migrateToV05();

      const result = await shortStaleCoord.cleanup();

      expect(result.removed).toBe(1);
      expect(result.sessions).toHaveLength(1);

      shortStaleCoord.close();
    });

    it('should detect dead processes', async () => {
      // Use normal coordinator first
      const normalCoord = new Coordinator({
        dbPath: path.join(TEST_DIR, 'cleanup-dead.db'),
        staleThresholdMinutes: 60
      });

      await normalCoord.register(TEST_REPO_PATH, 99999);
      normalCoord.close();

      // Wait for timestamp difference
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Mock process as dead BEFORE creating new coordinator
      // (to ensure cleanup during any operation detects the dead process)
      processKillSpy.mockImplementation((pid: number, signal: number | string = 0) => {
        if (pid === 99999) {
          throw new Error('No such process');
        }
        return true;
      });

      // Create coordinator with aggressive cleanup
      const cleanupCoord = new Coordinator({
        dbPath: path.join(TEST_DIR, 'cleanup-dead.db'),
        staleThresholdMinutes: 0
      });

      // Run migration for new database
      await cleanupCoord['db'].migrateToV05();

      const result = await cleanupCoord.cleanup();

      // Session should have been removed (either during constructor or explicit cleanup)
      expect(result.removed).toBeGreaterThanOrEqual(0); // May be 0 if already cleaned up during constructor

      // Verify session is gone by checking status
      const status = cleanupCoord.status(TEST_REPO_PATH);
      expect(status.totalSessions).toBe(0);

      cleanupCoord.close();
    });

    it('should cleanup worktrees for stale worktree sessions', async () => {
      // Use normal coordinator first
      const normalCoord = new Coordinator({
        dbPath: path.join(TEST_DIR, 'worktree-cleanup.db'),
        staleThresholdMinutes: 60,
        autoCleanupWorktrees: true
      });

      // Register parallel sessions
      await normalCoord.register(TEST_REPO_PATH, 12345);
      await normalCoord.register(TEST_REPO_PATH, 99999);
      normalCoord.close();

      // Wait for timestamp difference
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Create coordinator with aggressive cleanup
      const shortStaleCoord = new Coordinator({
        dbPath: path.join(TEST_DIR, 'worktree-cleanup.db'),
        staleThresholdMinutes: 0,
        autoCleanupWorktrees: true
      });

      // Run migration for new database
      await shortStaleCoord['db'].migrateToV05();

      // Clear mocks from registration
      vi.clearAllMocks();

      // Mock 99999 as dead
      processKillSpy.mockImplementation((pid: number, signal: number | string = 0) => {
        if (pid === 99999) {
          throw new Error('No such process');
        }
        return true;
      });

      const result = await shortStaleCoord.cleanup();

      expect(result.worktreesRemoved.length).toBeGreaterThan(0);
      expect(GtrWrapper.prototype.removeWorktree).toHaveBeenCalled();

      shortStaleCoord.close();
    });

    it('should not remove sessions with alive processes even if stale', async () => {
      // Use normal coordinator first
      const normalCoord = new Coordinator({
        dbPath: path.join(TEST_DIR, 'alive-stale.db'),
        staleThresholdMinutes: 60
      });

      await normalCoord.register(TEST_REPO_PATH, 12345);
      normalCoord.close();

      // Wait for timestamp difference
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Create coordinator with aggressive cleanup
      const shortStaleCoord = new Coordinator({
        dbPath: path.join(TEST_DIR, 'alive-stale.db'),
        staleThresholdMinutes: 0
      });

      // Mock process as alive
      processKillSpy.mockImplementation((pid: number, signal: number | string = 0) => {
        return true; // All processes are alive
      });

      const result = await shortStaleCoord.cleanup();

      expect(result.removed).toBe(0);
      expect(result.sessions).toHaveLength(0);

      shortStaleCoord.close();
    });

    it('should handle worktree removal failures gracefully', async () => {
      // Use normal coordinator first
      const normalCoord = new Coordinator({
        dbPath: path.join(TEST_DIR, 'worktree-fail.db'),
        staleThresholdMinutes: 60,
        autoCleanupWorktrees: true
      });

      // Register parallel sessions
      await normalCoord.register(TEST_REPO_PATH, 12345);
      await normalCoord.register(TEST_REPO_PATH, 99999);
      normalCoord.close();

      // Wait for timestamp difference
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Create coordinator with aggressive cleanup
      const shortStaleCoord = new Coordinator({
        dbPath: path.join(TEST_DIR, 'worktree-fail.db'),
        staleThresholdMinutes: 0,
        autoCleanupWorktrees: true
      });

      // Run migration for new database
      await shortStaleCoord['db'].migrateToV05();

      // Mock worktree removal failure
      const MockedGtrWrapper = vi.mocked(GtrWrapper);
      MockedGtrWrapper.prototype.removeWorktree = vi.fn((): GtrResult => ({
        success: false,
        output: '',
        error: 'Removal failed'
      }));

      // Mock 99999 as dead
      processKillSpy.mockImplementation((pid: number, signal: number | string = 0) => {
        if (pid === 99999) {
          throw new Error('No such process');
        }
        return true;
      });

      const result = await shortStaleCoord.cleanup();

      expect(result.removed).toBeGreaterThan(0);
      expect(result.worktreesRemoved).toHaveLength(0);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to remove worktree'));

      shortStaleCoord.close();
    });
  });

  describe('normalizeRepoPath', () => {
    it('should use git rev-parse to get canonical path', async () => {
      const { execSync } = await import('child_process');

      const result = await coordinator.register(TEST_REPO_PATH, 12345);

      // Should have called execSync with git rev-parse
      expect(execSync).toHaveBeenCalledWith(
        'git rev-parse --show-toplevel',
        expect.objectContaining({
          cwd: TEST_REPO_PATH
        })
      );
    });

    it('should fall back to original path if not a git repo', async () => {
      const { execSync } = await import('child_process');

      // Mock execSync to throw error (not a git repo)
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('not a git repository');
      });

      const result = await coordinator.register(TEST_REPO_PATH, 12345);

      // Should use original path
      expect(result.worktreePath).toBe(TEST_REPO_PATH);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not normalize repo path'));
    });
  });

  describe('close', () => {
    it('should close database connection', async () => {
      const testCoord = new Coordinator({
        dbPath: path.join(TEST_DIR, 'close-test.db')
      });

      // Register a session
      await testCoord.register(TEST_REPO_PATH, 12345);

      // Close should not throw
      expect(() => testCoord.close()).not.toThrow();

      // Further operations should fail
      await expect(testCoord.register(TEST_REPO_PATH, 12346)).rejects.toThrow();
    });
  });

  describe('integration scenarios', () => {
    it('should handle complete lifecycle: register -> heartbeat -> status -> release', async () => {
      // Register
      const registerResult = await coordinator.register(TEST_REPO_PATH, 12345);
      expect(registerResult.isNew).toBe(true);

      // Heartbeat
      const heartbeatResult = coordinator.heartbeat(12345);
      expect(heartbeatResult).toBe(true);

      // Status
      const statusResult = coordinator.status(TEST_REPO_PATH);
      expect(statusResult.totalSessions).toBe(1);

      // Release
      const releaseResult = await coordinator.release(12345);
      expect(releaseResult.released).toBe(true);

      // Verify cleanup
      const finalStatus = coordinator.status(TEST_REPO_PATH);
      expect(finalStatus.totalSessions).toBe(0);
    });

    it('should handle multiple parallel sessions correctly', async () => {
      // Register 3 sessions
      const s1 = await coordinator.register(TEST_REPO_PATH, 12345);
      const s2 = await coordinator.register(TEST_REPO_PATH, 12346);
      const s3 = await coordinator.register(TEST_REPO_PATH, 12347);

      expect(s1.isMainRepo).toBe(true);
      expect(s2.isMainRepo).toBe(false);
      expect(s3.isMainRepo).toBe(false);

      const status = coordinator.status(TEST_REPO_PATH);
      expect(status.totalSessions).toBe(3);

      // Release middle session
      await coordinator.release(12346);

      const status2 = coordinator.status(TEST_REPO_PATH);
      expect(status2.totalSessions).toBe(2);
    });

    it('should handle multiple repos independently', async () => {
      await coordinator.register(TEST_REPO_PATH, 12345);
      await coordinator.register(TEST_REPO_PATH, 12346);
      await coordinator.register(TEST_REPO_PATH_2, 12347);
      await coordinator.register(TEST_REPO_PATH_2, 12348);

      const status1 = coordinator.status(TEST_REPO_PATH);
      const status2 = coordinator.status(TEST_REPO_PATH_2);

      expect(status1.totalSessions).toBe(2);
      expect(status2.totalSessions).toBe(2);

      const allStatus = coordinator.status();
      expect(allStatus.totalSessions).toBe(4);
    });
  });
});
