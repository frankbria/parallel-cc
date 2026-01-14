/**
 * E2B Sandbox Manager - Handles lifecycle management of E2B sandboxes
 *
 * Security Features:
 * - Input sanitization (prompts, file paths)
 * - Timeout enforcement (30min/50min warnings, 1-hour hard limit)
 * - Graceful error handling with E2B API failures
 */

import { Sandbox } from 'e2b';
import type { Logger } from '../logger.js';
import {
  SandboxStatus,
  type E2BSessionConfig,
  type SandboxHealthCheck,
  type SandboxTerminationResult,
  type TimeoutWarning,
  type SandboxTemplate
} from '../types.js';

/**
 * Result of template application
 */
export interface TemplateApplicationResult {
  success: boolean;
  message: string;
  commandsExecuted?: number;
  environmentVarsSet?: number;
  error?: string;
}

// Default configuration
const envTemplate = process.env.E2B_TEMPLATE?.trim();
const DEFAULT_CONFIG: Required<E2BSessionConfig> = {
  claudeVersion: 'latest',
  e2bSdkVersion: '1.13.2',
  sandboxImage: (envTemplate && envTemplate.length > 0) ? envTemplate : 'anthropic-claude-code', // E2B template with pre-installed Claude Code
  timeoutMinutes: 60,
  warningThresholds: [30, 50]
};

