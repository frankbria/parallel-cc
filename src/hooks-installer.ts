/**
 * Hook configuration installer for parallel-cc
 *
 * Manages installation of PostToolUse heartbeat hooks in Claude Code settings.
 * Supports both global (~/.claude/settings.json) and local (.claude/settings.json) installation.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, copyFileSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

// Get package root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '..');

export interface HookConfig {
  type: 'command';
  command: string;
}

export interface HookMatcher {
  matcher: string;
  hooks: HookConfig[];
}

export interface ClaudeSettings {
  hooks?: {
    PreToolUse?: HookMatcher[];
    PostToolUse?: HookMatcher[];
    Notification?: HookMatcher[];
    Stop?: HookMatcher[];
  };
  [key: string]: unknown;
}

export interface InstallHooksOptions {
  /** Install globally to ~/.claude/settings.json */
  global?: boolean;
  /** Install locally to ./.claude/settings.json */
  local?: boolean;
  /** Repository path for local installation (defaults to cwd) */
  repoPath?: string;
  /** Path to the heartbeat script (defaults to ~/.local/bin/parallel-cc-heartbeat.sh) */
  heartbeatPath?: string;
  /** Add .claude/ to .gitignore for local installation */
  addToGitignore?: boolean;
  /** Dry run - don't write files, just return what would be done */
  dryRun?: boolean;
}

export interface InstallHooksResult {
  success: boolean;
  settingsPath: string;
  created: boolean;
  merged: boolean;
  alreadyInstalled: boolean;
  gitignoreUpdated: boolean;
  error?: string;
}

const DEFAULT_HEARTBEAT_PATH = '~/.local/bin/parallel-cc-heartbeat.sh';

/**
 * Get the path to the global Claude settings file
 */
export function getGlobalSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

/**
 * Get the path to Claude MCP configuration file
 * Note: MCP servers go in ~/.claude.json, NOT ~/.claude/settings.json
 */
export function getMcpConfigPath(): string {
  return join(homedir(), '.claude.json');
}

/**
 * Get the path to local Claude settings file for a repository
 */
export function getLocalSettingsPath(repoPath: string): string {
  return join(resolve(repoPath), '.claude', 'settings.json');
}

/**
 * Create the parallel-cc heartbeat hook configuration
 */
export function createHeartbeatHook(heartbeatPath: string = DEFAULT_HEARTBEAT_PATH): HookMatcher {
  return {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: heartbeatPath
      }
    ]
  };
}

/**
 * Read and parse Claude settings from a path
 */
