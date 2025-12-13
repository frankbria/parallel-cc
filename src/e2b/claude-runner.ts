/**
 * E2B Claude Runner - Autonomous Claude Code execution in E2B sandboxes
 *
 * Features:
 * - Full autonomous execution workflow
 * - Claude update enforcement (latest version)
 * - Real-time output streaming
 * - Timeout enforcement with SandboxManager integration
 * - Comprehensive error handling
 * - Execution state tracking in SessionDB
 */

import type { Sandbox } from 'e2b';
import type { Logger } from '../logger.js';
import { SandboxManager, sanitizePrompt } from './sandbox-manager.js';
import { StreamMonitor, createTempLogFile, waitForLogStable } from './output-monitor.js';
import { SandboxStatus } from '../types.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Default execution timeout (60 minutes)
 */
const DEFAULT_TIMEOUT_MINUTES = 60;

/**
 * Default working directory in sandbox
 */
const DEFAULT_WORKING_DIR = '/workspace';

/**
 * Claude update timeout (2 minutes)
 */
const CLAUDE_UPDATE_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Claude execution command template
 * Uses --dangerously-skip-permissions because we're in a sandboxed environment
 */
const CLAUDE_COMMAND_TEMPLATE = 'cd {workingDir} && echo "{prompt}" | claude -p --dangerously-skip-permissions';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for Claude execution
 */
export interface ClaudeExecutionOptions {
  /**
   * Working directory in sandbox (default: /workspace)
   */
  workingDir?: string;

  /**
   * Execution timeout in minutes (default: 60)
   */
  timeout?: number;

  /**
   * Stream output in real-time (default: true)
   */
  streamOutput?: boolean;

  /**
   * Capture full log to file (default: true)
   */
  captureFullLog?: boolean;

  /**
   * Local path to save full execution log
   */
  localLogPath?: string;

  /**
   * Callback for real-time output chunks
   */
  onProgress?: (chunk: string) => void;
}

/**
 * Execution state
 */
export type ExecutionState = 'completed' | 'failed' | 'timeout' | 'killed';

/**
 * Result of Claude execution
 */
export interface ClaudeExecutionResult {
  /**
   * Whether execution succeeded
   */
  success: boolean;

  /**
   * Exit code from Claude process (0 = success)
   */
  exitCode: number;

  /**
   * Output from Claude execution (buffered, last 50KB)
   */
  output: string;

  /**
   * Full output log (if captureFullLog enabled)
   */
  fullOutput?: string;

  /**
   * Execution time in milliseconds
   */
  executionTime: number;

  /**
   * Final execution state
   */
  state: ExecutionState;

  /**
   * Error message (if failed)
   */
  error?: string;

  /**
   * Path to log file in sandbox
   */
  remoteLogPath?: string;

  /**
   * Path to local log file (if saved)
   */
  localLogPath?: string;
}

/**
 * Claude update result
 */
interface ClaudeUpdateResult {
  success: boolean;
  version: string;
  output: string;
  error?: string;
}

// ============================================================================
// Main Execution Function
// ============================================================================

/**
 * Execute Claude Code autonomously in an E2B sandbox
 *
 * This is the main orchestrator function that:
 * 1. Verifies sandbox health
 * 2. Ensures latest Claude Code version
 * 3. Executes Claude with the provided prompt
 * 4. Monitors execution with real-time output streaming
 * 5. Enforces timeout limits
 * 6. Returns comprehensive execution results
 *
 * @param sandbox - E2B Sandbox instance
 * @param sandboxManager - SandboxManager for health checks and timeout enforcement
 * @param prompt - User prompt to execute with Claude
 * @param logger - Logger instance
 * @param options - Execution options
 * @returns Execution result with output and state
 */
