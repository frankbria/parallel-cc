/**
 * Tests for GtrWrapper class
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { GtrWrapper } from '../src/gtr.js';
import type { GtrResult, GtrListEntry } from '../src/types.js';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  exec: vi.fn(),
}));

// Mock logger
vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('GtrWrapper', () => {
  const mockRepoPath = '/mock/repo/path';
  let gtr: GtrWrapper;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Reset the cached gtrCommand between tests
    // @ts-ignore - accessing private static property for testing
    GtrWrapper.gtrCommand = null;

    // Create new instance
    gtr = new GtrWrapper(mockRepoPath);
  });

  describe('detectGtrCommand', () => {
    it('should return "gtr" when v1.x is available', () => {
      // Mock successful v1.x command (returns Buffer when no encoding specified)
      vi.mocked(execSync).mockReturnValueOnce('gtr version 1.2.3' as any);

      const result = GtrWrapper.isAvailable();

      expect(result).toBe(true);
      expect(execSync).toHaveBeenCalledWith('gtr version', { stdio: 'pipe' });
      expect(execSync).toHaveBeenCalledTimes(1);
    });

    it('should return "git gtr" when v2.x is available', () => {
      // Mock v1.x failing, v2.x succeeding
      vi.mocked(execSync)
        .mockImplementationOnce(() => {
          throw new Error('Command not found');
        })
        .mockReturnValueOnce('gtr version 2.0.0' as any);

      const result = GtrWrapper.isAvailable();

      expect(result).toBe(true);
      expect(execSync).toHaveBeenCalledWith('gtr version', { stdio: 'pipe' });
      expect(execSync).toHaveBeenCalledWith('git gtr version', { stdio: 'pipe' });
      expect(execSync).toHaveBeenCalledTimes(2);
    });

    it('should throw when neither v1.x nor v2.x is available', () => {
      // Mock both commands failing
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Command not found');
      });

      // The error is thrown when trying to detect gtr, not when calling the method
      // createWorktree catches the error and returns a failure result
      const result = gtr.createWorktree('test-worktree');

      expect(result.success).toBe(false);
      expect(result.error).toContain('gtr is not installed');
    });

    it('should cache the result and only detect once', () => {
      // Mock successful v1.x command
      vi.mocked(execSync).mockReturnValue('gtr version 1.2.3' as any);

      // First call
      GtrWrapper.isAvailable();
      expect(execSync).toHaveBeenCalledTimes(1);

      // Second call should use cached value
      GtrWrapper.isAvailable();
      expect(execSync).toHaveBeenCalledTimes(1); // Still just 1

      // Third call on instance method should also use cache
      vi.mocked(execSync).mockClear();
      vi.mocked(execSync).mockReturnValue('Worktree created' as any);
      gtr.createWorktree('test');

      // Should not call 'gtr version' again, only 'gtr new'
      expect(execSync).toHaveBeenCalledTimes(1);
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('gtr new'),
        expect.any(Object)
      );
    });
  });

  describe('isAvailable', () => {
    it('should return true when gtr is found', () => {
      vi.mocked(execSync).mockReturnValue('gtr version 1.2.3' as any);

      const result = GtrWrapper.isAvailable();

      expect(result).toBe(true);
    });

    it('should return false when gtr is not installed', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Command not found');
      });

      const result = GtrWrapper.isAvailable();

      expect(result).toBe(false);
    });
  });

  describe('createWorktree', () => {
    beforeEach(() => {
      // Setup: gtr v1.x is available
      vi.mocked(execSync).mockReturnValueOnce('gtr version 1.2.3' as any);
      GtrWrapper.isAvailable(); // Populate cache
      vi.mocked(execSync).mockClear();
    });

    it('should call gtr new with correct arguments', () => {
      const mockOutput = 'Worktree created at /path/to/worktree';
      // When encoding: 'utf-8' is specified, execSync returns a string
      vi.mocked(execSync).mockReturnValue(mockOutput as any);

      const result = gtr.createWorktree('test-worktree');

      expect(result.success).toBe(true);
      expect(result.output).toBe(mockOutput);
      expect(execSync).toHaveBeenCalledWith(
        'gtr new test-worktree --from HEAD --yes',
        {
          cwd: mockRepoPath,
          encoding: 'utf-8',
          stdio: 'pipe'
        }
      );
    });

    it('should return success result with output', () => {
      const mockOutput = 'Worktree created successfully';
      vi.mocked(execSync).mockReturnValue(mockOutput as any);

      const result: GtrResult = gtr.createWorktree('my-worktree');

      expect(result).toEqual({
        success: true,
        output: mockOutput
      });
    });

    it('should return error result on failure', () => {
      const mockError = {
        message: 'Failed to create worktree',
        stderr: Buffer.from('error: branch already exists')
      };
      vi.mocked(execSync).mockImplementation(() => {
        throw mockError;
      });

      const result: GtrResult = gtr.createWorktree('existing-worktree');

      expect(result.success).toBe(false);
      expect(result.output).toBe('');
      expect(result.error).toBe('error: branch already exists');
    });

    it('should use default fromRef of HEAD', () => {
      vi.mocked(execSync).mockReturnValue('Created' as any);

      gtr.createWorktree('test-worktree');

      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('--from HEAD'),
        expect.any(Object)
      );
    });

    it('should accept custom fromRef', () => {
      vi.mocked(execSync).mockReturnValue('Created' as any);

      gtr.createWorktree('test-worktree', 'main');

      expect(execSync).toHaveBeenCalledWith(
        'gtr new test-worktree --from main --yes',
        expect.any(Object)
      );
    });

    it('should handle error without stderr', () => {
      const mockError = {
        message: 'Generic error'
      };
      vi.mocked(execSync).mockImplementation(() => {
        throw mockError;
      });

      const result = gtr.createWorktree('test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Generic error');
    });
  });

  describe('getWorktreePath', () => {
    beforeEach(() => {
      // Setup: gtr v2.x is available
      vi.mocked(execSync)
        .mockImplementationOnce(() => {
          throw new Error('v1 not found');
        })
        .mockReturnValueOnce('gtr version 2.0.0' as any);
      GtrWrapper.isAvailable();
      vi.mocked(execSync).mockClear();
    });

    it('should call gtr go and return path', () => {
      const mockPath = '/path/to/worktree';
      vi.mocked(execSync).mockReturnValue(mockPath + '\n' as any);

      const result = gtr.getWorktreePath('test-worktree');

      expect(result).toBe(mockPath);
      expect(execSync).toHaveBeenCalledWith(
        'git gtr go test-worktree',
        {
          cwd: mockRepoPath,
          encoding: 'utf-8',
          stdio: 'pipe'
        }
      );
    });

    it('should return null on error', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Worktree not found');
      });

      const result = gtr.getWorktreePath('nonexistent');

      expect(result).toBeNull();
    });

    it('should trim whitespace from output', () => {
      const mockPath = '/path/to/worktree';
      vi.mocked(execSync).mockReturnValue(`  ${mockPath}  \n` as any);

      const result = gtr.getWorktreePath('test-worktree');

      expect(result).toBe(mockPath);
    });
  });

  describe('removeWorktree', () => {
    beforeEach(() => {
      // Setup: gtr v1.x is available
      vi.mocked(execSync).mockReturnValueOnce('gtr version 1.2.3' as any);
      GtrWrapper.isAvailable();
      vi.mocked(execSync).mockClear();
    });

    it('should call gtr rm with --yes flag', () => {
      const mockOutput = 'Worktree removed';
      vi.mocked(execSync).mockReturnValue(mockOutput as any);

      const result = gtr.removeWorktree('test-worktree');

      expect(result.success).toBe(true);
      expect(result.output).toBe(mockOutput);
      expect(execSync).toHaveBeenCalledWith(
        'gtr rm test-worktree --yes',
        {
          cwd: mockRepoPath,
          encoding: 'utf-8',
          stdio: 'pipe'
        }
      );
    });

    it('should include --delete-branch flag when requested', () => {
      vi.mocked(execSync).mockReturnValue('Removed' as any);

      gtr.removeWorktree('test-worktree', true);

      expect(execSync).toHaveBeenCalledWith(
        'gtr rm test-worktree --delete-branch --yes',
        expect.any(Object)
      );
    });

    it('should return success result', () => {
      const mockOutput = 'Worktree and branch deleted';
      vi.mocked(execSync).mockReturnValue(mockOutput as any);

      const result: GtrResult = gtr.removeWorktree('test', true);

      expect(result).toEqual({
        success: true,
        output: mockOutput
      });
    });

    it('should return error result on failure', () => {
      const mockError = {
        message: 'Failed to remove',
        stderr: Buffer.from('error: worktree not found')
      };
      vi.mocked(execSync).mockImplementation(() => {
        throw mockError;
      });

      const result: GtrResult = gtr.removeWorktree('nonexistent');

      expect(result.success).toBe(false);
      expect(result.output).toBe('');
      expect(result.error).toBe('error: worktree not found');
    });
  });

  describe('listWorktrees', () => {
    beforeEach(() => {
      // Setup: gtr v1.x is available
      vi.mocked(execSync).mockReturnValueOnce('gtr version 1.2.3' as any);
      GtrWrapper.isAvailable();
      vi.mocked(execSync).mockClear();
    });

    it('should parse porcelain output correctly', () => {
      const mockOutput = `worktree /home/user/repo
HEAD abc123
branch refs/heads/main

worktree /home/user/repo-worktrees/parallel-123
HEAD def456
branch refs/heads/feature-1`;

      vi.mocked(execSync).mockReturnValue(mockOutput as any);

      const result = gtr.listWorktrees();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        path: '/home/user/repo',
        branch: 'main',
        isMain: true
      });
      expect(result[1]).toEqual({
        path: '/home/user/repo-worktrees/parallel-123',
        branch: 'feature-1',
        isMain: false
      });
    });

    it('should extract worktree path and branch', () => {
      const mockOutput = `worktree /path/to/worktree
HEAD 1234567
branch refs/heads/my-branch`;

      vi.mocked(execSync).mockReturnValue(mockOutput as any);

      const result = gtr.listWorktrees();

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('/path/to/worktree');
      expect(result[0].branch).toBe('my-branch');
    });

    it('should identify main repo correctly', () => {
      const mockOutput = `worktree /home/user/main-repo
HEAD abc123
branch refs/heads/main

worktree /home/user/main-repo-worktrees/parallel-456
HEAD def456
branch refs/heads/feature`;

      vi.mocked(execSync).mockReturnValue(mockOutput as any);

      const result = gtr.listWorktrees();

      expect(result[0].isMain).toBe(true);
      expect(result[1].isMain).toBe(false);
    });

    it('should fallback to git worktree list on gtr failure', () => {
      // First call (gtr list) fails
      // Second call (git worktree list) succeeds
      vi.mocked(execSync)
        .mockImplementationOnce(() => {
          throw new Error('gtr list failed');
        })
        .mockReturnValueOnce(`worktree /home/user/repo
HEAD abc123
branch refs/heads/main` as any);

      const result = gtr.listWorktrees();

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('/home/user/repo');
      expect(execSync).toHaveBeenCalledWith(
        'gtr list --porcelain',
        expect.any(Object)
      );
      expect(execSync).toHaveBeenCalledWith(
        'git worktree list --porcelain',
        expect.any(Object)
      );
    });

    it('should skip entries without path', () => {
      const mockOutput = `HEAD abc123
branch refs/heads/main

worktree /valid/path
HEAD def456
branch refs/heads/feature`;

      vi.mocked(execSync).mockReturnValue(mockOutput as any);

      const result = gtr.listWorktrees();

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('/valid/path');
    });

    it('should skip entries without branch', () => {
      const mockOutput = `worktree /path/without/branch
HEAD abc123

worktree /valid/path
HEAD def456
branch refs/heads/feature`;

      vi.mocked(execSync).mockReturnValue(mockOutput as any);

      const result = gtr.listWorktrees();

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('/valid/path');
    });
  });

  describe('listWorktreesGit (fallback)', () => {
    beforeEach(() => {
      // Setup: gtr is available but will fail on list
      vi.mocked(execSync).mockReturnValueOnce('gtr version 1.2.3' as any);
      GtrWrapper.isAvailable();
      vi.mocked(execSync).mockClear();
    });

    it('should parse git worktree list --porcelain output', () => {
      // Fail gtr list, succeed git worktree list
      vi.mocked(execSync)
        .mockImplementationOnce(() => {
          throw new Error('gtr failed');
        })
        .mockReturnValueOnce(`worktree /home/user/repo
HEAD abc123
branch refs/heads/main

worktree /home/user/repo-worktrees/wt-1
HEAD def456
branch refs/heads/feature` as any);

      const result = gtr.listWorktrees();

      expect(result).toHaveLength(2);
      expect(result[0].branch).toBe('main');
      expect(result[1].branch).toBe('feature');
    });

    it('should handle detached HEAD branches', () => {
      vi.mocked(execSync)
        .mockImplementationOnce(() => {
          throw new Error('gtr failed');
        })
        .mockReturnValueOnce(`worktree /home/user/repo
HEAD abc123
detached` as any);

      const result = gtr.listWorktrees();

      expect(result).toHaveLength(1);
      expect(result[0].branch).toBe('detached');
    });

    it('should return empty array on error', () => {
      // Both gtr and git fail
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('All commands failed');
      });

      const result = gtr.listWorktrees();

      expect(result).toEqual([]);
    });

    it('should mark first entry as main', () => {
      vi.mocked(execSync)
        .mockImplementationOnce(() => {
          throw new Error('gtr failed');
        })
        .mockReturnValueOnce(`worktree /home/user/main
HEAD abc123
branch refs/heads/main

worktree /home/user/worktree1
HEAD def456
branch refs/heads/feature1

worktree /home/user/worktree2
HEAD ghi789
branch refs/heads/feature2` as any);

      const result = gtr.listWorktrees();

      expect(result).toHaveLength(3);
      expect(result[0].isMain).toBe(true);
      expect(result[1].isMain).toBe(false);
      expect(result[2].isMain).toBe(false);
    });

    it('should handle worktree without branch as detached', () => {
      vi.mocked(execSync)
        .mockImplementationOnce(() => {
          throw new Error('gtr failed');
        })
        .mockReturnValueOnce(`worktree /home/user/repo
HEAD abc123` as any);

      const result = gtr.listWorktrees();

      expect(result).toHaveLength(1);
      expect(result[0].branch).toBe('detached');
    });
  });

  describe('getMainRepoPath', () => {
    beforeEach(() => {
      vi.mocked(execSync).mockReturnValueOnce('gtr version 1.2.3' as any);
      GtrWrapper.isAvailable();
      vi.mocked(execSync).mockClear();
    });

    it('should return path of main repo', () => {
      const mockOutput = `worktree /home/user/main-repo
HEAD abc123
branch refs/heads/main

worktree /home/user/main-repo-worktrees/wt-1
HEAD def456
branch refs/heads/feature`;

      vi.mocked(execSync).mockReturnValue(mockOutput as any);

      const result = gtr.getMainRepoPath();

      expect(result).toBe('/home/user/main-repo');
    });

    it('should return null when no worktrees exist', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('No worktrees');
      });

      const result = gtr.getMainRepoPath();

      expect(result).toBeNull();
    });

    it('should return null when listWorktrees returns empty array', () => {
      vi.mocked(execSync).mockReturnValue('' as any);

      const result = gtr.getMainRepoPath();

      expect(result).toBeNull();
    });
  });

  describe('generateWorktreeName (static)', () => {
    it('should use default prefix "parallel-"', () => {
      const name = GtrWrapper.generateWorktreeName();

      expect(name).toMatch(/^parallel-[a-z0-9]+-[a-z0-9]{4}$/);
    });

    it('should accept custom prefix', () => {
      const name = GtrWrapper.generateWorktreeName('custom-');

      expect(name).toMatch(/^custom-[a-z0-9]+-[a-z0-9]{4}$/);
    });

    it('should include timestamp and random suffix', () => {
      const name = GtrWrapper.generateWorktreeName();
      const parts = name.split('-');

      expect(parts).toHaveLength(3); // prefix, timestamp, random
      expect(parts[0]).toBe('parallel');
      expect(parts[1]).toMatch(/^[a-z0-9]+$/); // timestamp in base36
      expect(parts[2]).toMatch(/^[a-z0-9]{4}$/); // 4 char random
    });

    it('should generate unique names', () => {
      const names = new Set<string>();

      for (let i = 0; i < 100; i++) {
        names.add(GtrWrapper.generateWorktreeName());
      }

      // All names should be unique
      expect(names.size).toBe(100);
    });

    it('should work with empty prefix', () => {
      const name = GtrWrapper.generateWorktreeName('');

      expect(name).toMatch(/^[a-z0-9]+-[a-z0-9]{4}$/);
      expect(name).not.toMatch(/^parallel-/);
    });

    it('should preserve prefix exactly', () => {
      const customPrefix = 'my-custom-prefix-';
      const name = GtrWrapper.generateWorktreeName(customPrefix);

      expect(name.startsWith(customPrefix)).toBe(true);
    });
  });

  describe('edge cases and error handling', () => {
    beforeEach(() => {
      vi.mocked(execSync).mockReturnValueOnce('gtr version 1.2.3' as any);
      GtrWrapper.isAvailable();
      vi.mocked(execSync).mockClear();
    });

    it('should handle empty output from gtr commands', () => {
      vi.mocked(execSync).mockReturnValue('' as any);

      const result = gtr.createWorktree('test');

      expect(result.success).toBe(true);
      expect(result.output).toBe('');
    });

    it('should handle multi-line output', () => {
      const mockOutput = 'Line 1\nLine 2\nLine 3\n';
      vi.mocked(execSync).mockReturnValue(mockOutput as any);

      const result = gtr.createWorktree('test');

      expect(result.success).toBe(true);
      expect(result.output).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should handle worktree names with special characters', () => {
      vi.mocked(execSync).mockReturnValue('Created' as any);

      gtr.createWorktree('feature/branch-name');

      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('feature/branch-name'),
        expect.any(Object)
      );
    });

    it('should handle long worktree names', () => {
      const longName = 'a'.repeat(200);
      vi.mocked(execSync).mockReturnValue('Created' as any);

      gtr.createWorktree(longName);

      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining(longName),
        expect.any(Object)
      );
    });

    it('should handle repo paths with spaces', () => {
      const gtrWithSpaces = new GtrWrapper('/path with spaces/repo');
      vi.mocked(execSync).mockReturnValue('Created' as any);

      gtrWithSpaces.createWorktree('test');

      expect(execSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          cwd: '/path with spaces/repo'
        })
      );
    });
  });

  describe('version detection edge cases', () => {
    it('should handle gtr command that exists but version fails', () => {
      // execSync succeeds but returns empty
      vi.mocked(execSync).mockReturnValue('' as any);

      const result = GtrWrapper.isAvailable();

      expect(result).toBe(true);
    });

    it('should prioritize v1.x over v2.x', () => {
      // Both versions available
      vi.mocked(execSync)
        .mockReturnValueOnce('gtr version 1.0.0' as any)
        .mockReturnValueOnce('gtr version 2.0.0' as any);

      GtrWrapper.isAvailable();

      // Should only call v1.x version check
      expect(execSync).toHaveBeenCalledTimes(1);
      expect(execSync).toHaveBeenCalledWith('gtr version', { stdio: 'pipe' });
    });

    it('should handle execSync throwing non-Error objects', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw 'string error';
      });

      // The method catches errors and returns failure result
      const result = gtr.createWorktree('test');

      expect(result.success).toBe(false);
      // When a non-Error is thrown (e.g., a string), err.stderr and err.message
      // don't exist, so error will be undefined
      // This is an edge case that could be improved in the implementation
      expect(result.error).toBeUndefined();
    });
  });

  describe('integration scenarios', () => {
    beforeEach(() => {
      vi.mocked(execSync).mockReturnValueOnce('gtr version 2.0.0' as any);
      GtrWrapper.isAvailable();
      vi.mocked(execSync).mockClear();
    });

    it('should create worktree, get path, then remove it', () => {
      const worktreeName = 'integration-test';
      const worktreePath = '/path/to/worktree';

      // Mock createWorktree
      vi.mocked(execSync).mockReturnValueOnce('Created' as any);
      const createResult = gtr.createWorktree(worktreeName);
      expect(createResult.success).toBe(true);

      // Mock getWorktreePath
      vi.mocked(execSync).mockReturnValueOnce(worktreePath as any);
      const path = gtr.getWorktreePath(worktreeName);
      expect(path).toBe(worktreePath);

      // Mock removeWorktree
      vi.mocked(execSync).mockReturnValueOnce('Removed' as any);
      const removeResult = gtr.removeWorktree(worktreeName, true);
      expect(removeResult.success).toBe(true);
    });

    it('should list worktrees after creating several', () => {
      const mockList = `worktree /home/user/repo
HEAD abc
branch refs/heads/main

worktree /home/user/repo-worktrees/wt1
HEAD def
branch refs/heads/feature1

worktree /home/user/repo-worktrees/wt2
HEAD ghi
branch refs/heads/feature2`;

      vi.mocked(execSync).mockReturnValue(mockList as any);

      const worktrees = gtr.listWorktrees();

      expect(worktrees).toHaveLength(3);
      expect(worktrees.filter(w => w.isMain)).toHaveLength(1);
      expect(worktrees.filter(w => !w.isMain)).toHaveLength(2);
    });
  });
});
