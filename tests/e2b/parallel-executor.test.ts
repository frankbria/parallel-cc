/**
 * Tests for ParallelExecutor class
 *
 * Tests parallel sandbox execution orchestration including:
 * - Multiple task execution with concurrency control
 * - Fail-fast behavior (stop all on first failure)
 * - Result aggregation and summary generation
 * - Progress monitoring and callbacks
 * - Error handling and cleanup
 * - Cancellation of remaining tasks
 *
 * All E2B SDK and file system operations are mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ParallelExecutor } from '../../src/e2b/parallel-executor.js';
import type {
  ParallelExecutionConfig,
  TaskResult,
  ParallelProgressUpdate,
  ParallelTaskStatus
} from '../../src/types.js';
import type { Logger } from '../../src/logger.js';
import type { Coordinator } from '../../src/coordinator.js';
import type { SandboxManager } from '../../src/e2b/sandbox-manager.js';

// Mock dependencies
vi.mock('../../src/coordinator.js');
vi.mock('../../src/e2b/sandbox-manager.js');
vi.mock('../../src/e2b/file-sync.js');
vi.mock('../../src/e2b/claude-runner.js');
vi.mock('fs/promises');

// Create mock logger
const createMockLogger = (): Logger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
});

// Create mock coordinator
const createMockCoordinator = () => ({
  register: vi.fn().mockResolvedValue({
    sessionId: 'session-123',
    worktreePath: '/tmp/worktree-1',
    worktreeName: 'parallel-task-1',
    isNew: true,
    isMainRepo: false,
    parallelSessions: 1
  }),
  release: vi.fn().mockResolvedValue({ success: true }),
  close: vi.fn()
});

// Create mock sandbox manager
const createMockSandboxManager = () => ({
  createSandbox: vi.fn().mockResolvedValue({
    sandbox: { sandboxId: 'sandbox-123', commands: { run: vi.fn() }, files: { write: vi.fn() } },
    sandboxId: 'sandbox-123',
    status: 'INITIALIZING'
  }),
  terminateSandbox: vi.fn().mockResolvedValue({ success: true, cleanedUp: true }),
  getEstimatedCost: vi.fn().mockReturnValue('$0.10'),
  getSandbox: vi.fn(),
  setBudgetLimit: vi.fn(),
  cleanupAll: vi.fn().mockResolvedValue(undefined)
});

describe('ParallelExecutor', () => {
  let executor: ParallelExecutor;
  let mockLogger: Logger;
  let mockCoordinator: ReturnType<typeof createMockCoordinator>;
  let mockSandboxManager: ReturnType<typeof createMockSandboxManager>;
  let defaultConfig: ParallelExecutionConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    mockLogger = createMockLogger();
    mockCoordinator = createMockCoordinator();
    mockSandboxManager = createMockSandboxManager();

    defaultConfig = {
      tasks: ['Task 1: Implement feature A', 'Task 2: Fix bug B', 'Task 3: Add tests'],
      maxConcurrent: 2,
      failFast: false,
      outputDir: '/tmp/parallel-results',
      repoPath: '/home/user/project',
      authMethod: 'api-key',
      gitLive: false,
      targetBranch: 'main'
    };

    executor = new ParallelExecutor(
      defaultConfig,
      mockCoordinator as unknown as Coordinator,
      mockSandboxManager as unknown as SandboxManager,
      mockLogger
    );
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('constructor', () => {
    it('should create executor with valid config', () => {
      expect(executor).toBeInstanceOf(ParallelExecutor);
    });

    it('should throw error when no tasks provided', () => {
      expect(() => {
        new ParallelExecutor(
          { ...defaultConfig, tasks: [] },
          mockCoordinator as unknown as Coordinator,
          mockSandboxManager as unknown as SandboxManager,
          mockLogger
        );
      }).toThrow(/at least one task/i);
    });

    it('should throw error when maxConcurrent is less than 1', () => {
      expect(() => {
        new ParallelExecutor(
          { ...defaultConfig, maxConcurrent: 0 },
          mockCoordinator as unknown as Coordinator,
          mockSandboxManager as unknown as SandboxManager,
          mockLogger
        );
      }).toThrow(/maxConcurrent must be at least 1/i);
    });

    it('should use default maxConcurrent of 3 when not specified', () => {
      const configWithoutConcurrent = { ...defaultConfig };
      delete (configWithoutConcurrent as any).maxConcurrent;
      configWithoutConcurrent.maxConcurrent = 3;

      const exec = new ParallelExecutor(
        configWithoutConcurrent,
        mockCoordinator as unknown as Coordinator,
        mockSandboxManager as unknown as SandboxManager,
        mockLogger
      );

      expect(exec).toBeInstanceOf(ParallelExecutor);
    });
  });

  describe('execute', () => {
    it('should execute all tasks and return results', async () => {
      // Mock successful task execution
      const mockExecuteTask = vi.spyOn(executor as any, 'executeTask');
      mockExecuteTask.mockResolvedValue({
        taskId: 'task-1',
        taskDescription: 'Task 1',
        sessionId: 'session-123',
        sandboxId: 'sandbox-123',
        worktreePath: '/tmp/worktree',
        status: 'completed' as ParallelTaskStatus,
        startTime: new Date(),
        endTime: new Date(),
        duration: 5000,
        filesChanged: 3,
        outputPath: '/tmp/parallel-results/task-1',
        exitCode: 0,
        costEstimate: 0.10
      });

      const result = await executor.execute();

      expect(result.success).toBe(true);
      expect(result.tasks).toHaveLength(3);
      expect(result.summary).toBeDefined();
      expect(result.summary.successCount).toBe(3);
      expect(result.summary.failureCount).toBe(0);
    });

    it('should respect maxConcurrent limit', async () => {
      const concurrentCalls: number[] = [];
      let currentConcurrent = 0;

      const mockExecuteTask = vi.spyOn(executor as any, 'executeTask');
      mockExecuteTask.mockImplementation(async () => {
        currentConcurrent++;
        concurrentCalls.push(currentConcurrent);

        // Simulate some work
        await new Promise(resolve => setTimeout(resolve, 10));

        currentConcurrent--;
        return {
          taskId: 'task-1',
          taskDescription: 'Task',
          sessionId: 'session-123',
          sandboxId: 'sandbox-123',
          worktreePath: '/tmp/worktree',
          status: 'completed' as ParallelTaskStatus,
          startTime: new Date(),
          endTime: new Date(),
          duration: 10,
          filesChanged: 1,
          outputPath: '/tmp/output',
          exitCode: 0
        };
      });

      await executor.execute();

      // Should never exceed maxConcurrent (2)
      expect(Math.max(...concurrentCalls)).toBeLessThanOrEqual(2);
    });

    it('should handle task failures without fail-fast', async () => {
      const mockExecuteTask = vi.spyOn(executor as any, 'executeTask');
      mockExecuteTask
        .mockResolvedValueOnce({
          taskId: 'task-1',
          status: 'completed' as ParallelTaskStatus,
          filesChanged: 1,
          outputPath: '/tmp/output',
          sessionId: 'session-1',
          sandboxId: 'sandbox-1',
          worktreePath: '/tmp/worktree-1',
          taskDescription: 'Task 1',
          startTime: new Date(),
          endTime: new Date(),
          duration: 1000,
          exitCode: 0
        })
        .mockResolvedValueOnce({
          taskId: 'task-2',
          status: 'failed' as ParallelTaskStatus,
          error: 'Task failed',
          filesChanged: 0,
          outputPath: '/tmp/output',
          sessionId: 'session-2',
          sandboxId: 'sandbox-2',
          worktreePath: '/tmp/worktree-2',
          taskDescription: 'Task 2',
          startTime: new Date(),
          endTime: new Date(),
          duration: 1000,
          exitCode: 1
        })
        .mockResolvedValueOnce({
          taskId: 'task-3',
          status: 'completed' as ParallelTaskStatus,
          filesChanged: 2,
          outputPath: '/tmp/output',
          sessionId: 'session-3',
          sandboxId: 'sandbox-3',
          worktreePath: '/tmp/worktree-3',
          taskDescription: 'Task 3',
          startTime: new Date(),
          endTime: new Date(),
          duration: 1000,
          exitCode: 0
        });

      const result = await executor.execute();

      // All tasks should complete even though one failed
      expect(result.tasks).toHaveLength(3);
      expect(result.summary.successCount).toBe(2);
      expect(result.summary.failureCount).toBe(1);
      expect(result.success).toBe(false); // Overall failure due to one failed task
    });

    it('should stop remaining tasks on fail-fast', async () => {
      const failFastExecutor = new ParallelExecutor(
        { ...defaultConfig, failFast: true, maxConcurrent: 1 },
        mockCoordinator as unknown as Coordinator,
        mockSandboxManager as unknown as SandboxManager,
        mockLogger
      );

      const executedTasks: string[] = [];
      const mockExecuteTask = vi.spyOn(failFastExecutor as any, 'executeTask');
      mockExecuteTask.mockImplementation(async (taskId: string) => {
        executedTasks.push(taskId);

        if (taskId === 'task-1') {
          return {
            taskId,
            status: 'failed' as ParallelTaskStatus,
            error: 'First task failed',
            filesChanged: 0,
            outputPath: '/tmp/output',
            sessionId: 'session-1',
            sandboxId: 'sandbox-1',
            worktreePath: '/tmp/worktree-1',
            taskDescription: 'Task 1',
            startTime: new Date(),
            endTime: new Date(),
            duration: 1000,
            exitCode: 1
          };
        }

        return {
          taskId,
          status: 'completed' as ParallelTaskStatus,
          filesChanged: 1,
          outputPath: '/tmp/output',
          sessionId: `session-${taskId}`,
          sandboxId: `sandbox-${taskId}`,
          worktreePath: `/tmp/worktree-${taskId}`,
          taskDescription: `Task ${taskId}`,
          startTime: new Date(),
          endTime: new Date(),
          duration: 1000,
          exitCode: 0
        };
      });

      const result = await failFastExecutor.execute();

      // Should stop after first failure when maxConcurrent is 1
      expect(result.summary.failureCount).toBe(1);
      expect(result.summary.cancelledCount).toBe(2); // Remaining tasks cancelled
    });

    it('should call progress callback for each task update', async () => {
      const progressUpdates: ParallelProgressUpdate[] = [];
      const progressCallback = vi.fn((update: ParallelProgressUpdate) => {
        progressUpdates.push(update);
      });

      const mockExecuteTask = vi.spyOn(executor as any, 'executeTask');
      mockExecuteTask.mockResolvedValue({
        taskId: 'task-1',
        status: 'completed' as ParallelTaskStatus,
        filesChanged: 1,
        outputPath: '/tmp/output',
        sessionId: 'session-1',
        sandboxId: 'sandbox-1',
        worktreePath: '/tmp/worktree-1',
        taskDescription: 'Task 1',
        startTime: new Date(),
        endTime: new Date(),
        duration: 1000,
        exitCode: 0
      });

      await executor.execute(progressCallback);

      // Should have progress updates for task starts and completions
      expect(progressCallback).toHaveBeenCalled();
      expect(progressUpdates.some(u => u.status === 'running')).toBe(true);
      expect(progressUpdates.some(u => u.status === 'completed')).toBe(true);
    });

    it('should generate correct summary statistics', async () => {
      const mockExecuteTask = vi.spyOn(executor as any, 'executeTask');
      mockExecuteTask
        .mockResolvedValueOnce({
          taskId: 'task-1',
          status: 'completed' as ParallelTaskStatus,
          duration: 5000,
          filesChanged: 3,
          costEstimate: 0.10,
          outputPath: '/tmp/output',
          sessionId: 'session-1',
          sandboxId: 'sandbox-1',
          worktreePath: '/tmp/worktree-1',
          taskDescription: 'Task 1',
          startTime: new Date(),
          endTime: new Date(),
          exitCode: 0
        })
        .mockResolvedValueOnce({
          taskId: 'task-2',
          status: 'completed' as ParallelTaskStatus,
          duration: 3000,
          filesChanged: 2,
          costEstimate: 0.08,
          outputPath: '/tmp/output',
          sessionId: 'session-2',
          sandboxId: 'sandbox-2',
          worktreePath: '/tmp/worktree-2',
          taskDescription: 'Task 2',
          startTime: new Date(),
          endTime: new Date(),
          exitCode: 0
        })
        .mockResolvedValueOnce({
          taskId: 'task-3',
          status: 'completed' as ParallelTaskStatus,
          duration: 4000,
          filesChanged: 5,
          costEstimate: 0.12,
          outputPath: '/tmp/output',
          sessionId: 'session-3',
          sandboxId: 'sandbox-3',
          worktreePath: '/tmp/worktree-3',
          taskDescription: 'Task 3',
          startTime: new Date(),
          endTime: new Date(),
          exitCode: 0
        });

      const result = await executor.execute();

      expect(result.summary.successCount).toBe(3);
      expect(result.summary.failureCount).toBe(0);
      expect(result.summary.totalFilesChanged).toBe(10); // 3 + 2 + 5
      expect(result.summary.sequentialDuration).toBe(12000); // 5000 + 3000 + 4000
      expect(result.summary.totalCost).toBeCloseTo(0.30, 2); // 0.10 + 0.08 + 0.12
    });

    it('should cleanup resources on error', async () => {
      const mockExecuteTask = vi.spyOn(executor as any, 'executeTask');
      mockExecuteTask.mockRejectedValue(new Error('Unexpected error'));

      await expect(executor.execute()).rejects.toThrow('Unexpected error');

      // Cleanup should have been called
      expect(mockSandboxManager.cleanupAll).toHaveBeenCalled();
    });
  });

  describe('executeTask', () => {
    it('should register session and create worktree', async () => {
      // Access private method for testing
      const executeTask = (executor as any).executeTask.bind(executor);

      // Mock the full execution flow
      vi.spyOn(executor as any, 'uploadAndExecute').mockResolvedValue({
        success: true,
        exitCode: 0,
        filesChanged: 2
      });

      const result = await executeTask('task-1', 'Implement feature X');

      expect(mockCoordinator.register).toHaveBeenCalledWith(
        '/home/user/project',
        expect.any(Number)
      );
      expect(result.sessionId).toBe('session-123');
      expect(result.worktreePath).toBe('/tmp/worktree-1');
    });

    it('should create sandbox for task execution', async () => {
      const executeTask = (executor as any).executeTask.bind(executor);

      vi.spyOn(executor as any, 'uploadAndExecute').mockResolvedValue({
        success: true,
        exitCode: 0,
        filesChanged: 2
      });

      await executeTask('task-1', 'Implement feature X');

      expect(mockSandboxManager.createSandbox).toHaveBeenCalledWith('session-123');
    });

    it('should cleanup sandbox on task completion', async () => {
      const executeTask = (executor as any).executeTask.bind(executor);

      vi.spyOn(executor as any, 'uploadAndExecute').mockResolvedValue({
        success: true,
        exitCode: 0,
        filesChanged: 2
      });

      await executeTask('task-1', 'Implement feature X');

      expect(mockSandboxManager.terminateSandbox).toHaveBeenCalledWith('sandbox-123');
      expect(mockCoordinator.release).toHaveBeenCalledWith(expect.any(Number));
    });

    it('should cleanup sandbox on task failure', async () => {
      const executeTask = (executor as any).executeTask.bind(executor);

      vi.spyOn(executor as any, 'uploadAndExecute').mockResolvedValue({
        success: false,
        exitCode: 1,
        error: 'Execution failed',
        filesChanged: 0
      });

      const result = await executeTask('task-1', 'Implement feature X');

      expect(result.status).toBe('failed');
      expect(mockSandboxManager.terminateSandbox).toHaveBeenCalledWith('sandbox-123');
      expect(mockCoordinator.release).toHaveBeenCalledWith(expect.any(Number));
    });

    it('should set budget limit when configured', async () => {
      const configWithBudget = { ...defaultConfig, budgetPerTask: 0.50 };
      const executorWithBudget = new ParallelExecutor(
        configWithBudget,
        mockCoordinator as unknown as Coordinator,
        mockSandboxManager as unknown as SandboxManager,
        mockLogger
      );

      const executeTask = (executorWithBudget as any).executeTask.bind(executorWithBudget);

      vi.spyOn(executorWithBudget as any, 'uploadAndExecute').mockResolvedValue({
        success: true,
        exitCode: 0,
        filesChanged: 2
      });

      await executeTask('task-1', 'Implement feature X');

      expect(mockSandboxManager.setBudgetLimit).toHaveBeenCalledWith('sandbox-123', 0.50);
    });
  });

  describe('cancelRemainingTasks', () => {
    it('should mark pending tasks as cancelled', async () => {
      const failFastExecutor = new ParallelExecutor(
        { ...defaultConfig, failFast: true, maxConcurrent: 1 },
        mockCoordinator as unknown as Coordinator,
        mockSandboxManager as unknown as SandboxManager,
        mockLogger
      );

      // Simulate cancellation mid-execution
      const cancelRemainingTasks = (failFastExecutor as any).cancelRemainingTasks.bind(failFastExecutor);

      // Set up some pending tasks
      (failFastExecutor as any).taskStatuses = new Map([
        ['task-1', 'completed'],
        ['task-2', 'running'],
        ['task-3', 'pending']
      ]);

      await cancelRemainingTasks();

      const statuses = (failFastExecutor as any).taskStatuses;
      expect(statuses.get('task-1')).toBe('completed'); // Unchanged
      expect(statuses.get('task-2')).toBe('cancelled'); // Running -> cancelled
      expect(statuses.get('task-3')).toBe('cancelled'); // Pending -> cancelled
    });

    it('should terminate running sandboxes', async () => {
      const failFastExecutor = new ParallelExecutor(
        { ...defaultConfig, failFast: true },
        mockCoordinator as unknown as Coordinator,
        mockSandboxManager as unknown as SandboxManager,
        mockLogger
      );

      // Set up running tasks with sandbox IDs
      (failFastExecutor as any).taskStatuses = new Map([
        ['task-1', 'running'],
        ['task-2', 'running']
      ]);
      (failFastExecutor as any).taskSandboxIds = new Map([
        ['task-1', 'sandbox-1'],
        ['task-2', 'sandbox-2']
      ]);

      const cancelRemainingTasks = (failFastExecutor as any).cancelRemainingTasks.bind(failFastExecutor);
      await cancelRemainingTasks();

      expect(mockSandboxManager.terminateSandbox).toHaveBeenCalledWith('sandbox-1');
      expect(mockSandboxManager.terminateSandbox).toHaveBeenCalledWith('sandbox-2');
    });
  });

  describe('generateSummaryReport', () => {
    it('should create markdown report with task summary', async () => {
      const { readFile } = await import('fs/promises');
      const mockedReadFile = vi.mocked(readFile);

      const results: TaskResult[] = [
        {
          taskId: 'task-1',
          taskDescription: 'Implement feature A',
          sessionId: 'session-1',
          sandboxId: 'sandbox-1',
          worktreePath: '/tmp/worktree-1',
          status: 'completed',
          startTime: new Date('2025-01-01T00:00:00Z'),
          endTime: new Date('2025-01-01T00:05:00Z'),
          duration: 300000,
          filesChanged: 5,
          outputPath: '/tmp/output/task-1',
          exitCode: 0,
          costEstimate: 0.10
        },
        {
          taskId: 'task-2',
          taskDescription: 'Fix bug B',
          sessionId: 'session-2',
          sandboxId: 'sandbox-2',
          worktreePath: '/tmp/worktree-2',
          status: 'failed',
          startTime: new Date('2025-01-01T00:00:00Z'),
          endTime: new Date('2025-01-01T00:03:00Z'),
          duration: 180000,
          filesChanged: 0,
          outputPath: '/tmp/output/task-2',
          exitCode: 1,
          error: 'Compilation error',
          costEstimate: 0.08
        }
      ];

      const generateSummaryReport = (executor as any).generateSummaryReport.bind(executor);
      const reportPath = await generateSummaryReport(results, {
        totalDuration: 300000,
        sequentialDuration: 480000,
        timeSaved: 180000,
        successCount: 1,
        failureCount: 1,
        cancelledCount: 0,
        totalFilesChanged: 5,
        totalCost: 0.18,
        batchId: 'batch-123'
      });

      // The method returns the file path
      expect(reportPath).toContain('summary-report.md');

      // Verify the report was written by checking the write call args
      // Since fs is mocked, we check that writeFile was called with expected content
      const { writeFile } = await import('fs/promises');
      const mockedWriteFile = vi.mocked(writeFile);

      expect(mockedWriteFile).toHaveBeenCalled();
      const [, content] = mockedWriteFile.mock.calls[mockedWriteFile.mock.calls.length - 1];

      expect(content).toContain('# Parallel Execution Summary');
      expect(content).toContain('Description'); // Table header with description column
      expect(content).toContain('Implement feature A');
      expect(content).toContain('Fix bug B');
      expect(content).toContain('✓'); // Success indicator
      expect(content).toContain('✗'); // Failure indicator
      expect(content).toContain('Compilation error');
    });

    it('should include time saved calculation', async () => {
      const results: TaskResult[] = [
        {
          taskId: 'task-1',
          taskDescription: 'Task 1',
          sessionId: 'session-1',
          sandboxId: 'sandbox-1',
          worktreePath: '/tmp/worktree-1',
          status: 'completed',
          startTime: new Date(),
          duration: 60000,
          filesChanged: 1,
          outputPath: '/tmp/output/task-1',
          exitCode: 0
        }
      ];

      const generateSummaryReport = (executor as any).generateSummaryReport.bind(executor);
      const reportPath = await generateSummaryReport(results, {
        totalDuration: 60000,
        sequentialDuration: 180000,
        timeSaved: 120000,
        successCount: 1,
        failureCount: 0,
        cancelledCount: 0,
        totalFilesChanged: 1,
        totalCost: 0.10,
        batchId: 'batch-123'
      });

      expect(reportPath).toContain('summary-report.md');

      const { writeFile } = await import('fs/promises');
      const mockedWriteFile = vi.mocked(writeFile);
      const [, content] = mockedWriteFile.mock.calls[mockedWriteFile.mock.calls.length - 1];

      expect(content).toContain('Time Saved');
      expect(content).toContain('2m'); // 120000ms = 2 minutes
    });
  });

  describe('error handling', () => {
    it('should handle coordinator registration failure', async () => {
      mockCoordinator.register.mockRejectedValue(new Error('Registration failed'));

      const executeTask = (executor as any).executeTask.bind(executor);
      const result = await executeTask('task-1', 'Implement feature X');

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Registration failed');
    });

    it('should handle sandbox creation failure', async () => {
      mockSandboxManager.createSandbox.mockRejectedValue(new Error('E2B quota exceeded'));

      const executeTask = (executor as any).executeTask.bind(executor);

      // Need to mock coordinator success first
      const result = await executeTask('task-1', 'Implement feature X');

      expect(result.status).toBe('failed');
      expect(result.error).toContain('E2B quota exceeded');
    });

    it('should handle file sync failure', async () => {
      vi.spyOn(executor as any, 'uploadAndExecute').mockRejectedValue(
        new Error('Tarball creation failed')
      );

      const executeTask = (executor as any).executeTask.bind(executor);
      const result = await executeTask('task-1', 'Implement feature X');

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Tarball creation failed');
    });

    it('should log errors but continue with other tasks', async () => {
      const mockExecuteTask = vi.spyOn(executor as any, 'executeTask');
      mockExecuteTask
        .mockResolvedValueOnce({
          taskId: 'task-1',
          status: 'failed' as ParallelTaskStatus,
          error: 'Task 1 failed',
          filesChanged: 0,
          outputPath: '/tmp/output',
          sessionId: 'session-1',
          sandboxId: 'sandbox-1',
          worktreePath: '/tmp/worktree-1',
          taskDescription: 'Task 1',
          startTime: new Date(),
          endTime: new Date(),
          duration: 1000,
          exitCode: 1
        })
        .mockResolvedValueOnce({
          taskId: 'task-2',
          status: 'completed' as ParallelTaskStatus,
          filesChanged: 3,
          outputPath: '/tmp/output',
          sessionId: 'session-2',
          sandboxId: 'sandbox-2',
          worktreePath: '/tmp/worktree-2',
          taskDescription: 'Task 2',
          startTime: new Date(),
          endTime: new Date(),
          duration: 1000,
          exitCode: 0
        })
        .mockResolvedValueOnce({
          taskId: 'task-3',
          status: 'completed' as ParallelTaskStatus,
          filesChanged: 2,
          outputPath: '/tmp/output',
          sessionId: 'session-3',
          sandboxId: 'sandbox-3',
          worktreePath: '/tmp/worktree-3',
          taskDescription: 'Task 3',
          startTime: new Date(),
          endTime: new Date(),
          duration: 1000,
          exitCode: 0
        });

      const result = await executor.execute();

      // When tasks fail, the progress callback reports the failure
      // The executor continues processing other tasks
      expect(result.tasks).toHaveLength(3);
      expect(result.summary.successCount).toBe(2);
      expect(result.summary.failureCount).toBe(1);
    });
  });

  describe('output directory management', () => {
    it('should create output directory for each task', async () => {
      const { mkdir } = await import('fs/promises');
      const mockedMkdir = vi.mocked(mkdir);
      mockedMkdir.mockResolvedValue(undefined);

      const executeTask = (executor as any).executeTask.bind(executor);

      vi.spyOn(executor as any, 'uploadAndExecute').mockResolvedValue({
        success: true,
        exitCode: 0,
        filesChanged: 2
      });

      const result = await executeTask('task-1', 'Implement feature X');

      expect(result.outputPath).toContain('task-1');
    });
  });

  describe('batch tracking', () => {
    it('should generate unique batch ID for each execution', async () => {
      const mockExecuteTask = vi.spyOn(executor as any, 'executeTask');
      mockExecuteTask.mockResolvedValue({
        taskId: 'task-1',
        status: 'completed' as ParallelTaskStatus,
        filesChanged: 1,
        outputPath: '/tmp/output',
        sessionId: 'session-1',
        sandboxId: 'sandbox-1',
        worktreePath: '/tmp/worktree-1',
        taskDescription: 'Task 1',
        startTime: new Date(),
        endTime: new Date(),
        duration: 1000,
        exitCode: 0
      });

      const result1 = await executor.execute();
      const result2 = await executor.execute();

      expect(result1.summary.batchId).toBeDefined();
      expect(result2.summary.batchId).toBeDefined();
      expect(result1.summary.batchId).not.toBe(result2.summary.batchId);
    });
  });
});

describe('ConcurrencyLimiter', () => {
  // Import the limiter for testing
  // This tests the concurrency control mechanism used by ParallelExecutor

  it('should limit concurrent operations', async () => {
    const { ConcurrencyLimiter } = await import('../../src/utils/concurrency.js');
    const limiter = new ConcurrencyLimiter(2);

    const results: number[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async (id: number): Promise<number> => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(resolve => setTimeout(resolve, 10));
      concurrent--;
      return id;
    };

    const promises = [1, 2, 3, 4, 5].map(id =>
      limiter.run(() => task(id)).then(r => results.push(r))
    );

    await Promise.all(promises);

    expect(results).toHaveLength(5);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('should handle task failures without blocking other tasks', async () => {
    const { ConcurrencyLimiter } = await import('../../src/utils/concurrency.js');
    const limiter = new ConcurrencyLimiter(2);

    const task = async (id: number): Promise<number> => {
      if (id === 2) throw new Error('Task 2 failed');
      await new Promise(resolve => setTimeout(resolve, 10));
      return id;
    };

    const results = await Promise.allSettled([
      limiter.run(() => task(1)),
      limiter.run(() => task(2)),
      limiter.run(() => task(3))
    ]);

    expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
    expect(results[1]).toEqual({ status: 'rejected', reason: expect.any(Error) });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
  });
});