export async function executeClaudeInSandbox(
  sandbox: Sandbox,
  sandboxManager: SandboxManager,
  prompt: string,
  logger: Logger,
  options: ClaudeExecutionOptions = {}
): Promise<ClaudeExecutionResult> {
  const startTime = Date.now();

  // Merge with defaults
  const opts: Required<ClaudeExecutionOptions> = {
    workingDir: options.workingDir ?? DEFAULT_WORKING_DIR,
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MINUTES,
    streamOutput: options.streamOutput ?? true,
    captureFullLog: options.captureFullLog ?? true,
    localLogPath: options.localLogPath ?? '',
    onProgress: options.onProgress ?? (() => {})
  };

  logger.info(`Starting Claude execution in sandbox ${sandbox.sandboxId}`);
  logger.debug(`Working directory: ${opts.workingDir}, Timeout: ${opts.timeout} minutes`);

  try {
    // Step 1: Verify sandbox health
    logger.info('Step 1/4: Verifying sandbox health...');
    const healthCheck = await sandboxManager.monitorSandboxHealth(sandbox.sandboxId);
    if (!healthCheck.isHealthy) {
      return {
        success: false,
        exitCode: -1,
        output: '',
        executionTime: Date.now() - startTime,
        state: 'failed',
        error: `Sandbox health check failed: ${healthCheck.error || 'Unknown error'}`
      };
    }
    logger.info('Sandbox is healthy');

    // Step 1.5: Ensure Claude Code is installed
    logger.info('Step 1.5/4: Ensuring Claude Code CLI is available...');
    const claudeInstalled = await ensureClaudeCode(sandbox, logger);
    if (!claudeInstalled) {
      return {
        success: false,
        exitCode: -1,
        output: '',
        executionTime: Date.now() - startTime,
        state: 'failed',
        error: 'Claude Code CLI not available and installation failed. Use anthropic-claude-code template or check E2B configuration.'
      };
    }

    // Step 2: Run Claude update
    logger.info('Step 2/4: Ensuring latest Claude Code version...');
    const updateResult = await runClaudeUpdate(sandbox, logger);
    if (!updateResult.success) {
      logger.warn(`Claude update failed, continuing anyway: ${updateResult.error}`);
      // Non-fatal: continue execution even if update fails
    } else {
      logger.info(`Claude version: ${updateResult.version}`);
    }

    // Step 3: Execute Claude with prompt
    logger.info('Step 3/4: Executing Claude Code...');
    const executionResult = await runClaudeWithPrompt(
      sandbox,
      prompt,
      logger,
      opts
    );

    // Step 4: Monitor and return results
    logger.info('Step 4/4: Execution complete');
    return executionResult;

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('Claude execution failed with unexpected error', error);

    return {
      success: false,
      exitCode: -1,
      output: '',
      executionTime: Date.now() - startTime,
      state: 'failed',
      error: errorMsg
    };
  }
}

// ============================================================================
// Core Execution Functions
// ============================================================================

/**
 * Ensure Claude Code CLI is installed in the sandbox
 *
 * Checks if Claude Code is available, and if not, installs it via npm.
 * This fallback supports custom/base E2B images that don't have Claude pre-installed.
 *
 * @param sandbox - E2B Sandbox instance
 * @param logger - Logger instance
 * @returns True if Claude Code is available or was successfully installed
 */
async function ensureClaudeCode(sandbox: Sandbox, logger: Logger): Promise<boolean> {
  // Check if claude CLI is available
  try {
    const check = await sandbox.commands.run('which claude', { timeoutMs: 10000 });
    if (check.exitCode === 0) {
      logger.info('Claude Code CLI detected (pre-installed)');
      return true;
    }
  } catch (error) {
    logger.warn(`Failed to check for Claude CLI: ${error instanceof Error ? error.message : String(error)}`);
    // Fall through to install attempt; if install isn't possible, we'll return false.
  }

  logger.info('Claude Code not found - installing from npm...');
  logger.info('This may take 2-3 minutes for base/custom images');

  try {
    // Install Node.js and Claude Code CLI
    // Includes apt-get availability check for non-Debian images
    const install = await sandbox.commands.run(
      [
        // Fail fast if apt-get isn't available (non-Debian images)
        'command -v apt-get >/dev/null 2>&1 || (echo "apt-get not available (non-Debian image)" >&2; exit 127)',
        'DEBIAN_FRONTEND=noninteractive apt-get update -qq',
        'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl nodejs npm',
        'npm install -g @anthropic-ai/claude-code',
        // Re-verify presence on PATH
        'which claude'
      ].join(' && '),
      { timeoutMs: 180000 } // 3 minutes for installation
    );

    if (install.exitCode === 0) {
      logger.info('Claude Code CLI installed successfully');
      return true;
    } else {
      logger.error(`Claude Code installation failed: exit code ${install.exitCode}`);
      logger.error(`stderr: ${install.stderr}`);
      return false;
    }
  } catch (error) {
    logger.error('Claude Code installation threw exception', error);
    return false;
  }
}

/**
 * Ensure latest Claude Code version is installed
 *
 * Runs `claude update` in the sandbox to ensure the latest version.
 * This is critical for autonomous execution to avoid bugs in older versions.
 *
 * @param sandbox - E2B Sandbox instance
 * @param logger - Logger instance
 * @returns Update result with version info
 */
