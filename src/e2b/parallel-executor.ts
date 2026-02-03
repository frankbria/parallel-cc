/**
 * Parallel Executor - Orchestrates multiple sandbox executions
 *
 * Features:
 * - Concurrent sandbox execution with configurable limits
 * - Fail-fast mode (stop all on first failure)
 * - Progress monitoring with callbacks
 * - Result aggregation and summary reporting
 * - Resource cleanup on errors
 * - Per-task worktree isolation via Coordinator
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Logger } from '../logger.js';
import type { Coordinator } from '../coordinator.js';
import { SandboxManager } from './sandbox-manager.js';
import {
  createTarball,
  uploadToSandbox,
  downloadChangedFiles
} from './file-sync.js';
import { executeClaudeInSandbox } from './claude-runner.js';
import { ConcurrencyLimiter } from '../utils/concurrency.js';
import type {
  ParallelExecutionConfig,
  ParallelExecutionResult,
  ParallelExecutionSummary,
  TaskResult,
  ParallelTaskStatus,
  ParallelProgressCallback,
  ParallelProgressUpdate
} from '../types.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_OUTPUT_DIR = './parallel-results';

// ============================================================================
// ParallelExecutor Class
// ============================================================================

/**
 * Orchestrates parallel execution of multiple tasks in E2B sandboxes
 *
 * Each task gets:
 * - Its own worktree (via Coordinator)
 * - Its own E2B sandbox instance
 * - Its own output directory
 *
 * @example
 * ```typescript
 * const executor = new ParallelExecutor(config, coordinator, sandboxManager, logger);
 * const result = await executor.execute((update) => {
 *   console.log(`Task ${update.taskId}: ${update.status}`);
 * });
 * ```
 */
export class ParallelExecutor {
  private readonly config: ParallelExecutionConfig;
  private readonly coordinator: Coordinator;
  private readonly sandboxManager: SandboxManager;
  private readonly logger: Logger;
  private readonly limiter: ConcurrencyLimiter;

  // Tracking for cancellation
  private taskStatuses: Map<string, ParallelTaskStatus> = new Map();
  private taskSandboxIds: Map<string, string> = new Map();
  private cancelled = false;

  /**
   * Create a new ParallelExecutor
   *
   * @param config - Configuration for parallel execution
   * @param coordinator - Coordinator instance for session management
   * @param sandboxManager - SandboxManager instance for E2B operations
   * @param logger - Logger instance
   * @throws Error if config is invalid
   */
  constructor(
    config: ParallelExecutionConfig,
    coordinator: Coordinator,
    sandboxManager: SandboxManager,
    logger: Logger
  ) {
    // Validate config
    if (!config.tasks || config.tasks.length === 0) {
      throw new Error('ParallelExecutor requires at least one task');
    }

    const maxConcurrent = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    if (maxConcurrent < 1) {
      throw new Error('maxConcurrent must be at least 1');
    }

    this.config = {
      ...config,
      maxConcurrent,
      outputDir: config.outputDir || DEFAULT_OUTPUT_DIR,
      failFast: config.failFast ?? false,
      gitLive: config.gitLive ?? false,
      targetBranch: config.targetBranch || 'main'
    };

    this.coordinator = coordinator;
    this.sandboxManager = sandboxManager;
    this.logger = logger;
    this.limiter = new ConcurrencyLimiter(maxConcurrent);

    // Initialize task statuses
    for (let i = 0; i < config.tasks.length; i++) {
      this.taskStatuses.set(`task-${i + 1}`, 'pending');
    }
  }

