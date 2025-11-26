#!/usr/bin/env node
/**
 * Helper script for colored console output in bash scripts
 * Usage: node scripts/print.mjs <type> <message>
 * Types: success, error, warning, info, title, subtitle, step
 */

import chalk from 'chalk';

const type = process.argv[2];
const message = process.argv.slice(3).join(' ');

switch (type) {
  case 'success':
    console.log(chalk.green('✓'), chalk.green(message));
    break;
  case 'error':
    console.log(chalk.red('✗'), chalk.red(message));
    break;
  case 'warning':
    console.log(chalk.yellow('⚠️'), chalk.yellow(message));
    break;
  case 'info':
    console.log(chalk.blue('ℹ️'), chalk.blue(message));
    break;
  case 'title':
    console.log();
    console.log(chalk.bold.cyan('━'.repeat(62)));
    console.log(chalk.bold.cyan(`  ${message}`));
    console.log(chalk.bold.cyan('━'.repeat(62)));
    console.log();
    break;
  case 'subtitle':
    console.log();
    console.log(chalk.bold(message));
    break;
  case 'step':
    console.log(chalk.dim('  ' + message));
    break;
  case 'section':
    console.log();
    console.log(chalk.bold.magenta(`${message}`));
    console.log();
    break;
  case 'check':
    console.log(chalk.green('  ✓'), message);
    break;
  case 'install':
    console.log(chalk.cyan('🔗'), chalk.cyan(message));
    break;
  case 'build':
    console.log(chalk.yellow('📦'), chalk.yellow(message));
    break;
  case 'verify':
    console.log(chalk.magenta('🔍'), chalk.magenta(message));
    break;
  case 'cleanup':
    console.log(chalk.red('🗑️'), chalk.red(message));
    break;
  case 'folder':
    console.log(chalk.blue('📁'), chalk.blue(message));
    break;
  default:
    console.log(message);
}