// Security constants
const MAX_PROMPT_LENGTH = 100000; // 100KB
const SHELL_METACHARACTERS = /([;&|`$(){}[\]<>*?~!\\"])/g;
const PATH_TRAVERSAL_PATTERN = /\.\./;
const ABSOLUTE_PATH_PATTERN = /^\/[^/]/;

/**
 * Sanitize user-provided prompts to prevent shell injection
 */
export function sanitizePrompt(prompt: string): string {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('Invalid prompt: must be a non-empty string');
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
  }

  // Remove control characters (except newlines and tabs)
  let cleaned = prompt.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

  // Replace newlines with literal \n for shell safety
  // This prevents multiline prompts from breaking shell commands like: echo "prompt"
  cleaned = cleaned.replace(/\n/g, '\\n');

  // Escape shell metacharacters for safe execution
  return cleaned.replace(SHELL_METACHARACTERS, '\\$1');
}

/**
 * Validate file paths to prevent directory traversal attacks
 */
export function validateFilePath(path: string): boolean {
  if (!path || typeof path !== 'string') {
    throw new Error('Invalid file path: must be a non-empty string');
  }

  // Prevent directory traversal
  if (PATH_TRAVERSAL_PATTERN.test(path)) {
    throw new Error('Invalid file path: directory traversal detected (..)');
  }

  // Prevent absolute paths (files should be relative to repo root)
  if (ABSOLUTE_PATH_PATTERN.test(path)) {
    throw new Error('Invalid file path: absolute paths not allowed');
  }

  // Additional validation: no null bytes
  if (path.includes('\0')) {
    throw new Error('Invalid file path: null byte detected');
  }

  return true;
}

/**
 * E2B Sandbox Manager
 *
 * Responsibilities:
 * - Create and initialize E2B sandboxes
 * - Monitor sandbox health (heartbeat checks)
 * - Enforce timeout limits with warnings
 * - Graceful termination and cleanup
 */
export class SandboxManager {
  private config: Required<E2BSessionConfig>;
  private logger: Logger;
  private activeSandboxes: Map<string, Sandbox> = new Map();
  private sandboxStartTimes: Map<string, Date> = new Map();
  private timeoutWarningsIssued: Map<string, Set<number>> = new Map();

  constructor(logger: Logger, config: Partial<E2BSessionConfig> = {}) {
    this.logger = logger;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Validate E2B API key is present
   *
   * @param apiKey - Optional API key to validate
   * @throws Error if API key is not found
   */
  static validateApiKey(apiKey?: string): void {
    const e2bApiKey = apiKey || process.env.E2B_API_KEY;
    if (!e2bApiKey) {
      throw new Error(
        'E2B API key not found. Set E2B_API_KEY environment variable or pass apiKey parameter.'
      );
    }
  }

  /**
   * Create a new E2B sandbox
   *
   * @param sessionId - Unique session identifier
   * @param apiKey - E2B API key (from environment)
   * @returns Sandbox instance and ID
   */
  async createSandbox(
    sessionId: string,
    apiKey?: string
  ): Promise<{ sandbox: Sandbox; sandboxId: string; status: SandboxStatus }> {
    try {
      this.logger.info(`Creating E2B sandbox for session ${sessionId}`);

      // Validate API key (required for E2B)
      SandboxManager.validateApiKey(apiKey);
      const e2bApiKey = apiKey || process.env.E2B_API_KEY;

      // Create sandbox using E2B SDK
      // E2B SDK signature: Sandbox.create(template, opts)
      const sandbox = await Sandbox.create(this.config.sandboxImage, {
        apiKey: e2bApiKey,
        timeoutMs: this.config.timeoutMinutes * 60 * 1000, // Convert minutes to milliseconds
        metadata: {
          sessionId,
          createdAt: new Date().toISOString(),
          claudeVersion: this.config.claudeVersion || 'latest',
          timeoutMinutes: String(this.config.timeoutMinutes) // Metadata values must be strings
        }
      });

      const sandboxId = sandbox.sandboxId;

      // Track active sandbox
      this.activeSandboxes.set(sandboxId, sandbox);
      this.sandboxStartTimes.set(sandboxId, new Date());
      this.timeoutWarningsIssued.set(sandboxId, new Set());

      this.logger.info(`E2B sandbox created: ${sandboxId} for session ${sessionId}`);

      return {
        sandbox,
        sandboxId,
        status: SandboxStatus.INITIALIZING
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to create E2B sandbox for session ${sessionId}: ${errorMsg}`);

      // Graceful degradation: provide actionable error message
      if (errorMsg.includes('API key')) {
        throw new Error(
          'E2B authentication failed. Check your E2B_API_KEY environment variable.'
        );
      } else if (errorMsg.includes('quota') || errorMsg.includes('limit')) {
        throw new Error(
          'E2B quota exceeded. Check your usage at https://e2b.dev/dashboard'
        );
      } else if (errorMsg.includes('network') || errorMsg.includes('timeout')) {
        throw new Error(
          'Network error connecting to E2B. Check your internet connection and try again.'
        );
      }

      // Generic error
      throw new Error(`E2B sandbox creation failed: ${errorMsg}`);
    }
  }

  /**
   * Monitor sandbox health with heartbeat checks
   *
   * @param sandboxId - Sandbox ID to check
   * @param attemptReconnect - Whether to attempt reconnection if not in active sandboxes (default: true)
   * @returns Health check result
   */
  async monitorSandboxHealth(sandboxId: string, attemptReconnect: boolean = true): Promise<SandboxHealthCheck> {
    try {
      // Try to get existing sandbox or reconnect
      let sandbox = this.activeSandboxes.get(sandboxId);

      if (!sandbox && attemptReconnect) {
        this.logger.info(`Sandbox ${sandboxId} not in active sandboxes, attempting reconnection...`);
        const reconnected = await this.getOrReconnectSandbox(sandboxId);
        sandbox = reconnected ?? undefined;
      }

      if (!sandbox) {
        return {
          isHealthy: false,
          sandboxId,
          status: SandboxStatus.FAILED,
          lastHeartbeat: new Date(),
          error: `Sandbox ${sandboxId} not found and reconnection failed`
        };
      }

      // Check if sandbox is still running using E2B SDK's isRunning() method
      // This makes an actual API call to verify sandbox connectivity
      // E2B SDK's isRunning() doesn't support timeout, so we wrap it with Promise.race()
      let isRunning = false;
      try {
        isRunning = await Promise.race([
          sandbox.isRunning(),
          new Promise<boolean>((_, reject) =>
            setTimeout(() => reject(new Error('Health check timeout after 30 seconds')), 30000)
          )
        ]);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to check sandbox ${sandboxId} status: ${errorMsg}`);
        // Assume not running if health check fails or timeout
        isRunning = false;
      }

      // Note: startTime may not exist for reconnected sandboxes
      const startTime = this.sandboxStartTimes.get(sandboxId);

      return {
        isHealthy: isRunning,
        sandboxId,
        status: isRunning ? SandboxStatus.RUNNING : SandboxStatus.FAILED,
        lastHeartbeat: new Date(),
        message: isRunning
          ? (startTime ? 'Sandbox is healthy' : 'Sandbox is healthy (reconnected)')
          : 'Sandbox is not responding'
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Health check failed for sandbox ${sandboxId}: ${errorMsg}`);

      return {
        isHealthy: false,
        sandboxId,
        status: SandboxStatus.FAILED,
        lastHeartbeat: new Date(),
        error: errorMsg
      };
    }
  }

  /**
   * Enforce timeout limits with soft warnings and hard kill
   *
   * @param sandboxId - Sandbox ID to check
   * @returns Timeout warning if threshold reached, null otherwise
   */
  async enforceTimeout(sandboxId: string): Promise<TimeoutWarning | null> {
    try {
      const startTime = this.sandboxStartTimes.get(sandboxId);
      if (!startTime) {
        this.logger.warn(`Start time not found for sandbox ${sandboxId}, cannot enforce timeout`);
        return null;
      }

      const elapsedMinutes = Math.floor((Date.now() - startTime.getTime()) / 60000);
      const warningsIssued = this.timeoutWarningsIssued.get(sandboxId) || new Set();

      // Hard timeout enforcement (cannot be bypassed) - CHECK FIRST
      if (elapsedMinutes >= this.config.timeoutMinutes) {
        const estimatedCost = this.calculateEstimatedCost(elapsedMinutes);
        const warning: TimeoutWarning = {
          sandboxId,
          elapsedMinutes,
          warningLevel: 'hard',
          message: `HARD TIMEOUT: Sandbox exceeded ${this.config.timeoutMinutes} minute limit. Terminating sandbox. Total cost: ${estimatedCost}`,
          estimatedCost
        };

        this.logger.error(warning.message);

        // Immediately terminate sandbox
        await this.terminateSandbox(sandboxId);

        return warning;
      }

      // Check soft warning thresholds (30min, 50min)
      for (const threshold of this.config.warningThresholds) {
        if (elapsedMinutes >= threshold && !warningsIssued.has(threshold)) {
          warningsIssued.add(threshold);
          this.timeoutWarningsIssued.set(sandboxId, warningsIssued);

          const estimatedCost = this.calculateEstimatedCost(elapsedMinutes);
          const warning: TimeoutWarning = {
            sandboxId,
            elapsedMinutes,
            warningLevel: 'soft',
            message: `Sandbox has been running for ${elapsedMinutes} minutes. Estimated cost: ${estimatedCost}. Approaching ${this.config.timeoutMinutes} minute limit.`,
            estimatedCost
          };

          this.logger.warn(warning.message);
          return warning;
        }
      }

      return null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Timeout enforcement failed for sandbox ${sandboxId}: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Terminate a sandbox and cleanup resources
   *
   * @param sandboxId - Sandbox ID to terminate
   * @returns Termination result
   */
  async terminateSandbox(sandboxId: string): Promise<SandboxTerminationResult> {
    try {
      this.logger.info(`Terminating E2B sandbox: ${sandboxId}`);

      const sandbox = this.activeSandboxes.get(sandboxId);
      if (!sandbox) {
        return {
          success: false,
          sandboxId,
          cleanedUp: false,
          error: `Sandbox ${sandboxId} not found in active sandboxes`
        };
      }

      // Kill sandbox (E2B SDK uses kill(), not close())
      // Wrap with timeout in case kill() hangs
      try {
        await Promise.race([
          sandbox.kill(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('Sandbox kill timeout after 30 seconds')), 30000)
          )
        ]);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        // Check if this is a timeout error
        if (errorMsg.includes('timeout')) {
          this.logger.warn(`Kill operation timeout for ${sandboxId}, proceeding with cleanup`);
          // For timeout, we continue with cleanup (sandbox might be dead anyway)
        } else {
          // For other errors, re-throw so outer catch can handle it
          throw error;
        }
      }

      // Cleanup tracking data
      this.activeSandboxes.delete(sandboxId);
      this.sandboxStartTimes.delete(sandboxId);
      this.timeoutWarningsIssued.delete(sandboxId);

      this.logger.info(`E2B sandbox terminated successfully: ${sandboxId}`);

      return {
        success: true,
        sandboxId,
        cleanedUp: true
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to terminate sandbox ${sandboxId}: ${errorMsg}`);

      // Best-effort cleanup even on error
      this.activeSandboxes.delete(sandboxId);
      this.sandboxStartTimes.delete(sandboxId);
      this.timeoutWarningsIssued.delete(sandboxId);

      return {
        success: false,
        sandboxId,
        cleanedUp: true, // Cleanup completed even if termination failed
        error: errorMsg
      };
    }
  }

  /**
   * Get an active sandbox instance
   *
   * @param sandboxId - Sandbox ID
   * @returns Sandbox instance or null if not found
   */
  getSandbox(sandboxId: string): Sandbox | null {
    return this.activeSandboxes.get(sandboxId) || null;
  }

  /**
   * Get or reconnect to an existing sandbox
   *
   * This method first checks if the sandbox is already in the active sandboxes map.
   * If not found, it attempts to reconnect to the sandbox using the E2B SDK's
   * Sandbox.connect() method. This is essential for CLI commands that need to
   * access sandboxes created in separate process invocations.
   *
   * @param sandboxId - Sandbox ID to connect to
   * @param apiKey - Optional E2B API key (defaults to E2B_API_KEY env var)
   * @returns Sandbox instance or null if connection fails
   */
  async getOrReconnectSandbox(sandboxId: string, apiKey?: string): Promise<Sandbox | null> {
    try {
      // Check if sandbox is already in active sandboxes
      const existingSandbox = this.activeSandboxes.get(sandboxId);
      if (existingSandbox) {
        this.logger.debug(`Using cached sandbox instance: ${sandboxId}`);
        return existingSandbox;
      }

      // Validate API key
      const e2bApiKey = apiKey || process.env.E2B_API_KEY;
      if (!e2bApiKey) {
        this.logger.error('E2B API key not found. Set E2B_API_KEY environment variable.');
        return null;
      }

      this.logger.info(`Reconnecting to sandbox: ${sandboxId}`);

      // Reconnect to existing sandbox using E2B SDK
      const sandbox = await Sandbox.connect(sandboxId, {
        apiKey: e2bApiKey
      });

      // Track reconnected sandbox (but don't track start time since we don't know it)
      this.activeSandboxes.set(sandboxId, sandbox);
      this.logger.info(`Successfully reconnected to sandbox: ${sandboxId}`);

      return sandbox;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to reconnect to sandbox ${sandboxId}: ${errorMsg}`);

      // Provide helpful error messages
      if (errorMsg.includes('not found') || errorMsg.includes('404')) {
        this.logger.error('Sandbox may have been terminated or does not exist');
      } else if (errorMsg.includes('API key')) {
        this.logger.error('Invalid or missing E2B API key');
      } else if (errorMsg.includes('timeout')) {
        this.logger.error('Connection timeout - sandbox may be unresponsive');
      }

      return null;
    }
  }

  /**
   * Get sandbox elapsed time in minutes
   *
   * @param sandboxId - Sandbox ID
   * @returns Elapsed minutes or null if sandbox not found
   */
  getElapsedMinutes(sandboxId: string): number | null {
    const startTime = this.sandboxStartTimes.get(sandboxId);
    if (!startTime) {
      return null;
    }
    return Math.floor((Date.now() - startTime.getTime()) / 60000);
  }

  /**
   * Calculate estimated cost based on elapsed time
   *
   * @param elapsedMinutes - Elapsed minutes
   * @returns Estimated cost string (e.g., "$0.50")
   */
  private calculateEstimatedCost(elapsedMinutes: number): string {
    // E2B pricing: ~$0.10/hour for basic compute
    const costPerMinute = 0.10 / 60;
    const estimatedCost = elapsedMinutes * costPerMinute;
    return `$${estimatedCost.toFixed(2)}`;
  }

  /**
   * Get all active sandbox IDs
   *
   * @returns Array of active sandbox IDs
   */
  getActiveSandboxIds(): string[] {
    return Array.from(this.activeSandboxes.keys());
  }

  /**
   * Extend sandbox timeout (useful for long-running tasks)
   *
   * @param sandboxId - Sandbox ID
   * @param additionalMinutes - Additional minutes to extend
   * @returns Success status
   */
  async extendTimeout(sandboxId: string, additionalMinutes: number): Promise<boolean> {
    try {
      const sandbox = this.activeSandboxes.get(sandboxId);
      if (!sandbox) {
        this.logger.error(`Cannot extend timeout: Sandbox ${sandboxId} not found`);
        return false;
      }

      // E2B SDK setTimeout() expects milliseconds
      const timeoutMs = additionalMinutes * 60 * 1000;

      // E2B SDK has a maximum timeout based on subscription tier
      // Hobby: 1 hour (3600 seconds), Pro: 24 hours (86400 seconds)
      const maxTimeoutMs = 24 * 60 * 60 * 1000; // 24 hours max

      if (timeoutMs > maxTimeoutMs) {
        this.logger.warn(
          `Requested timeout ${additionalMinutes} minutes exceeds maximum (24 hours). Setting to maximum.`
        );
      }

      // Wrap setTimeout call with timeout protection
      await Promise.race([
        sandbox.setTimeout(Math.min(timeoutMs, maxTimeoutMs)),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('setTimeout call timeout after 10 seconds')), 10000)
        )
      ]);
      this.logger.info(`Extended timeout for sandbox ${sandboxId} by ${additionalMinutes} minutes`);

      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to extend timeout for sandbox ${sandboxId}: ${errorMsg}`);
      return false;
    }
  }

  /**
   * Configure NPM authentication in sandbox for private package access
   *
   * Creates ~/.npmrc file with authentication token for the specified registry.
   * This enables npm/yarn/pnpm to install private packages.
   *
   * Security:
   * - Token is never logged
   * - Token is sanitized (newlines removed)
   * - Registry URL is validated
   *
   * @param sandbox - E2B Sandbox instance
   * @param npmToken - NPM authentication token
   * @param npmRegistry - NPM registry URL (default: https://registry.npmjs.org)
   * @returns boolean indicating success
   */
  async configureNpmAuth(
    sandbox: Sandbox,
    npmToken: string,
    npmRegistry: string = 'https://registry.npmjs.org'
  ): Promise<boolean> {
    try {
      // Validate sandbox
      if (!sandbox || !sandbox.files) {
        this.logger.error('Invalid sandbox: missing files API');
        return false;
      }

      // Validate token
      if (!npmToken || typeof npmToken !== 'string' || !npmToken.trim()) {
        this.logger.error('Invalid NPM token: must be a non-empty string');
        return false;
      }

      // Reject tokens containing newlines (injection attack prevention)
      // Legitimate NPM tokens never contain newlines
      if (/[\r\n]/.test(npmToken)) {
        this.logger.error('Invalid NPM token: contains newline characters');
        return false;
      }

      const sanitizedToken = npmToken.trim();

      // Validate registry URL
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(npmRegistry);
      } catch {
        this.logger.error(`Invalid registry URL format: ${npmRegistry}`);
        return false;
      }

      // Check protocol
      if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        this.logger.error(`Invalid registry URL: must use http or https protocol`);
        return false;
      }

      // Warn about insecure http
      if (parsedUrl.protocol === 'http:') {
        this.logger.warn('Using HTTP for NPM registry is insecure. Consider using HTTPS.');
      }

      // Build normalized registry (origin + optional path) without query/fragment
      // This ensures auth scope and registry= line use the same normalized value
      const cleanPath = parsedUrl.pathname && parsedUrl.pathname !== '/'
        ? parsedUrl.pathname.replace(/\/$/, '')
        : '';
      const registryHost = parsedUrl.host + cleanPath;
      const normalizedRegistry = `${parsedUrl.protocol}//${registryHost}`;

      // Build .npmrc content
      // Use function replacement to avoid $ character interpretation in registryHost
      const npmrcContent = [
        `//registry.npmjs.org/:_authToken=${sanitizedToken}`.replace(
          'registry.npmjs.org',
          () => registryHost
        ),
        `registry=${normalizedRegistry}`
      ].join('\n') + '\n';

      // Write .npmrc file
      await sandbox.files.write('/root/.npmrc', npmrcContent);

      this.logger.info('NPM authentication configured successfully');
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to configure NPM config: ${errorMsg}`);
      return false;
    }
  }

  /**
   * Get sandbox cost estimation
   *
   * @param sandboxId - Sandbox ID
   * @returns Estimated cost or null if sandbox not found
   */
  getEstimatedCost(sandboxId: string): string | null {
    const elapsedMinutes = this.getElapsedMinutes(sandboxId);
    if (elapsedMinutes === null) {
      return null;
    }
    return this.calculateEstimatedCost(elapsedMinutes);
  }

  /**
   * Cleanup all active sandboxes (for shutdown)
   */
  async cleanupAll(): Promise<void> {
    this.logger.info(`Cleaning up ${this.activeSandboxes.size} active sandboxes`);

    const cleanupPromises = Array.from(this.activeSandboxes.keys()).map(sandboxId =>
      this.terminateSandbox(sandboxId)
    );

    const results = await Promise.allSettled(cleanupPromises);

    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length > 0) {
      this.logger.error(`Failed to cleanup ${failed.length} sandboxes during shutdown`);
    }
  }

  /**
   * Apply a template to a sandbox
   *
   * This method executes the template's setup commands and sets environment
   * variables in the sandbox. It should be called after sandbox creation.
   *
   * @param sandboxId - Sandbox ID to apply template to
   * @param template - Template definition with setup commands and environment
   * @returns Result of template application
   */
  async applyTemplate(
    sandboxId: string,
    template: SandboxTemplate
  ): Promise<TemplateApplicationResult> {
    try {
      const sandbox = this.activeSandboxes.get(sandboxId);
      if (!sandbox) {
        return {
          success: false,
          message: 'Template application failed',
          error: `Sandbox ${sandboxId} not found in active sandboxes`
        };
      }

      this.logger.info(`Applying template "${template.name}" to sandbox ${sandboxId}`);

      let commandsExecuted = 0;
      let environmentVarsSet = 0;

      // Set environment variables first
      if (template.environment && Object.keys(template.environment).length > 0) {
        const envExports = Object.entries(template.environment)
          .map(([key, value]) => `export ${key}="${value}"`)
          .join(' && ');

        this.logger.info(`Setting ${Object.keys(template.environment).length} environment variables`);

        try {
          const result = await sandbox.commands.run(envExports, {
            timeoutMs: 30000 // 30 second timeout for env setup
          });

          if (result.exitCode !== 0) {
            return {
              success: false,
              message: 'Template application failed',
              error: `Failed to set environment variables: ${result.stderr}`
            };
          }

          environmentVarsSet = Object.keys(template.environment).length;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            message: 'Template application failed',
            error: `Failed to set environment variables: ${errorMsg}`
          };
        }
      }

      // Execute setup commands sequentially
      if (template.setupCommands && template.setupCommands.length > 0) {
        for (const command of template.setupCommands) {
          this.logger.info(`Executing setup command: ${command}`);

          try {
            const result = await sandbox.commands.run(command, {
              timeoutMs: 300000 // 5 minute timeout per command
            });

            if (result.exitCode !== 0) {
              return {
                success: false,
                message: 'Template application failed',
                commandsExecuted,
                environmentVarsSet,
                error: `Setup command failed: "${command}" (exit code ${result.exitCode}): ${result.stderr}`
              };
            }

            commandsExecuted++;
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            return {
              success: false,
              message: 'Template application failed',
              commandsExecuted,
              environmentVarsSet,
              error: `Setup command failed: "${command}": ${errorMsg}`
            };
          }
        }
      }

      this.logger.info(
        `Template "${template.name}" applied successfully: ` +
        `${commandsExecuted} commands, ${environmentVarsSet} env vars`
      );

      return {
        success: true,
        message: `Template "${template.name}" applied successfully`,
        commandsExecuted,
        environmentVarsSet
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to apply template: ${errorMsg}`);

      return {
        success: false,
        message: 'Template application failed',
        error: errorMsg
      };
    }
  }
}
