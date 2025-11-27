/**
 * Hook configuration installer for parallel-cc
 *
 * Manages installation of PostToolUse heartbeat hooks in Claude Code settings.
 * Supports both global (~/.claude/settings.json) and local (.claude/settings.json) installation.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';

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
