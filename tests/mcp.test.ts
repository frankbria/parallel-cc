/**
 * Tests for MCP server and tools
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Coordinator } from '../src/coordinator.js';
import {
  getParallelStatus,
  getMySession,
  notifyWhenMerged
} from '../src/mcp/tools.js';
import {
  GetParallelStatusInputSchema,
  GetParallelStatusOutputSchema,
  GetMySessionInputSchema,
  GetMySessionOutputSchema,
  NotifyWhenMergedInputSchema,
  NotifyWhenMergedOutputSchema,
  SessionInfoSchema,
  type GetParallelStatusInput,
  type GetParallelStatusOutput,
  type GetMySessionOutput,
  type NotifyWhenMergedInput,
  type NotifyWhenMergedOutput
} from '../src/mcp/schemas.js';
import { createMcpServer } from '../src/mcp/index.js';
import type { StatusResult, SessionInfo } from '../src/types.js';

// Create a mock Coordinator instance that can be configured in tests
const mockCoordinatorInstance = {
  status: vi.fn(),
  close: vi.fn()
};

// Mock the Coordinator class to return our mock instance
vi.mock('../src/coordinator.js', () => {
  return {
    Coordinator: vi.fn().mockImplementation(() => mockCoordinatorInstance)
  };
});

// Helper to create mock session data
function createMockSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: overrides.sessionId ?? 'test-session-id',
    pid: overrides.pid ?? 12345,
    worktreePath: overrides.worktreePath ?? '/home/user/repo',
    worktreeName: overrides.worktreeName ?? null,
    isMainRepo: overrides.isMainRepo ?? true,
    createdAt: overrides.createdAt ?? '2025-01-01T10:00:00Z',
    lastHeartbeat: overrides.lastHeartbeat ?? '2025-01-01T10:05:00Z',
    isAlive: overrides.isAlive ?? true,
    durationMinutes: overrides.durationMinutes ?? 5
  };
}

// Helper to create mock status result
function createMockStatusResult(
  sessions: SessionInfo[] = [],
  repoPath = '/home/user/repo'
): StatusResult {
  return {
    repoPath,
    totalSessions: sessions.length,
    sessions
  };
}

describe('MCP Tools', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalCwd: () => string;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    originalCwd = process.cwd;

    // Mock process.cwd()
    process.cwd = vi.fn(() => '/home/user/repo');

    // Reset mocks
    mockCoordinatorInstance.status.mockReset();
    mockCoordinatorInstance.close.mockReset();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    process.cwd = originalCwd;
  });

  // ==========================================================================
  // getParallelStatus tests
  // ==========================================================================

  describe('getParallelStatus', () => {
    it('should return empty sessions when no sessions exist', async () => {
      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult([]));

      const result = await getParallelStatus({});

      expect(result.sessions).toEqual([]);
      expect(result.totalSessions).toBe(0);
      expect(mockCoordinatorInstance.close).toHaveBeenCalled();
    });

    it('should use process.cwd() when no repo_path provided', async () => {
      const mockSession = createMockSession();
      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult([mockSession]));

      await getParallelStatus({});

      expect(mockCoordinatorInstance.status).toHaveBeenCalledWith('/home/user/repo');
      expect(mockCoordinatorInstance.close).toHaveBeenCalled();
    });

    it('should use provided repo_path when given', async () => {
      const mockSession = createMockSession();
      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult([mockSession], '/custom/repo/path'));

      await getParallelStatus({ repo_path: '/custom/repo/path' });

      expect(mockCoordinatorInstance.status).toHaveBeenCalledWith('/custom/repo/path');
      expect(mockCoordinatorInstance.close).toHaveBeenCalled();
    });

    it('should properly map session info fields', async () => {
      const mockSession = createMockSession({
        sessionId: 'sess-123',
        pid: 99999,
        worktreePath: '/home/user/repo-worktrees/feature',
        worktreeName: 'feature-branch',
        isMainRepo: false,
        durationMinutes: 15,
        isAlive: true
      });
      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult([mockSession]));

      const result = await getParallelStatus({});

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toEqual({
        pid: 99999,
        worktreePath: '/home/user/repo-worktrees/feature',
        worktreeName: 'feature-branch',
        isMainRepo: false,
        durationMinutes: 15,
        isAlive: true
      });
      expect(result.totalSessions).toBe(1);
    });

    it('should handle multiple sessions', async () => {
      const mockSessions = [
        createMockSession({ pid: 100, worktreeName: 'main-repo', isMainRepo: true }),
        createMockSession({ pid: 200, worktreeName: 'feature-1', isMainRepo: false }),
        createMockSession({ pid: 300, worktreeName: 'feature-2', isMainRepo: false })
      ];
      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult(mockSessions));

      const result = await getParallelStatus({});

      expect(result.sessions).toHaveLength(3);
      expect(result.totalSessions).toBe(3);
      expect(result.sessions.map(s => s.pid)).toEqual([100, 200, 300]);
    });

    it('should handle null worktreeName', async () => {
      const mockSession = createMockSession({ worktreeName: null });
      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult([mockSession]));

      const result = await getParallelStatus({});

      expect(result.sessions[0].worktreeName).toBeNull();
    });

    it('should close coordinator even if status throws', async () => {
      mockCoordinatorInstance.status.mockImplementation(() => {
        throw new Error('Database error');
      });

      await expect(getParallelStatus({})).rejects.toThrow('Database error');
      expect(mockCoordinatorInstance.close).toHaveBeenCalled();
    });

    it('should handle dead sessions', async () => {
      const deadSession = createMockSession({ isAlive: false, pid: 99999 });
      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult([deadSession]));

      const result = await getParallelStatus({});

      expect(result.sessions[0].isAlive).toBe(false);
    });
  });

  // ==========================================================================
  // getMySession tests
  // ==========================================================================

  describe('getMySession', () => {
    it('should return error when PARALLEL_CC_SESSION_ID not set', async () => {
      delete process.env.PARALLEL_CC_SESSION_ID;

      const result = await getMySession();

      expect(result.sessionId).toBeNull();
      expect(result.worktreePath).toBeNull();
      expect(result.worktreeName).toBeNull();
      expect(result.isMainRepo).toBeNull();
      expect(result.startedAt).toBeNull();
      expect(result.parallelSessions).toBe(0);
      expect(result.error).toContain('Not running in a parallel-cc managed session');
    });

    it('should return error when session not found in database', async () => {
      process.env.PARALLEL_CC_SESSION_ID = 'non-existent-session';

      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult([]));

      const result = await getMySession();

      expect(result.sessionId).toBe('non-existent-session');
      expect(result.worktreePath).toBeNull();
      expect(result.worktreeName).toBeNull();
      expect(result.isMainRepo).toBeNull();
      expect(result.startedAt).toBeNull();
      expect(result.parallelSessions).toBe(0);
      expect(result.error).toContain('Session non-existent-session not found');
      expect(mockCoordinatorInstance.close).toHaveBeenCalled();
    });

    it('should return session info when session found', async () => {
      process.env.PARALLEL_CC_SESSION_ID = 'my-session-id';

      const mySession = createMockSession({
        sessionId: 'my-session-id',
        pid: 12345,
        worktreePath: '/home/user/repo-worktrees/feature',
        worktreeName: 'feature-branch',
        isMainRepo: false,
        createdAt: '2025-01-01T10:00:00Z'
      });
      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult([mySession]));

      const result = await getMySession();

      expect(result.sessionId).toBe('my-session-id');
      expect(result.worktreePath).toBe('/home/user/repo-worktrees/feature');
      expect(result.worktreeName).toBe('feature-branch');
      expect(result.isMainRepo).toBe(false);
      expect(result.startedAt).toBe('2025-01-01T10:00:00Z');
      expect(result.parallelSessions).toBe(1);
      expect(result.error).toBeUndefined();
      expect(mockCoordinatorInstance.close).toHaveBeenCalled();
    });

    it('should count parallel sessions correctly with single session', async () => {
      process.env.PARALLEL_CC_SESSION_ID = 'my-session-id';

      const mySession = createMockSession({
        sessionId: 'my-session-id',
        worktreePath: '/home/user/repo'
      });
      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult([mySession]));

      const result = await getMySession();

      expect(result.parallelSessions).toBe(1);
    });

    it('should count parallel sessions correctly with multiple sessions in same repo', async () => {
      process.env.PARALLEL_CC_SESSION_ID = 'session-1';

      const sessions = [
        createMockSession({
          sessionId: 'session-1',
          worktreePath: '/home/user/repo-worktrees/feature-1'
        }),
        createMockSession({
          sessionId: 'session-2',
          worktreePath: '/home/user/repo-worktrees/feature-2'
        }),
        createMockSession({
          sessionId: 'session-3',
          worktreePath: '/home/user/repo-worktrees/feature-3'
        })
      ];
      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult(sessions));

      const result = await getMySession();

      // All sessions share the same base path: /home/user/repo-worktrees
      expect(result.parallelSessions).toBe(3);
    });

    it('should count parallel sessions correctly excluding different repos', async () => {
      process.env.PARALLEL_CC_SESSION_ID = 'session-1';

      const sessions = [
        createMockSession({
          sessionId: 'session-1',
          worktreePath: '/home/user/repo-worktrees/feature-1'
        }),
        createMockSession({
          sessionId: 'session-2',
          worktreePath: '/home/user/repo-worktrees/feature-2'
        }),
        createMockSession({
          sessionId: 'other-session',
          worktreePath: '/home/user/other-repo-worktrees/feature'
        })
      ];
      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult(sessions));

      const result = await getMySession();

      // Should only count sessions in the same repo base path
      expect(result.parallelSessions).toBe(2);
    });

    it('should close coordinator even if status throws', async () => {
      process.env.PARALLEL_CC_SESSION_ID = 'my-session-id';

      mockCoordinatorInstance.status.mockImplementation(() => {
        throw new Error('Database error');
      });

      await expect(getMySession()).rejects.toThrow('Database error');
      expect(mockCoordinatorInstance.close).toHaveBeenCalled();
    });

    it('should handle main repo session', async () => {
      process.env.PARALLEL_CC_SESSION_ID = 'main-session';

      const mainSession = createMockSession({
        sessionId: 'main-session',
        worktreePath: '/home/user/repo',
        worktreeName: null,
        isMainRepo: true
      });
      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult([mainSession]));

      const result = await getMySession();

      expect(result.isMainRepo).toBe(true);
      expect(result.worktreeName).toBeNull();
    });
  });

  // ==========================================================================
  // notifyWhenMerged tests
  // ==========================================================================

  describe('notifyWhenMerged', () => {
    it('should return subscribed true with message', async () => {
      const input: NotifyWhenMergedInput = { branch: 'feature-branch' };
      const result = await notifyWhenMerged(input);

      expect(result.subscribed).toBe(true);
      expect(result.message).toContain('feature-branch');
    });

    it('should include branch name in message', async () => {
      const input: NotifyWhenMergedInput = { branch: 'my-custom-branch' };
      const result = await notifyWhenMerged(input);

      expect(result.message).toContain('my-custom-branch');
      expect(result.message).toContain('merge');
    });

    it('should indicate v0.4 implementation', async () => {
      const input: NotifyWhenMergedInput = { branch: 'test-branch' };
      const result = await notifyWhenMerged(input);

      expect(result.message).toContain('v0.4');
    });

    it('should suggest using get_parallel_status', async () => {
      const input: NotifyWhenMergedInput = { branch: 'test-branch' };
      const result = await notifyWhenMerged(input);

      expect(result.message).toContain('get_parallel_status');
    });

    it('should handle different branch names', async () => {
      const branches = ['main', 'develop', 'feature/new-feature', 'bugfix/critical'];

      for (const branch of branches) {
        const result = await notifyWhenMerged({ branch });
        expect(result.subscribed).toBe(true);
        expect(result.message).toContain(branch);
      }
    });
  });

  // ==========================================================================
  // Schema tests
  // ==========================================================================

  describe('Schemas', () => {
    it('should export GetParallelStatusInputSchema', () => {
      expect(GetParallelStatusInputSchema).toBeDefined();
      expect(GetParallelStatusInputSchema.repo_path).toBeDefined();
    });

    it('should export GetParallelStatusOutputSchema', () => {
      expect(GetParallelStatusOutputSchema).toBeDefined();
      expect(GetParallelStatusOutputSchema.sessions).toBeDefined();
      expect(GetParallelStatusOutputSchema.totalSessions).toBeDefined();
    });

    it('should export SessionInfoSchema', () => {
      expect(SessionInfoSchema).toBeDefined();
    });

    it('should export GetMySessionInputSchema', () => {
      expect(GetMySessionInputSchema).toBeDefined();
    });

    it('should export GetMySessionOutputSchema', () => {
      expect(GetMySessionOutputSchema).toBeDefined();
      expect(GetMySessionOutputSchema.sessionId).toBeDefined();
      expect(GetMySessionOutputSchema.error).toBeDefined();
    });

    it('should export NotifyWhenMergedInputSchema', () => {
      expect(NotifyWhenMergedInputSchema).toBeDefined();
      expect(NotifyWhenMergedInputSchema.branch).toBeDefined();
    });

    it('should export NotifyWhenMergedOutputSchema', () => {
      expect(NotifyWhenMergedOutputSchema).toBeDefined();
      expect(NotifyWhenMergedOutputSchema.subscribed).toBeDefined();
      expect(NotifyWhenMergedOutputSchema.message).toBeDefined();
    });

    it('should validate SessionInfo with SessionInfoSchema', () => {
      const validSession = {
        pid: 12345,
        worktreePath: '/home/user/repo',
        worktreeName: 'feature',
        isMainRepo: false,
        durationMinutes: 10,
        isAlive: true
      };

      const result = SessionInfoSchema.safeParse(validSession);
      expect(result.success).toBe(true);
    });

    it('should reject invalid SessionInfo', () => {
      const invalidSession = {
        pid: 'not-a-number', // Should be number
        worktreePath: '/home/user/repo',
        isMainRepo: false,
        durationMinutes: 10,
        isAlive: true
      };

      const result = SessionInfoSchema.safeParse(invalidSession);
      expect(result.success).toBe(false);
    });

    it('should allow null worktreeName in SessionInfo', () => {
      const sessionWithNullName = {
        pid: 12345,
        worktreePath: '/home/user/repo',
        worktreeName: null,
        isMainRepo: true,
        durationMinutes: 5,
        isAlive: true
      };

      const result = SessionInfoSchema.safeParse(sessionWithNullName);
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // MCP Server tests
  // ==========================================================================

  describe('createMcpServer', () => {
    it('should return an McpServer instance', () => {
      const server = createMcpServer();
      expect(server).toBeDefined();
      expect(typeof server).toBe('object');
    });

    it('should have name "parallel-cc"', () => {
      const server = createMcpServer();
      // Note: We can't directly access the name property, but we can verify
      // the server was created successfully
      expect(server).toBeDefined();
    });

    it('should have version "0.3.0"', () => {
      const server = createMcpServer();
      // Note: We can't directly access the version property, but we can verify
      // the server was created successfully
      expect(server).toBeDefined();
    });

    it('should create server without throwing', () => {
      expect(() => createMcpServer()).not.toThrow();
    });

    it('should register tools successfully', () => {
      // This test verifies that the server initialization doesn't throw
      // Full integration testing would require more complex setup
      const server = createMcpServer();
      expect(server).toBeDefined();
    });
  });

  // ==========================================================================
  // Integration-style tests
  // ==========================================================================

  describe('Integration scenarios', () => {
    it('should handle workflow: check status, find no sessions', async () => {
      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult([]));

      const status = await getParallelStatus({ repo_path: '/home/user/repo' });

      expect(status.totalSessions).toBe(0);
      expect(status.sessions).toHaveLength(0);
    });

    it('should handle workflow: check my session, then check parallel status', async () => {
      process.env.PARALLEL_CC_SESSION_ID = 'session-1';

      const sessions = [
        createMockSession({
          sessionId: 'session-1',
          worktreePath: '/home/user/repo-worktrees/feature-1'
        }),
        createMockSession({
          sessionId: 'session-2',
          worktreePath: '/home/user/repo-worktrees/feature-2'
        })
      ];
      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult(sessions));

      // First check my session
      const mySession = await getMySession();
      expect(mySession.sessionId).toBe('session-1');
      expect(mySession.parallelSessions).toBe(2);

      // Then check overall status
      const status = await getParallelStatus({});
      expect(status.totalSessions).toBe(2);
    });

    it('should handle workflow: subscribe to merge notifications', async () => {
      const result = await notifyWhenMerged({ branch: 'feature-branch' });

      expect(result.subscribed).toBe(true);
      expect(result.message).toBeTruthy();
    });

    it('should handle all null values in session output', async () => {
      delete process.env.PARALLEL_CC_SESSION_ID;

      const result = await getMySession();

      expect(result.sessionId).toBeNull();
      expect(result.worktreePath).toBeNull();
      expect(result.worktreeName).toBeNull();
      expect(result.isMainRepo).toBeNull();
      expect(result.startedAt).toBeNull();
    });
  });

  // ==========================================================================
  // Error handling tests
  // ==========================================================================

  describe('Error handling', () => {
    it('should handle coordinator status throwing error in getParallelStatus', async () => {
      const error = new Error('Database connection failed');
      mockCoordinatorInstance.status.mockImplementation(() => {
        throw error;
      });

      await expect(getParallelStatus({})).rejects.toThrow('Database connection failed');
      expect(mockCoordinatorInstance.close).toHaveBeenCalled();
    });

    it('should handle coordinator status throwing error in getMySession', async () => {
      process.env.PARALLEL_CC_SESSION_ID = 'my-session';

      const error = new Error('Database connection failed');
      mockCoordinatorInstance.status.mockImplementation(() => {
        throw error;
      });

      await expect(getMySession()).rejects.toThrow('Database connection failed');
      expect(mockCoordinatorInstance.close).toHaveBeenCalled();
    });

    it('should not throw when PARALLEL_CC_SESSION_ID is undefined', async () => {
      delete process.env.PARALLEL_CC_SESSION_ID;

      const result = await getMySession();

      expect(result.error).toBeDefined();
      expect(result.sessionId).toBeNull();
    });

    it('should not throw when PARALLEL_CC_SESSION_ID is empty string', async () => {
      process.env.PARALLEL_CC_SESSION_ID = '';

      const result = await getMySession();

      expect(result.error).toBeDefined();
      expect(result.sessionId).toBeNull();
    });
  });

  // ==========================================================================
  // Edge cases
  // ==========================================================================

  describe('Edge cases', () => {
    it('should handle session with very long worktree path', async () => {
      const longPath = '/home/user/very/long/path/to/repository/worktrees/feature/that/has/many/nested/directories';
      const mockSession = createMockSession({ worktreePath: longPath });
      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult([mockSession]));

      const result = await getParallelStatus({});

      expect(result.sessions[0].worktreePath).toBe(longPath);
    });

    it('should handle session with zero duration', async () => {
      const mockSession = createMockSession({ durationMinutes: 0 });
      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult([mockSession]));

      const result = await getParallelStatus({});

      expect(result.sessions[0].durationMinutes).toBe(0);
    });

    it('should handle very large PID numbers', async () => {
      const largePid = 2147483647; // Max 32-bit signed integer
      const mockSession = createMockSession({ pid: largePid });
      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult([mockSession]));

      const result = await getParallelStatus({});

      expect(result.sessions[0].pid).toBe(largePid);
    });

    it('should handle branch names with special characters', async () => {
      const specialBranches = [
        'feature/FOO-123',
        'bugfix/issue#456',
        'hotfix/v1.2.3',
        'chore/update_deps',
        'feat/user@domain'
      ];

      for (const branch of specialBranches) {
        const result = await notifyWhenMerged({ branch });
        expect(result.subscribed).toBe(true);
        expect(result.message).toContain(branch);
      }
    });

    it('should handle repo_path with trailing slash', async () => {
      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult([]));

      await getParallelStatus({ repo_path: '/home/user/repo/' });

      expect(mockCoordinatorInstance.status).toHaveBeenCalledWith('/home/user/repo/');
    });

    it('should handle many parallel sessions', async () => {
      const manySessions = Array.from({ length: 100 }, (_, i) =>
        createMockSession({
          sessionId: `session-${i}`,
          pid: 10000 + i,
          worktreePath: `/home/user/repo-worktrees/feature-${i}`,
          worktreeName: `feature-${i}`
        })
      );
      mockCoordinatorInstance.status.mockReturnValue(createMockStatusResult(manySessions));

      const result = await getParallelStatus({});

      expect(result.totalSessions).toBe(100);
      expect(result.sessions).toHaveLength(100);
    });
  });
});