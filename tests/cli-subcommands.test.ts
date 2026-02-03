/**
 * CLI Subcommand Tests for parallel-cc v2.0.0
 *
 * Tests the CLI refactoring from hyphenated commands to subcommand structure:
 * - mcp-serve → mcp serve
 * - watch-merges → watch merges
 * - merge-status → merge status
 * - sandbox-* → sandbox *
 *
 * Also tests backward compatibility with deprecation warnings.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { execSync, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Path to built CLI
const CLI_PATH = path.join(__dirname, '..', 'dist', 'cli.js');

describe('CLI Subcommand Structure', () => {
  describe('Help Output', () => {
    it('should show subcommand groups in main help', () => {
      const result = spawnSync('node', [CLI_PATH, '--help'], { encoding: 'utf-8' });
      const helpOutput = result.stdout;

      // Should show new subcommand groups
      expect(helpOutput).toContain('mcp');
      expect(helpOutput).toContain('watch');
      expect(helpOutput).toContain('merge');
      expect(helpOutput).toContain('sandbox');
      expect(helpOutput).toContain('templates');
      expect(helpOutput).toContain('config');
      expect(helpOutput).toContain('budget');
    });

    it('should show mcp subcommand help', () => {
      const result = spawnSync('node', [CLI_PATH, 'mcp', '--help'], { encoding: 'utf-8' });
      const helpOutput = result.stdout;

      expect(helpOutput).toContain('serve');
      expect(helpOutput).toContain('MCP server');
    });

    it('should show watch subcommand help', () => {
      const result = spawnSync('node', [CLI_PATH, 'watch', '--help'], { encoding: 'utf-8' });
      const helpOutput = result.stdout;

      expect(helpOutput).toContain('merges');
      expect(helpOutput).toContain('merge detection');
    });

    it('should show merge subcommand help', () => {
      const result = spawnSync('node', [CLI_PATH, 'merge', '--help'], { encoding: 'utf-8' });
      const helpOutput = result.stdout;

      expect(helpOutput).toContain('status');
      expect(helpOutput).toContain('merge events');
    });

    it('should show sandbox subcommand help', () => {
      const result = spawnSync('node', [CLI_PATH, 'sandbox', '--help'], { encoding: 'utf-8' });
      const helpOutput = result.stdout;

      expect(helpOutput).toContain('run');
      expect(helpOutput).toContain('logs');
      expect(helpOutput).toContain('download');
      expect(helpOutput).toContain('kill');
      expect(helpOutput).toContain('list');
      expect(helpOutput).toContain('status');
    });
  });

  describe('New Subcommand Syntax', () => {
    it('should accept "mcp serve" as a valid command', () => {
      const result = spawnSync('node', [CLI_PATH, 'mcp', 'serve', '--help'], { encoding: 'utf-8' });
      // Should not error, should show help for mcp serve
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Start MCP server');
    });

    it('should accept "watch merges" as a valid command', () => {
      const result = spawnSync('node', [CLI_PATH, 'watch', 'merges', '--help'], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('merge detection');
    });

    it('should accept "merge status" as a valid command', () => {
      const result = spawnSync('node', [CLI_PATH, 'merge', 'status', '--help'], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('merge events');
    });

    it('should accept "sandbox run" as a valid command', () => {
      const result = spawnSync('node', [CLI_PATH, 'sandbox', 'run', '--help'], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('E2B sandbox');
    });

    it('should accept "sandbox logs" as a valid command', () => {
      const result = spawnSync('node', [CLI_PATH, 'sandbox', 'logs', '--help'], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('logs');
    });

    it('should accept "sandbox download" as a valid command', () => {
      const result = spawnSync('node', [CLI_PATH, 'sandbox', 'download', '--help'], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Download');
    });

    it('should accept "sandbox kill" as a valid command', () => {
      const result = spawnSync('node', [CLI_PATH, 'sandbox', 'kill', '--help'], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Terminate');
    });

    it('should accept "sandbox list" as a valid command', () => {
      const result = spawnSync('node', [CLI_PATH, 'sandbox', 'list', '--help'], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('List');
    });

    it('should accept "sandbox status" as a valid command', () => {
      const result = spawnSync('node', [CLI_PATH, 'sandbox', 'status', '--help'], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('status');
    });
  });

  describe('Backward Compatibility (Deprecated Commands)', () => {
    // Note: Deprecation warnings are shown when commands are executed, not during --help.
    // Commander.js --help flag short-circuits command execution before action handlers run.
    // These tests verify commands work and show deprecation warnings during actual execution.

    it('should show deprecation notice in help text for deprecated commands', () => {
      // Deprecated commands should have "[DEPRECATED]" in their description
      const result = spawnSync('node', [CLI_PATH, '--help'], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      // The deprecated commands should have "[DEPRECATED]" in their help text
      expect(result.stdout).toContain('[DEPRECATED]');
    });

    it('should show deprecation warning when merge-status is executed', () => {
      // merge-status --json runs quickly and shows deprecation warning
      const result = spawnSync('node', [CLI_PATH, 'merge-status', '--json'], { encoding: 'utf-8' });
      // Command may exit 0 or non-zero depending on environment, but stderr should have warning
      expect(result.stderr).toContain('deprecated');
      expect(result.stderr).toContain('merge status');
    });

    it('should show deprecation warning when watch-merges --once is executed', () => {
      // watch-merges --once --json runs a single poll and exits
      const result = spawnSync('node', [CLI_PATH, 'watch-merges', '--once', '--json'], { encoding: 'utf-8' });
      expect(result.stderr).toContain('deprecated');
      expect(result.stderr).toContain('watch merges');
    });

    it('should show deprecation warning when sandbox-list is executed', () => {
      // sandbox-list --json is a quick command that lists sessions
      const result = spawnSync('node', [CLI_PATH, 'sandbox-list', '--json'], { encoding: 'utf-8' });
      expect(result.stderr).toContain('deprecated');
      expect(result.stderr).toContain('sandbox list');
    });

    it('deprecation warning should include v3.0.0 removal notice', () => {
      const result = spawnSync('node', [CLI_PATH, 'merge-status', '--json'], { encoding: 'utf-8' });
      expect(result.stderr).toContain('v3.0.0');
    });

    it('deprecated commands should still be registered and available', () => {
      // Verify all deprecated commands are shown in help
      const result = spawnSync('node', [CLI_PATH, '--help'], { encoding: 'utf-8' });
      expect(result.stdout).toContain('mcp-serve');
      expect(result.stdout).toContain('watch-merges');
      expect(result.stdout).toContain('merge-status');
      expect(result.stdout).toContain('sandbox-run');
      expect(result.stdout).toContain('sandbox-logs');
      expect(result.stdout).toContain('sandbox-download');
      expect(result.stdout).toContain('sandbox-kill');
      expect(result.stdout).toContain('sandbox-list');
      expect(result.stdout).toContain('sandbox-status');
    });
  });

  describe('Non-hyphenated Commands (Unchanged)', () => {
    it('should keep core commands unchanged', () => {
      const coreCommands = ['register', 'release', 'status', 'cleanup', 'doctor', 'heartbeat', 'install', 'update'];

      for (const cmd of coreCommands) {
        const result = spawnSync('node', [CLI_PATH, cmd, '--help'], { encoding: 'utf-8' });
        // Should work without deprecation warning
        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain('deprecated');
      }
    });

    it('should keep templates subcommand unchanged', () => {
      const result = spawnSync('node', [CLI_PATH, 'templates', 'list', '--help'], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('deprecated');
    });

    it('should keep config subcommand unchanged', () => {
      const result = spawnSync('node', [CLI_PATH, 'config', 'list', '--help'], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('deprecated');
    });

    it('should keep budget subcommand unchanged', () => {
      const result = spawnSync('node', [CLI_PATH, 'budget', 'status', '--help'], { encoding: 'utf-8' });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('deprecated');
    });
  });

  describe('Command Option Preservation', () => {
    it('sandbox run should preserve all options', () => {
      const result = spawnSync('node', [CLI_PATH, 'sandbox', 'run', '--help'], { encoding: 'utf-8' });
      const helpText = result.stdout;

      // Check key options are preserved
      expect(helpText).toContain('--repo');
      expect(helpText).toContain('--prompt');
      expect(helpText).toContain('--prompt-file');
      expect(helpText).toContain('--template');
      expect(helpText).toContain('--auth-method');
      expect(helpText).toContain('--dry-run');
      expect(helpText).toContain('--branch');
      expect(helpText).toContain('--git-live');
      expect(helpText).toContain('--target-branch');
      expect(helpText).toContain('--git-user');
      expect(helpText).toContain('--git-email');
      expect(helpText).toContain('--ssh-key');
      expect(helpText).toContain('--npm-token');
      expect(helpText).toContain('--budget');
      expect(helpText).toContain('--json');
    });

    it('watch merges should preserve all options', () => {
      const result = spawnSync('node', [CLI_PATH, 'watch', 'merges', '--help'], { encoding: 'utf-8' });
      const helpText = result.stdout;

      expect(helpText).toContain('--interval');
      expect(helpText).toContain('--once');
      expect(helpText).toContain('--json');
    });

    it('merge status should preserve all options', () => {
      const result = spawnSync('node', [CLI_PATH, 'merge', 'status', '--help'], { encoding: 'utf-8' });
      const helpText = result.stdout;

      expect(helpText).toContain('--repo');
      expect(helpText).toContain('--branch');
      expect(helpText).toContain('--limit');
      expect(helpText).toContain('--subscriptions');
      expect(helpText).toContain('--json');
    });
  });
});

describe('Version Update', () => {
  it('should report version 2.0.0', () => {
    const result = spawnSync('node', [CLI_PATH, '--version'], { encoding: 'utf-8' });
    expect(result.stdout.trim()).toBe('2.0.0');
  });
});
