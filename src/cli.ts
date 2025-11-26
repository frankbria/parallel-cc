#!/usr/bin/env node
/**
 * parallel-cc CLI - Coordinate parallel Claude Code sessions
 */

import { program } from 'commander';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { Coordinator } from './coordinator.js';
import { GtrWrapper } from './gtr.js';
import { DEFAULT_CONFIG } from './types.js';

program
  .name('parallel-cc')
  .description('Coordinate parallel Claude Code sessions using git worktrees')
  .version('0.2.0');

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

// Parse and execute
program.parse();
