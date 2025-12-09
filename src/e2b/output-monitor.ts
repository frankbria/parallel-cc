/**
 * E2B Output Monitor - Real-time output streaming from E2B sandboxes
 *
 * Features:
 * - Event-based streaming architecture
 * - In-memory buffering (last 50KB)
 * - Full log persistence to file
 * - Chunked reading for memory efficiency (4KB chunks)
 * - Graceful error handling
 */

import { EventEmitter } from 'events';
import type { Sandbox } from 'e2b';
import * as fs from 'fs/promises';
import type { Logger } from '../logger.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Size of in-memory buffer for recent output (50KB)
 */
const BUFFER_SIZE_BYTES = 50 * 1024;

/**
 * Chunk size for reading logs (4KB)
 */
const CHUNK_SIZE_BYTES = 4 * 1024;

/**
 * Polling interval for log file updates (milliseconds)
 */
const POLL_INTERVAL_MS = 500;

/**
 * Maximum log file size before truncation (100MB)
 */
const MAX_LOG_SIZE_BYTES = 100 * 1024 * 1024;

// ============================================================================
// Types
// ============================================================================

/**
 * Stream monitor events
 */
export interface StreamEvents {
  chunk: (data: string) => void;
  complete: () => void;
  error: (error: Error) => void;
}

/**
 * Stream monitor options
 */
export interface StreamMonitorOptions {
  pollInterval?: number;
  maxBufferSize?: number;
  chunkSize?: number;
  onChunk?: (chunk: string) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
}

/**
 * Output streaming state
 */
interface StreamState {
  isStreaming: boolean;
  bytesSeen: number;
  lastPollTime: Date;
  pollTimer?: NodeJS.Timeout;
}

// ============================================================================
// StreamMonitor Class
// ============================================================================

/**
 * Real-time output monitor for E2B sandbox execution
 *
 * Usage:
 * ```typescript
 * const monitor = new StreamMonitor(sandbox, logger);
 * monitor.onChunk((chunk) => console.log(chunk));
 * monitor.onComplete(() => console.log('Done!'));
 * await monitor.startStreaming('/tmp/claude-output.log');
 * // ... later ...
 * await monitor.stopStreaming();
 * const fullOutput = monitor.getBufferedOutput();
 * ```
 */
export class StreamMonitor extends EventEmitter {
  private sandbox: Sandbox;
  private logger: Logger;
  private options: Required<StreamMonitorOptions>;
  private state: StreamState;
  private buffer: string;
  private logFilePath?: string;
  private localLogPath?: string;

  constructor(sandbox: Sandbox, logger: Logger, options: StreamMonitorOptions = {}) {
    super();
    this.sandbox = sandbox;
    this.logger = logger;
    this.options = {
      pollInterval: options.pollInterval ?? POLL_INTERVAL_MS,
      maxBufferSize: options.maxBufferSize ?? BUFFER_SIZE_BYTES,
      chunkSize: options.chunkSize ?? CHUNK_SIZE_BYTES,
      onChunk: options.onChunk ?? (() => {}),
      onComplete: options.onComplete ?? (() => {}),
      onError: options.onError ?? (() => {})
    };
    this.state = {
      isStreaming: false,
      bytesSeen: 0,
      lastPollTime: new Date()
    };
    this.buffer = '';

    // Register event handlers
    if (this.options.onChunk) {
      this.on('chunk', this.options.onChunk);
    }
    if (this.options.onComplete) {
      this.on('complete', this.options.onComplete);
    }
    if (this.options.onError) {
      this.on('error', this.options.onError);
    }
  }

