/**
 * CLI Deprecation Helpers
 *
 * Provides utilities for showing deprecation warnings when users invoke
 * deprecated hyphenated commands (e.g., mcp-serve instead of mcp serve).
 */

import chalk from 'chalk';

/**
 * Show a deprecation warning for a hyphenated command.
 * Outputs to stderr so it doesn't interfere with command output.
 *
 * @param oldCmd - The deprecated command name (e.g., 'mcp-serve')
 * @param newCmd - The new command syntax (e.g., 'mcp serve')
 */
export function showDeprecationWarning(oldCmd: string, newCmd: string): void {
  console.error(chalk.yellow(`⚠ Warning: "${oldCmd}" is deprecated`));
  console.error(chalk.dim(`  Use "${newCmd}" instead`));
  console.error(chalk.dim(`  The old command will be removed in v3.0.0\n`));
}

/**
 * Command mapping from deprecated hyphenated names to new subcommand syntax.
 */
export const DEPRECATED_COMMANDS: Record<string, string> = {
  'mcp-serve': 'mcp serve',
  'watch-merges': 'watch merges',
  'merge-status': 'merge status',
  'sandbox-run': 'sandbox run',
  'sandbox-logs': 'sandbox logs',
  'sandbox-download': 'sandbox download',
  'sandbox-kill': 'sandbox kill',
  'sandbox-list': 'sandbox list',
  'sandbox-status': 'sandbox status',
};
