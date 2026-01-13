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
  installWrapperScript,
  type InstallHooksOptions
} from './hooks-installer.js';
import { startMcpServer } from './mcp/index.js';
import { SandboxManager } from './e2b/sandbox-manager.js';
import { createTarball, uploadToSandbox, downloadChangedFiles, scanForCredentials } from './e2b/file-sync.js';
import { executeClaudeInSandbox } from './e2b/claude-runner.js';
import { pushToRemoteAndCreatePR } from './e2b/git-live.js';
import { validateSSHKeyPath, injectSSHKey, cleanupSSHKey, getSecurityWarning } from './e2b/ssh-key-injector.js';
import { logger } from './logger.js';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { SandboxStatus, type E2BSession, type StatusResult, type SessionInfo } from './types.js';

program
  .name('parallel-cc')
  .description('Coordinate parallel Claude Code sessions using git worktrees')
  .version('0.5.0');

/**
 * Helper to prompt user for input (for interactive mode)
 */
function promptUser(question: string): Promise<string> {
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

    // Check database schema version
    try {
      const db = new SessionDB();
      const schemaVersion = db.getSchemaVersion();
      const hasE2B = db.hasE2BColumns();
      db.close();

      console.log(chalk.dim(`  Schema version: ${schemaVersion || 'none (pre-0.5.0)'}`));

      if (!hasE2B) {
        console.log(chalk.yellow('  ⚠ Database schema needs update for E2B sandbox features'));
        console.log(chalk.dim('    Run: parallel-cc update'));
      } else {
        console.log(chalk.green('  ✓ E2B sandbox features available'));
      }
    } catch (error) {
      console.log(chalk.dim(`  Schema version: unknown (error: ${error instanceof Error ? error.message : 'unknown'})`));
    }

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

        // Report wrapper result
        if (result.wrapper) {
          if (result.wrapper.alreadyUpToDate) {
            console.log(chalk.green('✓ Wrapper script already up to date'));
          } else if (result.wrapper.success) {
            console.log(chalk.green('✓ Wrapper script installed/updated'));
          } else {
            console.log(chalk.yellow(`⚠ Wrapper script failed: ${result.wrapper.error}`));
          }
          console.log(chalk.dim(`  Path: ${result.wrapper.wrapperPath}`));
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

        // Automatically migrate database to latest version (v1.0)
        console.log(chalk.blue('\n⚙  Updating database schema...'));
        let coordinator: Coordinator | undefined;
        try {
          coordinator = new Coordinator();
          const db = coordinator['db'];
          const migrationResult = await db.migrateToLatest();

          if (migrationResult.migrations.length === 0) {
            console.log(chalk.green('✓ Database already at latest version'));
          } else {
            console.log(chalk.green('✓ Database updated successfully'));
            console.log(chalk.dim(`  Migrations applied: v${migrationResult.migrations.join(', v')}`));
          }
          console.log(chalk.dim(`  Schema version: ${migrationResult.to}`));
        } catch (error) {
          console.log(chalk.yellow('⚠ Database migration failed'));
          console.log(chalk.dim(`  ${error instanceof Error ? error.message : 'Unknown error'}`));
          console.log(chalk.dim('  You can run migrations manually: parallel-cc update'));
        } finally {
          if (coordinator) {
            coordinator.close();
          }
        }

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
      const hooksAnswer = await promptUser('Install heartbeat hooks? [y/N]: ');
      const wantHooks = hooksAnswer === 'y' || hooksAnswer === 'yes';

      let hooksGlobal = false;
      let hooksLocal = false;
      if (wantHooks) {
        const locationAnswer = await promptUser('  Install globally or locally? [global/local]: ');
        if (locationAnswer === 'global' || locationAnswer === 'g') {
          hooksGlobal = true;
        } else if (locationAnswer === 'local' || locationAnswer === 'l') {
          hooksLocal = true;
        }
      }

      // Prompt for alias
      const aliasAnswer = await promptUser('Add claude=claude-parallel alias? [y/N]: ');
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
        const wrapperResult = installWrapperScript();
        const aliasResult = installAlias();

        if (wrapperResult.success) {
          if (wrapperResult.alreadyUpToDate) {
            console.log(chalk.green('✓ Wrapper script already up to date'));
          } else {
            console.log(chalk.green('✓ Wrapper script installed/updated'));
          }
          console.log(chalk.dim(`  Path: ${wrapperResult.wrapperPath}`));
        } else {
          console.log(chalk.yellow(`⚠ Wrapper script failed: ${wrapperResult.error}`));
        }

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

      // Install wrapper script first
      const wrapperResult = installWrapperScript();
      const aliasResult = installAlias();

      if (options.json) {
        console.log(JSON.stringify({ wrapper: wrapperResult, alias: aliasResult }, null, 2));
      } else {
        // Report wrapper result
        if (wrapperResult.success) {
          if (wrapperResult.alreadyUpToDate) {
            console.log(chalk.green('✓ Wrapper script already up to date'));
          } else {
            console.log(chalk.green('✓ Wrapper script installed/updated'));
          }
          console.log(chalk.dim(`  Path: ${wrapperResult.wrapperPath}`));
        } else {
          console.log(chalk.yellow(`⚠ Wrapper script failed: ${wrapperResult.error}`));
        }

        // Report alias result
        if (aliasResult.success) {
          if (aliasResult.alreadyInstalled) {
            console.log(chalk.green('✓ Alias already installed'));
          } else {
            console.log(chalk.green('✓ Alias installed'));
            console.log(chalk.dim(`  Shell: ${aliasResult.shell}`));
            console.log(chalk.dim(`  Path: ${aliasResult.profilePath}`));
            console.log(chalk.yellow('\nRestart your shell or run: source ' + aliasResult.profilePath));
          }
        } else {
          console.error(chalk.red(`✗ Alias failed: ${aliasResult.error}`));
          process.exit(1);
        }
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

        const answer = await promptUser('Install globally or locally? [global/local/skip]: ');

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
 * Update command - automatically migrate to latest version
 */
program
  .command('update')
  .description('Update database schema to latest version (v1.0.0) - runs all necessary migrations')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const coordinator = new Coordinator();
    try {
      const db = coordinator['db'];
      const currentVersion = db.getSchemaVersion();

      if (!options.json) {
        console.log(chalk.bold('\nUpdating parallel-cc database schema\n'));
        console.log(chalk.dim(`Current version: ${currentVersion || 'none'}`));
        console.log(chalk.dim('Target version: 1.0.0\n'));
      }

      const result = await db.migrateToLatest();

      if (options.json) {
        console.log(JSON.stringify({
          success: true,
          from: result.from,
          to: result.to,
          migrations: result.migrations
        }));
      } else {
        if (result.migrations.length === 0) {
          console.log(chalk.green('✓ Already at latest version'));
        } else {
          console.log(chalk.green('✓ Update completed successfully\n'));
          console.log(chalk.dim('Migrations applied:'));
          for (const version of result.migrations) {
            console.log(chalk.dim(`  - v${version}`));
          }
          console.log('');
          console.log(chalk.dim('Database is now at version 1.0.0'));
          console.log(chalk.dim('E2B sandbox features are now available'));
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: errorMessage }));
      } else {
        console.error(chalk.red(`✗ Update failed: ${errorMessage}`));
      }
      process.exit(1);
    } finally {
      coordinator.close();
    }
  });

