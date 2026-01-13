/**
 * Tests for Git Identity Resolution in E2B Sandbox
 *
 * Tests the three-tier git identity configuration:
 * 1. CLI flags (highest priority)
 * 2. Environment variables (fallback)
 * 3. Local git config auto-detection (default)
 * 4. Hardcoded defaults (last resort)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Import function to test - will be exported after implementation
import { resolveGitIdentity, type GitIdentity } from '../../src/e2b/claude-runner.js';

describe('resolveGitIdentity', () => {
  // Save original env vars
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Clear git identity env vars for clean test state
    delete process.env.PARALLEL_CC_GIT_USER;
    delete process.env.PARALLEL_CC_GIT_EMAIL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Priority 1: CLI flags', () => {
    it('should use CLI flags when both gitUser and gitEmail are provided', async () => {
      const result = await resolveGitIdentity({
        gitUser: 'CLI User',
        gitEmail: 'cli@example.com'
      });

      expect(result.name).toBe('CLI User');
      expect(result.email).toBe('cli@example.com');
      expect(result.source).toBe('cli');
    });

    it('should fall back when only gitUser is provided (without gitEmail)', async () => {
      // When only one CLI flag is provided, it should fall through to other sources
      const result = await resolveGitIdentity({
        gitUser: 'CLI User Only'
        // gitEmail not provided
      });

      // Should not use the partial CLI config
      expect(result.source).not.toBe('cli');
    });

    it('should fall back when only gitEmail is provided (without gitUser)', async () => {
      const result = await resolveGitIdentity({
        gitEmail: 'onlyemail@example.com'
        // gitUser not provided
      });

      expect(result.source).not.toBe('cli');
    });
  });

  describe('Priority 2: Environment variables', () => {
    it('should use environment variables when both are set', async () => {
      process.env.PARALLEL_CC_GIT_USER = 'Env User';
      process.env.PARALLEL_CC_GIT_EMAIL = 'env@example.com';

      const result = await resolveGitIdentity({});

      expect(result.name).toBe('Env User');
      expect(result.email).toBe('env@example.com');
      expect(result.source).toBe('env');
    });

    it('should fall back when only PARALLEL_CC_GIT_USER is set', async () => {
      process.env.PARALLEL_CC_GIT_USER = 'Env User Only';
      // PARALLEL_CC_GIT_EMAIL not set

      const result = await resolveGitIdentity({});

      // Should not use partial env config
      expect(result.source).not.toBe('env');
    });

    it('should fall back when only PARALLEL_CC_GIT_EMAIL is set', async () => {
      process.env.PARALLEL_CC_GIT_EMAIL = 'envonly@example.com';
      // PARALLEL_CC_GIT_USER not set

      const result = await resolveGitIdentity({});

      expect(result.source).not.toBe('env');
    });

    it('should prefer CLI flags over environment variables', async () => {
      process.env.PARALLEL_CC_GIT_USER = 'Env User';
      process.env.PARALLEL_CC_GIT_EMAIL = 'env@example.com';

      const result = await resolveGitIdentity({
        gitUser: 'CLI User',
        gitEmail: 'cli@example.com'
      });

      expect(result.name).toBe('CLI User');
      expect(result.email).toBe('cli@example.com');
      expect(result.source).toBe('cli');
    });
  });

  describe('Priority 3: Local git config auto-detection', () => {
    it('should auto-detect from local git config when repoPath is a valid git repo', async () => {
      // Use the current project directory which should be a git repo
      const repoPath = process.cwd();

      const result = await resolveGitIdentity({ repoPath });

      // If running in a git repo with user config, source should be 'auto'
      // If no local git config, it will fall through to defaults
      expect(['auto', 'default']).toContain(result.source);

      // Should have valid values regardless of source
      expect(result.name).toBeTruthy();
      expect(result.email).toBeTruthy();
    });

    it('should use global git config for non-repo directories if available', async () => {
      // Use /tmp which is not a git repo, but global git config may apply
      const result = await resolveGitIdentity({ repoPath: '/tmp' });

      // If global git config exists, source will be 'auto'
      // If no global git config, source will be 'default'
      // Both are valid behaviors depending on the system
      expect(['auto', 'default']).toContain(result.source);
      expect(result.name).toBeTruthy();
      expect(result.email).toBeTruthy();
    });

    it('should fall back to defaults for non-existent directories', async () => {
      const result = await resolveGitIdentity({ repoPath: '/nonexistent/path/to/repo' });

      expect(result.source).toBe('default');
      expect(result.name).toBe('E2B Sandbox');
      expect(result.email).toBe('sandbox@e2b.dev');
    });
  });

  describe('Priority 4: Hardcoded defaults', () => {
    it('should return hardcoded defaults when no config is available', async () => {
      // Ensure no env vars, no CLI flags, and invalid repo path
      const result = await resolveGitIdentity({
        repoPath: '/nonexistent/repo'
      });

      expect(result.name).toBe('E2B Sandbox');
      expect(result.email).toBe('sandbox@e2b.dev');
      expect(result.source).toBe('default');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty strings in CLI flags', async () => {
      const result = await resolveGitIdentity({
        gitUser: '',
        gitEmail: ''
      });

      // Empty strings should be treated as not provided
      expect(result.source).not.toBe('cli');
    });

    it('should handle whitespace-only CLI flags', async () => {
      const result = await resolveGitIdentity({
        gitUser: '   ',
        gitEmail: '   '
      });

      // Whitespace-only should be treated as not provided
      expect(result.source).not.toBe('cli');
    });

    it('should handle empty environment variables', async () => {
      process.env.PARALLEL_CC_GIT_USER = '';
      process.env.PARALLEL_CC_GIT_EMAIL = '';

      const result = await resolveGitIdentity({});

      // Empty env vars should be treated as not set
      expect(result.source).not.toBe('env');
    });
  });

  describe('Return type validation', () => {
    it('should return GitIdentity with all required fields', async () => {
      const result = await resolveGitIdentity({
        gitUser: 'Test User',
        gitEmail: 'test@example.com'
      });

      expect(result).toHaveProperty('name');
      expect(result).toHaveProperty('email');
      expect(result).toHaveProperty('source');
      expect(typeof result.name).toBe('string');
      expect(typeof result.email).toBe('string');
      expect(['cli', 'env', 'auto', 'default']).toContain(result.source);
    });
  });
});

describe('initializeGitRepo with git identity', () => {
  // These tests would require E2B sandbox mocking
  // For now, we'll test the parameter passing via the exported interface

  it('should export GitIdentity type', () => {
    // Type check - if this compiles, the type is exported correctly
    const identity: GitIdentity = {
      name: 'Test',
      email: 'test@test.com',
      source: 'cli'
    };
    expect(identity).toBeDefined();
  });
});
