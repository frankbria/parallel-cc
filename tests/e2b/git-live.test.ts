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
  isValidBranchName,
  sanitizeBranchName,
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

describe('isValidBranchName', () => {
  it('should accept valid branch names with alphanumeric and safe characters', () => {
    expect(isValidBranchName('feature/my-branch')).toBe(true);
    expect(isValidBranchName('fix-bug-123')).toBe(true);
    expect(isValidBranchName('main')).toBe(true);
    expect(isValidBranchName('e2b/test-feature-123456')).toBe(true);
    expect(isValidBranchName('user_branch')).toBe(true);
  });

  it('should reject branch names with shell metacharacters', () => {
    expect(isValidBranchName('branch; rm -rf /')).toBe(false);
    expect(isValidBranchName('branch`whoami`')).toBe(false);
    expect(isValidBranchName('branch$(whoami)')).toBe(false);
    expect(isValidBranchName('branch${VAR}')).toBe(false);
    expect(isValidBranchName('branch|ls')).toBe(false);
    expect(isValidBranchName('branch&echo')).toBe(false);
  });

  it('should reject branch names with spaces', () => {
    expect(isValidBranchName('my branch')).toBe(false);
    expect(isValidBranchName(' leading-space')).toBe(false);
    expect(isValidBranchName('trailing-space ')).toBe(false);
  });

  it('should reject empty or whitespace-only strings', () => {
    expect(isValidBranchName('')).toBe(false);
    expect(isValidBranchName('   ')).toBe(false);
  });

  it('should reject branch names with special characters', () => {
    expect(isValidBranchName('branch@name')).toBe(false);
    expect(isValidBranchName('branch#tag')).toBe(false);
    expect(isValidBranchName('branch*wildcard')).toBe(false);
    expect(isValidBranchName('branch!exclaim')).toBe(false);
  });
});

describe('sanitizeBranchName', () => {
  it('should remove unsafe characters from branch name', () => {
    // Semicolon and spaces are removed, leaving: branch, rm, -rf, /
    expect(sanitizeBranchName('branch; rm -rf /', 'fallback')).toBe('branchrm-rf/');
    expect(sanitizeBranchName('my branch name', 'fallback')).toBe('mybranchname');
    expect(sanitizeBranchName('test@branch#name', 'fallback')).toBe('testbranchname');
  });

  it('should preserve safe characters', () => {
    expect(sanitizeBranchName('feature/fix-bug_123', 'fallback')).toBe('feature/fix-bug_123');
  });

  it('should fall back to generated name if sanitization results in empty string', () => {
    const result = sanitizeBranchName('!!!@@@###', 'My Fallback');
    expect(result).toMatch(/^e2b\/my-fallback-\d+$/);
  });

  it('should fall back to generated name for whitespace-only input', () => {
    const result = sanitizeBranchName('   ', 'Safe Prompt');
    expect(result).toMatch(/^e2b\/safe-prompt-\d+$/);
  });
});