/**
 * Database migration (v0.5+)
 * Migrate database schema to support various features
 */
program
  .command('migrate')
  .description('Run database migration to specified version (default: latest 1.0.0)')
  .option('--version <version>', 'Target version (0.5.0 or 1.0.0)', '1.0.0')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const coordinator = new Coordinator();
    const targetVersion = options.version;

    // Validate version parameter
    const validVersions = ['0.5.0', '1.0.0'];
    if (!validVersions.includes(targetVersion)) {
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: `Invalid version: ${targetVersion}. Valid versions: ${validVersions.join(', ')}` }));
      } else {
        console.error(chalk.red(`✗ Invalid version: ${targetVersion}`));
        console.error(chalk.dim(`  Valid versions: ${validVersions.join(', ')}`));
      }
      process.exit(1);
    }

    try {
      const db = coordinator['db'];
      const currentVersion = db.getSchemaVersion();

      if (options.json) {
        // JSON mode: silent until result
      } else {
        console.log(chalk.dim(`Current schema version: ${currentVersion || 'none'}`));
        console.log(chalk.dim(`Target version: ${targetVersion}`));
      }

      // Determine which migrations to run
      if (targetVersion === '0.5.0') {
        await db.migrateToV05();
        if (options.json) {
          console.log(JSON.stringify({ success: true, message: 'Migration to v0.5.0 completed', version: '0.5.0' }));
        } else {
          console.log(chalk.green('✓ Migration to v0.5.0 completed successfully'));
          console.log(chalk.dim('  Added tables: file_claims, conflict_resolutions, auto_fix_suggestions'));
        }
      } else if (targetVersion === '1.0.0') {
        // Need to run v0.5.0 first if not already there
        if (!currentVersion || currentVersion < '0.5.0') {
          if (!options.json) {
            console.log(chalk.dim('Running v0.5.0 migration first...'));
          }
          await db.migrateToV05();
        }

        // Now run v1.0.0 migration
        await db.runMigration('1.0.0');

        if (options.json) {
          console.log(JSON.stringify({ success: true, message: 'Migration to v1.0.0 completed', version: '1.0.0' }));
        } else {
          console.log(chalk.green('✓ Migration to v1.0.0 completed successfully'));
          console.log(chalk.dim('  Added E2B sandbox columns: execution_mode, sandbox_id, prompt, status, output_log'));
          console.log(chalk.dim('  E2B sandbox features are now available'));
        }
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
  .description(`Execute autonomous task in E2B sandbox with full worktree isolation (v1.0)

Authentication:
  --auth-method api-key   Use ANTHROPIC_API_KEY (default, pay-as-you-go)
  --auth-method oauth     Use Claude subscription (run /login first)

Branch Management:
  (no --branch)           Download as uncommitted changes (default - maximum control)
  --branch auto           Auto-generate branch name and commit (convenience)
  --branch <name>         Specify branch name and commit (custom naming)

Git Identity (for commits in sandbox):
  (default)               Auto-detect from local git config
  --git-user "Name"       Override git user name
  --git-email "email"     Override git user email
  PARALLEL_CC_GIT_USER    Environment variable fallback
  PARALLEL_CC_GIT_EMAIL   Environment variable fallback

NPM Authentication (for private packages):
  --npm-token <token>     NPM token (or set PARALLEL_CC_NPM_TOKEN env var)
  --npm-registry <url>    Custom registry (default: registry.npmjs.org)

Examples:
  # Default: uncommitted changes, review before committing
  parallel-cc sandbox-run --repo . --prompt "Fix bug"

  # OAuth auth + auto branch
  parallel-cc sandbox-run --repo . --prompt "Add feature" --auth-method oauth --branch auto

  # Custom branch name
  parallel-cc sandbox-run --repo . --prompt "Fix #42" --branch feature/issue-42

  # Override git identity for commits
  parallel-cc sandbox-run --repo . --prompt "Fix bug" --git-user "CI Bot" --git-email "ci@example.com"

  # Private NPM packages
  parallel-cc sandbox-run --repo . --prompt "Install deps" --npm-token "npm_xxx"

  # Custom NPM registry
  parallel-cc sandbox-run --repo . --prompt "Task" --npm-token "xxx" --npm-registry "https://npm.company.com"`)
  .requiredOption('--repo <path>', 'Repository path')
  .option('--prompt <text>', 'Prompt text to execute')
  .option('--prompt-file <path>', 'Path to prompt file (e.g., PLAN.md, .apm/Implementation_Plan.md)')
  .option('--template <image>', 'E2B sandbox template (default: anthropic-claude-code or E2B_TEMPLATE env var)')
  .option('--auth-method <method>', 'Authentication method: api-key (ANTHROPIC_API_KEY env var) or oauth (Claude subscription credentials)', 'api-key')
  .option('--dry-run', 'Test upload without execution (useful for verifying workspace)')
  .option('--branch <name>', 'Create feature branch for changes: "auto" (auto-generate name) or specify branch name. Default: no branch, uncommitted changes')
  .option('--git-live', 'Push results to remote feature branch and create PR instead of downloading (requires GITHUB_TOKEN)')
  .option('--target-branch <branch>', 'Target branch for PR when using --git-live (default: main)', 'main')
  .option('--git-user <name>', 'Git user name for commits in sandbox (default: auto-detect from local git config)')
  .option('--git-email <email>', 'Git user email for commits in sandbox (default: auto-detect from local git config)')
  .option('--ssh-key <path>', 'Path to SSH private key for private repository access (e.g., ~/.ssh/id_ed25519)')
  .option('--confirm-ssh-key', 'Skip interactive SSH key security warning (for non-interactive use)')
  .option('--npm-token <token>', 'NPM authentication token for private packages (or set PARALLEL_CC_NPM_TOKEN env var)')
  .option('--npm-registry <url>', 'Custom NPM registry URL (default: https://registry.npmjs.org)', 'https://registry.npmjs.org')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const coordinator = new Coordinator();
    // Precedence: CLI option > E2B_TEMPLATE env var > default 'anthropic-claude-code'
    const sandboxImage = options.template ||
                         (process.env.E2B_TEMPLATE?.trim() || '') ||
                         'anthropic-claude-code';
    const sandboxManager = new SandboxManager(logger, {
      sandboxImage
    });
    let sandboxId: string | null = null;

    try {
      // Check schema version - E2B features require v1.0.0 migration
      const db = coordinator['db'];
      const currentVersion = db.getSchemaVersion();
      if (!db.hasE2BColumns()) {
        if (options.json) {
          console.log(JSON.stringify({
            success: false,
            error: 'E2B sandbox features require database migration to v1.0.0',
            currentVersion: currentVersion || 'none',
            requiredVersion: '1.0.0'
          }));
        } else {
          console.error(chalk.red('✗ E2B sandbox features require database schema update'));
          console.error(chalk.dim(`  Current version: ${currentVersion || 'none'}`));
          console.error(chalk.yellow('  Run: parallel-cc update'));
        }
        process.exit(1);
      }

      // Validate inputs
      if (!options.prompt && !options.promptFile) {
        console.error(chalk.red('✗ Error: Either --prompt or --prompt-file is required'));
        process.exit(1);
      }

      if (options.prompt && options.promptFile) {
        console.error(chalk.red('✗ Error: Cannot use both --prompt and --prompt-file'));
        process.exit(1);
      }

      // Validate authentication method
      if (options.authMethod !== 'api-key' && options.authMethod !== 'oauth') {
        console.error(chalk.red(`✗ Error: Invalid --auth-method "${options.authMethod}". Must be "api-key" or "oauth"`));
        process.exit(1);
      }

      // Validate authentication credentials
      if (options.authMethod === 'api-key') {
        if (!process.env.ANTHROPIC_API_KEY) {
          console.error(chalk.red('✗ Error: ANTHROPIC_API_KEY environment variable required when using --auth-method api-key'));
          console.error(chalk.dim('  Set your API key: export ANTHROPIC_API_KEY="sk-ant-..."'));
          process.exit(1);
        }
      } else if (options.authMethod === 'oauth') {
        const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
        if (!existsSync(credPath)) {
          console.error(chalk.red('✗ Error: OAuth credentials not found when using --auth-method oauth'));
          console.error(chalk.dim(`  Expected location: ${credPath}`));
          console.error(chalk.dim('  Run "claude login" to authenticate with your Claude subscription'));
          process.exit(1);
        }
      }

      // Validate GitHub token for git-live mode
      if (options.gitLive) {
        if (!process.env.GITHUB_TOKEN) {
          if (options.json) {
            console.log(JSON.stringify({
              success: false,
              error: 'GITHUB_TOKEN environment variable required for --git-live mode',
              hint: 'Set your token: export GITHUB_TOKEN="ghp_..."'
            }));
          } else {
            console.error(chalk.red('✗ Error: GITHUB_TOKEN environment variable required for --git-live mode'));
            console.error(chalk.dim('  Set your GitHub token: export GITHUB_TOKEN="ghp_..."'));
            console.error(chalk.dim('  Create a token at: https://github.com/settings/tokens'));
          }
          process.exit(1);
        }
      }

      // Warn about partial git identity configuration
      const hasGitUser = options.gitUser && options.gitUser.trim();
      const hasGitEmail = options.gitEmail && options.gitEmail.trim();
      if ((hasGitUser && !hasGitEmail) || (!hasGitUser && hasGitEmail)) {
        if (!options.json) {
          console.warn(chalk.yellow('⚠ Warning: Both --git-user and --git-email should be provided together'));
        console.warn(chalk.dim('  Using the provided value; the missing one will be auto-detected/defaulted'));
        }
      }

      // Validate E2B API key early (fail fast before resource-intensive operations)
      try {
        SandboxManager.validateApiKey();
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : 'E2B API key validation failed',
            hint: 'Set E2B_API_KEY environment variable. Get your key from https://e2b.dev/dashboard'
          }));
        } else {
          console.error(chalk.red(`✗ ${error instanceof Error ? error.message : 'E2B API key validation failed'}`));
          console.error(chalk.dim('  Get your E2B API key from: https://e2b.dev/dashboard'));
          console.error(chalk.yellow('  Set it with: export E2B_API_KEY="your-key-here"'));
          console.error(chalk.dim('  Add to your shell profile (.bashrc, .zshrc) for persistence'));
        }
        process.exit(1);
      }

      // Validate SSH key if provided
      let sshKeyValidation: Awaited<ReturnType<typeof validateSSHKeyPath>> | undefined;
      if (options.sshKey) {
        // Expand ~ to home directory
        const sshKeyPath = options.sshKey.startsWith('~')
          ? path.join(os.homedir(), options.sshKey.slice(1))
          : options.sshKey;

        sshKeyValidation = await validateSSHKeyPath(sshKeyPath);

        if (!sshKeyValidation.valid) {
          if (options.json) {
            console.log(JSON.stringify({
              success: false,
              error: `SSH key validation failed: ${sshKeyValidation.error}`,
              keyPath: sshKeyPath
            }));
          } else {
            console.error(chalk.red(`✗ SSH key validation failed: ${sshKeyValidation.error}`));
          }
          process.exit(1);
        }

        // Warn about permissions if needed
        if (sshKeyValidation.permissionsWarning && !options.json) {
          console.warn(chalk.yellow(`⚠ ${sshKeyValidation.permissionsWarning}`));
        }

        // Display security warning and get confirmation
        if (!options.json && !options.confirmSshKey) {
          console.log('');
          console.log(chalk.yellow(getSecurityWarning(sshKeyPath)));
          console.log('');

          const answer = await promptUser('Do you want to proceed with SSH key injection? (y/n): ');
          if (answer !== 'y' && answer !== 'yes') {
            console.log(chalk.yellow('✓ Cancelled - SSH key will not be used'));
            options.sshKey = undefined;
            sshKeyValidation = undefined;
          } else {
            console.log(chalk.green('✓ Proceeding with SSH key injection'));
          }
        } else if (options.json && !options.confirmSshKey) {
          // In JSON mode without --confirm-ssh-key, require explicit confirmation
          console.log(JSON.stringify({
            success: false,
            error: 'SSH key injection requires explicit confirmation',
            hint: 'Use --confirm-ssh-key flag to skip interactive prompt in non-interactive mode'
          }));
          process.exit(1);
        }

        // Update the key path to expanded version
        options.sshKey = sshKeyPath;
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

      // Warn about parallel sessions when using --git-live mode
      if (options.gitLive && registerResult.parallelSessions > 1) {
        if (!options.json) {
          console.log('');
          console.log(chalk.yellow('⚠ Warning: Parallel sessions detected with --git-live mode'));
          console.log(chalk.yellow(`  ${registerResult.parallelSessions} sessions are currently active in this repository`));
          console.log(chalk.dim('  Multiple PRs may create conflicts or duplicate work'));
          console.log(chalk.dim('  Consider using download mode (default) for better control'));
          console.log('');

          // Prompt user to continue
          const answer = await promptUser('Continue with --git-live mode despite parallel sessions? (y/n): ');
          if (answer !== 'y' && answer !== 'yes') {
            console.log(chalk.yellow('✓ Switching to download mode'));
            options.gitLive = false;
          } else {
            console.log(chalk.green('✓ Continuing with --git-live mode'));
          }
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
      let sandbox: Awaited<ReturnType<typeof sandboxManager.createSandbox>>['sandbox'] | undefined;
      let sshKeyInjected = false;
      let injectedKeyFilename: string | undefined;
      try {
        // Step 4: Create sandbox and upload
        if (!options.json) {
          console.log(chalk.blue('\nStep 4/6: Creating E2B sandbox...'));
        }

        const createResult = await sandboxManager.createSandbox(sessionId);
        sandbox = createResult.sandbox;
        sandboxId = createResult.sandboxId; // Track for cleanup in catch block

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

      // Inject SSH key if provided (after sandbox creation and upload)
      if (options.sshKey) {
        if (!options.json) {
          console.log(chalk.dim('  Injecting SSH key for private repository access...'));
        }

        const injectionResult = await injectSSHKey(sandbox, options.sshKey, logger);

        if (!injectionResult.success) {
          if (options.json) {
            console.log(JSON.stringify({
              success: false,
              error: `SSH key injection failed: ${injectionResult.error}`,
              keyPath: options.sshKey
            }));
          } else {
            console.error(chalk.red(`✗ SSH key injection failed: ${injectionResult.error}`));
          }
          await sandboxManager.terminateSandbox(sandboxId);
          process.exit(1);
        }

        sshKeyInjected = true;
        injectedKeyFilename = injectionResult.keyFilename;
        if (!options.json) {
          console.log(chalk.green(`✓ SSH key injected (${injectionResult.keyType || 'unknown'} type)`));
          if (injectionResult.keyFingerprint) {
            console.log(chalk.dim(`  Fingerprint: ${injectionResult.keyFingerprint}`));
          }
        }
      }

      // Configure NPM authentication if token provided
      // Priority: CLI flag > environment variable
      const npmToken = options.npmToken || process.env.PARALLEL_CC_NPM_TOKEN;
      if (npmToken) {
        if (!options.json) {
          console.log(chalk.dim('  Configuring NPM authentication for private packages...'));
        }

        const npmConfigResult = await sandboxManager.configureNpmAuth(
          sandbox,
          npmToken,
          options.npmRegistry
        );

        if (npmConfigResult) {
          if (!options.json) {
            console.log(chalk.green('✓ NPM authentication configured'));
            // Don't log the registry URL if it's the default
            if (options.npmRegistry !== 'https://registry.npmjs.org') {
              console.log(chalk.dim(`  Registry: ${options.npmRegistry}`));
            }
          }
        } else {
          // NPM config failure is non-blocking - warn but continue
          if (!options.json) {
            console.warn(chalk.yellow('⚠ NPM authentication configuration failed'));
            console.warn(chalk.dim('  Continuing without private package access'));
          }
        }
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

      // Read OAuth credentials if using oauth auth method
      let oauthCredentials: string | undefined;
      if (options.authMethod === 'oauth') {
        const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
        try {
          oauthCredentials = await fs.readFile(credPath, 'utf-8');
          if (!options.json) {
            console.log(chalk.dim('Using OAuth credentials from ~/.claude/.credentials.json'));
          }
        } catch (error) {
          console.error(chalk.red(`✗ Failed to read OAuth credentials: ${error instanceof Error ? error.message : 'Unknown error'}`));
          await sandboxManager.terminateSandbox(sandboxId);
          process.exit(1);
        }
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
          },
          authMethod: options.authMethod as 'api-key' | 'oauth',
          oauthCredentials,
          gitUser: options.gitUser,
          gitEmail: options.gitEmail,
          localRepoPath: repoPath
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

      // Step 6: Git Live or Download results
      let gitLiveResult;
      let downloadResult;

      if (options.gitLive) {
        // Git Live Mode: Push to remote and create PR
        if (!options.json) {
          console.log(chalk.blue('\nStep 6/6: Pushing to remote and creating PR...'));
        }

        gitLiveResult = await pushToRemoteAndCreatePR(sandbox, logger, {
          repoPath,
          targetBranch: options.targetBranch,
          featureBranch: options.branch,
          prompt,
          executionTime: executionResult.executionTime,
          sessionId,
          sandboxId,
          githubToken: process.env.GITHUB_TOKEN!
        });

        if (!gitLiveResult.success) {
          console.error(chalk.red(`✗ Git live failed: ${gitLiveResult.error}`));
          await sandboxManager.terminateSandbox(sandboxId);
          process.exit(1);
        }

        if (!options.json) {
          console.log(chalk.green(`✓ Feature branch created: ${gitLiveResult.branchName}`));
          if (gitLiveResult.prUrl) {
            console.log(chalk.green(`✓ Pull request created: ${gitLiveResult.prUrl}`));
          }
        }

      } else {
        // Default Download Mode
        if (!options.json) {
          console.log(chalk.blue('\nStep 6/6: Downloading results...'));
        }

        downloadResult = await downloadChangedFiles(sandbox, '/workspace', worktreePath);

        if (!downloadResult.success) {
          console.error(chalk.red(`✗ Download failed: ${downloadResult.error}`));
          await sandboxManager.terminateSandbox(sandboxId);
          process.exit(1);
        }

        if (!options.json) {
          console.log(chalk.green(`✓ Results downloaded: ${downloadResult.filesDownloaded} files`));
          console.log(chalk.dim(`  Size: ${(downloadResult.sizeBytes / 1024 / 1024).toFixed(2)} MB`));
        }
      }

      // Create branch and commit if requested (download mode only)
      if (!options.gitLive && options.branch) {
        if (!options.json) {
          console.log(chalk.blue('\nCreating feature branch...'));
        }

        try {
          // Generate branch name
          let branchName: string;
          if (options.branch === 'auto') {
            // Auto-generate from prompt and timestamp
            const slug = prompt
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '') // Remove leading/trailing dashes
              .slice(0, 50);
            const timestamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
            branchName = `e2b/${slug}-${timestamp}`;
          } else {
            branchName = options.branch;
          }

          if (!options.json) {
            console.log(chalk.dim(`  Branch: ${branchName}`));
          }

          // Create and checkout branch
          const createBranchResult = spawnSync('git', ['checkout', '-b', branchName], {
            cwd: worktreePath,
            stdio: 'pipe'
          });

          if (createBranchResult.status !== 0) {
            // Branch might already exist, try to checkout
            const checkoutResult = spawnSync('git', ['checkout', branchName], {
              cwd: worktreePath,
              stdio: 'pipe'
            });

            if (checkoutResult.status !== 0) {
              throw new Error(`Failed to create/checkout branch: ${createBranchResult.stderr?.toString() || checkoutResult.stderr?.toString()}`);
            }
          }

          // Commit changes
          const commitMsg = `E2B execution: ${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}\n\nSandbox: ${sandboxId}\nExecution time: ${(executionResult.executionTime / 1000 / 60).toFixed(1)} minutes`;

          execSync('git add -A', { cwd: worktreePath, stdio: 'pipe' });

          const commitResult = spawnSync('git', ['commit', '-m', commitMsg], {
            cwd: worktreePath,
            stdio: 'pipe'
          });

          if (commitResult.status !== 0) {
            const stderr = commitResult.stderr?.toString() || '';
            // Ignore "nothing to commit" errors
            if (!stderr.includes('nothing to commit')) {
              throw new Error(`Git commit failed: ${stderr}`);
            }
          }

          if (!options.json) {
            console.log(chalk.green(`✓ Branch created: ${branchName}`));
            console.log(chalk.green('✓ Changes committed'));
            console.log(chalk.dim(`\n  Next: git push origin ${branchName}`));
          }
        } catch (error) {
          if (!options.json) {
            console.log(chalk.yellow(`⚠ Branch creation or commit failed: ${error instanceof Error ? error.message : 'Unknown error'}`));
          }
        }
      } else {
        // No --branch flag: leave changes uncommitted
        if (!options.json) {
          console.log(chalk.blue('\nChanges downloaded as uncommitted files'));
          console.log(chalk.dim('  Review with: git status, git diff'));
          console.log(chalk.dim('  Create branch: git checkout -b feature/name'));
          console.log(chalk.dim('  Commit: git commit -m "message"'));
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

        if (options.gitLive && gitLiveResult) {
          console.log(chalk.dim(`Branch: ${gitLiveResult.branchName}`));
          console.log(chalk.dim(`Target: ${gitLiveResult.targetBranch}`));
          if (gitLiveResult.prUrl) {
            console.log(chalk.green(`\nPull Request: ${gitLiveResult.prUrl}`));
          }
        } else {
          console.log(chalk.dim(`Worktree: ${worktreePath}`));
        }
      } else {
        const output: any = {
          success: true,
          sessionId,
          sandboxId,
          executionTime: executionResult.executionTime,
          exitCode: executionResult.exitCode
        };

        if (options.gitLive && gitLiveResult) {
          output.gitLive = {
            branchName: gitLiveResult.branchName,
            prUrl: gitLiveResult.prUrl,
            targetBranch: gitLiveResult.targetBranch
          };
        } else if (downloadResult) {
          output.worktreePath = worktreePath;
          output.filesDownloaded = downloadResult.filesDownloaded;
        }

        console.log(JSON.stringify(output, null, 2));
      }

      } finally {
        // Best-effort cleanup of SSH key from sandbox (before termination)
        if (sshKeyInjected && sandbox) {
          try {
            await cleanupSSHKey(sandbox, logger, injectedKeyFilename);
          } catch (cleanupError) {
            // Log but don't throw - don't mask original errors
            logger.warn(`Failed to cleanup SSH key: ${cleanupError instanceof Error ? cleanupError.message : 'Unknown error'}`);
          }
        }

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
      // Validate E2B API key early
      try {
        SandboxManager.validateApiKey();
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : 'E2B API key validation failed',
            hint: 'Set E2B_API_KEY environment variable. Get your key from https://e2b.dev/dashboard'
          }));
        } else {
          console.error(chalk.red(`✗ ${error instanceof Error ? error.message : 'E2B API key validation failed'}`));
          console.error(chalk.dim('  Get your E2B API key from: https://e2b.dev/dashboard'));
        }
        process.exit(1);
      }

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

      // Check if sandbox is still running (will attempt reconnection)
      const healthCheck = await sandboxManager.monitorSandboxHealth(session.sandbox_id, true);
      if (!healthCheck.isHealthy) {
        console.error(chalk.red(`✗ Sandbox not accessible: ${healthCheck.error}`));
        process.exit(1);
      }

      // Get sandbox instance (reconnect if needed)
      const sandbox = await sandboxManager.getOrReconnectSandbox(session.sandbox_id);
      if (!sandbox) {
        console.error(chalk.red('✗ Failed to connect to sandbox (may have been terminated)'));
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
      }

      // Terminate sandbox
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
