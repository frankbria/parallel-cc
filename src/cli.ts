#!/usr/bin/env node
/**
 * parallel-cc CLI - Coordinate parallel Claude Code sessions
 */

import { program } from 'commander';
import chalk from 'chalk';
import { execSync } from 'child_process';
import * as readline from 'readline';
import { Coordinator } from './coordinator.js';
import { GtrWrapper } from './gtr.js';
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

program
  .name('parallel-cc')
  .description('Coordinate parallel Claude Code sessions using git worktrees')
  .version('0.3.0');

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
  .action((options) => {
    const coordinator = new Coordinator();
    try {
      const result = coordinator.register(options.repo, options.pid);

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
  .action((options) => {
    const coordinator = new Coordinator();
    try {
      const result = coordinator.release(options.pid);

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
  .option('--json', 'Output as JSON')
  .action((options) => {
    const coordinator = new Coordinator();
    try {
      const result = coordinator.status(options.repo);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(chalk.bold(`\nActive Sessions: ${result.totalSessions}`));

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
  .action((options) => {
    const coordinator = new Coordinator();
    try {
      const result = coordinator.cleanup();

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
  .description('Start MCP server for Claude Code integration (stdio transport)')
  .action(async () => {
    try {
      await startMcpServer();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`MCP server failed: ${errorMessage}`);
      process.exit(1);
    }
  });

// Parse and execute
program.parse();
