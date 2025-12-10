#!/usr/bin/env node
/**
 * parallel-cc CLI - Coordinate parallel Claude Code sessions
 */

import { program } from 'commander';
import chalk from 'chalk';
import { execSync, spawnSync } from 'child_process';
import * as readline from 'readline';
import { Coordinator } from './coordinator.js';
import { GtrWrapper } from './gtr.js';
import { MergeDetector } from './merge-detector.js';
import { SessionDB } from './db.js';
import { DEFAULT_CONFIG } from './types.js';
import {
  installHooks,
  uninstallHooks,
  checkHooksStatus,
  installAlias,
  uninstallAlias,
  checkAliasStatus,
  installAll,
  checkAllStatus,
  installMcpServer,
  uninstallMcpServer,
  checkMcpStatus,
  type InstallHooksOptions
} from './hooks-installer.js';
import { startMcpServer } from './mcp/index.js';
import { SandboxManager } from './e2b/sandbox-manager.js';
import { createTarball, uploadToSandbox, downloadChangedFiles, scanForCredentials } from './e2b/file-sync.js';
import { executeClaudeInSandbox } from './e2b/claude-runner.js';
import { logger } from './logger.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { SandboxStatus, type E2BSession, type StatusResult, type SessionInfo } from './types.js';

program
  .name('parallel-cc')
  .description('Coordinate parallel Claude Code sessions using git worktrees')
  .version('0.5.0');

/**
 * Helper to prompt user for input (for interactive mode)
 */
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

/**
 * Register a new session
 */