describe('generatePRBody', () => {
  const mockOptions: GitLiveOptions = {
    repoPath: '/workspace',
    targetBranch: 'main',
    prompt: 'Implement feature X',
    executionTime: 123456,
    sessionId: 'test-session-123',
    sandboxId: 'sandbox-abc',
    githubToken: 'ghp_test_token_123'
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
    sandboxId: 'test-sandbox',
    githubToken: 'ghp_test_token_123'
  };

  it('should successfully create branch and PR', async () => {
    // Mock successful git operations
    mockSandbox.commands.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // add
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // write commit msg file
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // commit -F
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // rm temp file
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
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // add
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // write commit msg file
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // commit -F
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // rm temp file
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // push
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'https://github.com/user/repo/pull/42\n', stderr: '' }); // gh pr create

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

  it('should handle commit message file write failure', async () => {
    mockSandbox.commands.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // checkout ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // add ok
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'write failed' }) // write commit msg file fails
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // cleanup (in finally block)

    const result = await pushToRemoteAndCreatePR(mockSandbox, mockLogger, mockOptions);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to write commit message file');
  });

  it('should handle commit failure', async () => {
    mockSandbox.commands.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // checkout ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // add ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // write commit msg file ok
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'commit failed' }) // commit fails
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // cleanup (in finally block)

    const result = await pushToRemoteAndCreatePR(mockSandbox, mockLogger, mockOptions);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to commit');
  });

  it('should handle push failure', async () => {
    mockSandbox.commands.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // checkout ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // add ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // write commit msg file ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // commit ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // cleanup ok
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'push failed' }); // push fails

    const result = await pushToRemoteAndCreatePR(mockSandbox, mockLogger, mockOptions);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to push to remote');
  });

  it('should handle PR creation failure', async () => {
    mockSandbox.commands.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // checkout ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // add ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // write commit msg file ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // commit ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // cleanup ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // push ok
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'gh failed' }); // gh pr create fails

    const result = await pushToRemoteAndCreatePR(mockSandbox, mockLogger, mockOptions);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to create PR');
  });

  it('should log progress messages', async () => {
    mockSandbox.commands.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // add
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // write commit msg file
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // commit
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // cleanup
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // push
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'https://github.com/user/repo/pull/1\n', stderr: '' }); // gh pr create

    await pushToRemoteAndCreatePR(mockSandbox, mockLogger, mockOptions);

    expect(mockLogger.info).toHaveBeenCalledWith('Starting git live push and PR creation');
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Using branch name:'));
    expect(mockLogger.info).toHaveBeenCalledWith('Creating feature branch in sandbox');
    expect(mockLogger.info).toHaveBeenCalledWith('Staging changes');
    expect(mockLogger.info).toHaveBeenCalledWith('Creating commit');
    expect(mockLogger.info).toHaveBeenCalledWith('Pushing to remote');
    expect(mockLogger.info).toHaveBeenCalledWith('Creating pull request');
  });

  it('should handle special characters in commit message safely', async () => {
    mockSandbox.commands.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // add
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // write commit msg file
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // commit
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // cleanup
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // push
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'https://github.com/user/repo/pull/1\n', stderr: '' }); // gh pr create

    const optionsWithSpecialChars = { ...mockOptions, prompt: 'Fix "auth" bug with $VAR and `backticks`' };
    await pushToRemoteAndCreatePR(mockSandbox, mockLogger, optionsWithSpecialChars);

    // Check that commit uses -F flag with temp file (safe from injection)
    const commitCall = mockSandbox.commands.run.mock.calls[3];
    expect(commitCall[0]).toContain('git commit -F');
    expect(commitCall[0]).toContain('.git-commit-msg-');

    // Check that message is base64 encoded in write command
    const writeCall = mockSandbox.commands.run.mock.calls[2];
    expect(writeCall[0]).toContain('base64 -d');
  });

  it('should pass GITHUB_TOKEN to gh pr create command', async () => {
    mockSandbox.commands.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // add
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // write commit msg file
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // commit
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // cleanup
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // push
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'https://github.com/user/repo/pull/1\n', stderr: '' }); // gh pr create

    await pushToRemoteAndCreatePR(mockSandbox, mockLogger, mockOptions);

    // Check that gh pr create command includes GITHUB_TOKEN
    const ghCall = mockSandbox.commands.run.mock.calls[6];
    expect(ghCall[0]).toContain('GITHUB_TOKEN=ghp_test_token_123');
    expect(ghCall[0]).toContain('gh pr create');
  });

  it('should sanitize unsafe custom branch names to prevent shell injection', async () => {
    mockSandbox.commands.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // add
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // write commit msg file
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // commit
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // cleanup
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // push
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'https://github.com/user/repo/pull/1\n', stderr: '' }); // gh pr create

    const optionsWithUnsafeBranch = {
      ...mockOptions,
      featureBranch: 'branch; rm -rf /'
    };
    const result = await pushToRemoteAndCreatePR(mockSandbox, mockLogger, optionsWithUnsafeBranch);

    // Check that logger warned about sanitization
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid branch name'));
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('unsafe characters'));

    // Check that sanitized branch name was used (no shell metacharacters)
    const checkoutCall = mockSandbox.commands.run.mock.calls[0];
    expect(checkoutCall[0]).toContain('git checkout -b');
    expect(checkoutCall[0]).not.toContain(';');
    expect(checkoutCall[0]).not.toContain('rm -rf');

    // Verify the result uses sanitized name
    expect(result.branchName).toBe('branchrm-rf/');
  });

  it('should use valid custom branch names without sanitization', async () => {
    mockSandbox.commands.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // checkout
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // add
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // write commit msg file
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // commit
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // cleanup
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // push
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'https://github.com/user/repo/pull/1\n', stderr: '' }); // gh pr create

    const optionsWithSafeBranch = {
      ...mockOptions,
      featureBranch: 'feature/safe-branch-123'
    };
    const result = await pushToRemoteAndCreatePR(mockSandbox, mockLogger, optionsWithSafeBranch);

    // Check that no warning was logged
    expect(mockLogger.warn).not.toHaveBeenCalled();

    // Check that original branch name was used
    const checkoutCall = mockSandbox.commands.run.mock.calls[0];
    expect(checkoutCall[0]).toContain('git checkout -b feature/safe-branch-123');

    // Verify the result uses original name
    expect(result.branchName).toBe('feature/safe-branch-123');
  });
});