  /**
   * Start streaming output from a log file in the sandbox
   *
   * @param remoteLogPath - Path to log file in E2B sandbox (e.g., /tmp/claude-output.log)
   * @param localLogPath - Optional local path to persist full log
   */
  async startStreaming(remoteLogPath: string, localLogPath?: string): Promise<void> {
    if (this.state.isStreaming) {
      throw new Error('StreamMonitor is already streaming. Call stopStreaming() first.');
    }

    this.logger.info(`Starting output stream for ${remoteLogPath}`);
    this.logFilePath = remoteLogPath;
    this.localLogPath = localLogPath;
    this.state.isStreaming = true;
    this.state.bytesSeen = 0;
    this.state.lastPollTime = new Date();
    this.buffer = '';

    // Clear local log file if exists
    if (localLogPath) {
      try {
        await fs.writeFile(localLogPath, '');
      } catch (error) {
        this.logger.warn(`Failed to initialize local log file: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Start polling
    this.startPolling();
  }

  /**
   * Stop streaming and cleanup
   */
  async stopStreaming(): Promise<void> {
    if (!this.state.isStreaming) {
      return;
    }

    this.logger.info('Stopping output stream');
    this.state.isStreaming = false;

    // Stop polling timer
    if (this.state.pollTimer) {
      clearInterval(this.state.pollTimer);
      this.state.pollTimer = undefined;
    }

    // Final poll to capture any remaining output
    if (this.logFilePath) {
      try {
        await this.pollLogFile();
      } catch (error) {
        this.logger.warn(`Final poll failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.emit('complete');
  }

  /**
   * Get the buffered output (last 50KB)
   */
  getBufferedOutput(): string {
    return this.buffer;
  }

  /**
   * Get the full output from local log file (if persisted)
   */
  async getFullOutput(): Promise<string | null> {
    if (!this.localLogPath) {
      return null;
    }

    try {
      return await fs.readFile(this.localLogPath, 'utf-8');
    } catch (error) {
      this.logger.error('Failed to read full output log', error);
      return null;
    }
  }

  /**
   * Get streaming statistics
   */
  getStats(): {
    bytesSeen: number;
    bufferSize: number;
    isStreaming: boolean;
    lastPollTime: Date;
  } {
    return {
      bytesSeen: this.state.bytesSeen,
      bufferSize: this.buffer.length,
      isStreaming: this.state.isStreaming,
      lastPollTime: this.state.lastPollTime
    };
  }

  /**
   * Convenience method to register chunk handler
   */
  onChunk(handler: (chunk: string) => void): this {
    this.on('chunk', handler);
    return this;
  }

  /**
   * Convenience method to register completion handler
   */
  onComplete(handler: () => void): this {
    this.on('complete', handler);
    return this;
  }

  /**
   * Convenience method to register error handler
   */
  onError(handler: (error: Error) => void): this {
    this.on('error', handler);
    return this;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Start polling timer
   */
  private startPolling(): void {
    this.state.pollTimer = setInterval(() => {
      this.pollLogFile().catch(error => {
        this.logger.error('Poll error', error);
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
      });
    }, this.options.pollInterval);
  }

  /**
   * Poll the log file for new output
   */
  private async pollLogFile(): Promise<void> {
    if (!this.logFilePath) {
      return;
    }

    try {
      // Check if log file exists
      const checkCmd = await this.sandbox.commands.run(
        `test -f "${this.logFilePath}" && echo "exists" || echo "missing"`,
        { timeoutMs: 10000 } // 10 second timeout for file checks
      );
      if (checkCmd.stdout.trim() === 'missing') {
        // Log file doesn't exist yet (Claude hasn't started writing)
        return;
      }

      // Get current file size
      const sizeCmd = await this.sandbox.commands.run(
        `stat -c %s "${this.logFilePath}"`,
        { timeoutMs: 10000 } // 10 second timeout
      );
      const fileSize = parseInt(sizeCmd.stdout.trim(), 10);

      // Check for log file size explosion (prevent OOM)
      if (fileSize > MAX_LOG_SIZE_BYTES) {
        this.logger.warn(`Log file exceeded ${MAX_LOG_SIZE_BYTES} bytes. Truncating.`);
        await this.sandbox.commands.run(
          `tail -c ${MAX_LOG_SIZE_BYTES} "${this.logFilePath}" > "${this.logFilePath}.tmp" && mv "${this.logFilePath}.tmp" "${this.logFilePath}"`,
          { timeoutMs: 30000 } // 30 seconds for large file operations
        );
        return;
      }

      // Read new bytes since last poll
      if (fileSize > this.state.bytesSeen) {
        const bytesToRead = fileSize - this.state.bytesSeen;
        const readCmd = await this.sandbox.commands.run(
          `tail -c +${this.state.bytesSeen + 1} "${this.logFilePath}"`,
          { timeoutMs: 30000 } // 30 seconds for reading logs
        );

        const newContent = readCmd.stdout;
        if (newContent.length > 0) {
          // Update state
          this.state.bytesSeen = fileSize;
          this.state.lastPollTime = new Date();

          // Append to buffer (with size limit)
          this.appendToBuffer(newContent);

          // Persist to local log file
          if (this.localLogPath) {
            try {
              await fs.appendFile(this.localLogPath, newContent);
            } catch (error) {
              this.logger.warn(`Failed to persist log to ${this.localLogPath}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }

          // Emit chunk event
          this.emit('chunk', newContent);
        }
      }
    } catch (error) {
      // Don't throw - just log and emit error event
      this.logger.error('Failed to poll log file', error);
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Append content to buffer with size limit (keep last N bytes)
   */
  private appendToBuffer(content: string): void {
    this.buffer += content;

    // Trim buffer if it exceeds max size
    if (this.buffer.length > this.options.maxBufferSize) {
      const excessBytes = this.buffer.length - this.options.maxBufferSize;
      this.buffer = this.buffer.slice(excessBytes);
      this.logger.debug(`Buffer trimmed by ${excessBytes} bytes`);
    }
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a temporary log file in the sandbox
 *
 * @param sandbox - E2B sandbox instance
 * @returns Path to temporary log file
 */
export async function createTempLogFile(sandbox: Sandbox): Promise<string> {
  const timestamp = Date.now();
  const logPath = `/tmp/claude-output-${timestamp}.log`;

  // Create empty log file
  await sandbox.commands.run(`touch "${logPath}"`, { timeoutMs: 5000 }); // 5 second timeout for file creation

  return logPath;
}

/**
 * Stream output from a command execution
 *
 * @param sandbox - E2B sandbox instance
 * @param command - Command to execute
 * @param logger - Logger instance
 * @param options - Stream options
 * @returns StreamMonitor instance
 */
export async function streamCommand(
  sandbox: Sandbox,
  command: string,
  logger: Logger,
  options: StreamMonitorOptions = {}
): Promise<{ monitor: StreamMonitor; logFile: string }> {
  // Create temporary log file
  const logFile = await createTempLogFile(sandbox);

  // Create monitor
  const monitor = new StreamMonitor(sandbox, logger, options);

  // Start streaming before executing command
  await monitor.startStreaming(logFile);

  // Execute command with output redirection
  const redirectedCommand = `${command} > "${logFile}" 2>&1 &`;
  await sandbox.commands.run(redirectedCommand);

  return { monitor, logFile };
}

/**
 * Wait for a log file to stop growing (indicates completion)
 *
 * @param sandbox - E2B sandbox instance
 * @param logPath - Path to log file
 * @param stableSeconds - Seconds file must remain unchanged (default: 3)
 * @param timeoutSeconds - Max wait time (default: 300 = 5 minutes)
 * @returns true if file stabilized, false if timeout
 */
export async function waitForLogStable(
  sandbox: Sandbox,
  logPath: string,
  stableSeconds: number = 3,
  timeoutSeconds: number = 300
): Promise<boolean> {
  const startTime = Date.now();
  let lastSize = -1;
  let stableStart: number | null = null;

  while (true) {
    // Check timeout
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    if (elapsedSeconds > timeoutSeconds) {
      return false;
    }

    // Get current file size
    try {
      const sizeCmd = await sandbox.commands.run(
        `stat -c %s "${logPath}" 2>/dev/null || echo "0"`,
        { timeoutMs: 5000 } // 5 seconds
      );
      const currentSize = parseInt(sizeCmd.stdout.trim(), 10);

      if (currentSize === lastSize) {
        // File size unchanged
        if (stableStart === null) {
          stableStart = Date.now();
        } else {
          const stableTime = (Date.now() - stableStart) / 1000;
          if (stableTime >= stableSeconds) {
            return true; // File is stable
          }
        }
      } else {
        // File size changed
        lastSize = currentSize;
        stableStart = null;
      }
    } catch (error) {
      // File might not exist yet
      lastSize = 0;
      stableStart = null;
    }

    // Wait before next check
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