program
  .command('register')
  .description('Register a Claude Code session (called by SessionStart hook)')
  .requiredOption('--repo <path>', 'Repository path')
  .requiredOption('--pid <number>', 'Process ID', parseInt)
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const coordinator = new Coordinator();
    try {
      const result = await coordinator.register(options.repo, options.pid);

      if (options.json) {
        console.log(JSON.stringify(result));
      } else {
        if (result.isMainRepo) {
          console.log(chalk.green('✓ Registered in main repository'));
        } else {
          console.log(chalk.blue(`✓ Created worktree: ${result.worktreeName}`));
          console.log(chalk.dim(`  Path: ${result.worktreePath}`));
        }

        if (result.parallelSessions > 1) {
          console.log(chalk.yellow(`  ⚠ ${result.parallelSessions} parallel sessions active`));
        }
      }

      // Output worktree path to stdout for hook script to capture
      // This is the key output - the hook will cd to this path
      console.log(`WORKTREE_PATH=${result.worktreePath}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: errorMessage }));
      } else {
        console.error(chalk.red(`✗ Registration failed: ${errorMessage}`));
      }
      process.exit(1);
    } finally {
      coordinator.close();
    }
  });

/**
 * Update heartbeat
 */
program
  .command('heartbeat')
  .description('Update session heartbeat (called by PostToolUse hook)')
  .requiredOption('--pid <number>', 'Process ID', parseInt)
  .action((options) => {
    const coordinator = new Coordinator();
    try {
      const success = coordinator.heartbeat(options.pid);
      if (!success) {
        // Session not found - might be first tool use, register it
        console.error(chalk.dim('Session not found for heartbeat'));
      }
    } catch (error) {
      // Silently fail for heartbeat - not critical
    } finally {
      coordinator.close();
    }
  });

/**
 * Release a session
 */
program
  .command('release')
  .description('Release a session and cleanup worktree')
  .requiredOption('--pid <number>', 'Process ID', parseInt)
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const coordinator = new Coordinator();
    try {
      const result = await coordinator.release(options.pid);

      if (options.json) {
        console.log(JSON.stringify(result));
      } else {
        if (result.released) {
          console.log(chalk.green('✓ Session released'));
          if (result.worktreeRemoved) {
            console.log(chalk.dim('  Worktree cleaned up'));
          }
        } else {
          console.log(chalk.yellow('Session not found'));
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: errorMessage }));
      } else {
        console.error(chalk.red(`✗ Release failed: ${errorMessage}`));
      }
      process.exit(1);
    } finally {
      coordinator.close();
    }
  });


/**
 * Show status
 */
program
  .command('status')
  .description('Show status of active sessions')
  .option('--repo <path>', 'Filter by repository')
  .option('--sandbox-only', 'Show only E2B sandbox sessions (v1.0)')
  .option('--json', 'Output as JSON')
  .action((options) => {
    const coordinator = new Coordinator();
    try {
      const db = coordinator['db'];

      let result: StatusResult;
      let sessions: SessionInfo[];

      if (options.sandboxOnly) {
        // Filter for E2B sessions only
        const repoPath = options.repo ? path.resolve(options.repo) : undefined;
        const e2bSessions = db.listE2BSessions(repoPath);

        // Convert E2B sessions to SessionInfo format
        sessions = e2bSessions.map(e2b => {
          const createdAt = new Date(e2b.created_at);
          const durationMs = Date.now() - createdAt.getTime();
          const durationMinutes = Math.floor(durationMs / 1000 / 60);

          return {
            sessionId: e2b.id,
            pid: e2b.pid,
            worktreePath: e2b.worktree_path,
            worktreeName: e2b.worktree_name,
            isMainRepo: e2b.is_main_repo,
            createdAt: e2b.created_at,
            lastHeartbeat: e2b.last_heartbeat,
            isAlive: coordinator['isProcessAlive'](e2b.pid),
            durationMinutes
          };
        });

        result = {
          repoPath: repoPath || 'all',
          totalSessions: sessions.length,
          sessions
        };
      } else {
        // Standard status (local sessions)
        result = coordinator.status(options.repo);
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const sessionType = options.sandboxOnly ? 'E2B Sandbox Sessions' : 'Active Sessions';
        console.log(chalk.bold(`\n${sessionType}: ${result.totalSessions}`));

        if (result.totalSessions === 0) {
          console.log(chalk.dim('  No active sessions'));
        } else {
          for (const session of result.sessions) {
            const status = session.isAlive
              ? chalk.green('●')
              : chalk.red('○');
            const location = session.isMainRepo
              ? chalk.dim('(main)')
              : chalk.blue(`(${session.worktreeName})`);

            console.log(`\n  ${status} PID ${session.pid} ${location}`);
            console.log(chalk.dim(`    Path: ${session.worktreePath}`));
            console.log(chalk.dim(`    Duration: ${session.durationMinutes}m`));
            console.log(chalk.dim(`    Last heartbeat: ${session.lastHeartbeat}`));

            // Show E2B-specific info if in sandbox-only mode
            if (options.sandboxOnly) {
              const e2bSession = db.listE2BSessions().find(s => s.id === session.sessionId);
              if (e2bSession) {
                console.log(chalk.dim(`    Sandbox: ${e2bSession.sandbox_id}`));
                console.log(chalk.dim(`    Status: ${e2bSession.status}`));
              }
            }
          }
        }
        console.log('');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: errorMessage }));
      } else {
        console.error(chalk.red(`✗ Status failed: ${errorMessage}`));
      }
      process.exit(1);
    } finally {
      coordinator.close();
    }
  });


/**
 * Cleanup stale sessions
 */
program
  .command('cleanup')
  .description('Remove stale sessions and orphaned worktrees')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const coordinator = new Coordinator();
    try {
      const result = await coordinator.cleanup();

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(chalk.bold(`\nCleanup Results:`));
        console.log(`  Sessions removed: ${result.removed}`);
        console.log(`  Worktrees removed: ${result.worktreesRemoved.length}`);

        if (result.worktreesRemoved.length > 0) {
          for (const wt of result.worktreesRemoved) {
            console.log(chalk.dim(`    - ${wt}`));
          }
        }
        console.log('');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: errorMessage }));
      } else {
        console.error(chalk.red(`✗ Cleanup failed: ${errorMessage}`));
      }
      process.exit(1);
    } finally {
      coordinator.close();
    }
  });

/**
 * Doctor - check system health
 */
program
  .command('doctor')
  .description('Check system health and dependencies')
  .action(() => {
    console.log(chalk.bold('\nSystem Health Check\n'));

    // Check gtr
    const gtrAvailable = GtrWrapper.isAvailable();
    const gtrStatus = gtrAvailable ? chalk.green('✓') : chalk.red('✗');
    console.log(`  ${gtrStatus} gtr (git-worktree-runner)`);
    if (!gtrAvailable) {
      console.log(chalk.dim('    Install: https://github.com/coderabbitai/git-worktree-runner'));
    }

    // Check git
    let gitAvailable = false;
    try {
      execSync('git --version', { stdio: 'pipe' });
      gitAvailable = true;
    } catch {}
    const gitStatus = gitAvailable ? chalk.green('✓') : chalk.red('✗');
    console.log(`  ${gitStatus} git`);

    // Check jq
    let jqAvailable = false;
    try {
      execSync('jq --version', { stdio: 'pipe' });
      jqAvailable = true;
    } catch {}
    const jqStatus = jqAvailable ? chalk.green('✓') : chalk.red('✗');
    console.log(`  ${jqStatus} jq (JSON processor)`);
    if (!jqAvailable) {
      console.log(chalk.dim('    Required by claude-parallel wrapper script'));
      console.log(chalk.dim('    Install: https://jqlang.github.io/jq/download/'));
    }

    // Check database path
    const dbPath = DEFAULT_CONFIG.dbPath.replace('~', process.env.HOME ?? '~');
    console.log(chalk.dim(`\n  Database: ${dbPath}`));

    // Show config
    console.log(chalk.dim(`  Stale threshold: ${DEFAULT_CONFIG.staleThresholdMinutes} minutes`));
    console.log(chalk.dim(`  Auto-cleanup: ${DEFAULT_CONFIG.autoCleanupWorktrees}`));
    console.log(chalk.dim(`  Worktree prefix: ${DEFAULT_CONFIG.worktreePrefix}`));

    // Check MCP configuration (informational)
    const mcpStatus = checkMcpStatus();
    if (mcpStatus.installed) {
      console.log(chalk.dim(`  MCP Server: configured`));
    } else {
      console.log(chalk.dim(`  MCP Server: not configured`));
      console.log(chalk.dim(`    Run: parallel-cc install --mcp`));
    }

    console.log('');
  });

/**
 * Install hooks and configure shell alias
 */
program
  .command('install')
  .description('Configure parallel-cc hooks, alias, MCP server, and settings')
  .option('--hooks', 'Install PostToolUse heartbeat hook for better session tracking')
  .option('--alias', 'Add claude=claude-parallel alias to shell profile')
  .option('--mcp', 'Configure MCP server in Claude Code settings (v0.3)')
  .option('--all', 'Install everything (hooks globally + alias + MCP)')
  .option('--interactive', 'Interactive mode - prompt for each option')
  .option('--global', 'Install hooks to global settings (~/.claude/settings.json)')
  .option('--local', 'Install hooks to local settings (./.claude/settings.json)')
  .option('--repo <path>', 'Repository path for local installation', process.cwd())
  .option('--gitignore', 'Add .claude/ to .gitignore (for --local)')
  .option('--uninstall', 'Remove installed hooks/alias/MCP instead of installing')
  .option('--status', 'Check current installation status')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    // Status check
    if (options.status) {
      const status = checkAllStatus(options.repo);

      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log(chalk.bold('\nInstallation Status\n'));

        // Hooks status
        console.log(chalk.bold('  Hooks:'));
        const globalStatus = status.hooks.globalInstalled
          ? chalk.green('✓ Installed')
          : chalk.dim('Not installed');
        console.log(`    Global: ${globalStatus}`);
        console.log(chalk.dim(`      Path: ${status.hooks.globalPath}`));

        const localStatus = status.hooks.localInstalled
          ? chalk.green('✓ Installed')
          : chalk.dim('Not installed');
        console.log(`    Local:  ${localStatus}`);
        console.log(chalk.dim(`      Path: ${status.hooks.localPath}`));

        // Alias status
        console.log(chalk.bold('\n  Alias:'));
        const aliasStatus = status.alias.installed
          ? chalk.green('✓ Installed')
          : chalk.dim('Not installed');
        console.log(`    Status: ${aliasStatus}`);
        console.log(chalk.dim(`    Shell:  ${status.alias.shell}`));
        if (status.alias.profilePath) {
          console.log(chalk.dim(`    Path:   ${status.alias.profilePath}`));
        }

        // MCP status (v0.3)
        console.log(chalk.bold('\n  MCP Server:'));
        const mcpStatus = status.mcp?.installed
          ? chalk.green('✓ Configured')
          : chalk.dim('Not configured');
        console.log(`    Status: ${mcpStatus}`);
        if (status.mcp?.settingsPath) {
          console.log(chalk.dim(`    Path:   ${status.mcp.settingsPath}`));
        }
        console.log('');
      }
      return;
    }

    // --all mode: install hooks globally + alias
    if (options.all) {
      console.log(chalk.bold('\nInstalling all parallel-cc configuration...\n'));

      const result = installAll({
        hooks: true,
        global: true,
        alias: true,
        dryRun: false
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        // Report hooks result
        if (result.hooks) {
          if (result.hooks.alreadyInstalled) {
            console.log(chalk.green('✓ Hooks already installed'));
          } else if (result.hooks.success) {
            console.log(chalk.green('✓ Hooks installed globally'));
          } else {
            console.log(chalk.red(`✗ Hooks failed: ${result.hooks.error}`));
          }
          console.log(chalk.dim(`  Path: ${result.hooks.settingsPath}`));
        }

        // Report alias result
        if (result.alias) {
          if (result.alias.alreadyInstalled) {
            console.log(chalk.green('✓ Alias already installed'));
          } else if (result.alias.success) {
            console.log(chalk.green('✓ Alias installed'));
            console.log(chalk.dim(`  Shell: ${result.alias.shell}`));
            console.log(chalk.dim(`  Path: ${result.alias.profilePath}`));
            console.log(chalk.yellow('\n  Restart your shell or run: source ' + result.alias.profilePath));
          } else {
            console.log(chalk.red(`✗ Alias failed: ${result.alias.error}`));
          }
        }

        // Install MCP server config (v0.3)
        const mcpResult = installMcpServer();
        if (mcpResult.alreadyInstalled) {
          console.log(chalk.green('✓ MCP server already configured'));
        } else if (mcpResult.success) {
          console.log(chalk.green('✓ MCP server configured'));
        } else {
          console.log(chalk.red(`✗ MCP server failed: ${mcpResult.error}`));
          result.success = false;
        }
        console.log(chalk.dim(`  Path: ${mcpResult.settingsPath}`));

        if (!result.success) {
          process.exit(1);
        }
      }
      return;
    }

    // --interactive mode: prompt for each option
    if (options.interactive) {
      console.log(chalk.bold('\nInteractive Installation\n'));

      // Prompt for hooks
      const hooksAnswer = await prompt('Install heartbeat hooks? [y/N]: ');
      const wantHooks = hooksAnswer === 'y' || hooksAnswer === 'yes';

      let hooksGlobal = false;
      let hooksLocal = false;
      if (wantHooks) {
        const locationAnswer = await prompt('  Install globally or locally? [global/local]: ');
        if (locationAnswer === 'global' || locationAnswer === 'g') {
          hooksGlobal = true;
        } else if (locationAnswer === 'local' || locationAnswer === 'l') {
          hooksLocal = true;
        }
      }

      // Prompt for alias
      const aliasAnswer = await prompt('Add claude=claude-parallel alias? [y/N]: ');
      const wantAlias = aliasAnswer === 'y' || aliasAnswer === 'yes';

      // Execute installations
      console.log('');

      if (wantHooks && (hooksGlobal || hooksLocal)) {
        const hooksResult = installHooks({
          global: hooksGlobal,
          local: hooksLocal,
          repoPath: options.repo
        });

        if (hooksResult.success) {
          if (hooksResult.alreadyInstalled) {
            console.log(chalk.green('✓ Hooks already installed'));
          } else {
            console.log(chalk.green('✓ Hooks installed'));
          }
          console.log(chalk.dim(`  Path: ${hooksResult.settingsPath}`));
        } else {
          console.log(chalk.red(`✗ Hooks failed: ${hooksResult.error}`));
        }
      }

      if (wantAlias) {
        const aliasResult = installAlias();

        if (aliasResult.success) {
          if (aliasResult.alreadyInstalled) {
            console.log(chalk.green('✓ Alias already installed'));
          } else {
            console.log(chalk.green('✓ Alias installed'));
            console.log(chalk.dim(`  Path: ${aliasResult.profilePath}`));
            console.log(chalk.yellow('  Restart your shell or run: source ' + aliasResult.profilePath));
          }
        } else {
          console.log(chalk.red(`✗ Alias failed: ${aliasResult.error}`));
        }
      }

      console.log('');
      return;
    }

    // Handle --alias flag
    if (options.alias) {
      if (options.uninstall) {
        const result = uninstallAlias();

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.success) {
          console.log(chalk.green('✓ Alias removed'));
          console.log(chalk.dim(`  From: ${result.profilePath}`));
        } else {
          console.error(chalk.red(`✗ Uninstall failed: ${result.error}`));
          process.exit(1);
        }
        return;
      }

      const result = installAlias();

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.success) {
        if (result.alreadyInstalled) {
          console.log(chalk.green('✓ Alias already installed'));
        } else {
          console.log(chalk.green('✓ Alias installed'));
          console.log(chalk.dim(`  Shell: ${result.shell}`));
          console.log(chalk.dim(`  Path: ${result.profilePath}`));
          console.log(chalk.yellow('\nRestart your shell or run: source ' + result.profilePath));
        }
      } else {
        console.error(chalk.red(`✗ Installation failed: ${result.error}`));
        process.exit(1);
      }
      return;
    }

    // Handle --mcp flag (v0.3)
    if (options.mcp) {
      if (options.uninstall) {
        const result = uninstallMcpServer();

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.success) {
          console.log(chalk.green('✓ MCP server configuration removed'));
          console.log(chalk.dim(`  From: ${result.settingsPath}`));
        } else {
          console.error(chalk.red(`✗ Uninstall failed: ${result.error}`));
          process.exit(1);
        }
        return;
      }

      const result = installMcpServer();

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.success) {
        if (result.alreadyInstalled) {
          console.log(chalk.green('✓ MCP server already configured'));
        } else {
          console.log(chalk.green('✓ MCP server configured'));
          console.log(chalk.dim('  Claude Code will now be able to query parallel session status'));
        }
        console.log(chalk.dim(`  Path: ${result.settingsPath}`));
      } else {
        console.error(chalk.red(`✗ Installation failed: ${result.error}`));
        process.exit(1);
      }
      return;
    }

    // Handle --hooks flag
    if (options.hooks) {
      // Uninstall mode
      if (options.uninstall) {
        const result = uninstallHooks({
          global: options.global,
          local: options.local,
          repoPath: options.repo
        });

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.success) {
          console.log(chalk.green('✓ Hooks uninstalled'));
          console.log(chalk.dim(`  From: ${result.settingsPath}`));
        } else {
          console.error(chalk.red(`✗ Uninstall failed: ${result.error}`));
          process.exit(1);
        }
        return;
      }

      // Interactive mode - prompt for global vs local
      let installGlobal = options.global;
      let installLocal = options.local;

      if (!installGlobal && !installLocal) {
        // Interactive mode
        console.log(chalk.bold('\nInstall Heartbeat Hook\n'));
        console.log('The heartbeat hook improves session tracking by updating');
        console.log('timestamps each time Claude Code uses a tool.\n');

        const answer = await prompt('Install globally or locally? [global/local/skip]: ');

        if (answer === 'global' || answer === 'g') {
          installGlobal = true;
        } else if (answer === 'local' || answer === 'l') {
          installLocal = true;
        } else if (answer === 'skip' || answer === 's' || answer === '') {
          console.log(chalk.yellow('Skipped hook installation.'));
          return;
        } else {
          console.log(chalk.yellow(`Unknown option: ${answer}. Skipping.`));
          return;
        }
      }

      // Install hooks
      const installOptions: InstallHooksOptions = {
        global: installGlobal,
        local: installLocal,
        repoPath: options.repo,
        addToGitignore: options.gitignore && installLocal
      };

      const result = installHooks(installOptions);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.success) {
        if (result.alreadyInstalled) {
          console.log(chalk.green('✓ Hooks already installed'));
        } else if (result.created) {
          console.log(chalk.green('✓ Hooks installed (created new settings file)'));
        } else {
          console.log(chalk.green('✓ Hooks installed (merged with existing settings)'));
        }
        console.log(chalk.dim(`  Path: ${result.settingsPath}`));

        if (result.gitignoreUpdated) {
          console.log(chalk.dim('  Added .claude/ to .gitignore'));
        }
      } else {
        console.error(chalk.red(`✗ Installation failed: ${result.error}`));
        process.exit(1);
      }
      return;
    }

    // No specific action specified - show help
    console.log(chalk.yellow('No action specified.'));
    console.log('');
    console.log('Examples:');
    console.log('  parallel-cc install --all             # Install hooks + alias + MCP');
    console.log('  parallel-cc install --interactive     # Prompted installation');
    console.log('  parallel-cc install --hooks           # Install hooks (interactive)');
    console.log('  parallel-cc install --hooks --global  # Install hooks globally');
    console.log('  parallel-cc install --alias           # Install shell alias');
    console.log('  parallel-cc install --mcp             # Configure MCP server');
    console.log('  parallel-cc install --status          # Check status');
    console.log('');
  });

/**
 * MCP Server - expose tools for Claude Code to query session status
 */
program
  .command('mcp-serve')
  .description('Start MCP server for Claude Code integration - exposes v0.5 tools for file claims, conflict detection, and auto-fix (stdio transport)')
  .action(async () => {
    try {
      await startMcpServer();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`MCP server failed: ${errorMessage}`);
      process.exit(1);
    }
  });

/**
 * Watch for merged branches (v0.4)
 * Starts a background daemon that polls for merged branches and sends notifications
 */
program
  .command('watch-merges')
  .description('Start merge detection daemon to monitor for merged branches (v0.4)')
  .option('--interval <seconds>', 'Poll interval in seconds', '60')
  .option('--once', 'Run a single poll iteration and exit')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const db = new SessionDB();
    const pollInterval = parseInt(options.interval, 10);

    if (isNaN(pollInterval) || pollInterval < 5) {
      console.error(chalk.red('Poll interval must be at least 5 seconds'));
      process.exit(1);
    }

    const detector = new MergeDetector(db, {
      pollIntervalSeconds: pollInterval
    });

    try {
      if (options.once) {
        // Single poll run
        if (!options.json) {
          console.log(chalk.bold('\nRunning single merge detection poll...\n'));
        }

        const result = await detector.pollForMerges();

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Subscriptions checked: ${result.subscriptionsChecked}`);
          console.log(`New merges detected: ${result.newMerges.length}`);
          console.log(`Notifications sent: ${result.notificationsSent}`);

          if (result.newMerges.length > 0) {
            console.log(chalk.bold('\nNew Merges:'));
            for (const merge of result.newMerges) {
              console.log(`  ${chalk.green('●')} ${merge.branch_name} → ${merge.target_branch}`);
              console.log(chalk.dim(`    Repo: ${merge.repo_path}`));
              console.log(chalk.dim(`    Detected: ${merge.detected_at}`));
            }
          }

          if (result.errors.length > 0) {
            console.log(chalk.bold('\nErrors:'));
            for (const err of result.errors) {
              console.log(chalk.red(`  ✗ ${err}`));
            }
          }
          console.log('');
        }
      } else {
        // Continuous polling daemon
        console.log(chalk.bold('\nStarting merge detection daemon...\n'));
        console.log(chalk.dim(`  Poll interval: ${pollInterval} seconds`));
        console.log(chalk.dim('  Press Ctrl+C to stop\n'));

        // Handle graceful shutdown
        process.on('SIGINT', () => {
          console.log(chalk.yellow('\nStopping merge detection daemon...'));
          detector.stopPolling();
          db.close();
          process.exit(0);
        });

        process.on('SIGTERM', () => {
          detector.stopPolling();
          db.close();
          process.exit(0);
        });

        detector.startPolling();

        // Keep process alive
        await new Promise(() => {}); // Never resolves, runs until signal
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: errorMessage }));
      } else {
        console.error(chalk.red(`✗ Merge detection failed: ${errorMessage}`));
      }
      db.close();
      process.exit(1);
    }
  });

