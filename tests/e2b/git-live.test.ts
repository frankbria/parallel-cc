/**
 * Tests for git-live module
 *
 * Tests the git-live workflow for pushing sandbox results directly to remote:
 * - Branch name generation from prompts
 * - PR body formatting with execution details
 * - Git workflow execution in sandbox (mocked)
 * - Error handling and fallback
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generateBranchName,
  generatePRBody,
  pushToRemoteAndCreatePR,
  type GitLiveOptions
} from '../../src/e2b/git-live.js';
import type { Logger } from '../../src/logger.js';

// Create mock logger
const createMockLogger = (): Logger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
});

describe('generateBranchName', () => {
  it('should slugify prompt correctly', () => {
    const result = generateBranchName('Fix authentication bug');
    expect(result).toMatch(/^e2b\/fix-authentication-bug-\d+$/);
  });

  it('should handle special characters', () => {
    const result = generateBranchName('Add feature #42 (with tests)');
    expect(result).toMatch(/^e2b\/add-feature-42-with-tests-\d+$/);
  });

  it('should limit branch name to 50 characters', () => {
    const longPrompt = 'This is a very long prompt that exceeds the maximum allowed length for branch names';
    const result = generateBranchName(longPrompt);
    const slug = result.replace(/^e2b\//, '').replace(/-\d+$/, '');
    expect(slug.length).toBeLessThanOrEqual(50);
  });

  it('should remove leading/trailing hyphens', () => {
    const result = generateBranchName('!!!Fix bug!!!');
    expect(result).toMatch(/^e2b\/fix-bug-\d+$/);
  });

  it('should handle uppercase letters', () => {
    const result = generateBranchName('Fix AUTH Bug');
    expect(result).toMatch(/^e2b\/fix-auth-bug-\d+$/);
  });

  it('should add timestamp for uniqueness', async () => {
    const result1 = generateBranchName('Same prompt');
    // Small delay to ensure different timestamps
    await new Promise(resolve => setTimeout(resolve, 2));
    const result2 = generateBranchName('Same prompt');
    expect(result1).not.toBe(result2);
  });
});

describe('generatePRBody', () => {
  const mockOptions: GitLiveOptions = {
    repoPath: '/workspace',
    targetBranch: 'main',
    prompt: 'Implement feature X',
    executionTime: 123456,
    sessionId: 'test-session-123',
    sandboxId: 'sandbox-abc'
  };

  it('should include prompt in PR body', () => {
    const body = generatePRBody(mockOptions);
    expect(body).toContain('**Prompt:** Implement feature X');
  });

  it('should include execution details', () => {
    const body = generatePRBody(mockOptions);
    expect(body).toContain('Execution Time: 123.5s');
    expect(body).toContain('Session ID: test-session-123');
    expect(body).toContain('Sandbox ID: sandbox-abc');
    expect(body).toContain('Target Branch: main');
  });

  it('should include review checklist', () => {
    const body = generatePRBody(mockOptions);
    expect(body).toContain('## Review Checklist');
    expect(body).toContain('- [ ] Review all changed files');
    expect(body).toContain('- [ ] Run tests locally');
    expect(body).toContain('- [ ] Verify no sensitive data was committed');
  });

  it('should include execution log details in collapsed section', () => {
    const body = generatePRBody(mockOptions);
    expect(body).toContain('<details>');
    expect(body).toContain('<summary>E2B Execution Log</summary>');
    expect(body).toContain('Session ID: `test-session-123`');
    expect(body).toContain('Sandbox ID: `sandbox-abc`');
  });

  it('should format execution time correctly', () => {
    const options = { ...mockOptions, executionTime: 45678 };
    const body = generatePRBody(options);
    expect(body).toContain('Execution Time: 45.7s');
  });
});

describe('pushToRemoteAndCreatePR', () => {
  let mockLogger: Logger;
  let mockSandbox: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();

    // Create mock sandbox with commands API
    mockSandbox = {
      commands: {
        run: vi.fn()
      }
    };
  });

  const mockOptions: GitLiveOptions = {
    repoPath: '/workspace',
    targetBranch: 'main',
    prompt: 'Test feature',
    executionTime: 60000,
    sessionId: 'test-session',
    sandboxId: 'test-sandbox'
  };

  it('should successfully create branch and PR', async () => {
    // Mock successful git operations
    mockSandbox.commands.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // add
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // commit
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // push
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'https://github.com/user/repo/pull/123\n',
        stderr: ''
      }); // gh pr create

    const result = await pushToRemoteAndCreatePR(mockSandbox, mockLogger, mockOptions);

    expect(result.success).toBe(true);
    expect(result.branchName).toMatch(/^e2b\/test-feature-\d+$/);
    expect(result.prUrl).toBe('https://github.com/user/repo/pull/123');
    expect(result.targetBranch).toBe('main');
  });

  it('should use provided feature branch name if given', async () => {
    mockSandbox.commands.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'https://github.com/user/repo/pull/42\n', stderr: '' });

    const optionsWithBranch = { ...mockOptions, featureBranch: 'custom-branch' };
    const result = await pushToRemoteAndCreatePR(mockSandbox, mockLogger, optionsWithBranch);

    expect(result.success).toBe(true);
    expect(result.branchName).toBe('custom-branch');
  });

  it('should handle checkout failure', async () => {
    mockSandbox.commands.run.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'checkout failed' });

    const result = await pushToRemoteAndCreatePR(mockSandbox, mockLogger, mockOptions);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to create branch');
  });

  it('should handle git add failure', async () => {
    mockSandbox.commands.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // checkout ok
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'add failed' }); // add fails

    const result = await pushToRemoteAndCreatePR(mockSandbox, mockLogger, mockOptions);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to stage changes');
  });

  it('should handle commit failure', async () => {
    mockSandbox.commands.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // checkout ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // add ok
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'commit failed' }); // commit fails

    const result = await pushToRemoteAndCreatePR(mockSandbox, mockLogger, mockOptions);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to commit');
  });

  it('should handle push failure', async () => {
    mockSandbox.commands.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // checkout ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // add ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // commit ok
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'push failed' }); // push fails

    const result = await pushToRemoteAndCreatePR(mockSandbox, mockLogger, mockOptions);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to push to remote');
  });

  it('should handle PR creation failure', async () => {
    mockSandbox.commands.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // checkout ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // add ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // commit ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // push ok
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'gh failed' }); // gh pr create fails

    const result = await pushToRemoteAndCreatePR(mockSandbox, mockLogger, mockOptions);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to create PR');
  });

  it('should log progress messages', async () => {
    mockSandbox.commands.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'https://github.com/user/repo/pull/1\n', stderr: '' });

    await pushToRemoteAndCreatePR(mockSandbox, mockLogger, mockOptions);

    expect(mockLogger.info).toHaveBeenCalledWith('Starting git live push and PR creation');
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Using branch name:'));
    expect(mockLogger.info).toHaveBeenCalledWith('Creating feature branch in sandbox');
    expect(mockLogger.info).toHaveBeenCalledWith('Staging changes');
    expect(mockLogger.info).toHaveBeenCalledWith('Creating commit');
    expect(mockLogger.info).toHaveBeenCalledWith('Pushing to remote');
    expect(mockLogger.info).toHaveBeenCalledWith('Creating pull request');
  });

  it('should escape quotes in commit message', async () => {
    mockSandbox.commands.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'https://github.com/user/repo/pull/1\n', stderr: '' });

    const optionsWithQuotes = { ...mockOptions, prompt: 'Fix "authentication" bug' };
    await pushToRemoteAndCreatePR(mockSandbox, mockLogger, optionsWithQuotes);

    // Check that commit command was called with escaped quotes
    const commitCall = mockSandbox.commands.run.mock.calls[2];
    expect(commitCall[0]).toContain('\\"authentication\\"');
  });
});
