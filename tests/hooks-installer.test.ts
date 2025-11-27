/**
 * Tests for hooks-installer module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getGlobalSettingsPath,
  getLocalSettingsPath,
  createHeartbeatHook,
  readSettings,
  writeSettings,
  isHookInstalled,
  mergeHookIntoSettings,
  isInGitignore,
  addToGitignore,
  installHooks,
  uninstallHooks,
  checkHooksStatus,
  type ClaudeSettings
} from '../src/hooks-installer.js';

// Test fixtures directory
const TEST_DIR = path.join(os.tmpdir(), 'parallel-cc-test-' + process.pid);
const GLOBAL_SETTINGS_DIR = path.join(TEST_DIR, '.claude');
const GLOBAL_SETTINGS_PATH = path.join(GLOBAL_SETTINGS_DIR, 'settings.json');
const LOCAL_REPO_PATH = path.join(TEST_DIR, 'test-repo');
const LOCAL_SETTINGS_DIR = path.join(LOCAL_REPO_PATH, '.claude');
const LOCAL_SETTINGS_PATH = path.join(LOCAL_SETTINGS_DIR, 'settings.json');

describe('hooks-installer', () => {
  beforeEach(() => {
    // Create test directories
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(LOCAL_REPO_PATH, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directories
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('getGlobalSettingsPath', () => {
    it('should return path in home directory', () => {
      const settingsPath = getGlobalSettingsPath();
      expect(settingsPath).toContain('.claude');
      expect(settingsPath).toContain('settings.json');
      expect(settingsPath.startsWith(os.homedir())).toBe(true);
    });
  });

  describe('getLocalSettingsPath', () => {
    it('should return path in repo .claude directory', () => {
      const settingsPath = getLocalSettingsPath('/some/repo/path');
      expect(settingsPath).toBe('/some/repo/path/.claude/settings.json');
    });

    it('should resolve relative paths', () => {
      const settingsPath = getLocalSettingsPath('.');
      expect(path.isAbsolute(settingsPath)).toBe(true);
    });
  });

  describe('createHeartbeatHook', () => {
    it('should create hook with default path', () => {
      const hook = createHeartbeatHook();
      expect(hook.matcher).toBe('*');
      expect(hook.hooks).toHaveLength(1);
      expect(hook.hooks[0].type).toBe('command');
      expect(hook.hooks[0].command).toContain('parallel-cc-heartbeat.sh');
    });

    it('should create hook with custom path', () => {
      const hook = createHeartbeatHook('/custom/path/heartbeat.sh');
      expect(hook.hooks[0].command).toBe('/custom/path/heartbeat.sh');
    });
  });

  describe('readSettings', () => {
    it('should return null for non-existent file', () => {
      const result = readSettings('/non/existent/path/settings.json');
      expect(result).toBeNull();
    });

    it('should parse valid JSON settings', () => {
      fs.mkdirSync(GLOBAL_SETTINGS_DIR, { recursive: true });
      const settings: ClaudeSettings = {
        hooks: {
          PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo test' }] }]
        },
        otherSetting: 'value'
      };
      fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(settings));

      const result = readSettings(GLOBAL_SETTINGS_PATH);
      expect(result).toEqual(settings);
    });

    it('should throw error for invalid JSON', () => {
      fs.mkdirSync(GLOBAL_SETTINGS_DIR, { recursive: true });
      fs.writeFileSync(GLOBAL_SETTINGS_PATH, 'not valid json {{{');

      expect(() => readSettings(GLOBAL_SETTINGS_PATH)).toThrow();
    });
  });

  describe('writeSettings', () => {
    it('should create directory and file', () => {
      const settings: ClaudeSettings = { hooks: {} };
      writeSettings(GLOBAL_SETTINGS_PATH, settings);

      expect(fs.existsSync(GLOBAL_SETTINGS_PATH)).toBe(true);
      const content = fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf-8');
      expect(JSON.parse(content)).toEqual(settings);
    });

    it('should overwrite existing file', () => {
      fs.mkdirSync(GLOBAL_SETTINGS_DIR, { recursive: true });
      fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ old: 'data' }));

      const newSettings: ClaudeSettings = { hooks: { PostToolUse: [] } };
      writeSettings(GLOBAL_SETTINGS_PATH, newSettings);

      const content = fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf-8');
      expect(JSON.parse(content)).toEqual(newSettings);
    });
  });

  describe('isHookInstalled', () => {
    it('should return false for null settings', () => {
      expect(isHookInstalled(null)).toBe(false);
    });

    it('should return false for empty settings', () => {
      expect(isHookInstalled({})).toBe(false);
    });

    it('should return false for settings without PostToolUse', () => {
      const settings: ClaudeSettings = {
        hooks: {
          PreToolUse: []
        }
      };
      expect(isHookInstalled(settings)).toBe(false);
    });

    it('should return false for settings without parallel-cc hook', () => {
      const settings: ClaudeSettings = {
        hooks: {
          PostToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: 'echo other' }] }
          ]
        }
      };
      expect(isHookInstalled(settings)).toBe(false);
    });

    it('should return true when parallel-cc hook is installed', () => {
      const settings: ClaudeSettings = {
        hooks: {
          PostToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: '~/.local/bin/parallel-cc-heartbeat.sh' }] }
          ]
        }
      };
      expect(isHookInstalled(settings)).toBe(true);
    });

    it('should return true when parallel-cc appears anywhere in command', () => {
      const settings: ClaudeSettings = {
        hooks: {
          PostToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: '/custom/parallel-cc/heartbeat.sh' }] }
          ]
        }
      };
      expect(isHookInstalled(settings)).toBe(true);
    });
  });

  describe('mergeHookIntoSettings', () => {
    it('should create settings with hook from null', () => {
      const result = mergeHookIntoSettings(null);
      expect(result.hooks?.PostToolUse).toHaveLength(1);
      expect(result.hooks?.PostToolUse?.[0].matcher).toBe('*');
    });

    it('should create settings with hook from empty object', () => {
      const result = mergeHookIntoSettings({});
      expect(result.hooks?.PostToolUse).toHaveLength(1);
    });

    it('should preserve existing hooks when adding', () => {
      const existing: ClaudeSettings = {
        hooks: {
          PostToolUse: [
            { matcher: '*.ts', hooks: [{ type: 'command', command: 'echo typescript' }] }
          ],
          PreToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: 'echo pre' }] }
          ]
        },
        someOtherKey: 'preserved'
      };

      const result = mergeHookIntoSettings(existing);

      // Should have 2 PostToolUse hooks now
      expect(result.hooks?.PostToolUse).toHaveLength(2);
      // Should preserve PreToolUse
      expect(result.hooks?.PreToolUse).toHaveLength(1);
      // Should preserve other settings
      expect(result.someOtherKey).toBe('preserved');
    });

    it('should update existing parallel-cc hook', () => {
      const existing: ClaudeSettings = {
        hooks: {
          PostToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: '/old/path/parallel-cc-heartbeat.sh' }] }
          ]
        }
      };

      const result = mergeHookIntoSettings(existing, '/new/path/parallel-cc-heartbeat.sh');

      // Should still have only 1 PostToolUse hook
      expect(result.hooks?.PostToolUse).toHaveLength(1);
      // Should have new path
      expect(result.hooks?.PostToolUse?.[0].hooks[0].command).toBe('/new/path/parallel-cc-heartbeat.sh');
    });
  });

  describe('isInGitignore', () => {
    it('should return false for non-existent gitignore', () => {
      expect(isInGitignore(LOCAL_REPO_PATH)).toBe(false);
    });

    it('should return false when .claude not in gitignore', () => {
      const gitignorePath = path.join(LOCAL_REPO_PATH, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/\n.env\n');

      expect(isInGitignore(LOCAL_REPO_PATH)).toBe(false);
    });

    it('should return true when .claude/ is in gitignore', () => {
      const gitignorePath = path.join(LOCAL_REPO_PATH, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/\n.claude/\n.env\n');

      expect(isInGitignore(LOCAL_REPO_PATH)).toBe(true);
    });

    it('should return true when .claude (no slash) is in gitignore', () => {
      const gitignorePath = path.join(LOCAL_REPO_PATH, '.gitignore');
      fs.writeFileSync(gitignorePath, '.claude\n');

      expect(isInGitignore(LOCAL_REPO_PATH)).toBe(true);
    });

    it('should return true when /.claude/ is in gitignore', () => {
      const gitignorePath = path.join(LOCAL_REPO_PATH, '.gitignore');
      fs.writeFileSync(gitignorePath, '/.claude/\n');

      expect(isInGitignore(LOCAL_REPO_PATH)).toBe(true);
    });
  });

  describe('addToGitignore', () => {
    it('should create gitignore with .claude/', () => {
      const result = addToGitignore(LOCAL_REPO_PATH);

      expect(result).toBe(true);
      const gitignorePath = path.join(LOCAL_REPO_PATH, '.gitignore');
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('.claude/');
    });

    it('should append to existing gitignore', () => {
      const gitignorePath = path.join(LOCAL_REPO_PATH, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/');

      const result = addToGitignore(LOCAL_REPO_PATH);

      expect(result).toBe(true);
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('node_modules/');
      expect(content).toContain('.claude/');
    });

    it('should return false if already in gitignore', () => {
      const gitignorePath = path.join(LOCAL_REPO_PATH, '.gitignore');
      fs.writeFileSync(gitignorePath, '.claude/\n');

      const result = addToGitignore(LOCAL_REPO_PATH);

      expect(result).toBe(false);
    });

    it('should add newline before entry if file does not end with newline', () => {
      const gitignorePath = path.join(LOCAL_REPO_PATH, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/'); // No trailing newline

      addToGitignore(LOCAL_REPO_PATH);

      const content = fs.readFileSync(gitignorePath, 'utf-8');
      // Should have newline between original content and new entry
      expect(content.startsWith('node_modules/')).toBe(true);
      expect(content).toContain('\n');
      expect(content).toContain('.claude/');
    });
  });

  describe('installHooks', () => {
    it('should return correct path structure for global settings', () => {
      // We can't easily mock homedir, so just verify the path structure
      const result = installHooks({ global: true, dryRun: true });

      expect(result.success).toBe(true);
      expect(result.settingsPath).toContain('.claude');
      expect(result.settingsPath).toContain('settings.json');
      expect(result.settingsPath.startsWith(os.homedir())).toBe(true);
    });

    it('should install hooks to local settings', () => {
      const result = installHooks({
        local: true,
        repoPath: LOCAL_REPO_PATH
      });

      expect(result.success).toBe(true);
      expect(result.created).toBe(true);
      expect(result.settingsPath).toBe(LOCAL_SETTINGS_PATH);

      const settings = readSettings(LOCAL_SETTINGS_PATH);
      expect(isHookInstalled(settings)).toBe(true);
    });

    it('should merge with existing settings', () => {
      // Create existing settings
      fs.mkdirSync(LOCAL_SETTINGS_DIR, { recursive: true });
      const existingSettings: ClaudeSettings = {
        hooks: {
          PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo pre' }] }]
        },
        customSetting: 'value'
      };
      fs.writeFileSync(LOCAL_SETTINGS_PATH, JSON.stringify(existingSettings));

      const result = installHooks({
        local: true,
        repoPath: LOCAL_REPO_PATH
      });

      expect(result.success).toBe(true);
      expect(result.merged).toBe(true);
      expect(result.created).toBe(false);

      const settings = readSettings(LOCAL_SETTINGS_PATH);
      expect(settings?.customSetting).toBe('value');
      expect(settings?.hooks?.PreToolUse).toHaveLength(1);
      expect(isHookInstalled(settings)).toBe(true);
    });

    it('should report already installed', () => {
      // Create settings with hook already installed
      fs.mkdirSync(LOCAL_SETTINGS_DIR, { recursive: true });
      const existingSettings: ClaudeSettings = {
        hooks: {
          PostToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: '~/.local/bin/parallel-cc-heartbeat.sh' }] }
          ]
        }
      };
      fs.writeFileSync(LOCAL_SETTINGS_PATH, JSON.stringify(existingSettings));

      const result = installHooks({
        local: true,
        repoPath: LOCAL_REPO_PATH
      });

      expect(result.success).toBe(true);
      expect(result.alreadyInstalled).toBe(true);
    });

    it('should add to gitignore when requested', () => {
      const result = installHooks({
        local: true,
        repoPath: LOCAL_REPO_PATH,
        addToGitignore: true
      });

      expect(result.success).toBe(true);
      expect(result.gitignoreUpdated).toBe(true);
      expect(isInGitignore(LOCAL_REPO_PATH)).toBe(true);
    });

    it('should not modify files in dry run mode', () => {
      const result = installHooks({
        local: true,
        repoPath: LOCAL_REPO_PATH,
        dryRun: true
      });

      expect(result.success).toBe(true);
      expect(result.created).toBe(true);
      expect(fs.existsSync(LOCAL_SETTINGS_PATH)).toBe(false);
    });
  });

  describe('uninstallHooks', () => {
    it('should remove parallel-cc hooks', () => {
      // First install
      fs.mkdirSync(LOCAL_SETTINGS_DIR, { recursive: true });
      const settings: ClaudeSettings = {
        hooks: {
          PostToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: '~/.local/bin/parallel-cc-heartbeat.sh' }] },
            { matcher: '*.ts', hooks: [{ type: 'command', command: 'echo other' }] }
          ]
        }
      };
      fs.writeFileSync(LOCAL_SETTINGS_PATH, JSON.stringify(settings));

      const result = uninstallHooks({
        local: true,
        repoPath: LOCAL_REPO_PATH
      });

      expect(result.success).toBe(true);

      const newSettings = readSettings(LOCAL_SETTINGS_PATH);
      expect(isHookInstalled(newSettings)).toBe(false);
      // Should preserve other hooks
      expect(newSettings?.hooks?.PostToolUse).toHaveLength(1);
    });

    it('should clean up empty hooks object', () => {
      fs.mkdirSync(LOCAL_SETTINGS_DIR, { recursive: true });
      const settings: ClaudeSettings = {
        hooks: {
          PostToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: '~/.local/bin/parallel-cc-heartbeat.sh' }] }
          ]
        },
        otherSetting: 'preserved'
      };
      fs.writeFileSync(LOCAL_SETTINGS_PATH, JSON.stringify(settings));

      uninstallHooks({
        local: true,
        repoPath: LOCAL_REPO_PATH
      });

      const newSettings = readSettings(LOCAL_SETTINGS_PATH);
      expect(newSettings?.hooks).toBeUndefined();
      expect(newSettings?.otherSetting).toBe('preserved');
    });

    it('should succeed when no hooks installed', () => {
      const result = uninstallHooks({
        local: true,
        repoPath: LOCAL_REPO_PATH
      });

      expect(result.success).toBe(true);
    });
  });

  describe('checkHooksStatus', () => {
    it('should report local not installed by default', () => {
      const status = checkHooksStatus({ repoPath: LOCAL_REPO_PATH });

      expect(status.localInstalled).toBe(false);
      expect(status.localPath).toBe(LOCAL_SETTINGS_PATH);
    });

    it('should report local installed after installation', () => {
      // Install locally
      installHooks({
        local: true,
        repoPath: LOCAL_REPO_PATH
      });

      const status = checkHooksStatus({ repoPath: LOCAL_REPO_PATH });

      expect(status.localInstalled).toBe(true);
    });

    it('should return correct paths', () => {
      const status = checkHooksStatus({ repoPath: LOCAL_REPO_PATH });

      expect(status.globalPath).toContain('.claude');
      expect(status.globalPath).toContain('settings.json');
      expect(status.localPath).toBe(LOCAL_SETTINGS_PATH);
    });
  });
});