/**
 * Show merge events (v0.4)
 * Display history of detected merge events
 */
program
  .command('merge-status')
  .description('Show merge events and subscription status (v0.4)')
  .option('--repo <path>', 'Filter by repository path')
  .option('--branch <name>', 'Filter by branch name')
  .option('--limit <n>', 'Limit number of results', '20')
  .option('--subscriptions', 'Show active subscriptions instead of merge events')
  .option('--json', 'Output as JSON')
  .action((options) => {
    const db = new SessionDB();
    try {
      const limit = parseInt(options.limit, 10) || 20;

      if (options.subscriptions) {
        // Show subscriptions
        const subscriptions = db.getActiveSubscriptions();
        let filtered = subscriptions;

        if (options.repo) {
          filtered = filtered.filter(s => s.repo_path.includes(options.repo));
        }
        if (options.branch) {
          filtered = filtered.filter(s => s.branch_name.includes(options.branch));
        }

        filtered = filtered.slice(0, limit);

        if (options.json) {
          console.log(JSON.stringify({ subscriptions: filtered, total: filtered.length }, null, 2));
        } else {
          console.log(chalk.bold(`\nActive Merge Subscriptions: ${filtered.length}`));

          if (filtered.length === 0) {
            console.log(chalk.dim('  No active subscriptions'));
          } else {
            for (const sub of filtered) {
              console.log(`\n  ${chalk.blue('●')} ${sub.branch_name} → ${sub.target_branch}`);
              console.log(chalk.dim(`    Session: ${sub.session_id}`));
              console.log(chalk.dim(`    Repo: ${sub.repo_path}`));
              console.log(chalk.dim(`    Created: ${sub.created_at}`));
            }
          }
          console.log('');
        }
      } else {
        // Show merge events
        let events = options.repo
          ? db.getMergeEventsByRepo(options.repo)
          : db.getAllMergeEvents();

        if (options.branch) {
          events = events.filter(e => e.branch_name.includes(options.branch));
        }

        events = events.slice(0, limit);

        if (options.json) {
          console.log(JSON.stringify({ events, total: events.length }, null, 2));
        } else {
          console.log(chalk.bold(`\nMerge Events: ${events.length}`));

          if (events.length === 0) {
            console.log(chalk.dim('  No merge events recorded'));
            console.log(chalk.dim('  Run "parallel-cc watch-merges" to start detecting merges'));
          } else {
            for (const event of events) {
              const status = event.notification_sent
                ? chalk.green('✓')
                : chalk.yellow('○');
              console.log(`\n  ${status} ${event.branch_name} → ${event.target_branch}`);
              console.log(chalk.dim(`    Repo: ${event.repo_path}`));
              console.log(chalk.dim(`    Merged: ${event.merged_at}`));
              console.log(chalk.dim(`    Detected: ${event.detected_at}`));
              console.log(chalk.dim(`    Source commit: ${event.source_commit.substring(0, 8)}`));
            }
          }
          console.log('');
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: errorMessage }));
      } else {
        console.error(chalk.red(`✗ Failed to get merge status: ${errorMessage}`));
      }
      process.exit(1);
    } finally {
      db.close();
    }
  });

