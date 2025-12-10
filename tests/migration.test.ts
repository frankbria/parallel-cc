/**
 * Tests for database migration runner (v1.0)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionDB } from '../src/db.js';
import { existsSync, unlinkSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';

describe('Database Migration Runner', () => {
  let db: SessionDB;
  const testDbPath = './test-migration.db';
  const testMigrationsDir = './test-migrations';

  beforeEach(() => {
    // Clean up any existing test database and migrations
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    if (existsSync(testMigrationsDir)) {
      rmSync(testMigrationsDir, { recursive: true });
    }
    mkdirSync(testMigrationsDir, { recursive: true });

    db = new SessionDB(testDbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    // Clean up all backup files (matches both .v*.backup and .vpre-migration.backup)
    try {
      const files = readdirSync('.');
      const backupPattern = /test-migration\.db.*\.backup$/;
      files.forEach((file: string) => {
        if (backupPattern.test(file)) {
          unlinkSync(file);
        }
      });
    } catch (error) {
      // Ignore errors during cleanup
    }
    // Clean up test migrations
    if (existsSync(testMigrationsDir)) {
      rmSync(testMigrationsDir, { recursive: true });
    }
  });

  describe('runMigration', () => {
    it('should skip migration if already at target version', async () => {
      // First, migrate to v0.5.0
      await db.migrateToV05();

      // Delete any existing backup
      const backup1 = `${testDbPath}.vpre-migration.backup`;
      const backup2 = `${testDbPath}.v0.5.0.backup`;
      if (existsSync(backup1)) {
        unlinkSync(backup1);
      }
      if (existsSync(backup2)) {
        unlinkSync(backup2);
      }

      // Try to migrate again to v0.5.0
      await db.runMigration('0.5.0');

      // Should not create a new backup since we're already at v0.5.0
      const backupPath = `${testDbPath}.v0.5.0.backup`;
      expect(existsSync(backupPath)).toBe(false);
    });

    it('should create backup before migration', async () => {
      // Migrate to v0.5.0 first
      await db.migrateToV05();

      // Create a test migration for v1.0.0-test
      const migrationSQL = `
        BEGIN TRANSACTION;
        UPDATE schema_metadata SET value = '1.0.0-test' WHERE key = 'version';
        COMMIT;
      `;
      writeFileSync(path.join(testMigrationsDir, 'v1.0.0-test.sql'), migrationSQL);

      // Change working directory temporarily
      const originalCwd = process.cwd();
      process.chdir(__dirname);

      try {
        // Copy migration to migrations directory
        const migrationsDir = path.join(process.cwd(), 'migrations');
        if (!existsSync(migrationsDir)) {
          mkdirSync(migrationsDir);
        }
        writeFileSync(path.join(migrationsDir, 'v1.0.0-test.sql'), migrationSQL);

        // Run migration
        await db.runMigration('1.0.0-test');

        // Verify backup was created
        const backupPath = `${testDbPath}.v0.5.0.backup`;
        expect(existsSync(backupPath)).toBe(true);

        // Clean up
        unlinkSync(path.join(migrationsDir, 'v1.0.0-test.sql'));
        rmSync(migrationsDir, { recursive: true, force: true });
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should throw error if migration file not found', async () => {
      await expect(db.runMigration('99.99.99')).rejects.toThrow(/Migration file not found/);
    });

    it('should verify schema version after migration', async () => {
      // Migrate to v0.5.0 first
      await db.migrateToV05();

      // Create a faulty migration that doesn't update version
      const migrationSQL = `
        BEGIN TRANSACTION;
        -- This migration doesn't update schema_metadata.version
        CREATE TABLE IF NOT EXISTS test_table (id TEXT);
        COMMIT;
      `;

      const originalCwd = process.cwd();
      process.chdir(__dirname);

      try {
        const migrationsDir = path.join(process.cwd(), 'migrations');
        if (!existsSync(migrationsDir)) {
          mkdirSync(migrationsDir);
        }
        writeFileSync(path.join(migrationsDir, 'v1.0.0-faulty.sql'), migrationSQL);

        // Should throw because version wasn't updated
        await expect(db.runMigration('1.0.0-faulty')).rejects.toThrow(/Migration verification failed/);

        // Clean up
        unlinkSync(path.join(migrationsDir, 'v1.0.0-faulty.sql'));
        rmSync(migrationsDir, { recursive: true, force: true });
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe('rollbackMigration', () => {
    it('should restore database from backup', async () => {
      // Migrate to v0.5.0
      await db.migrateToV05();

      // Create a session in v0.5.0
      const sessionId = randomUUID();
      db.createSession({
        id: sessionId,
        pid: 12345,
        repo_path: '/test',
        worktree_path: '/test',
        worktree_name: null,
        is_main_repo: true
      });

      // Create backup manually
      const backupPath = `${testDbPath}.v0.5.0.backup`;
      require('fs').copyFileSync(testDbPath, backupPath);

      // Modify database (simulate migration)
      db['db'].prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      expect(db.getSessionById(sessionId)).toBeNull();

      // Rollback to v0.5.0
      await db.rollbackMigration('0.5.0');

      // Verify session is restored
      const restored = db.getSessionById(sessionId);
      expect(restored).not.toBeNull();
      expect(restored?.id).toBe(sessionId);
    });

    it('should throw error if backup not found', async () => {
      await expect(db.rollbackMigration('99.99.99')).rejects.toThrow(/Backup file not found/);
    });

    it('should reconnect to database after rollback', async () => {
      // Migrate to v0.5.0
      await db.migrateToV05();

      // Create backup manually
      const backupPath = `${testDbPath}.v0.5.0.backup`;
      require('fs').copyFileSync(testDbPath, backupPath);

      // Rollback
      await db.rollbackMigration('0.5.0');

      // Verify database is still usable
      const sessionId = randomUUID();
      const session = db.createSession({
        id: sessionId,
        pid: 12345,
        repo_path: '/test',
        worktree_path: '/test',
        worktree_name: null,
        is_main_repo: true
      });

      expect(session.id).toBe(sessionId);
    });
  });

  describe('v1.0.0 Migration', () => {
    it('should add E2B columns to sessions table', async () => {
      // Start with v0.5.0
      await db.migrateToV05();

      // Run v1.0.0 migration
      const originalCwd = process.cwd();
      const projectRoot = path.resolve(__dirname, '..');
      process.chdir(projectRoot);

      try {
        await db.runMigration('1.0.0');

        // Verify columns exist by creating an E2B session
        const sessionId = randomUUID();
        const sandboxId = `sb_${randomUUID()}`;

        const session = db.createE2BSession({
          id: sessionId,
          pid: 12345,
          repo_path: '/test',
          worktree_path: '/test/worktree',
          worktree_name: null,
          sandbox_id: sandboxId,
          prompt: 'Test task'
        });

        expect(session.execution_mode).toBe('e2b');
        expect(session.sandbox_id).toBe(sandboxId);
        expect(session.prompt).toBe('Test task');
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should create E2B indexes', async () => {
      // Start with v0.5.0
      await db.migrateToV05();

      // Run v1.0.0 migration
      const originalCwd = process.cwd();
      const projectRoot = path.resolve(__dirname, '..');
      process.chdir(projectRoot);

      try {
        await db.runMigration('1.0.0');

        // Verify indexes exist
        const indexes = db['db'].prepare(`
          SELECT name FROM sqlite_master
          WHERE type='index'
          AND name IN ('idx_sessions_execution_mode', 'idx_sessions_sandbox_id', 'idx_sessions_status', 'idx_sessions_e2b_active')
        `).all() as { name: string }[];

        expect(indexes).toHaveLength(4);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should create e2b_sessions view', async () => {
      // Start with v0.5.0
      await db.migrateToV05();

      // Run v1.0.0 migration
      const originalCwd = process.cwd();
      const projectRoot = path.resolve(__dirname, '..');
      process.chdir(projectRoot);

      try {
        await db.runMigration('1.0.0');

        // Verify view exists
        const views = db['db'].prepare(`
          SELECT name FROM sqlite_master
          WHERE type='view'
          AND name = 'e2b_sessions'
        `).all() as { name: string }[];

        expect(views).toHaveLength(1);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should maintain backward compatibility with v0.5 sessions', async () => {
      // Create a v0.5.0 session before migration
      await db.migrateToV05();

      const sessionId = randomUUID();
      db.createSession({
        id: sessionId,
        pid: 12345,
        repo_path: '/test',
        worktree_path: '/test',
        worktree_name: null,
        is_main_repo: true
      });

      // Run v1.0.0 migration
      const originalCwd = process.cwd();
      const projectRoot = path.resolve(__dirname, '..');
      process.chdir(projectRoot);

      try {
        await db.runMigration('1.0.0');

        // Verify old session still exists and works
        const session = db.getSessionById(sessionId);
        expect(session).not.toBeNull();
        expect(session?.id).toBe(sessionId);

        // Verify E2B fields default to 'local' after migration
        expect(session?.execution_mode).toBe('local');
        expect(session?.sandbox_id).toBeUndefined();
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should be idempotent (can run multiple times)', async () => {
      await db.migrateToV05();

      const originalCwd = process.cwd();
      const projectRoot = path.resolve(__dirname, '..');
      process.chdir(projectRoot);

      try {
        // Run migration twice
        await db.runMigration('1.0.0');
        await db.runMigration('1.0.0');

        // Should not throw errors
        // Verify database is still functional
        const sessionId = randomUUID();
        const session = db.createE2BSession({
          id: sessionId,
          pid: 12345,
          repo_path: '/test',
          worktree_path: '/test/worktree',
          worktree_name: null,
          sandbox_id: `sb_${randomUUID()}`,
          prompt: 'Test'
        });

        expect(session.execution_mode).toBe('e2b');
      } finally {
        process.chdir(originalCwd);
      }
    });
  });
});
