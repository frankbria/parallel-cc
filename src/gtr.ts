/**
 * Wrapper for gtr (git-worktree-runner) CLI commands
 */

import { execSync, exec } from 'child_process';
import { logger } from './logger.js';
import type { GtrResult, GtrListEntry } from './types.js';

export class GtrWrapper {
  private repoPath: string;
  
  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }
  
  /**
   * Check if gtr is installed and available
   */
  static isAvailable(): boolean {
    try {
      execSync('gtr version', { stdio: 'pipe' });
      return true;
    } catch (error) {
      logger.debug('gtr not available', error);
      return false;
    }
  }
  
  /**
   * Create a new worktree
   */
  createWorktree(name: string, fromRef: string = 'HEAD'): GtrResult {
    try {
      const output = execSync(
        `gtr new ${name} --from ${fromRef} --yes`,
        { cwd: this.repoPath, encoding: 'utf-8', stdio: 'pipe' }
      );
      return { success: true, output: output.trim() };
    } catch (err: any) {
      return { 
        success: false, 
        output: '', 
        error: err.stderr?.toString() || err.message 
      };
    }
  }

  /**
   * Get the path to a worktree
   */
  getWorktreePath(name: string): string | null {
    try {
      const output = execSync(
        `gtr go ${name}`,
        { cwd: this.repoPath, encoding: 'utf-8', stdio: 'pipe' }
      );
      return output.trim();
    } catch (error) {
      logger.error(`Failed to get worktree path for ${name}`, error);
      return null;
    }
  }
  
  /**
   * Remove a worktree
   */
  removeWorktree(name: string, deleteBranch: boolean = false): GtrResult {
    try {
      const flags = deleteBranch ? '--delete-branch --yes' : '--yes';
      const output = execSync(
        `gtr rm ${name} ${flags}`,
        { cwd: this.repoPath, encoding: 'utf-8', stdio: 'pipe' }
      );
      return { success: true, output: output.trim() };
    } catch (err: any) {
      return { 
        success: false, 
        output: '', 
        error: err.stderr?.toString() || err.message 
      };
    }
  }

  /**
   * List all worktrees
   */
  listWorktrees(): GtrListEntry[] {
    try {
      const output = execSync(
        'gtr list --porcelain',
        { cwd: this.repoPath, encoding: 'utf-8', stdio: 'pipe' }
      );
      
      // Parse porcelain output
      // Format: worktree <path>\nHEAD <sha>\nbranch <ref>\n\n
      const entries: GtrListEntry[] = [];
      const blocks = output.trim().split('\n\n');
      
      for (const block of blocks) {
        const lines = block.split('\n');
        let path = '';
        let branch = '';
        
        for (const line of lines) {
          if (line.startsWith('worktree ')) {
            path = line.substring(9);
          } else if (line.startsWith('branch ')) {
            branch = line.substring(7).replace('refs/heads/', '');
          }
        }
        
        if (path && branch) {
          entries.push({
            path,
            branch,
            isMain: !path.includes('-worktrees/')
          });
        }
      }
      
      return entries;
    } catch (error) {
      // Fallback to git worktree list if gtr fails
      logger.warn(`gtr list failed, falling back to git worktree list: ${error instanceof Error ? error.message : 'unknown error'}`);
      return this.listWorktreesGit();
    }
  }

  /**
   * Fallback: use git worktree list directly
   */
  private listWorktreesGit(): GtrListEntry[] {
    try {
      const output = execSync(
        'git worktree list --porcelain',
        { cwd: this.repoPath, encoding: 'utf-8', stdio: 'pipe' }
      );
      
      const entries: GtrListEntry[] = [];
      const blocks = output.trim().split('\n\n');
      
      for (const block of blocks) {
        const lines = block.split('\n');
        let path = '';
        let branch = '';
        
        for (const line of lines) {
          if (line.startsWith('worktree ')) {
            path = line.substring(9);
          } else if (line.startsWith('branch ')) {
            branch = line.substring(7).replace('refs/heads/', '');
          }
        }
        
        if (path) {
          entries.push({
            path,
            branch: branch || 'detached',
            isMain: entries.length === 0 // First entry is always main
          });
        }
      }
      
      return entries;
    } catch (error) {
      logger.error('Failed to list worktrees via git', error);
      return [];
    }
  }
  
  /**
   * Get the main repo path
   */
  getMainRepoPath(): string | null {
    const entries = this.listWorktrees();
    const main = entries.find(e => e.isMain);
    return main?.path ?? null;
  }
  
  /**
   * Generate a unique worktree name
   */
  static generateWorktreeName(prefix: string = 'parallel-'): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 6);
    return `${prefix}${timestamp}-${random}`;
  }
}