/**
 * Database migration to v0.5 (v0.5)
 * Migrate database schema to support file claims and conflict resolution
 */
program
  .command('migrate')
  .description('Run database migration to v0.5 schema (adds file_claims, conflict_resolutions, auto_fix_suggestions tables)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const coordinator = new Coordinator();
    try {
      await coordinator['db'].migrateToV05();

      if (options.json) {
        console.log(JSON.stringify({ success: true, message: 'Migration to v0.5 completed' }));
      } else {
        console.log(chalk.green('✓ Migration to v0.5 completed successfully'));
        console.log(chalk.dim('  Added tables: file_claims, conflict_resolutions, auto_fix_suggestions'));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: errorMessage }));
      } else {
        console.error(chalk.red(`✗ Migration failed: ${errorMessage}`));
      }
      process.exit(1);
    } finally {
      coordinator.close();
    }
  });

/**
 * List active file claims (v0.5)
 */
program
  .command('claims')
  .description('List active file claims - shows EXCLUSIVE/SHARED/INTENT locks on files (v0.5)')
  .option('--repo <path>', 'Filter by repository path')
  .option('--session <id>', 'Filter by session ID')
  .option('--file <path>', 'Filter by file path')
  .option('--json', 'Output as JSON')
  .action((options) => {
    const coordinator = new Coordinator();
    try {
      const claims = coordinator['db'].listClaims({
        repo_path: options.repo,
        session_id: options.session,
        file_path: options.file,
        is_active: true
      });

      if (options.json) {
        console.log(JSON.stringify({ claims, total: claims.length }, null, 2));
      } else {
        if (claims.length === 0) {
          console.log(chalk.dim('\nNo active file claims\n'));
        } else {
          console.log(chalk.bold(`\nActive File Claims: ${claims.length}\n`));

          for (const claim of claims) {
            const modeColor = claim.claim_mode === 'EXCLUSIVE'
              ? chalk.red
              : claim.claim_mode === 'SHARED'
              ? chalk.yellow
              : chalk.blue;

            console.log(`  ${modeColor('●')} ${claim.file_path}`);
            console.log(chalk.dim(`    Mode: ${claim.claim_mode}`));
            console.log(chalk.dim(`    Session: ${claim.session_id.substring(0, 8)}...`));
            console.log(chalk.dim(`    Claimed: ${claim.claimed_at}`));
            console.log(chalk.dim(`    Expires: ${claim.expires_at}`));
            if (claim.metadata) {
              console.log(chalk.dim(`    Metadata: ${JSON.stringify(claim.metadata)}`));
            }
            console.log('');
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: errorMessage }));
      } else {
        console.error(chalk.red(`✗ Failed to list claims: ${errorMessage}`));
      }
      process.exit(1);
    } finally {
      coordinator.close();
    }
  });