  /**
   * Execute all tasks in parallel
   *
   * @param onProgress - Optional callback for progress updates
   * @returns Execution result with all task results and summary
   */
  async execute(onProgress?: ParallelProgressCallback): Promise<ParallelExecutionResult> {
    const startTime = Date.now();
    const batchId = randomUUID();

    this.logger.info(`Starting parallel execution of ${this.config.tasks.length} tasks (batch: ${batchId})`);
    this.logger.info(`Max concurrent: ${this.config.maxConcurrent}, Fail-fast: ${this.config.failFast}`);

    // Reset state for new execution
    this.cancelled = false;
    this.taskStatuses.clear();
    this.taskSandboxIds.clear();

    // Initialize task statuses
    for (let i = 0; i < this.config.tasks.length; i++) {
      this.taskStatuses.set(`task-${i + 1}`, 'pending');
    }

    // Create output directory
    try {
      await fs.mkdir(this.config.outputDir, { recursive: true });
    } catch (error) {
      this.logger.warn(`Failed to create output directory: ${error}`);
    }

    try {
      // Create task execution promises
      const taskPromises = this.config.tasks.map((taskDescription, index) => {
        const taskId = `task-${index + 1}`;
        return this.limiter.run(async () => {
          // Check if cancelled before starting
          if (this.cancelled) {
            return this.createCancelledResult(taskId, taskDescription);
          }

          // Notify progress: starting
          this.taskStatuses.set(taskId, 'running');
          this.notifyProgress(onProgress, {
            taskId,
            status: 'running',
            message: `Starting: ${taskDescription.substring(0, 50)}...`,
            totalTasks: this.config.tasks.length,
            completedTasks: this.getCompletedCount()
          });

          // Execute the task
          const result = await this.executeTask(taskId, taskDescription);

          // Update status and notify
          this.taskStatuses.set(taskId, result.status);
          this.notifyProgress(onProgress, {
            taskId,
            status: result.status,
            message: result.status === 'completed'
              ? `Completed: ${result.filesChanged} files changed`
              : `Failed: ${result.error || 'Unknown error'}`,
            elapsed: result.duration,
            totalTasks: this.config.tasks.length,
            completedTasks: this.getCompletedCount()
          });

          // Check fail-fast
          if (this.config.failFast && result.status === 'failed') {
            this.logger.error(`Fail-fast triggered by ${taskId}`);
            await this.cancelRemainingTasks();
          }

          return result;
        });
      });

      // Wait for all tasks
      const results = await Promise.all(taskPromises);

      // Calculate summary
      const endTime = Date.now();
      const summary = this.calculateSummary(results, startTime, endTime, batchId);

      // Generate summary report
      const reportPath = await this.generateSummaryReport(results, summary);

      const allSucceeded = results.every(r => r.status === 'completed');

      this.logger.info(`Parallel execution complete: ${summary.successCount}/${results.length} succeeded`);

      return {
        success: allSucceeded,
        tasks: results,
        summary,
        reportPath
      };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Parallel execution failed: ${errorMsg}`);

      // Cleanup all sandboxes
      await this.sandboxManager.cleanupAll();

      throw error;
    }
  }

  /**
   * Execute a single task in its own sandbox
   *
   * @param taskId - Unique task identifier
   * @param taskDescription - Task description/prompt
   * @returns Task result
   */
  private async executeTask(taskId: string, taskDescription: string): Promise<TaskResult> {
    const startTime = new Date();
    const outputPath = path.join(this.config.outputDir, taskId);

    let sessionId = '';
    let sandboxId = '';
    let worktreePath = '';
    let pid = 0;

    try {
      // Step 1: Create output directory for this task
      await fs.mkdir(outputPath, { recursive: true });

      // Step 2: Register session and create worktree
      pid = process.pid + Math.floor(Math.random() * 100000);
      const registerResult = await this.coordinator.register(this.config.repoPath, pid);
      sessionId = registerResult.sessionId;
      worktreePath = registerResult.worktreePath;

      this.logger.info(`[${taskId}] Registered session ${sessionId}, worktree: ${worktreePath}`);

      // Step 3: Create sandbox
      const sandboxResult = await this.sandboxManager.createSandbox(sessionId);
      sandboxId = sandboxResult.sandboxId;
      this.taskSandboxIds.set(taskId, sandboxId);

      this.logger.info(`[${taskId}] Created sandbox ${sandboxId}`);

      // Step 4: Set budget limit if configured
      if (this.config.budgetPerTask) {
        this.sandboxManager.setBudgetLimit(sandboxId, this.config.budgetPerTask);
      }

      // Step 5: Execute task (upload, run, download)
      const executionResult = await this.uploadAndExecute(
        taskId,
        taskDescription,
        worktreePath,
        sandboxResult.sandbox,
        outputPath
      );

      const endTime = new Date();
      const duration = endTime.getTime() - startTime.getTime();
      const costEstimate = this.parseCost(this.sandboxManager.getEstimatedCost(sandboxId));

      return {
        taskId,
        taskDescription,
        sessionId,
        sandboxId,
        worktreePath,
        status: executionResult.success ? 'completed' : 'failed',
        startTime,
        endTime,
        duration,
        filesChanged: executionResult.filesChanged,
        outputPath,
        exitCode: executionResult.exitCode,
        error: executionResult.error,
        costEstimate
      };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${taskId}] Task failed: ${errorMsg}`);

      return {
        taskId,
        taskDescription,
        sessionId: sessionId || 'unknown',
        sandboxId: sandboxId || 'unknown',
        worktreePath: worktreePath || 'unknown',
        status: 'failed',
        startTime,
        endTime: new Date(),
        duration: Date.now() - startTime.getTime(),
        filesChanged: 0,
        outputPath,
        error: errorMsg
      };

    } finally {
      // Cleanup: terminate sandbox and release session
      if (sandboxId) {
        try {
          await this.sandboxManager.terminateSandbox(sandboxId);
          this.logger.debug(`[${taskId}] Sandbox ${sandboxId} terminated`);
        } catch (error) {
          this.logger.warn(`[${taskId}] Failed to terminate sandbox: ${error}`);
        }
      }

      if (pid) {
        try {
          await this.coordinator.release(pid);
          this.logger.debug(`[${taskId}] Session released`);
        } catch (error) {
          this.logger.warn(`[${taskId}] Failed to release session: ${error}`);
        }
      }
    }
  }

  /**
   * Upload worktree to sandbox, execute Claude, and download results
   */
  private async uploadAndExecute(
    taskId: string,
    prompt: string,
    worktreePath: string,
    sandbox: any, // E2B Sandbox type
    outputPath: string
  ): Promise<{ success: boolean; exitCode: number; filesChanged: number; error?: string }> {
    // Step 1: Create tarball
    this.logger.info(`[${taskId}] Creating tarball from ${worktreePath}`);
    const tarballResult = await createTarball(worktreePath);
    this.logger.debug(`[${taskId}] Tarball: ${tarballResult.fileCount} files, ${tarballResult.sizeBytes} bytes`);

    try {
      // Step 2: Upload to sandbox
      this.logger.info(`[${taskId}] Uploading to sandbox`);
      const uploadResult = await uploadToSandbox(tarballResult.path, sandbox);
      if (!uploadResult.success) {
        return {
          success: false,
          exitCode: -1,
          filesChanged: 0,
          error: `Upload failed: ${uploadResult.error}`
        };
      }

      // Step 3: Execute Claude
      this.logger.info(`[${taskId}] Executing Claude with prompt`);
      const executionResult = await executeClaudeInSandbox(
        sandbox,
        this.sandboxManager,
        prompt,
        this.logger,
        {
          authMethod: this.config.authMethod,
          oauthCredentials: this.config.oauthCredentials,
          gitUser: this.config.gitUser,
          gitEmail: this.config.gitEmail,
          localRepoPath: this.config.repoPath
        }
      );

      // Step 4: Download changed files
      this.logger.info(`[${taskId}] Downloading changed files`);
      const downloadPath = path.join(outputPath, 'changed-files');
      await fs.mkdir(downloadPath, { recursive: true });

      const downloadResult = await downloadChangedFiles(sandbox, '/workspace', downloadPath);

      // Track overall success (execution AND download must both succeed)
      const overallSuccess = executionResult.success && downloadResult.success;
      const overallError = downloadResult.success
        ? executionResult.error
        : executionResult.error
          ? `${executionResult.error}; Download failed: ${downloadResult.error}`
          : `Download failed: ${downloadResult.error}`;

      // Step 5: Save execution log
      const logPath = path.join(outputPath, 'execution.log');
      const logContent = executionResult.fullOutput || executionResult.output || '';
      await fs.writeFile(logPath, logContent);

      // Step 6: Save metadata
      const metadataPath = path.join(outputPath, 'metadata.json');
      await fs.writeFile(metadataPath, JSON.stringify({
        taskId,
        prompt,
        exitCode: executionResult.exitCode,
        executionTime: executionResult.executionTime,
        filesDownloaded: downloadResult.filesDownloaded,
        success: overallSuccess,
        state: executionResult.state,
        error: overallError,
        downloadSuccess: downloadResult.success,
        downloadError: downloadResult.error
      }, null, 2));

      return {
        success: overallSuccess,
        exitCode: executionResult.exitCode,
        filesChanged: downloadResult.filesDownloaded,
        error: overallError
      };

    } finally {
      // Cleanup tarball
      try {
        await fs.unlink(tarballResult.path);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Cancel all remaining (pending/running) tasks
   */
  private async cancelRemainingTasks(): Promise<void> {
    this.cancelled = true;
    this.logger.info('Cancelling remaining tasks');

    // Mark pending and running tasks as cancelled
    for (const [taskId, status] of this.taskStatuses) {
      if (status === 'pending' || status === 'running') {
        this.taskStatuses.set(taskId, 'cancelled');

        // Terminate sandbox if running
        const sandboxId = this.taskSandboxIds.get(taskId);
        if (sandboxId) {
          try {
            await this.sandboxManager.terminateSandbox(sandboxId);
            this.logger.debug(`Terminated sandbox ${sandboxId} for cancelled task ${taskId}`);
          } catch (error) {
            this.logger.warn(`Failed to terminate sandbox for ${taskId}: ${error}`);
          }
        }
      }
    }
  }

  /**
   * Create a result for a cancelled task
   */
  private createCancelledResult(taskId: string, taskDescription: string): TaskResult {
    return {
      taskId,
      taskDescription,
      sessionId: '',
      sandboxId: '',
      worktreePath: '',
      status: 'cancelled',
      startTime: new Date(),
      endTime: new Date(),
      duration: 0,
      filesChanged: 0,
      outputPath: path.join(this.config.outputDir, taskId)
    };
  }

  /**
   * Calculate execution summary
   */
  private calculateSummary(
    results: TaskResult[],
    startTime: number,
    endTime: number,
    batchId: string
  ): ParallelExecutionSummary {
    const successCount = results.filter(r => r.status === 'completed').length;
    const failureCount = results.filter(r => r.status === 'failed').length;
    const cancelledCount = results.filter(r => r.status === 'cancelled').length;

    const totalDuration = endTime - startTime;
    const sequentialDuration = results.reduce((sum, r) => sum + (r.duration || 0), 0);
    const timeSaved = Math.max(0, sequentialDuration - totalDuration);

    const totalFilesChanged = results.reduce((sum, r) => sum + r.filesChanged, 0);
    const totalCost = results.reduce((sum, r) => sum + (r.costEstimate || 0), 0);

    return {
      totalDuration,
      sequentialDuration,
      timeSaved,
      successCount,
      failureCount,
      cancelledCount,
      totalFilesChanged,
      totalCost,
      batchId
    };
  }

  /**
   * Generate markdown summary report
   */
  private async generateSummaryReport(
    results: TaskResult[],
    summary: ParallelExecutionSummary
  ): Promise<string> {
    const reportPath = path.join(this.config.outputDir, 'summary-report.md');

    const formatDuration = (ms: number): string => {
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      if (minutes > 0) {
        return `${minutes}m ${remainingSeconds}s`;
      }
      return `${seconds}s`;
    };

    const lines: string[] = [
      '# Parallel Execution Summary',
      '',
      `**Batch ID:** ${summary.batchId}`,
      `**Generated:** ${new Date().toISOString()}`,
      '',
      '## Statistics',
      '',
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Total Tasks | ${results.length} |`,
      `| Successful | ${summary.successCount} |`,
      `| Failed | ${summary.failureCount} |`,
      `| Cancelled | ${summary.cancelledCount} |`,
      `| Total Duration | ${formatDuration(summary.totalDuration)} |`,
      `| Sequential Duration | ${formatDuration(summary.sequentialDuration)} |`,
      `| Time Saved | ${formatDuration(summary.timeSaved)} |`,
      `| Files Changed | ${summary.totalFilesChanged} |`,
      `| Total Cost | $${summary.totalCost.toFixed(2)} |`,
      '',
      '## Task Results',
      '',
      '| Task | Description | Status | Duration | Files | Cost |',
      '|------|-------------|--------|----------|-------|------|'
    ];

    for (const result of results) {
      const statusIcon = result.status === 'completed' ? '✓' : result.status === 'failed' ? '✗' : '○';
      const duration = result.duration ? formatDuration(result.duration) : '-';
      const cost = result.costEstimate ? `$${result.costEstimate.toFixed(2)}` : '-';
      // Truncate long descriptions for table formatting
      const description = result.taskDescription.length > 40
        ? result.taskDescription.substring(0, 37) + '...'
        : result.taskDescription;

      lines.push(
        `| ${statusIcon} ${result.taskId} | ${description} | ${result.status} | ${duration} | ${result.filesChanged} | ${cost} |`
      );
    }

    // Add error details for failed tasks
    const failedTasks = results.filter(r => r.status === 'failed' && r.error);
    if (failedTasks.length > 0) {
      lines.push('', '## Errors', '');
      for (const task of failedTasks) {
        lines.push(`### ${task.taskId}`);
        lines.push('');
        lines.push(`**Description:** ${task.taskDescription}`);
        lines.push('');
        lines.push('```');
        lines.push(task.error || 'Unknown error');
        lines.push('```');
        lines.push('');
      }
    }

    const content = lines.join('\n');
    await fs.writeFile(reportPath, content);

    this.logger.info(`Summary report written to ${reportPath}`);
    return reportPath;
  }

  /**
   * Notify progress callback
   */
  private notifyProgress(
    callback: ParallelProgressCallback | undefined,
    update: ParallelProgressUpdate
  ): void {
    if (callback) {
      try {
        callback(update);
      } catch (error) {
        this.logger.warn(`Progress callback error: ${error}`);
      }
    }
  }

  /**
   * Get count of completed tasks
   */
  private getCompletedCount(): number {
    let count = 0;
    for (const status of this.taskStatuses.values()) {
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        count++;
      }
    }
    return count;
  }

  /**
   * Parse cost string to number
   */
  private parseCost(costString: string | null): number {
    if (!costString) return 0;
    const match = costString.match(/\$?([\d.]+)/);
    return match ? parseFloat(match[1]) : 0;
  }
}