export async function runClaudeUpdate(
  sandbox: Sandbox,
  logger: Logger
): Promise<ClaudeUpdateResult> {
  logger.info('Running claude update...');

  try {
    // Run `claude update` with timeout
    const result = await sandbox.commands.run('claude update', {
      timeoutMs: CLAUDE_UPDATE_TIMEOUT_MS
    });

    // Parse version from output
    // Expected output: "Claude Code updated to version X.Y.Z"
    const versionMatch = result.stdout.match(/version\s+([\d.]+)/i);
    const version = versionMatch ? versionMatch[1] : 'unknown';

    // Check if update succeeded (exit code 0)
    const success = result.exitCode === 0;

    if (success) {
      logger.info(`Claude update succeeded: version ${version}`);
    } else {
      logger.warn(`Claude update failed: exit code ${result.exitCode}`);
    }

    return {
      success,
      version,
      output: result.stdout + result.stderr,
      error: success ? undefined : `Update failed with exit code ${result.exitCode}`
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('Claude update threw exception', error);

    // Check for "command not found" errors (exit 127)
    if (errorMsg.includes('127') || errorMsg.toLowerCase().includes('not found')) {
      logger.error('Claude CLI missing. Use anthropic-claude-code template or check installation.');
    }

    return {
      success: false,
      version: 'unknown',
      output: '',
      error: errorMsg
    };
  }
}

/**
 * Execute Claude Code with a prompt
 *
 * Runs: `echo "$PROMPT" | claude -p --dangerously-skip-permissions`
 * - `-p` enables plan mode (autonomous execution)
 * - `--dangerously-skip-permissions` skips permission prompts (safe in sandbox)
 *
 * @param sandbox - E2B Sandbox instance
 * @param prompt - User prompt for Claude
 * @param logger - Logger instance
 * @param options - Execution options
 * @returns Execution result with output and state
 */
export async function runClaudeWithPrompt(
  sandbox: Sandbox,
  prompt: string,
  logger: Logger,
  options: Required<ClaudeExecutionOptions>
): Promise<ClaudeExecutionResult> {
  const startTime = Date.now();

  try {
    // Sanitize prompt to prevent shell injection
    const sanitizedPrompt = sanitizePrompt(prompt);
    logger.debug(`Prompt sanitized (${sanitizedPrompt.length} chars)`);

    // Create log file for output capture
    const remoteLogPath = await createTempLogFile(sandbox);
    logger.debug(`Created output log: ${remoteLogPath}`);

    // Build Claude command
    const command = CLAUDE_COMMAND_TEMPLATE
      .replace('{workingDir}', options.workingDir)
      .replace('{prompt}', sanitizedPrompt);

    // Start output monitoring (if enabled)
    let monitor: StreamMonitor | null = null;
    if (options.streamOutput) {
      monitor = new StreamMonitor(sandbox, logger, {
        onChunk: options.onProgress
      });
      await monitor.startStreaming(remoteLogPath, options.localLogPath || undefined);
      logger.debug('Output streaming started');
    }

    // Execute Claude command with output redirection
    const fullCommand = `${command} > "${remoteLogPath}" 2>&1`;
    logger.debug(`Executing: ${fullCommand.substring(0, 100)}...`);

    const executionPromise = sandbox.commands.run(fullCommand, {
      timeoutMs: options.timeout * 60 * 1000 // Convert minutes to milliseconds
    });

    // Wait for execution to complete
    const result = await executionPromise;

    // Stop monitoring
    if (monitor) {
      await monitor.stopStreaming();
      logger.debug('Output streaming stopped');
    }

    // Get output (buffered or full log)
    let output = '';
    let fullOutput: string | undefined;

    if (monitor) {
      output = monitor.getBufferedOutput();
      if (options.captureFullLog) {
        fullOutput = (await monitor.getFullOutput()) ?? undefined;
      }
    } else {
      // If streaming disabled, read entire log file
      try {
        const readResult = await sandbox.commands.run(`cat "${remoteLogPath}"`);
        output = readResult.stdout;
        fullOutput = output;
      } catch (error) {
        logger.warn(`Failed to read log file: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const executionTime = Date.now() - startTime;

    // Determine execution state
    let state: ExecutionState;
    if (result.exitCode === 0) {
      state = 'completed';
    } else if (result.exitCode === 124) {
      // Exit code 124 typically indicates timeout
      state = 'timeout';
    } else {
      state = 'failed';
    }

    logger.info(`Claude execution ${state} (exit code: ${result.exitCode}, time: ${executionTime}ms)`);

    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      output,
      fullOutput,
      executionTime,
      state,
      remoteLogPath,
      localLogPath: options.localLogPath || undefined
    };

  } catch (error) {
    const executionTime = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('Claude execution threw exception', error);

    // Check if error is timeout-related
    const isTimeout = errorMsg.toLowerCase().includes('timeout') ||
                     errorMsg.toLowerCase().includes('timed out');

    // Check for "command not found" errors (exit 127)
    if (errorMsg.includes('127') || errorMsg.toLowerCase().includes('not found')) {
      logger.error('Claude CLI missing. Use anthropic-claude-code template or check installation.');
    }

    return {
      success: false,
      exitCode: -1,
      output: '',
      executionTime,
      state: isTimeout ? 'timeout' : 'failed',
      error: errorMsg
    };
  }
}

/**
 * Monitor Claude execution with timeout enforcement
 *
 * Integrates with SandboxManager to enforce timeout limits and handle warnings.
 * This function is called periodically during long-running executions.
 *
 * @param sandboxManager - SandboxManager instance
 * @param sandboxId - Sandbox ID to monitor
 * @param logger - Logger instance
 * @returns null if execution should continue, warning if timeout reached
 */
export async function monitorExecution(
  sandboxManager: SandboxManager,
  sandboxId: string,
  logger: Logger
): Promise<{ shouldTerminate: boolean; reason?: string }> {
  try {
    // Check for timeout warnings
    const timeoutWarning = await sandboxManager.enforceTimeout(sandboxId);

    if (timeoutWarning) {
      if (timeoutWarning.warningLevel === 'hard') {
        // Hard timeout reached - terminate immediately
        logger.error(`Hard timeout reached for sandbox ${sandboxId}`);
        return {
          shouldTerminate: true,
          reason: timeoutWarning.message
        };
      } else {
        // Soft warning - log but continue
        logger.warn(`Timeout warning: ${timeoutWarning.message}`);
      }
    }

    // Check sandbox health
    const healthCheck = await sandboxManager.monitorSandboxHealth(sandboxId);
    if (!healthCheck.isHealthy) {
      logger.error(`Sandbox ${sandboxId} is unhealthy: ${healthCheck.error || 'Unknown error'}`);
      return {
        shouldTerminate: true,
        reason: `Sandbox became unhealthy: ${healthCheck.error || 'Unknown error'}`
      };
    }

    // All good - continue execution
    return { shouldTerminate: false };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('Execution monitoring failed', error);

    // Don't terminate on monitoring errors - let execution continue
    return { shouldTerminate: false };
  }
}

/**
 * Capture output from a running Claude execution
 *
 * This is a helper function to capture output from an already-running
 * Claude process. Useful for long-running executions.
 *
 * @param sandbox - E2B Sandbox instance
 * @param remoteLogPath - Path to log file in sandbox
 * @param logger - Logger instance
 * @param localLogPath - Optional local path to save log
 * @returns Captured output
 */
export async function captureOutput(
  sandbox: Sandbox,
  remoteLogPath: string,
  logger: Logger,
  localLogPath?: string
): Promise<string> {
  try {
    // Create monitor
    const monitor = new StreamMonitor(sandbox, logger);

    // Start streaming
    await monitor.startStreaming(remoteLogPath, localLogPath);

    // Wait for log to stabilize (indicates completion)
    const stable = await waitForLogStable(sandbox, remoteLogPath, 3, 300);

    // Stop streaming
    await monitor.stopStreaming();

    if (!stable) {
      logger.warn('Log file did not stabilize within timeout');
    }

    // Return buffered output
    return monitor.getBufferedOutput();

  } catch (error) {
    logger.error('Failed to capture output', error);
    return '';
  }
}

// ============================================================================
// Execution State Helpers
// ============================================================================

/**
 * Convert ExecutionState to SandboxStatus for database storage
 *
 * @param state - Execution state
 * @returns Corresponding SandboxStatus
 */
export function executionStateToSandboxStatus(state: ExecutionState): SandboxStatus {
  switch (state) {
    case 'completed':
      return SandboxStatus.COMPLETED;
    case 'failed':
      return SandboxStatus.FAILED;
    case 'timeout':
      return SandboxStatus.TIMEOUT;
    case 'killed':
      return SandboxStatus.FAILED;
    default:
      return SandboxStatus.FAILED;
  }
}

/**
 * Format execution time as human-readable string
 *
 * @param milliseconds - Execution time in milliseconds
 * @returns Formatted string (e.g., "5m 30s")
 */
export function formatExecutionTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Check if execution result indicates success
 *
 * @param result - Execution result
 * @returns true if execution succeeded
 */
export function isExecutionSuccessful(result: ClaudeExecutionResult): boolean {
  return result.success && result.state === 'completed' && result.exitCode === 0;
}