/**
 * View conflict resolution history (v0.5)
 */
program
  .command('conflicts')
  .description('View conflict resolution history - tracks semantic, structural, and concurrent edit conflicts (v0.5)')
  .option('--repo <path>', 'Filter by repository path')
  .option('--file <path>', 'Filter by file path')
  .option('--type <type>', 'Filter by conflict type (TRIVIAL, CONCURRENT_EDIT, STRUCTURAL, SEMANTIC)')
  .option('--resolved', 'Show only resolved conflicts')
  .option('--limit <n>', 'Limit number of results', '20')
  .option('--json', 'Output as JSON')
  .action((options) => {
    const coordinator = new Coordinator();
    try {
      const limit = parseInt(options.limit, 10) || 20;

      let resolutions = coordinator['db'].getConflictResolutions({
        repo_path: options.repo,
        file_path: options.file,
        conflict_type: options.type as any,
        is_resolved: options.resolved ? true : undefined
      });

      // Apply limit
      resolutions = resolutions.slice(0, limit);

      if (options.json) {
        console.log(JSON.stringify({ resolutions, total: resolutions.length }, null, 2));
      } else {
        if (resolutions.length === 0) {
          console.log(chalk.dim('\nNo conflict resolutions found\n'));
        } else {
          console.log(chalk.bold(`\nConflict Resolution History: ${resolutions.length}\n`));

          for (const res of resolutions) {
            const statusIcon = res.resolved_at ? chalk.green('✓') : chalk.yellow('○');

            console.log(`  ${statusIcon} ${res.file_path}`);
            console.log(chalk.dim(`    Type: ${res.conflict_type}`));
            console.log(chalk.dim(`    Strategy: ${res.resolution_strategy}`));
            if (res.confidence_score !== undefined && res.confidence_score !== null) {
              const confidencePercent = (res.confidence_score * 100).toFixed(1);
              console.log(chalk.dim(`    Confidence: ${confidencePercent}%`));
            }
            console.log(chalk.dim(`    Detected: ${res.detected_at}`));
            if (res.resolved_at) {
              console.log(chalk.dim(`    Resolved: ${res.resolved_at}`));
            }
            if (res.auto_fix_suggestion_id) {
              console.log(chalk.dim(`    Auto-fix: ${res.auto_fix_suggestion_id.substring(0, 8)}...`));
            }
            console.log('');
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: errorMessage }));
      } else {
        console.error(chalk.red(`✗ Failed to get conflict resolutions: ${errorMessage}`));
      }
      process.exit(1);
    } finally {
      coordinator.close();
    }
  });

/**
 * List auto-fix suggestions (v0.5)
 */
program
  .command('suggestions')
  .description('List AI-generated auto-fix suggestions for detected conflicts with confidence scores (v0.5)')
  .option('--repo <path>', 'Filter by repository path')
  .option('--file <path>', 'Filter by file path')
  .option('--min-confidence <n>', 'Minimum confidence score (0-1)', '0.5')
  .option('--applied', 'Show only applied suggestions')
  .option('--limit <n>', 'Limit number of results', '20')
  .option('--json', 'Output as JSON')
  .action((options) => {
    const coordinator = new Coordinator();
    try {
      const limit = parseInt(options.limit, 10) || 20;
      const minConfidence = parseFloat(options.minConfidence) || 0.5;

      let suggestions = coordinator['db'].getAutoFixSuggestions({
        repo_path: options.repo,
        file_path: options.file,
        min_confidence: minConfidence,
        is_applied: options.applied ? true : undefined
      });

      // Apply limit
      suggestions = suggestions.slice(0, limit);

      if (options.json) {
        console.log(JSON.stringify({ suggestions, total: suggestions.length }, null, 2));
      } else {
        if (suggestions.length === 0) {
          console.log(chalk.dim('\nNo auto-fix suggestions found\n'));
        } else {
          console.log(chalk.bold(`\nAuto-Fix Suggestions: ${suggestions.length}\n`));

          for (const sug of suggestions) {
            const statusIcon = sug.was_auto_applied ? chalk.green('✓') : chalk.blue('○');
            const confidencePercent = (sug.confidence_score * 100).toFixed(1);

            console.log(`  ${statusIcon} ${sug.file_path}`);
            console.log(chalk.dim(`    Strategy: ${sug.strategy_used}`));
            console.log(chalk.dim(`    Confidence: ${confidencePercent}%`));
            console.log(chalk.dim(`    Type: ${sug.conflict_type}`));
            console.log(chalk.dim(`    Generated: ${sug.generated_at}`));
            if (sug.applied_at) {
              console.log(chalk.dim(`    Applied: ${sug.applied_at}`));
            }
            console.log(chalk.dim(`    Explanation: ${sug.explanation}`));
            console.log('');
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: errorMessage }));
      } else {
        console.error(chalk.red(`✗ Failed to get auto-fix suggestions: ${errorMessage}`));
      }
      process.exit(1);
    } finally {
      coordinator.close();
    }
  });

// ============================================================================
// E2B Sandbox Commands (v1.0)
// ============================================================================

/**
 * Execute autonomous task in E2B sandbox
 */
