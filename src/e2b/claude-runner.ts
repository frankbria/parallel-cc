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
 * Includes ANTHROPIC_API_KEY for authentication
 */
const CLAUDE_COMMAND_TEMPLATE = 'cd {workingDir} && ANTHROPIC_API_KEY={apiKey} echo "{prompt}" | claude -p --dangerously-skip-permissions';

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

  /**
   * Authentication method: 'api-key' or 'oauth'
   * - api-key: Uses ANTHROPIC_API_KEY environment variable
   * - oauth: Uses Claude subscription credentials from ~/.claude/.credentials.json
   */
  authMethod?: 'api-key' | 'oauth';

  /**
   * OAuth credentials (required when authMethod is 'oauth')
   * Content of ~/.claude/.credentials.json
   */
  oauthCredentials?: string;

  /**
   * Git user name for commits in sandbox
   * Takes precedence over environment variables and auto-detection
   */
  gitUser?: string;

  /**
   * Git user email for commits in sandbox
   * Takes precedence over environment variables and auto-detection
   */
  gitEmail?: string;

  /**
   * Local repository path for git identity auto-detection
   * Used to read local git config when gitUser/gitEmail not provided
   */
  localRepoPath?: string;
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

/**
 * Git identity source - indicates where the git identity was resolved from
 */
export type GitIdentitySource = 'cli' | 'env' | 'auto' | 'default';

/**
 * Resolved git identity for sandbox commits
 */
export interface GitIdentity {
  /**
   * Git user name for commits
   */
  name: string;

  /**
   * Git user email for commits
   */
  email: string;

  /**
   * Source of the identity (for logging/debugging)
   */
  source: GitIdentitySource;
}

/**
 * Options for resolving git identity
 */
export interface GitIdentityOptions {
  /**
   * Git user name from CLI flag
   */
  gitUser?: string;

  /**
   * Git email from CLI flag
   */
  gitEmail?: string;

