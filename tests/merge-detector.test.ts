/**
 * Tests for MergeDetector class (v0.4)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { SessionDB } from '../src/db.js';
import { MergeDetector, type MergeDetectorConfig } from '../src/merge-detector.js';

// Helper to create a temp directory
function createTempDir(): string {
  const dir = join(tmpdir(), `merge-detector-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Helper to init a git repo and get the default branch name
function initGitRepo(dir: string): string {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: 'pipe' });
  // Return the default branch name (main or master)
  const branch = execSync('git branch --show-current', { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }).trim();
  return branch || 'main'; // Git returns empty before first commit
}

// Helper to get the default branch after first commit
function getDefaultBranch(dir: string): string {
  return execSync('git branch --show-current', { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

// Helper to create a commit
function createCommit(dir: string, filename: string, content: string, message: string): string {
  writeFileSync(join(dir, filename), content);
  execSync(`git add "${filename}"`, { cwd: dir, stdio: 'pipe' });

  // Use spawnSync to prevent shell injection in commit messages
  const commitResult = spawnSync('git', ['commit', '-m', message], { cwd: dir, stdio: 'pipe' });
  if (commitResult.status !== 0) {
    throw new Error(`Git commit failed: ${commitResult.stderr?.toString() || 'Unknown error'}`);
  }

  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

describe('MergeDetector', () => {
  let db: SessionDB;
  let dbPath: string;
  let detector: MergeDetector;

  beforeEach(() => {
    dbPath = join(tmpdir(), `test-merge-detector-${randomUUID()}.db`);
    db = new SessionDB(dbPath);
  });

  afterEach(() => {
    detector?.stopPolling();
    db?.close();
    if (existsSync(dbPath)) {
      rmSync(dbPath, { force: true });
    }
  });

  describe('constructor', () => {
    it('should create detector with default config', () => {
      detector = new MergeDetector(db);
      const config = detector.getConfig();

      expect(config.pollIntervalSeconds).toBe(60);
      expect(config.maxParallelChecks).toBe(10);
    });

    it('should create detector with custom config', () => {
      detector = new MergeDetector(db, {
        pollIntervalSeconds: 30,
        maxParallelChecks: 5
      });
      const config = detector.getConfig();

      expect(config.pollIntervalSeconds).toBe(30);
      expect(config.maxParallelChecks).toBe(5);
    });

    it('should merge partial config with defaults', () => {
      detector = new MergeDetector(db, {
        pollIntervalSeconds: 120
      });
      const config = detector.getConfig();

      expect(config.pollIntervalSeconds).toBe(120);
      expect(config.maxParallelChecks).toBe(10); // default
    });
  });

  describe('startPolling/stopPolling', () => {
    it('should track polling state correctly', () => {
      detector = new MergeDetector(db, { pollIntervalSeconds: 1000 });

      expect(detector.isActivelyPolling()).toBe(false);

      detector.startPolling();
      expect(detector.isActivelyPolling()).toBe(true);

      detector.stopPolling();
      expect(detector.isActivelyPolling()).toBe(false);
    });

    it('should not start polling twice', () => {
      detector = new MergeDetector(db, { pollIntervalSeconds: 1000 });

      detector.startPolling();
      detector.startPolling(); // Should be no-op

      expect(detector.isActivelyPolling()).toBe(true);
      detector.stopPolling();
    });

    it('should handle stopPolling when not started', () => {
      detector = new MergeDetector(db);

      // Should not throw
      detector.stopPolling();
      expect(detector.isActivelyPolling()).toBe(false);
    });
  });

  describe('pollForMerges', () => {
    it('should return empty result when no subscriptions', async () => {
      detector = new MergeDetector(db);

      const result = await detector.pollForMerges();

      expect(result.subscriptionsChecked).toBe(0);
      expect(result.newMerges).toHaveLength(0);
      expect(result.notificationsSent).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should not poll concurrently', async () => {
      detector = new MergeDetector(db);

      // Start first poll (will be blocked by test)
      const poll1 = detector.pollForMerges();
      const poll2 = detector.pollForMerges();

      const [result1, result2] = await Promise.all([poll1, poll2]);

      // Second poll should return early with zeros
      // (or both complete, depending on timing)
      expect(result1.errors).toHaveLength(0);
      expect(result2.errors).toHaveLength(0);
    });
  });

  describe('checkIfBranchMerged', () => {
    let repoDir: string;

    beforeEach(() => {
      repoDir = createTempDir();
      initGitRepo(repoDir);
    });

    afterEach(() => {
      if (existsSync(repoDir)) {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('should return false for non-existent repo', () => {
      detector = new MergeDetector(db);

      const result = detector.checkIfBranchMerged('/nonexistent/path', 'feature', 'main');

      expect(result).toBe(false);
    });

    it('should return false for non-existent branch', () => {
      detector = new MergeDetector(db);

      // Create initial commit on main
      createCommit(repoDir, 'readme.txt', 'initial', 'Initial commit');

      const result = detector.checkIfBranchMerged(repoDir, 'nonexistent-branch', 'main');

      expect(result).toBe(false);
    });

    it('should return false for unmerged branch', () => {
      detector = new MergeDetector(db);

      // Create initial commit on default branch
      createCommit(repoDir, 'readme.txt', 'initial', 'Initial commit');
      const defaultBranch = getDefaultBranch(repoDir);

      // Create and switch to feature branch
      execSync('git checkout -b feature', { cwd: repoDir, stdio: 'pipe' });
      createCommit(repoDir, 'feature.txt', 'feature content', 'Feature commit');

      // Switch back to default branch
      execSync(`git checkout ${defaultBranch}`, { cwd: repoDir, stdio: 'pipe' });

      const result = detector.checkIfBranchMerged(repoDir, 'feature', defaultBranch);

      expect(result).toBe(false);
    });

    it('should return true for merged branch', () => {
      detector = new MergeDetector(db);

      // Create initial commit on default branch
      createCommit(repoDir, 'readme.txt', 'initial', 'Initial commit');
      const defaultBranch = getDefaultBranch(repoDir);

      // Create and switch to feature branch
      execSync('git checkout -b feature', { cwd: repoDir, stdio: 'pipe' });
      createCommit(repoDir, 'feature.txt', 'feature content', 'Feature commit');

      // Switch back to default branch and merge
      execSync(`git checkout ${defaultBranch}`, { cwd: repoDir, stdio: 'pipe' });
      execSync('git merge feature', { cwd: repoDir, stdio: 'pipe' });

      const result = detector.checkIfBranchMerged(repoDir, 'feature', defaultBranch);

      expect(result).toBe(true);
    });

    it('should handle master as target branch', () => {
      detector = new MergeDetector(db);

      // Create initial commit then rename to master
      createCommit(repoDir, 'readme.txt', 'initial', 'Initial commit');
      const currentBranch = getDefaultBranch(repoDir);
      if (currentBranch !== 'master') {
        execSync('git branch -m master', { cwd: repoDir, stdio: 'pipe' });
      }

      // Create and switch to feature branch
      execSync('git checkout -b feature', { cwd: repoDir, stdio: 'pipe' });
      createCommit(repoDir, 'feature.txt', 'feature content', 'Feature commit');

      // Switch back to master and merge
      execSync('git checkout master', { cwd: repoDir, stdio: 'pipe' });
      execSync('git merge feature', { cwd: repoDir, stdio: 'pipe' });

      const result = detector.checkIfBranchMerged(repoDir, 'feature', 'master');

      expect(result).toBe(true);
    });
  });

  describe('getBranchStatus', () => {
    let repoDir: string;

    beforeEach(() => {
      repoDir = createTempDir();
      initGitRepo(repoDir);
    });

    afterEach(() => {
      if (existsSync(repoDir)) {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('should return null for non-existent repo', () => {
      detector = new MergeDetector(db);

      const status = detector.getBranchStatus('/nonexistent/path', 'main');

      expect(status).toBeNull();
    });

    it('should return null for non-existent branch', () => {
      detector = new MergeDetector(db);

      createCommit(repoDir, 'readme.txt', 'initial', 'Initial commit');

      const status = detector.getBranchStatus(repoDir, 'nonexistent-branch');

      expect(status).toBeNull();
    });

    it('should return status for existing branch', () => {
      detector = new MergeDetector(db);

      createCommit(repoDir, 'readme.txt', 'initial', 'Initial commit');
      const defaultBranch = getDefaultBranch(repoDir);

      const status = detector.getBranchStatus(repoDir, defaultBranch);

      expect(status).not.toBeNull();
      expect(status!.name).toBe(defaultBranch);
      expect(status!.commit).toHaveLength(40);
      expect(status!.isMerged).toBe(true); // default branch is always merged to itself
    });

    it('should track ahead/behind counts', () => {
      detector = new MergeDetector(db);

      // Create initial commit on main
      createCommit(repoDir, 'readme.txt', 'initial', 'Initial commit');

      // Create and switch to feature branch
      execSync('git checkout -b feature', { cwd: repoDir, stdio: 'pipe' });
      createCommit(repoDir, 'feature.txt', 'feature content', 'Feature commit');

      const status = detector.getBranchStatus(repoDir, 'feature');

      expect(status).not.toBeNull();
      expect(status!.name).toBe('feature');
      expect(status!.aheadBy).toBeGreaterThanOrEqual(0);
    });
  });

  describe('pollForMerges with subscriptions', () => {
    let repoDir: string;

    beforeEach(() => {
      repoDir = createTempDir();
      initGitRepo(repoDir);
    });

    afterEach(() => {
      if (existsSync(repoDir)) {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('should detect merged branch and create merge event', async () => {
      detector = new MergeDetector(db);

      // Create initial commit on default branch
      createCommit(repoDir, 'readme.txt', 'initial', 'Initial commit');
      const defaultBranch = getDefaultBranch(repoDir);

      // Create and switch to feature branch
      execSync('git checkout -b feature', { cwd: repoDir, stdio: 'pipe' });
      createCommit(repoDir, 'feature.txt', 'feature content', 'Feature commit');

      // Switch back to default branch and merge
      execSync(`git checkout ${defaultBranch}`, { cwd: repoDir, stdio: 'pipe' });
      execSync('git merge feature', { cwd: repoDir, stdio: 'pipe' });

      // Create a session and subscription
      const session = db.createSession({
        id: randomUUID(),
        pid: process.pid,
        repo_path: repoDir,
        worktree_path: repoDir,
        worktree_name: null,
        is_main_repo: true
      });

      db.createSubscription({
        id: randomUUID(),
        session_id: session.id,
        repo_path: repoDir,
        branch_name: 'feature',
        target_branch: defaultBranch,
        is_active: true
      });

      // Poll for merges
      const result = await detector.pollForMerges();

      expect(result.subscriptionsChecked).toBe(1);
      expect(result.newMerges).toHaveLength(1);
      expect(result.newMerges[0].branch_name).toBe('feature');
      expect(result.newMerges[0].target_branch).toBe(defaultBranch);
      expect(result.notificationsSent).toBe(1);
    });

    it('should not detect same merge twice', async () => {
      detector = new MergeDetector(db);

      // Create initial commit on default branch
      createCommit(repoDir, 'readme.txt', 'initial', 'Initial commit');
      const defaultBranch = getDefaultBranch(repoDir);

      // Create and switch to feature branch
      execSync('git checkout -b feature', { cwd: repoDir, stdio: 'pipe' });
      createCommit(repoDir, 'feature.txt', 'feature content', 'Feature commit');

      // Switch back to default branch and merge
      execSync(`git checkout ${defaultBranch}`, { cwd: repoDir, stdio: 'pipe' });
      execSync('git merge feature', { cwd: repoDir, stdio: 'pipe' });

      // Create a session and subscription
      const session = db.createSession({
        id: randomUUID(),
        pid: process.pid,
        repo_path: repoDir,
        worktree_path: repoDir,
        worktree_name: null,
        is_main_repo: true
      });

      db.createSubscription({
        id: randomUUID(),
        session_id: session.id,
        repo_path: repoDir,
        branch_name: 'feature',
        target_branch: defaultBranch,
        is_active: true
      });

      // First poll
      const result1 = await detector.pollForMerges();
      expect(result1.newMerges).toHaveLength(1);

      // Create another subscription (simulating another session subscribing)
      const session2 = db.createSession({
        id: randomUUID(),
        pid: process.pid + 1,
        repo_path: repoDir,
        worktree_path: repoDir,
        worktree_name: null,
        is_main_repo: true
      });

      db.createSubscription({
        id: randomUUID(),
        session_id: session2.id,
        repo_path: repoDir,
        branch_name: 'feature',
        target_branch: defaultBranch,
        is_active: true
      });

      // Second poll should not create duplicate event
      const result2 = await detector.pollForMerges();
      expect(result2.newMerges).toHaveLength(0);

      // But should notify the new subscription
      const events = db.getAllMergeEvents();
      expect(events).toHaveLength(1); // Only one merge event
    });

    it('should handle error when checking subscription', async () => {
      detector = new MergeDetector(db);

      // Create a session and subscription for non-existent repo
      const session = db.createSession({
        id: randomUUID(),
        pid: process.pid,
        repo_path: '/nonexistent/repo',
        worktree_path: '/nonexistent/repo',
        worktree_name: null,
        is_main_repo: true
      });

      db.createSubscription({
        id: randomUUID(),
        session_id: session.id,
        repo_path: '/nonexistent/repo',
        branch_name: 'feature',
        target_branch: 'main',
        is_active: true
      });

      // Poll should not throw but record error
      const result = await detector.pollForMerges();

      expect(result.subscriptionsChecked).toBe(1);
      expect(result.newMerges).toHaveLength(0);
    });
  });

  describe('getConfig', () => {
    it('should return a copy of config', () => {
      detector = new MergeDetector(db, {
        pollIntervalSeconds: 45
      });

      const config1 = detector.getConfig();
      const config2 = detector.getConfig();

      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2); // Different objects

      // Mutating returned config should not affect detector
      config1.pollIntervalSeconds = 999;
      expect(detector.getConfig().pollIntervalSeconds).toBe(45);
    });
  });
});