program
  .command('sandbox-run')
  .description('Execute autonomous task in E2B sandbox with full worktree isolation (v1.0)')
  .requiredOption('--repo <path>', 'Repository path')
  .option('--prompt <text>', 'Prompt text to execute')
  .option('--prompt-file <path>', 'Path to prompt file (e.g., PLAN.md, .apm/Implementation_Plan.md)')
  .option('--dry-run', 'Test upload without execution (useful for verifying workspace)')
  .option('--no-commit', 'Skip auto-commit of results to worktree')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const coordinator = new Coordinator();
    const sandboxManager = new SandboxManager(logger);
    let sandboxId: string | null = null;

    try {
      // Validate inputs
      if (!options.prompt && !options.promptFile) {
        console.error(chalk.red('✗ Error: Either --prompt or --prompt-file is required'));
        process.exit(1);
      }

      if (options.prompt && options.promptFile) {
        console.error(chalk.red('✗ Error: Cannot use both --prompt and --prompt-file'));
        process.exit(1);
      }

      // Read prompt
      let prompt: string;
      if (options.promptFile) {
        try {
          prompt = await fs.readFile(options.promptFile, 'utf-8');
          if (!options.json) {
            console.log(chalk.dim(`Reading prompt from: ${options.promptFile}`));
          }
        } catch (error) {
          console.error(chalk.red(`✗ Failed to read prompt file: ${error instanceof Error ? error.message : 'Unknown error'}`));
          process.exit(1);
        }
      } else {
        prompt = options.prompt;
      }

      // Normalize repo path
      const repoPath = path.resolve(options.repo);

      if (!options.json) {
        console.log(chalk.bold('\n🚀 Starting E2B Sandbox Execution\n'));
        console.log(chalk.dim(`Repository: ${repoPath}`));
        console.log(chalk.dim(`Prompt length: ${prompt.length} characters`));
        if (options.dryRun) {
          console.log(chalk.yellow('Mode: DRY RUN (upload only, no execution)\n'));
        }
      }

      // Step 1: Check for parallel sessions and create worktree if needed
      if (!options.json) {
        console.log(chalk.blue('Step 1/6: Setting up isolated worktree...'));
      }

      const sessionId = randomUUID();
      const pid = process.pid;

      const registerResult = await coordinator.register(repoPath, pid);
      const worktreePath = registerResult.worktreePath;

      if (!options.json) {
        if (registerResult.isMainRepo) {
          console.log(chalk.green('✓ Using main repository (no parallel sessions)'));
        } else {
          console.log(chalk.green(`✓ Created worktree: ${registerResult.worktreeName}`));
          console.log(chalk.dim(`  Path: ${worktreePath}`));
        }
      }

      // Step 2: Scan for credentials
      if (!options.json) {
        console.log(chalk.blue('\nStep 2/6: Scanning for credentials...'));
      }

      const credScan = await scanForCredentials(worktreePath);
      if (credScan.hasSuspiciousFiles) {
        if (!options.json) {
          console.log(chalk.yellow(`⚠ Warning: Found ${credScan.suspiciousFiles.length} files with potential credentials:`));
          for (const file of credScan.suspiciousFiles.slice(0, 5)) {
            console.log(chalk.yellow(`    - ${file}`));
          }
          if (credScan.suspiciousFiles.length > 5) {
            console.log(chalk.yellow(`    ... and ${credScan.suspiciousFiles.length - 5} more`));
          }
          console.log(chalk.dim(`  ${credScan.recommendation}`));
        }
      } else {
        if (!options.json) {
          console.log(chalk.green('✓ No suspicious files detected'));
        }
      }

      // Step 3: Create tarball
      if (!options.json) {
        console.log(chalk.blue('\nStep 3/6: Creating workspace tarball...'));
      }

      const tarballResult = await createTarball(worktreePath);

      if (!options.json) {
        console.log(chalk.green(`✓ Tarball created: ${(tarballResult.sizeBytes / 1024 / 1024).toFixed(2)} MB`));
        console.log(chalk.dim(`  Files: ${tarballResult.fileCount}`));
        console.log(chalk.dim(`  Duration: ${(tarballResult.duration / 1000).toFixed(1)}s`));
      }

      // Wrap tarball usage in try/finally for guaranteed cleanup
      try {
        // Step 4: Create sandbox and upload
        if (!options.json) {
          console.log(chalk.blue('\nStep 4/6: Creating E2B sandbox...'));
        }

        const { sandbox, sandboxId: createdSandboxId, status } = await sandboxManager.createSandbox(sessionId);
        sandboxId = createdSandboxId; // Track for cleanup in catch block

      if (!options.json) {
        console.log(chalk.green(`✓ Sandbox created: ${sandboxId}`));
        console.log(chalk.dim('  Uploading workspace...'));
      }

      const uploadResult = await uploadToSandbox(tarballResult.path, sandbox, '/workspace');

      if (!uploadResult.success) {
        console.error(chalk.red(`✗ Upload failed: ${uploadResult.error}`));
        await sandboxManager.terminateSandbox(sandboxId);
        process.exit(1);
      }

      if (!options.json) {
        console.log(chalk.green(`✓ Workspace uploaded: ${(uploadResult.sizeBytes / 1024 / 1024).toFixed(2)} MB`));
        console.log(chalk.dim(`  Duration: ${(uploadResult.duration / 1000).toFixed(1)}s`));
      }

        // Create E2B session in database
      const db = coordinator['db'];
      db.createE2BSession({
        id: sessionId,
        pid,
        repo_path: repoPath,
        worktree_path: worktreePath,
        worktree_name: registerResult.worktreeName,
        sandbox_id: sandboxId,
        prompt,
        status: SandboxStatus.RUNNING
      });

      // Step 5: Execute (unless dry-run)
      if (options.dryRun) {
        if (!options.json) {
          console.log(chalk.yellow('\n✓ DRY RUN complete - skipping execution'));
          console.log(chalk.dim('  Sandbox will remain active for inspection'));
          console.log(chalk.dim(`  Use: parallel-cc sandbox-kill --session-id ${sessionId}`));
        }

        if (options.json) {
          console.log(JSON.stringify({
            success: true,
            sessionId,
            sandboxId,
            worktreePath,
            dryRun: true
          }, null, 2));
        }

        return;
      }

      if (!options.json) {
        console.log(chalk.blue('\nStep 5/6: Executing Claude Code...'));
        console.log(chalk.dim('  This may take up to 60 minutes'));
        console.log(chalk.dim('  Output is streaming in real-time\n'));
      }

      const executionResult = await executeClaudeInSandbox(
        sandbox,
        sandboxManager,
        prompt,
        logger,
        {
          workingDir: '/workspace',
          timeout: 60,
          streamOutput: true,
          captureFullLog: true,
          onProgress: (chunk) => {
            if (!options.json) {
              process.stdout.write(chunk);
            }
          }
        }
      );

      // Update session status
      db.updateE2BSessionStatus(
        sandboxId,
        executionResult.success ? SandboxStatus.COMPLETED : SandboxStatus.FAILED,
        executionResult.output
      );

      if (!executionResult.success) {
        console.error(chalk.red(`\n✗ Execution failed: ${executionResult.error}`));
        await sandboxManager.terminateSandbox(sandboxId);
        process.exit(1);
      }

      if (!options.json) {
        console.log(chalk.green(`\n✓ Execution completed: ${(executionResult.executionTime / 1000 / 60).toFixed(1)} minutes`));
      }

      // Step 6: Download results
      if (!options.json) {
        console.log(chalk.blue('\nStep 6/6: Downloading results...'));
      }

      const downloadResult = await downloadChangedFiles(sandbox, '/workspace', worktreePath);

      if (!downloadResult.success) {
        console.error(chalk.red(`✗ Download failed: ${downloadResult.error}`));
        await sandboxManager.terminateSandbox(sandboxId);
        process.exit(1);
      }

      if (!options.json) {
        console.log(chalk.green(`✓ Results downloaded: ${downloadResult.filesDownloaded} files`));
        console.log(chalk.dim(`  Size: ${(downloadResult.sizeBytes / 1024 / 1024).toFixed(2)} MB`));
      }

      // Commit changes if requested
      if (options.commit !== false) {
        if (!options.json) {
          console.log(chalk.blue('\nCommitting changes to worktree...'));
        }

        try {
          const commitMsg = `E2B sandbox execution: ${sessionId}\n\nPrompt: ${prompt.substring(0, 500)}${prompt.length > 500 ? '...' : ''}\nSandbox: ${sandboxId}\nExecution time: ${(executionResult.executionTime / 1000 / 60).toFixed(1)} minutes`;

          // Git add and commit
          execSync('git add -A', { cwd: worktreePath, stdio: 'pipe' });

          // Use spawnSync with argument array to prevent shell injection
          // (safer than execSync with string interpolation)
          const commitResult = spawnSync('git', ['commit', '-m', commitMsg], {
            cwd: worktreePath,
            stdio: 'pipe'
          });

          if (commitResult.status !== 0) {
            throw new Error(`Git commit failed: ${commitResult.stderr?.toString() || 'Unknown error'}`);
          }

          if (!options.json) {
            console.log(chalk.green('✓ Changes committed to worktree'));
          }
        } catch (error) {
          if (!options.json) {
            console.log(chalk.yellow('⚠ No changes to commit or commit failed'));
          }
        }
      }

      // Cleanup sandbox
      await sandboxManager.terminateSandbox(sandboxId);
      db.cleanupE2BSession(sandboxId, SandboxStatus.COMPLETED);

      // Release session
      await coordinator.release(pid);

      if (!options.json) {
        console.log(chalk.bold.green('\n✅ Sandbox execution complete!\n'));
        console.log(chalk.dim(`Session ID: ${sessionId}`));
        console.log(chalk.dim(`Worktree: ${worktreePath}`));
      } else {
        console.log(JSON.stringify({
          success: true,
          sessionId,
          sandboxId,
          worktreePath,
          executionTime: executionResult.executionTime,
          filesDownloaded: downloadResult.filesDownloaded,
          exitCode: executionResult.exitCode
        }, null, 2));
      }

      } finally {
        // Best-effort cleanup of tarball
        try {
          const tarballExists = await fs.access(tarballResult.path).then(() => true).catch(() => false);
          if (tarballExists) {
            await fs.unlink(tarballResult.path);
          }
        } catch (cleanupError) {
          // Log but don't throw - don't mask original errors
          logger.warn(`Failed to cleanup tarball: ${cleanupError instanceof Error ? cleanupError.message : 'Unknown error'}`);
        }
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Best-effort sandbox cleanup on error
      if (sandboxId) {
        try {
          await sandboxManager.terminateSandbox(sandboxId);
        } catch (cleanupError) {
          // Log but don't throw - don't mask original error
          logger.error(`Failed to cleanup sandbox during error handling: ${cleanupError instanceof Error ? cleanupError.message : 'Unknown error'}`);
        }
      }
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: errorMessage }));
      } else {
        console.error(chalk.red(`\n✗ Sandbox execution failed: ${errorMessage}`));
      }
      process.exit(1);
    } finally {
      coordinator.close();
    }
  });