  /**
   * Local repository path for auto-detection
   */
  repoPath?: string;
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
    onProgress: options.onProgress ?? (() => {}),
    authMethod: options.authMethod ?? 'api-key',
    oauthCredentials: options.oauthCredentials ?? '',
    gitUser: options.gitUser ?? '',
    gitEmail: options.gitEmail ?? '',
    localRepoPath: options.localRepoPath ?? ''
  };

  logger.info(`Starting Claude execution in sandbox ${sandbox.sandboxId}`);
  logger.debug(`Working directory: ${opts.workingDir}, Timeout: ${opts.timeout} minutes`);
  logger.debug(`Authentication method: ${opts.authMethod}`);

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
    logger.info('Step 1.5/5: Ensuring Claude Code CLI is available...');
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

    // Step 1.6: Update Claude Code to latest version
    logger.info('Step 1.6/5: Updating Claude Code to latest version...');
    const claudeUpdated = await updateClaudeCode(sandbox, logger);
    if (!claudeUpdated) {
      logger.warn('Claude Code update failed - proceeding with installed version');
    }

    // Step 1.75: Setup OAuth credentials if using oauth auth method
    if (opts.authMethod === 'oauth') {
      logger.info('Step 1.75/5: Setting up OAuth credentials...');
      if (!opts.oauthCredentials) {
        return {
          success: false,
          exitCode: -1,
          output: '',
          executionTime: Date.now() - startTime,
          state: 'failed',
          error: 'OAuth credentials required when using oauth auth method'
        };
      }

      const oauthSetup = await setupOAuthCredentials(sandbox, logger, opts.oauthCredentials);
      if (!oauthSetup) {
        return {
          success: false,
          exitCode: -1,
          output: '',
          executionTime: Date.now() - startTime,
          state: 'failed',
          error: 'Failed to setup OAuth credentials in sandbox'
        };
      }
    }

    // Step 1.9: Initialize git repository (needed for download and gh CLI)
    logger.info('Step 1.9/5: Initializing git repository...');

    // Resolve git identity for commits in sandbox
    const gitIdentity = await resolveGitIdentity({
      gitUser: opts.gitUser || undefined,
      gitEmail: opts.gitEmail || undefined,
      repoPath: opts.localRepoPath || undefined
    });

    const gitInit = await initializeGitRepo(sandbox, logger, opts.workingDir, gitIdentity);
    if (!gitInit) {
      logger.warn('Git initialization failed - download and GitHub operations may not work');
    }

    // Step 2: Setup additional CLI tools (gh, etc.)
    logger.info('Step 2/5: Installing MCP servers and tools...');
    const toolsSetup = await setupAdditionalTools(sandbox, logger);
    if (!toolsSetup) {
      logger.warn('Some tools failed to install, continuing anyway');
    }

    // Step 3: Execute Claude with prompt
    logger.info('Step 3/5: Executing Claude Code...');
    const executionResult = await runClaudeWithPrompt(
      sandbox,
      prompt,
      logger,
      opts
    );

    // Step 4: Monitor and return results
    logger.info('Step 4/5: Execution complete');
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
      logger.info(`Claude path: ${check.stdout.trim()}`);
      return true;
    } else {
      logger.info(`'which claude' returned exit code ${check.exitCode}`);
      logger.info(`stdout: ${check.stdout}`);
      logger.info(`stderr: ${check.stderr}`);
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
 * Update Claude Code to the latest version
 *
 * Tries multiple strategies to update Claude Code:
 * 1. Use `claude update` command (preferred)
 * 2. Use npm with --prefix to local directory
 * 3. Fall back to existing version
 *
 * @param sandbox - E2B Sandbox instance
 * @param logger - Logger instance
 * @returns True if update succeeded or wasn't needed
 */
async function updateClaudeCode(sandbox: Sandbox, logger: Logger): Promise<boolean> {
  logger.info('Updating Claude Code to latest version...');

  try {
    // First, check the current version
    const versionCheck = await sandbox.commands.run('claude --version', { timeoutMs: 10000 });
    const currentVersion = versionCheck.exitCode === 0 ? versionCheck.stdout.trim() : 'unknown';
    logger.info(`Current Claude version: ${currentVersion}`);

    // Strategy 1: Try using the built-in claude update command
    // This may work better than npm global install in the sandbox
    logger.debug('Trying claude update command...');
    try {
      const claudeUpdate = await sandbox.commands.run(
        'claude update --yes 2>&1 || claude update 2>&1',
        { timeoutMs: 120000 }
      );

      if (claudeUpdate.exitCode === 0) {
        const newVersion = await sandbox.commands.run('claude --version', { timeoutMs: 10000 });
        logger.info(`Claude Code updated successfully: ${newVersion.stdout.trim()}`);
        return true;
      }
      logger.debug(`claude update failed: ${claudeUpdate.stdout} ${claudeUpdate.stderr}`);
    } catch (e) {
      logger.debug(`claude update threw: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Strategy 2: Try npm install with --prefix to /tmp (works without global perms)
    logger.debug('Trying npm install with local prefix...');
    try {
      const npmLocal = await sandbox.commands.run(
        'npm install --prefix /tmp/claude-update @anthropic-ai/claude-code@latest && ln -sf /tmp/claude-update/node_modules/.bin/claude /usr/local/bin/claude-new',
        { timeoutMs: 180000 }
      );

      if (npmLocal.exitCode === 0) {
        // Test the new claude
        const testNew = await sandbox.commands.run('/usr/local/bin/claude-new --version', { timeoutMs: 10000 });
        if (testNew.exitCode === 0) {
          // Replace the old claude symlink
          await sandbox.commands.run('mv /usr/local/bin/claude-new /usr/local/bin/claude || cp /usr/local/bin/claude-new /usr/bin/claude', { timeoutMs: 5000 });
          logger.info(`Claude Code updated via local prefix: ${testNew.stdout.trim()}`);
          return true;
        }
      }
      logger.debug(`npm local prefix failed: ${npmLocal.stdout} ${npmLocal.stderr}`);
    } catch (e) {
      logger.debug(`npm local prefix threw: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Strategy 3: Try npx to run the latest version directly (updates PATH)
    logger.debug('Trying npx approach...');
    try {
      // Create a wrapper script that uses npx
      const createWrapper = await sandbox.commands.run(
        `cat > /tmp/claude-wrapper.sh << 'EOFSCRIPT'
#!/bin/bash
exec npx -y @anthropic-ai/claude-code@latest "$@"
EOFSCRIPT
chmod +x /tmp/claude-wrapper.sh`,
        { timeoutMs: 10000 }
      );

      if (createWrapper.exitCode === 0) {
        // Test if npx can fetch and run latest
        const testNpx = await sandbox.commands.run(
          'npx -y @anthropic-ai/claude-code@latest --version',
          { timeoutMs: 120000 }
        );

        if (testNpx.exitCode === 0) {
          // Replace claude with the wrapper
          await sandbox.commands.run('cp /tmp/claude-wrapper.sh /usr/local/bin/claude && chmod +x /usr/local/bin/claude', { timeoutMs: 5000 });
          logger.info(`Claude Code will use npx latest: ${testNpx.stdout.trim()}`);
          return true;
        }
      }
    } catch (e) {
      logger.debug(`npx approach threw: ${e instanceof Error ? e.message : String(e)}`);
    }

    // All strategies failed
    logger.warn(`All Claude update strategies failed. Using installed version: ${currentVersion}`);
    return false;
  } catch (error) {
    logger.error('Claude Code update threw unexpected exception', error);
    return false;
  }
}

/**
 * Setup OAuth authentication in the sandbox
 *
 * Copies Claude subscription credentials to the sandbox for OAuth authentication.
 * This allows using Claude subscription instead of API key.
 *
 * @param sandbox - E2B Sandbox instance
 * @param logger - Logger instance
 * @param oauthCredentials - OAuth credentials JSON string
 * @returns True if credentials were successfully setup
 */
async function setupOAuthCredentials(
  sandbox: Sandbox,
  logger: Logger,
  oauthCredentials: string
): Promise<boolean> {
  logger.info('Setting up OAuth credentials in sandbox...');

  try {
    // Create .claude directory in sandbox home
    const mkdirResult = await sandbox.commands.run('mkdir -p ~/.claude', { timeoutMs: 5000 });
    if (mkdirResult.exitCode !== 0) {
      logger.error('Failed to create .claude directory');
      logger.error(`stderr: ${mkdirResult.stderr}`);
      return false;
    }

    // Write credentials to file
    // Escape single quotes in credentials JSON for shell command
    const escapedCreds = oauthCredentials.replace(/'/g, "'\\''");
    const writeResult = await sandbox.commands.run(
      `echo '${escapedCreds}' > ~/.claude/.credentials.json`,
      { timeoutMs: 5000 }
    );

    if (writeResult.exitCode !== 0) {
      logger.error('Failed to write credentials file');
      logger.error(`stderr: ${writeResult.stderr}`);
      return false;
    }

    // Verify file was written
    const verifyResult = await sandbox.commands.run('test -f ~/.claude/.credentials.json && echo "OK"', { timeoutMs: 5000 });
    if (verifyResult.exitCode === 0 && verifyResult.stdout.trim() === 'OK') {
      logger.info('OAuth credentials successfully setup in sandbox');
      return true;
    } else {
      logger.error('Credentials file verification failed');
      return false;
    }
  } catch (error) {
    logger.error('OAuth credentials setup failed', error);
    return false;
  }
}

// ============================================================================
// Git Identity Resolution
// ============================================================================

/**
 * Default git identity used when no other configuration is available
 */
const DEFAULT_GIT_IDENTITY: Omit<GitIdentity, 'source'> = {
  name: 'E2B Sandbox',
  email: 'sandbox@e2b.dev'
};

/**
 * Resolve git identity for sandbox commits
 *
 * Implements a three-tier configuration system:
 * 1. CLI flags (highest priority) - explicit user intent
 * 2. Environment variables - session-level configuration
 * 3. Local git config auto-detection - seamless default
 * 4. Hardcoded defaults (lowest priority) - backward compatibility
 *
 * @param options - Git identity options
 * @returns Resolved git identity with source information
 */
export async function resolveGitIdentity(
  options: GitIdentityOptions = {}
): Promise<GitIdentity> {
  const { gitUser, gitEmail, repoPath } = options;

  // Priority 1: CLI flags (both must be provided)
  const trimmedUser = gitUser?.trim();
  const trimmedEmail = gitEmail?.trim();
  if (trimmedUser && trimmedEmail) {
    return {
      name: trimmedUser,
      email: trimmedEmail,
      source: 'cli'
    };
  }

  // Priority 2: Environment variables (both must be set)
  const envUser = process.env.PARALLEL_CC_GIT_USER?.trim();
  const envEmail = process.env.PARALLEL_CC_GIT_EMAIL?.trim();
  if (envUser && envEmail) {
    return {
      name: envUser,
      email: envEmail,
      source: 'env'
    };
  }

  // Priority 3: Auto-detect from local git config
  if (repoPath) {
    try {
      const { execSync } = await import('child_process');
      const { realpathSync, existsSync } = await import('fs');

      // Verify the path exists
      if (existsSync(repoPath)) {
        // Resolve symlinks for accurate git config reading
        const realPath = realpathSync(repoPath);

        // Try to read git config user.name and user.email
        const autoName = execSync('git config user.name', {
          cwd: realPath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore'] // Suppress stderr
        }).trim();

        const autoEmail = execSync('git config user.email', {
          cwd: realPath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore']
        }).trim();

        if (autoName && autoEmail) {
          return {
            name: autoName,
            email: autoEmail,
            source: 'auto'
          };
        }
      }
    } catch {
      // Git config not available or path is not a git repo
      // Fall through to defaults
    }
  }

  // Priority 4: Hardcoded defaults (backward compatibility)
  return {
    ...DEFAULT_GIT_IDENTITY,
    source: 'default'
  };
}

/**
 * Initialize a git repository in the sandbox workspace
 *
 * Since we exclude .git from uploads (to save bandwidth), we need to initialize
 * a fresh git repo in the sandbox. This enables:
 * - Git commands for tracking changes (needed for download)
 * - GitHub CLI operations (gh issue, gh pr, etc.)
 * - Git-based workflows in Claude Code
 *
 * @param sandbox - E2B Sandbox instance
 * @param logger - Logger instance
 * @param workingDir - Working directory path (default: /workspace)
 * @returns True if git was successfully initialized
 */
async function initializeGitRepo(
  sandbox: Sandbox,
  logger: Logger,
  workingDir: string = '/workspace',
  gitIdentity?: GitIdentity
): Promise<boolean> {
  logger.info('Initializing git repository in sandbox workspace...');

  // Use provided identity or default
  const identity = gitIdentity ?? {
    name: DEFAULT_GIT_IDENTITY.name,
    email: DEFAULT_GIT_IDENTITY.email,
    source: 'default' as GitIdentitySource
  };

  logger.info(`Git identity: "${identity.name}" <${identity.email}> (source: ${identity.source})`);

  try {
    // Step 1: Initialize git repo
    const initResult = await sandbox.commands.run('git init', {
      cwd: workingDir,
      timeoutMs: 10000
    });

    if (initResult.exitCode !== 0) {
      logger.error('Failed to initialize git repository');
      logger.error(`stderr: ${initResult.stderr}`);
      return false;
    }

    // Step 2: Configure git user (required for commits)
    // Escape double quotes in identity values for shell safety
    const escapedName = identity.name.replace(/"/g, '\\"');
    const escapedEmail = identity.email.replace(/"/g, '\\"');

    const configName = await sandbox.commands.run(
      `git config user.name "${escapedName}"`,
      { cwd: workingDir, timeoutMs: 5000 }
    );
    const configEmail = await sandbox.commands.run(
      `git config user.email "${escapedEmail}"`,
      { cwd: workingDir, timeoutMs: 5000 }
    );

    if (configName.exitCode !== 0 || configEmail.exitCode !== 0) {
      logger.warn('Failed to configure git user, but continuing');
    }

    // Step 3: Create initial commit
    const addResult = await sandbox.commands.run('git add .', {
      cwd: workingDir,
      timeoutMs: 30000
    });

    if (addResult.exitCode !== 0) {
      logger.error('Failed to stage files for git commit');
      logger.error(`stderr: ${addResult.stderr}`);
      return false;
    }

    const commitResult = await sandbox.commands.run(
      'git commit -m "Initial workspace state"',
      { cwd: workingDir, timeoutMs: 30000 }
    );

    if (commitResult.exitCode !== 0) {
      logger.error('Failed to create initial commit');
      logger.error(`stderr: ${commitResult.stderr}`);
      return false;
    }

    // Step 4: Configure git remote (needed for gh CLI)
    // Try to get the remote URL from the local repo
    try {
      const { execSync } = await import('child_process');
      const { realpathSync } = await import('fs');

      // Get the real path of the working directory (resolve symlinks)
      const realWorkDir = realpathSync(process.cwd());

      // Get remote URL from local git repo
      const remoteUrl = execSync('git remote get-url origin', {
        cwd: realWorkDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'] // Suppress stderr
      }).trim();

      if (remoteUrl) {
        logger.debug(`Setting git remote origin to: ${remoteUrl}`);
        const remoteResult = await sandbox.commands.run(
          `git remote add origin "${remoteUrl}"`,
          { cwd: workingDir, timeoutMs: 5000 }
        );

        if (remoteResult.exitCode === 0) {
          logger.info(`Git remote configured: ${remoteUrl}`);
        } else {
          logger.warn('Failed to set git remote, but continuing');
        }
      }
    } catch (error) {
      logger.debug('Could not detect git remote from local repo (not a git repo or no remote)');
    }

    // Step 5: Verify git is working
    const statusResult = await sandbox.commands.run('git status', {
      cwd: workingDir,
      timeoutMs: 5000
    });

    if (statusResult.exitCode === 0) {
      logger.info('Git repository initialized successfully');
      logger.debug(`Git status: ${statusResult.stdout?.substring(0, 100)}`);
      return true;
    } else {
      logger.error('Git repository verification failed');
      return false;
    }
  } catch (error) {
    logger.error('Git initialization failed', error);
    return false;
  }
}

/**
 * Copy mcporter configuration to sandbox
 *
 * Copies ~/.mcporter/mcporter.json from host to sandbox so mcporter
 * knows about installed MCP servers and their configurations.
 *
 * @param sandbox - E2B Sandbox instance
 * @param logger - Logger instance
 * @returns True if config was copied successfully
 */
async function copyMcporterConfig(
  sandbox: Sandbox,
  logger: Logger
): Promise<boolean> {
  logger.info('Copying mcporter configuration to sandbox...');

  try {
    // Read mcporter config from host
    const { homedir } = await import('os');
    const { readFile } = await import('fs/promises');
    const { join } = await import('path');

    const configPath = join(homedir(), '.mcporter', 'mcporter.json');

    let configContent: string;
    try {
      configContent = await readFile(configPath, 'utf-8');
      logger.debug('mcporter config found on host');
    } catch (error) {
      logger.debug('No mcporter config on host, skipping');
      return true; // Not an error - user may not have mcporter configured
    }

    // Create .mcporter directory in sandbox
    const mkdirResult = await sandbox.commands.run('mkdir -p ~/.mcporter', { timeoutMs: 5000 });
    if (mkdirResult.exitCode !== 0) {
      logger.error('Failed to create .mcporter directory');
      return false;
    }

    // Write config to sandbox
    const escapedConfig = configContent.replace(/'/g, "'\\''");
    const writeResult = await sandbox.commands.run(
      `echo '${escapedConfig}' > ~/.mcporter/mcporter.json`,
      { timeoutMs: 5000 }
    );

    if (writeResult.exitCode !== 0) {
      logger.error('Failed to write mcporter config');
      logger.error(`stderr: ${writeResult.stderr}`);
      return false;
    }

    // Verify file was written
    const verifyResult = await sandbox.commands.run('test -f ~/.mcporter/mcporter.json && echo "OK"', { timeoutMs: 5000 });
    if (verifyResult.exitCode === 0 && verifyResult.stdout.trim() === 'OK') {
      logger.info('mcporter config successfully copied to sandbox');
      return true;
    } else {
      logger.error('mcporter config verification failed');
      return false;
    }
  } catch (error) {
    logger.error('Failed to copy mcporter config', error);
    return false;
  }
}

/**
 * Setup additional CLI tools needed for development
 *
 * Installs MCP servers and mcporter to match local development environment.
 *
 * @param sandbox - E2B Sandbox instance
 * @param logger - Logger instance
 * @returns True if setup succeeded
 */
async function setupAdditionalTools(
  sandbox: Sandbox,
  logger: Logger
): Promise<boolean> {
  logger.info('Installing MCP servers and tools...');

  try {
    // Step 1: Always install mcporter for dynamic MCP server management
    logger.info('Installing mcporter...');
    const mcporterInstall = await sandbox.commands.run(
      'npm install -g mcporter',
      { timeoutMs: 60000 }
    );

    if (mcporterInstall.exitCode === 0) {
      logger.info('mcporter installed successfully');

      // Copy mcporter configuration from host if it exists
      await copyMcporterConfig(sandbox, logger);
    } else {
      logger.warn('mcporter installation failed, continuing anyway');
      logger.debug(`stderr: ${mcporterInstall.stderr}`);
    }

    // Step 2: Install MCP servers from settings.json files
    const mcpServers = await discoverMCPServers(sandbox, logger);
    if (mcpServers.length > 0) {
      logger.info(`Found ${mcpServers.length} MCP servers to install`);

      for (const serverPackage of mcpServers) {
        logger.info(`Installing MCP server: ${serverPackage}`);
        const install = await sandbox.commands.run(
          `npm install -g ${serverPackage}`,
          { timeoutMs: 90000 }
        );

        if (install.exitCode === 0) {
          logger.info(`✓ ${serverPackage} installed`);
        } else {
          logger.warn(`✗ ${serverPackage} failed to install`);
          logger.debug(`stderr: ${install.stderr}`);
        }
      }
    } else {
      logger.info('No MCP servers configured in settings.json');
    }

    return true;
  } catch (error) {
    logger.error('Additional tools setup failed', error);
    return false;
  }
}

/**
 * Discover MCP servers from settings.json files
 *
 * Reads both global (~/.claude/settings.json) and local (.claude/settings.json)
 * to find configured MCP servers and extract their npm package names.
 *
 * @param sandbox - E2B Sandbox instance
 * @param logger - Logger instance
 * @returns Array of npm package names to install
 */
async function discoverMCPServers(
  sandbox: Sandbox,
  logger: Logger
): Promise<string[]> {
  const packages = new Set<string>();

  // Check local settings in workspace
  const localSettingsPath = '/workspace/.claude/settings.json';
  const localCheck = await sandbox.commands.run(
    `test -f ${localSettingsPath} && cat ${localSettingsPath}`,
    { timeoutMs: 5000 }
  );

  if (localCheck.exitCode === 0 && localCheck.stdout) {
    try {
      const settings = JSON.parse(localCheck.stdout);
      if (settings.mcpServers) {
        extractMCPPackages(settings.mcpServers, packages, logger);
      }
    } catch (error) {
      logger.debug('Failed to parse local settings.json');
    }
  }

  return Array.from(packages);
}

/**
 * Extract npm package names from MCP server configurations
 *
 * Supports common patterns:
 * - npx -y @org/package-name
 * - npx @org/package-name
 * - node /path/to/server.js (skipped - not an npm package)
 *
 * @param mcpServers - MCP servers configuration object
 * @param packages - Set to add package names to
 * @param logger - Logger instance
 */
function extractMCPPackages(
  mcpServers: Record<string, any>,
  packages: Set<string>,
  logger: Logger
): void {
  for (const [serverName, config] of Object.entries(mcpServers)) {
    if (!config || typeof config !== 'object') continue;

    // Extract package from command and args
    if (config.command === 'npx' && Array.isArray(config.args)) {
      // Find the package name in args (skip flags like -y)
      const packageArg = config.args.find((arg: string) =>
        !arg.startsWith('-') && arg.includes('/')
      );

      if (packageArg) {
        packages.add(packageArg);
        logger.debug(`Found MCP server: ${serverName} -> ${packageArg}`);
      }
    } else if (config.command && config.command.includes('npx')) {
      // Handle inline npx commands
      const match = config.command.match(/npx\s+(?:-y\s+)?(@[\w-]+\/[\w-]+)/);
      if (match && match[1]) {
        packages.add(match[1]);
        logger.debug(`Found MCP server: ${serverName} -> ${match[1]}`);
      }
    }
  }
}

/**
 * Patterns that indicate Claude is already at the latest version
 * These patterns appear when `claude update` is run but no update is needed
 */
const ALREADY_UP_TO_DATE_PATTERNS = [
  /already\s+(?:at\s+)?(?:the\s+)?latest/i,
  /up[\s-]?to[\s-]?date/i,
  /no\s+updates?\s+available/i,
  /already\s+(?:at\s+)?(?:version|v)?[\s]?[\d.]+/i,
  /current\s+version/i
];

/**
 * Check if output indicates Claude is already up-to-date
 *
 * @param output - Combined stdout + stderr from update command
 * @returns True if output indicates already up-to-date
 */
function isAlreadyUpToDate(output: string): boolean {
  return ALREADY_UP_TO_DATE_PATTERNS.some(pattern => pattern.test(output));
}

/**
 * Parse version from various output formats
 *
 * Handles:
 * - "Claude Code updated to version X.Y.Z"
 * - "Already at latest version X.Y.Z"
 * - "version X.Y.Z"
 * - Plain version string "X.Y.Z"
 *
 * @param output - Text to parse version from
 * @returns Version string or null if not found
 */
function parseVersion(output: string): string | null {
  // Try various version patterns
  const patterns = [
    /version\s+(\d+\.\d+\.\d+)/i,
    /v(\d+\.\d+\.\d+)/i,
    /^([\d]+\.[\d]+\.[\d]+)$/m
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/**
 * Ensure latest Claude Code version is installed
 *
 * Runs `claude update --yes` in the sandbox to ensure the latest version.
 * This is critical for autonomous execution to avoid bugs in older versions.
 *
 * Enhanced to handle "already up-to-date" scenarios gracefully:
 * 1. Pre-checks current version before update
 * 2. Uses --yes flag to auto-accept prompts
 * 3. Detects "already up-to-date" messages and treats them as success
 * 4. Falls back to pre-check version when update output lacks version
 *
 * @param sandbox - E2B Sandbox instance
 * @param logger - Logger instance
 * @param authMethod - Authentication method ('api-key' or 'oauth')
 * @returns Update result with version info
 */
export async function runClaudeUpdate(
  sandbox: Sandbox,
  logger: Logger,
  authMethod: 'api-key' | 'oauth' = 'api-key'
): Promise<ClaudeUpdateResult> {
  logger.info('Running claude update...');

  // Step 1: Pre-check current version
  let currentVersion = 'unknown';
  try {
    const versionCheck = await sandbox.commands.run('claude --version', {
      timeoutMs: 10000
    });
    if (versionCheck.exitCode === 0) {
      currentVersion = parseVersion(versionCheck.stdout.trim()) || versionCheck.stdout.trim() || 'unknown';
      logger.info(`Current Claude version: ${currentVersion}`);
    }
  } catch (e) {
    logger.debug(`Version pre-check failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    // Step 2: Build update command with --yes flag based on auth method
    let updateCommand: string;
    if (authMethod === 'oauth') {
      // OAuth mode: credentials already in sandbox, no env var needed
      logger.debug('Using OAuth authentication for update');
      updateCommand = 'claude update --yes';
    } else {
      // API key mode: pass ANTHROPIC_API_KEY as environment variable
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        logger.warn('ANTHROPIC_API_KEY not set - Claude may require authentication');
      }
      updateCommand = apiKey
        ? `ANTHROPIC_API_KEY=${apiKey} claude update --yes`
        : 'claude update --yes';
    }

    const result = await sandbox.commands.run(updateCommand, {
      timeoutMs: CLAUDE_UPDATE_TIMEOUT_MS
    });

    const combinedOutput = result.stdout + result.stderr;

    // Step 3: Parse version from output, fall back to pre-check version
    let version = parseVersion(combinedOutput);
    if (!version) {
      version = currentVersion;
    }

    // Step 4: Check for success conditions
    // Success if: exit code 0 OR output indicates "already up-to-date"
    const exitCodeSuccess = result.exitCode === 0;
    const alreadyUpToDate = isAlreadyUpToDate(combinedOutput);
    const success = exitCodeSuccess || alreadyUpToDate;

    if (success) {
      if (alreadyUpToDate && !exitCodeSuccess) {
        logger.info(`Claude is already up-to-date: version ${version}`);
      } else {
        logger.info(`Claude update succeeded: version ${version}`);
      }
    } else {
      logger.warn(`Claude update failed: exit code ${result.exitCode}`);
      logger.debug(`stdout: ${result.stdout}`);
      logger.debug(`stderr: ${result.stderr}`);
    }

    return {
      success,
      version,
      output: combinedOutput,
      error: success ? undefined : `Update failed with exit code ${result.exitCode}`
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('Claude update threw exception', error);

    // Try to extract stdout/stderr from error if available
    let stdout = '';
    let stderr = '';
    if (error && typeof error === 'object') {
      const errObj = error as Record<string, unknown>;
      if (typeof errObj.stdout === 'string') stdout = errObj.stdout;
      if (typeof errObj.stderr === 'string') stderr = errObj.stderr;

      // Log the actual command output
      if (stdout) logger.debug(`stdout: ${stdout}`);
      if (stderr) logger.debug(`stderr: ${stderr}`);
    }

    // Check for "already up-to-date" in exception output
    const combinedOutput = stdout + stderr;
    if (isAlreadyUpToDate(combinedOutput)) {
      logger.info(`Claude is already up-to-date (from exception output): version ${currentVersion}`);
      return {
        success: true,
        version: currentVersion,
        output: combinedOutput
      };
    }

    // Check for "command not found" errors (exit 127)
    if (errorMsg.includes('127') || errorMsg.toLowerCase().includes('not found')) {
      logger.error('Claude CLI missing. Use anthropic-claude-code template or check installation.');
    }

    return {
      success: false,
      version: currentVersion !== 'unknown' ? currentVersion : 'unknown',
      output: combinedOutput,
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

    // Build Claude command based on auth method
    // Note: We use 'export' instead of inline env vars because inline vars only apply
    // to the first command in a pipeline, not to commands after the pipe (|)
    let command: string;
    const exportStatements: string[] = [];

    if (options.authMethod === 'oauth') {
      // OAuth mode: credentials already setup in sandbox, no env var needed for Claude
      logger.debug('Using OAuth authentication (credentials already configured)');
    } else {
      // API key mode: pass ANTHROPIC_API_KEY as environment variable
      const apiKey = process.env.ANTHROPIC_API_KEY || '';
      if (!apiKey) {
        logger.warn('ANTHROPIC_API_KEY not set - Claude execution may fail with authentication error');
      }
      logger.debug('Using API key authentication');
      exportStatements.push(`export ANTHROPIC_API_KEY='${apiKey}'`);
    }

    // Add GITHUB_TOKEN if available
    const githubToken = process.env.GITHUB_TOKEN;
    if (githubToken) {
      exportStatements.push(`export GITHUB_TOKEN='${githubToken}'`);
      logger.debug('GITHUB_TOKEN will be passed to sandbox');
    } else {
      logger.debug('GITHUB_TOKEN not set - GitHub operations may require authentication');
    }

    // Build the full command with exports
    const exportPrefix = exportStatements.length > 0 ? exportStatements.join(' && ') + ' && ' : '';
    command = `cd ${options.workingDir} && ${exportPrefix}echo "${sanitizedPrompt}" | claude -p --dangerously-skip-permissions`;

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

    // Log error details for failed executions
    if (state === 'failed') {
      logger.error(`stdout: ${result.stdout}`);
      logger.error(`stderr: ${result.stderr}`);
    }

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