export function readSettings(settingsPath: string): ClaudeSettings | null {
  if (!existsSync(settingsPath)) {
    return null;
  }

  try {
    const content = readFileSync(settingsPath, 'utf-8');
    return JSON.parse(content) as ClaudeSettings;
  } catch (error) {
    throw new Error(`Failed to parse settings file at ${settingsPath}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/**
 * Write Claude settings to a path
 */
export function writeSettings(settingsPath: string, settings: ClaudeSettings): void {
  const dir = dirname(settingsPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

/**
 * Check if the parallel-cc heartbeat hook is already installed in settings
 */
export function isHookInstalled(settings: ClaudeSettings | null, heartbeatPath: string = DEFAULT_HEARTBEAT_PATH): boolean {
  if (!settings?.hooks?.PostToolUse) {
    return false;
  }

  return settings.hooks.PostToolUse.some(matcher =>
    matcher.hooks?.some(hook =>
      hook.type === 'command' && hook.command.includes('parallel-cc')
    )
  );
}

/**
 * Merge the heartbeat hook into existing settings, preserving other configuration
 */
export function mergeHookIntoSettings(
  existingSettings: ClaudeSettings | null,
  heartbeatPath: string = DEFAULT_HEARTBEAT_PATH
): ClaudeSettings {
  const settings: ClaudeSettings = existingSettings ? { ...existingSettings } : {};

  // Initialize hooks structure if not present
  if (!settings.hooks) {
    settings.hooks = {};
  }

  // Initialize PostToolUse array if not present
  if (!settings.hooks.PostToolUse) {
    settings.hooks.PostToolUse = [];
  }

  // Add our heartbeat hook if not already present
  const heartbeatHook = createHeartbeatHook(heartbeatPath);

  // Check if we already have a parallel-cc hook
  const existingIndex = settings.hooks.PostToolUse.findIndex(matcher =>
    matcher.hooks?.some(hook =>
      hook.type === 'command' && hook.command.includes('parallel-cc')
    )
  );

  if (existingIndex === -1) {
    // Add new hook
    settings.hooks.PostToolUse.push(heartbeatHook);
  } else {
    // Update existing hook
    settings.hooks.PostToolUse[existingIndex] = heartbeatHook;
  }

  return settings;
}

/**
 * Check if .claude/ is already in .gitignore
 */
export function isInGitignore(repoPath: string): boolean {
  const gitignorePath = join(resolve(repoPath), '.gitignore');

  if (!existsSync(gitignorePath)) {
    return false;
  }

  try {
    const content = readFileSync(gitignorePath, 'utf-8');
    const lines = content.split('\n').map(line => line.trim());
    return lines.some(line =>
      line === '.claude/' ||
      line === '.claude' ||
      line === '/.claude/' ||
      line === '/.claude'
    );
  } catch {
    return false;
  }
}

/**
 * Add .claude/ to .gitignore
 */
export function addToGitignore(repoPath: string): boolean {
  const gitignorePath = join(resolve(repoPath), '.gitignore');

  try {
    let content = '';
    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, 'utf-8');
    }

    // Check if already present
    if (isInGitignore(repoPath)) {
      return false;
    }

    // Add newline if file doesn't end with one
    const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    const entry = `${prefix}# Claude Code local settings\n.claude/\n`;

    appendFileSync(gitignorePath, entry, 'utf-8');
    return true;
  } catch (error) {
    throw new Error(`Failed to update .gitignore: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/**
 * Install heartbeat hooks to Claude Code settings
 *
 * @param options - Installation options
 * @returns Result of the installation
 */
export function installHooks(options: InstallHooksOptions = {}): InstallHooksResult {
  const {
    global: installGlobal = false,
    local: installLocal = false,
    repoPath = process.cwd(),
    heartbeatPath = DEFAULT_HEARTBEAT_PATH,
    addToGitignore: shouldAddToGitignore = false,
    dryRun = false
  } = options;

  // Determine which settings file to use
  let settingsPath: string;
  if (installGlobal) {
    settingsPath = getGlobalSettingsPath();
  } else if (installLocal) {
    settingsPath = getLocalSettingsPath(repoPath);
  } else {
    // Default to global if neither specified
    settingsPath = getGlobalSettingsPath();
  }

  const result: InstallHooksResult = {
    success: false,
    settingsPath,
    created: false,
    merged: false,
    alreadyInstalled: false,
    gitignoreUpdated: false
  };

  try {
    // Read existing settings
    const existingSettings = readSettings(settingsPath);

    // Check if already installed
    if (isHookInstalled(existingSettings, heartbeatPath)) {
      result.success = true;
      result.alreadyInstalled = true;
      return result;
    }

    // Determine if we're creating new or merging
    result.created = existingSettings === null;
    result.merged = !result.created;

    // Merge hook into settings
    const newSettings = mergeHookIntoSettings(existingSettings, heartbeatPath);

    // Write settings (unless dry run)
    if (!dryRun) {
      writeSettings(settingsPath, newSettings);
    }

    // Handle .gitignore for local installation
    if (installLocal && shouldAddToGitignore && !dryRun) {
      try {
        result.gitignoreUpdated = addToGitignore(repoPath);
      } catch {
        // Non-fatal error - gitignore update failed
        result.gitignoreUpdated = false;
      }
    }

    result.success = true;
    return result;

  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    return result;
  }
}

/**
 * Uninstall heartbeat hooks from Claude Code settings
 */
export function uninstallHooks(options: { global?: boolean; local?: boolean; repoPath?: string }): InstallHooksResult {
  const {
    global: uninstallGlobal = false,
    local: uninstallLocal = false,
    repoPath = process.cwd()
  } = options;

  // Determine which settings file to use
  let settingsPath: string;
  if (uninstallGlobal) {
    settingsPath = getGlobalSettingsPath();
  } else if (uninstallLocal) {
    settingsPath = getLocalSettingsPath(repoPath);
  } else {
    settingsPath = getGlobalSettingsPath();
  }

  const result: InstallHooksResult = {
    success: false,
    settingsPath,
    created: false,
    merged: false,
    alreadyInstalled: false,
    gitignoreUpdated: false
  };

  try {
    const existingSettings = readSettings(settingsPath);

    if (!existingSettings || !isHookInstalled(existingSettings)) {
      // Nothing to uninstall
      result.success = true;
      return result;
    }

    // Remove parallel-cc hooks from PostToolUse
    if (existingSettings.hooks?.PostToolUse) {
      existingSettings.hooks.PostToolUse = existingSettings.hooks.PostToolUse.filter(
        matcher => !matcher.hooks?.some(hook =>
          hook.type === 'command' && hook.command.includes('parallel-cc')
        )
      );

      // Clean up empty arrays
      if (existingSettings.hooks.PostToolUse.length === 0) {
        delete existingSettings.hooks.PostToolUse;
      }
      if (Object.keys(existingSettings.hooks).length === 0) {
        delete existingSettings.hooks;
      }
    }

    writeSettings(settingsPath, existingSettings);
    result.success = true;
    return result;

  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    return result;
  }
}

/**
 * Check the current hook installation status
 */
export function checkHooksStatus(options: { global?: boolean; local?: boolean; repoPath?: string } = {}): {
  globalInstalled: boolean;
  localInstalled: boolean;
  globalPath: string;
  localPath: string;
} {
  const repoPath = options.repoPath ?? process.cwd();
  const globalPath = getGlobalSettingsPath();
  const localPath = getLocalSettingsPath(repoPath);

  const globalSettings = readSettings(globalPath);
  const localSettings = readSettings(localPath);

  return {
    globalInstalled: isHookInstalled(globalSettings),
    localInstalled: isHookInstalled(localSettings),
    globalPath,
    localPath
  };
}

// ============================================================================
// Alias Installation (v0.2.3)
// ============================================================================

export type ShellType = 'bash' | 'zsh' | 'fish' | 'unknown';

export interface InstallAliasOptions {
  /** Custom alias name (defaults to 'claude') */
  aliasName?: string;
  /** Custom target command (defaults to 'claude-parallel') */
  targetCommand?: string;
  /** Dry run - don't write files */
  dryRun?: boolean;
}

export interface InstallAliasResult {
  success: boolean;
  shell: ShellType;
  profilePath: string;
  alreadyInstalled: boolean;
  error?: string;
}

const ALIAS_COMMENT = '# parallel-cc: alias for claude-parallel wrapper';

/**
 * Detect the current shell type from $SHELL environment variable
 */
export function detectShell(): ShellType {
  const shell = process.env.SHELL ?? '';
  const shellName = shell.split('/').pop() ?? '';

  if (shellName === 'bash') return 'bash';
  if (shellName === 'zsh') return 'zsh';
  if (shellName === 'fish') return 'fish';

  return 'unknown';
}

/**
 * Get the shell profile file path for the detected shell
 */
export function getShellProfilePath(shell: ShellType): string | null {
  const home = homedir();

  switch (shell) {
    case 'bash':
      // Prefer .bashrc for interactive shells, fallback to .bash_profile
      const bashrc = join(home, '.bashrc');
      const bashProfile = join(home, '.bash_profile');
      if (existsSync(bashrc)) return bashrc;
      if (existsSync(bashProfile)) return bashProfile;
      return bashrc; // Default to .bashrc even if it doesn't exist
    case 'zsh':
      return join(home, '.zshrc');
    case 'fish':
      return join(home, '.config', 'fish', 'config.fish');
    default:
      return null;
  }
}

/**
 * Generate the alias line for a given shell
 */
export function generateAliasLine(shell: ShellType, aliasName: string, targetCommand: string): string {
  if (shell === 'fish') {
    return `${ALIAS_COMMENT}\nalias ${aliasName} '${targetCommand}'`;
  }
  return `${ALIAS_COMMENT}\nalias ${aliasName}='${targetCommand}'`;
}

/**
 * Check if the parallel-cc alias is already installed in a profile file
 */
export function isAliasInstalled(profilePath: string, aliasName: string = 'claude'): boolean {
  if (!existsSync(profilePath)) {
    return false;
  }

  try {
    const content = readFileSync(profilePath, 'utf-8');
    // Check for our comment marker or the alias itself
    const aliasPattern = new RegExp(`alias\\s+${aliasName}[=\\s].*claude-parallel`, 'i');
    return content.includes(ALIAS_COMMENT) || aliasPattern.test(content);
  } catch {
    return false;
  }
}

/**
 * Install the claude alias to the shell profile
 */
export function installAlias(options: InstallAliasOptions = {}): InstallAliasResult {
  const {
    aliasName = 'claude',
    targetCommand = 'claude-parallel',
    dryRun = false
  } = options;

  const shell = detectShell();
  const profilePath = getShellProfilePath(shell);

  const result: InstallAliasResult = {
    success: false,
    shell,
    profilePath: profilePath ?? '',
    alreadyInstalled: false
  };

  // Check if shell is supported
  if (!profilePath) {
    result.error = `Unsupported shell: ${shell}. Please add the alias manually.`;
    return result;
  }

  result.profilePath = profilePath;

  try {
    // Check if already installed
    if (isAliasInstalled(profilePath, aliasName)) {
      result.success = true;
      result.alreadyInstalled = true;
      return result;
    }

    // Generate alias line
    const aliasLine = generateAliasLine(shell, aliasName, targetCommand);

    if (!dryRun) {
      // Ensure directory exists for fish config
      if (shell === 'fish') {
        const fishConfigDir = dirname(profilePath);
        if (!existsSync(fishConfigDir)) {
          mkdirSync(fishConfigDir, { recursive: true });
        }
      }

      // Read existing content
      let content = '';
      if (existsSync(profilePath)) {
        content = readFileSync(profilePath, 'utf-8');
      }

      // Add newline if file doesn't end with one
      const prefix = content.length > 0 && !content.endsWith('\n') ? '\n\n' : '\n';
      const entry = `${prefix}${aliasLine}\n`;

      appendFileSync(profilePath, entry, 'utf-8');
    }

    result.success = true;
    return result;

  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    return result;
  }
}

/**
 * Uninstall the claude alias from the shell profile
 */
export function uninstallAlias(options: { aliasName?: string } = {}): InstallAliasResult {
  const { aliasName = 'claude' } = options;

  const shell = detectShell();
  const profilePath = getShellProfilePath(shell);

  const result: InstallAliasResult = {
    success: false,
    shell,
    profilePath: profilePath ?? '',
    alreadyInstalled: false
  };

  if (!profilePath || !existsSync(profilePath)) {
    result.success = true; // Nothing to uninstall
    return result;
  }

  result.profilePath = profilePath;

  try {
    let content = readFileSync(profilePath, 'utf-8');

    // Remove our alias block (comment + alias line)
    const lines = content.split('\n');
    const newLines: string[] = [];
    let skipNext = false;

    for (const line of lines) {
      if (line.trim() === ALIAS_COMMENT) {
        skipNext = true; // Skip the comment and the next line (the alias)
        continue;
      }
      if (skipNext) {
        skipNext = false;
        continue;
      }
      // Also remove standalone alias lines that match
      const aliasPattern = new RegExp(`^\\s*alias\\s+${aliasName}[=\\s].*claude-parallel`);
      if (aliasPattern.test(line)) {
        continue;
      }
      newLines.push(line);
    }

    // Write back
    writeFileSync(profilePath, newLines.join('\n'), 'utf-8');
    result.success = true;
    return result;

  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    return result;
  }
}

/**
 * Check the current alias installation status
 */
export function checkAliasStatus(aliasName: string = 'claude'): {
  installed: boolean;
  shell: ShellType;
  profilePath: string | null;
} {
  const shell = detectShell();
  const profilePath = getShellProfilePath(shell);

  return {
    installed: profilePath ? isAliasInstalled(profilePath, aliasName) : false,
    shell,
    profilePath
  };
}

// ============================================================================
// Combined Installation (v0.2.4)
// ============================================================================

export interface InstallAllOptions {
  /** Install hooks globally */
  hooks?: boolean;
  /** Install hooks globally (shorthand for hooks + global) */
  global?: boolean;
  /** Install hooks locally */
  local?: boolean;
  /** Install shell alias */
  alias?: boolean;
  /** Add .claude/ to .gitignore */
  gitignore?: boolean;
  /** Repository path for local installation */
  repoPath?: string;
  /** Dry run - don't write files */
  dryRun?: boolean;
}

export interface InstallAllResult {
  success: boolean;
  hooks?: InstallHooksResult;
  alias?: InstallAliasResult;
  wrapper?: InstallWrapperResult;
  errors: string[];
}

/**
 * Install all parallel-cc configuration (hooks + alias)
 * Equivalent to: parallel-cc install --hooks --global --alias
 */
export function installAll(options: InstallAllOptions = {}): InstallAllResult {
  const {
    hooks = true,
    global: installGlobal = true,
    local: installLocal = false,
    alias = true,
    gitignore = false,
    repoPath = process.cwd(),
    dryRun = false
  } = options;

  const result: InstallAllResult = {
    success: true,
    errors: []
  };

  // Install hooks
  if (hooks) {
    const hooksResult = installHooks({
      global: installGlobal,
      local: installLocal,
      repoPath,
      addToGitignore: gitignore,
      dryRun
    });
    result.hooks = hooksResult;

    if (!hooksResult.success) {
      result.success = false;
      result.errors.push(`Hooks installation failed: ${hooksResult.error}`);
    }
  }

  // Install wrapper script and alias
  if (alias) {
    const wrapperResult = installWrapperScript({ dryRun });
    result.wrapper = wrapperResult;

    if (!wrapperResult.success) {
      result.success = false;
      result.errors.push(`Wrapper script installation failed: ${wrapperResult.error}`);
    }

    const aliasResult = installAlias({ dryRun });
    result.alias = aliasResult;

    if (!aliasResult.success) {
      result.success = false;
      result.errors.push(`Alias installation failed: ${aliasResult.error}`);
    }
  }

  return result;
}

/**
 * Get combined installation status
 */
export function checkAllStatus(repoPath?: string): {
  hooks: ReturnType<typeof checkHooksStatus>;
  alias: ReturnType<typeof checkAliasStatus>;
  mcp?: ReturnType<typeof checkMcpStatus>;
} {
  return {
    hooks: checkHooksStatus({ repoPath }),
    alias: checkAliasStatus(),
    mcp: checkMcpStatus()
  };
}

// ============================================================================
// MCP Server Installation (v0.3)
// ============================================================================

export interface McpServerConfig {
  command: string;
  args: string[];
}

export interface InstallMcpResult {
  success: boolean;
  settingsPath: string;
  created: boolean;
  merged: boolean;
  alreadyInstalled: boolean;
  error?: string;
}

/**
 * Create the MCP server configuration for parallel-cc
 */
export function createMcpServerConfig(): McpServerConfig {
  return {
    command: 'parallel-cc',
    args: ['mcp-serve']
  };
}

/**
 * Check if MCP server is configured in settings
 */
export function isMcpServerInstalled(settings: ClaudeSettings | null): boolean {
  if (!settings) return false;

  // Check for mcpServers.parallel-cc
  const mcpServers = (settings as Record<string, unknown>).mcpServers as Record<string, McpServerConfig> | undefined;
  if (!mcpServers || !mcpServers['parallel-cc']) {
    return false;
  }

  // Verify it has the correct command
  const config = mcpServers['parallel-cc'];
  return config.command === 'parallel-cc' && Array.isArray(config.args);
}

/**
 * Merge MCP server config into settings
 */
export function mergeMcpServerIntoSettings(
  settings: ClaudeSettings | null,
  config: McpServerConfig
): ClaudeSettings {
  const merged = { ...(settings || {}) };

  // Ensure mcpServers exists
  const mcpServers = (merged as Record<string, unknown>).mcpServers as Record<string, McpServerConfig> || {};
  mcpServers['parallel-cc'] = config;
  (merged as Record<string, unknown>).mcpServers = mcpServers;

  return merged;
}

/**
 * Install MCP server configuration to ~/.claude.json
 * Note: MCP servers go in ~/.claude.json, NOT ~/.claude/settings.json
 */
export function installMcpServer(options: { dryRun?: boolean } = {}): InstallMcpResult {
  const settingsPath = getMcpConfigPath();

  const result: InstallMcpResult = {
    success: false,
    settingsPath,
    created: false,
    merged: false,
    alreadyInstalled: false
  };

  try {
    // Read existing settings
    const existingSettings = readSettings(settingsPath);

    // Check if already installed
    if (isMcpServerInstalled(existingSettings)) {
      result.success = true;
      result.alreadyInstalled = true;
      return result;
    }

    // Create MCP config
    const mcpConfig = createMcpServerConfig();

    // Merge into settings
    const mergedSettings = mergeMcpServerIntoSettings(existingSettings, mcpConfig);

    // Write settings (unless dry run)
    if (!options.dryRun) {
      writeSettings(settingsPath, mergedSettings);
    }

    result.success = true;
    result.created = existingSettings === null;
    result.merged = existingSettings !== null;

    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    return result;
  }
}

/**
 * Uninstall MCP server configuration from ~/.claude.json
 */
export function uninstallMcpServer(): InstallMcpResult {
  const settingsPath = getMcpConfigPath();

  const result: InstallMcpResult = {
    success: false,
    settingsPath,
    created: false,
    merged: false,
    alreadyInstalled: false
  };

  try {
    const existingSettings = readSettings(settingsPath);

    if (!existingSettings) {
      result.success = true;
      return result;
    }

    // Remove parallel-cc from mcpServers
    const mcpServers = (existingSettings as Record<string, unknown>).mcpServers as Record<string, McpServerConfig> | undefined;
    if (mcpServers && mcpServers['parallel-cc']) {
      delete mcpServers['parallel-cc'];
      if (Object.keys(mcpServers).length === 0) {
        delete (existingSettings as Record<string, unknown>).mcpServers;
      }
      writeSettings(settingsPath, existingSettings);
    }

    result.success = true;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    return result;
  }
}

/**
 * Check MCP server installation status
 */
export function checkMcpStatus(): {
  installed: boolean;
  settingsPath: string;
} {
  const settingsPath = getMcpConfigPath();
  const settings = readSettings(settingsPath);

  return {
    installed: isMcpServerInstalled(settings),
    settingsPath
  };
}

// ============================================================================
// Wrapper Script Installation
// ============================================================================

export interface InstallWrapperResult {
  success: boolean;
  wrapperPath: string;
  alreadyUpToDate: boolean;
  error?: string;
}

/**
 * Install or update the claude-parallel wrapper script
 * Copies scripts/claude-parallel.sh to ~/.local/bin/claude-parallel
 */
export function installWrapperScript(options: { dryRun?: boolean } = {}): InstallWrapperResult {
  const { dryRun = false } = options;

  const installDir = join(homedir(), '.local', 'bin');
  const wrapperTarget = join(installDir, 'claude-parallel');
  const wrapperSource = join(PACKAGE_ROOT, 'scripts', 'claude-parallel.sh');

  const result: InstallWrapperResult = {
    success: false,
    wrapperPath: wrapperTarget,
    alreadyUpToDate: false
  };

  try {
    // Check if source file exists
    if (!existsSync(wrapperSource)) {
      result.error = `Wrapper script not found: ${wrapperSource}`;
      return result;
    }

    // Ensure install directory exists
    if (!existsSync(installDir)) {
      if (!dryRun) {
        mkdirSync(installDir, { recursive: true });
      }
    }

    // Check if target is already up to date
    if (existsSync(wrapperTarget)) {
      try {
        const sourceContent = readFileSync(wrapperSource, 'utf-8');
        const targetContent = readFileSync(wrapperTarget, 'utf-8');

        if (sourceContent === targetContent) {
          result.success = true;
          result.alreadyUpToDate = true;
          return result;
        }
      } catch {
        // If we can't read/compare, just proceed with copy
      }
    }

    // Copy wrapper script
    if (!dryRun) {
      copyFileSync(wrapperSource, wrapperTarget);
      chmodSync(wrapperTarget, 0o755); // rwxr-xr-x
    }

    result.success = true;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    return result;
  }
}