/**
 * View sandbox session logs
 */
program
  .command('sandbox-logs')
  .description('View E2B sandbox execution logs (v1.0)')
  .requiredOption('--session-id <id>', 'Session ID')
  .option('--follow', 'Follow log output in real-time (like tail -f)')
  .option('--lines <n>', 'Number of lines to show', '100')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const coordinator = new Coordinator();
    try {
      const db = coordinator['db'];
      const sessionId = options.sessionId;

      // Get E2B session by ID
      const sessions = db.listE2BSessions();
      const session = sessions.find(s => s.id === sessionId);

      if (!session) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: 'Session not found' }));
        } else {
          console.error(chalk.red(`✗ Session not found: ${sessionId}`));
        }
        process.exit(1);
      }

      if (!options.json) {
        console.log(chalk.bold(`\nSandbox Logs: ${sessionId}\n`));
        console.log(chalk.dim(`Sandbox ID: ${session.sandbox_id}`));
        console.log(chalk.dim(`Status: ${session.status}`));
        console.log(chalk.dim(`Created: ${session.created_at}\n`));
      }

      // Get output log from database
      const outputLog = session.output_log || '';

      if (options.follow && session.status === SandboxStatus.RUNNING) {
        if (!options.json) {
          console.log(chalk.yellow('⚠ Follow mode not yet implemented for live sessions'));
          console.log(chalk.dim('Showing buffered output:\n'));
        }
      }

      if (options.json) {
        console.log(JSON.stringify({
          success: true,
          sessionId,
          sandboxId: session.sandbox_id,
          status: session.status,
          output: outputLog,
          lineCount: outputLog.split('\n').length
        }, null, 2));
      } else {
        // Show last N lines
        const lines = outputLog.split('\n');
        const limitLines = parseInt(options.lines, 10) || 100;
        const displayLines = lines.slice(-limitLines);

        console.log(displayLines.join('\n'));
        console.log(chalk.dim(`\n(Showing last ${displayLines.length} of ${lines.length} lines)`));
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: errorMessage }));
      } else {
        console.error(chalk.red(`✗ Failed to get logs: ${errorMessage}`));
      }
      process.exit(1);
    } finally {
      coordinator.close();
    }
  });

/**
 * Download sandbox results
 */
program
  .command('sandbox-download')
  .description('Download results from E2B sandbox to local directory (v1.0)')
  .requiredOption('--session-id <id>', 'Session ID')
  .requiredOption('--output <path>', 'Output directory for downloaded files')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const coordinator = new Coordinator();
    const sandboxManager = new SandboxManager(logger);

    try {
      const db = coordinator['db'];
      const sessionId = options.sessionId;

      // Get E2B session
      const sessions = db.listE2BSessions();
      const session = sessions.find(s => s.id === sessionId);

      if (!session) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: 'Session not found' }));
        } else {
          console.error(chalk.red(`✗ Session not found: ${sessionId}`));
        }
        process.exit(1);
      }

      if (!options.json) {
        console.log(chalk.bold(`\nDownloading Sandbox Results\n`));
        console.log(chalk.dim(`Sandbox ID: ${session.sandbox_id}`));
        console.log(chalk.dim(`Output directory: ${options.output}`));
      }

      // Check if sandbox is still running
      const healthCheck = await sandboxManager.monitorSandboxHealth(session.sandbox_id);
      if (!healthCheck.isHealthy) {
        console.error(chalk.red(`✗ Sandbox not accessible: ${healthCheck.error}`));
        process.exit(1);
      }

      // Get sandbox instance (reconnect)
      const sandbox = sandboxManager['activeSandboxes'].get(session.sandbox_id);
      if (!sandbox) {
        console.error(chalk.red('✗ Sandbox instance not found (may have been terminated)'));
        process.exit(1);
      }

      // Create output directory
      await fs.mkdir(options.output, { recursive: true });

      // Download files
      const downloadResult = await downloadChangedFiles(sandbox, '/workspace', options.output);

      if (!downloadResult.success) {
        console.error(chalk.red(`✗ Download failed: ${downloadResult.error}`));
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify({
          success: true,
          sessionId,
          sandboxId: session.sandbox_id,
          outputPath: options.output,
          filesDownloaded: downloadResult.filesDownloaded,
          sizeBytes: downloadResult.sizeBytes
        }, null, 2));
      } else {
        console.log(chalk.green(`\n✓ Downloaded ${downloadResult.filesDownloaded} files`));
        console.log(chalk.dim(`  Size: ${(downloadResult.sizeBytes / 1024 / 1024).toFixed(2)} MB`));
        console.log(chalk.dim(`  Duration: ${(downloadResult.duration / 1000).toFixed(1)}s`));
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: errorMessage }));
      } else {
        console.error(chalk.red(`✗ Download failed: ${errorMessage}`));
      }
      process.exit(1);
    } finally {
      coordinator.close();
    }
  });

/**
 * Terminate sandbox
 */
program
  .command('sandbox-kill')
  .description('Terminate E2B sandbox and cleanup resources (v1.0)')
  .requiredOption('--session-id <id>', 'Session ID')
  .option('--force', 'Force termination even if sandbox is busy')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const coordinator = new Coordinator();
    const sandboxManager = new SandboxManager(logger);

    try {
      const db = coordinator['db'];
      const sessionId = options.sessionId;

      // Get E2B session
      const sessions = db.listE2BSessions();
      const session = sessions.find(s => s.id === sessionId);

      if (!session) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: 'Session not found' }));
        } else {
          console.error(chalk.red(`✗ Session not found: ${sessionId}`));
        }
        process.exit(1);
      }

      if (!options.json) {
        console.log(chalk.bold(`\nTerminating Sandbox: ${session.sandbox_id}\n`));
        if (options.force) {
          console.log(chalk.yellow('⚠ Force mode enabled'));
        }
      }

      // Terminate sandbox
      // Note: Force mode is not implemented in SandboxManager.terminateSandbox yet
      const termResult = await sandboxManager.terminateSandbox(session.sandbox_id);

      if (!termResult.success) {
        console.error(chalk.red(`✗ Termination failed: ${termResult.error}`));
        process.exit(1);
      }

      // Cleanup database record
      db.cleanupE2BSession(session.sandbox_id, SandboxStatus.FAILED, true);

      // Release session if still active
      const localSession = db.getSessionByPid(session.pid);
      if (localSession) {
        await coordinator.release(session.pid);
      }

      if (options.json) {
        console.log(JSON.stringify({
          success: true,
          sessionId,
          sandboxId: session.sandbox_id,
          terminated: termResult.success,
          cleanedUp: termResult.cleanedUp
        }, null, 2));
      } else {
        console.log(chalk.green('\n✓ Sandbox terminated successfully'));
        console.log(chalk.dim(`  Session: ${sessionId}`));
        console.log(chalk.dim(`  Sandbox: ${session.sandbox_id}`));
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: errorMessage }));
      } else {
        console.error(chalk.red(`✗ Termination failed: ${errorMessage}`));
      }
      process.exit(1);
    } finally {
      coordinator.close();
    }
  });

/**
 * List all E2B sandbox sessions
 */
program
  .command('sandbox-list')
  .description('List all E2B sandbox sessions (v1.0)')
  .option('--repo <path>', 'Filter by repository path')
  .option('--json', 'Output as JSON')
  .action((options) => {
    const coordinator = new Coordinator();
    try {
      const db = coordinator['db'];
      const repoPath = options.repo ? path.resolve(options.repo) : undefined;

      const sessions = db.listE2BSessions(repoPath);

      if (options.json) {
        console.log(JSON.stringify({ sessions, total: sessions.length }, null, 2));
      } else {
        console.log(chalk.bold(`\nE2B Sandbox Sessions: ${sessions.length}\n`));

        if (sessions.length === 0) {
          console.log(chalk.dim('  No E2B sessions found'));
        } else {
          for (const session of sessions) {
            const statusColor =
              session.status === SandboxStatus.COMPLETED ? chalk.green :
              session.status === SandboxStatus.FAILED ? chalk.red :
              session.status === SandboxStatus.TIMEOUT ? chalk.yellow :
              chalk.blue;

            console.log(`  ${statusColor('●')} ${session.id.substring(0, 8)}...`);
            console.log(chalk.dim(`    Status: ${session.status}`));
            console.log(chalk.dim(`    Sandbox: ${session.sandbox_id}`));
            console.log(chalk.dim(`    Worktree: ${session.worktree_path}`));
            console.log(chalk.dim(`    Created: ${session.created_at}`));
            console.log(chalk.dim(`    Prompt: ${session.prompt.substring(0, 80)}${session.prompt.length > 80 ? '...' : ''}`));
            console.log('');
          }
        }
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: errorMessage }));
      } else {
        console.error(chalk.red(`✗ Failed to list sessions: ${errorMessage}`));
      }
      process.exit(1);
    } finally {
      coordinator.close();
    }
  });

/**
 * Check sandbox health status
 */
program
  .command('sandbox-status')
  .description('Check health status of E2B sandbox (v1.0)')
  .requiredOption('--session-id <id>', 'Session ID')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const coordinator = new Coordinator();
    const sandboxManager = new SandboxManager(logger);

    try {
      const db = coordinator['db'];
      const sessionId = options.sessionId;

      // Get E2B session
      const sessions = db.listE2BSessions();
      const session = sessions.find(s => s.id === sessionId);

      if (!session) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: 'Session not found' }));
        } else {
          console.error(chalk.red(`✗ Session not found: ${sessionId}`));
        }
        process.exit(1);
      }

      if (!options.json) {
        console.log(chalk.bold(`\nSandbox Status: ${session.sandbox_id}\n`));
      }

      // Check sandbox health
      const healthCheck = await sandboxManager.monitorSandboxHealth(session.sandbox_id);

      // Calculate elapsed time
      const createdAt = new Date(session.created_at);
      const elapsedMinutes = (Date.now() - createdAt.getTime()) / 1000 / 60;

      if (options.json) {
        console.log(JSON.stringify({
          success: true,
          sessionId,
          sandboxId: session.sandbox_id,
          status: session.status,
          health: {
            isHealthy: healthCheck.isHealthy,
            message: healthCheck.message,
            error: healthCheck.error
          },
          createdAt: session.created_at,
          elapsedMinutes: elapsedMinutes.toFixed(1),
          prompt: session.prompt
        }, null, 2));
      } else {
        const healthIcon = healthCheck.isHealthy ? chalk.green('✓') : chalk.red('✗');
        console.log(`  ${healthIcon} Health: ${healthCheck.isHealthy ? 'Healthy' : 'Unhealthy'}`);
        console.log(chalk.dim(`    Status: ${session.status}`));
        console.log(chalk.dim(`    Sandbox ID: ${session.sandbox_id}`));
        console.log(chalk.dim(`    Created: ${session.created_at}`));
        console.log(chalk.dim(`    Elapsed: ${elapsedMinutes.toFixed(1)} minutes`));
        console.log(chalk.dim(`    Worktree: ${session.worktree_path}`));

        if (healthCheck.message) {
          console.log(chalk.dim(`    Message: ${healthCheck.message}`));
        }
        if (healthCheck.error) {
          console.log(chalk.red(`    Error: ${healthCheck.error}`));
        }

        console.log(chalk.dim(`\n  Prompt: ${session.prompt.substring(0, 200)}${session.prompt.length > 200 ? '...' : ''}`));
        console.log('');
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: errorMessage }));
      } else {
        console.error(chalk.red(`✗ Failed to get status: ${errorMessage}`));
      }
      process.exit(1);
    } finally {
      coordinator.close();
    }
  });

// Parse and execute
program.parse();
