/**
 * MCP tool implementations for parallel-cc
 */

import { Coordinator } from '../coordinator.js';
import { execSync } from 'child_process';
import type {
  GetParallelStatusInput,
  GetParallelStatusOutput,
  GetMySessionOutput,
  NotifyWhenMergedInput,
  NotifyWhenMergedOutput,
  CheckMergeStatusInput,
  CheckMergeStatusOutput,
  GetMergeEventsInput,
  GetMergeEventsOutput,
  CheckConflictsInput,
  CheckConflictsOutput,
  RebaseAssistInput,
  RebaseAssistOutput
} from './schemas.js';

/**
 * Get status of all parallel sessions in a repository
 */
export async function getParallelStatus(
  input: GetParallelStatusInput
): Promise<GetParallelStatusOutput> {
  const coordinator = new Coordinator();
  try {
    const repoPath = input.repo_path || process.cwd();
    const result = coordinator.status(repoPath);

    return {
      sessions: result.sessions.map(s => ({
        pid: s.pid,
        worktreePath: s.worktreePath,
        worktreeName: s.worktreeName,
        isMainRepo: s.isMainRepo,
        durationMinutes: s.durationMinutes,
        isAlive: s.isAlive
      })),
      totalSessions: result.totalSessions
    };
  } finally {
    coordinator.close();
  }
}

/**
 * Get information about the current session
 * Requires PARALLEL_CC_SESSION_ID environment variable to be set
 */
export async function getMySession(): Promise<GetMySessionOutput> {
  const sessionId = process.env.PARALLEL_CC_SESSION_ID;

  if (!sessionId) {
    return {
      sessionId: null,
      worktreePath: null,
      worktreeName: null,
      isMainRepo: null,
      startedAt: null,
      parallelSessions: 0,
      error: 'Not running in a parallel-cc managed session (PARALLEL_CC_SESSION_ID not set)'
    };
  }

  const coordinator = new Coordinator();
  try {
    // Get all sessions to find ours and count parallel sessions
    const allSessions = coordinator.status();
    const mySession = allSessions.sessions.find(s => s.sessionId === sessionId);

    if (!mySession) {
      return {
        sessionId,
        worktreePath: null,
        worktreeName: null,
        isMainRepo: null,
        startedAt: null,
        parallelSessions: 0,
        error: `Session ${sessionId} not found in database`
      };
    }

    // Count sessions in the same repo
    const repoSessions = allSessions.sessions.filter(
      s => s.worktreePath.startsWith(mySession.worktreePath.split('/').slice(0, -1).join('/'))
    );

    return {
      sessionId: mySession.sessionId,
      worktreePath: mySession.worktreePath,
      worktreeName: mySession.worktreeName,
      isMainRepo: mySession.isMainRepo,
      startedAt: mySession.createdAt,
      parallelSessions: repoSessions.length
    };
  } finally {
    coordinator.close();
  }
}

/**
 * Subscribe to notifications when a branch is merged
 * v0.4: Creates subscription in database for merge detection
 */
export async function notifyWhenMerged(
  input: NotifyWhenMergedInput
): Promise<NotifyWhenMergedOutput> {
  const sessionId = process.env.PARALLEL_CC_SESSION_ID;

  if (!sessionId) {
    return {
      subscribed: false,
      message: 'Not running in a parallel-cc managed session (PARALLEL_CC_SESSION_ID not set)'
    };
  }

  const coordinator = new Coordinator();
  try {
    // Get session to verify it exists and get repo path
    const status = coordinator.status();
    const session = status.sessions.find(s => s.sessionId === sessionId);

    if (!session) {
      return {
        subscribed: false,
        message: `Session ${sessionId} not found in database`
      };
    }

    const targetBranch = input.targetBranch || 'main';

    // Create subscription in database
    const result = coordinator.subscribeToMerge(sessionId, input.branch, targetBranch);

    if (!result.success) {
      return {
        subscribed: false,
        message: result.message
      };
    }

    return {
      subscribed: true,
      message: `Subscribed to merge notifications for branch '${input.branch}' -> '${targetBranch}'. ` +
        `You will be notified when this branch is merged via the PostToolUse hook.`
    };
  } finally {
    coordinator.close();
  }
}

/**
 * Check if a branch has been merged to the target branch
 * v0.4: Queries merge_events table for recorded merges
 */
export async function checkMergeStatus(
  input: CheckMergeStatusInput
): Promise<CheckMergeStatusOutput> {
  const coordinator = new Coordinator();
  try {
    const repoPath = process.cwd();
    const result = coordinator.getBranchMergeStatus(repoPath, input.branch);

    if (result.isMerged && result.mergeEvent) {
      const event = result.mergeEvent;
      return {
        isMerged: true,
        mergeEvent: {
          branchName: event.branch_name,
          targetBranch: event.target_branch,
          sourceCommit: event.source_commit,
          targetCommit: event.target_commit,
          mergedAt: event.merged_at,
          detectedAt: event.detected_at
        },
        message: `Branch '${input.branch}' was merged to '${event.target_branch}' at ${event.merged_at}`
      };
    }

    return {
      isMerged: false,
      mergeEvent: null,
      message: `Branch '${input.branch}' has not been detected as merged. Note: Merges are detected by the 'parallel-cc watch-merges' daemon.`
    };
  } finally {
    coordinator.close();
  }
}

/**
 * Get all merge events for the current repository
 * v0.4: Returns list of detected merge events
 */
export async function getMergeEvents(
  input: GetMergeEventsInput
): Promise<GetMergeEventsOutput> {
  const coordinator = new Coordinator();
  try {
    const repoPath = input.repo_path || process.cwd();
    const limit = input.limit || 50;

    const allEvents = coordinator.getMergeEvents(repoPath);
    const events = allEvents.slice(0, limit);

    return {
      events: events.map(e => ({
        branchName: e.branch_name,
        targetBranch: e.target_branch,
        sourceCommit: e.source_commit,
        targetCommit: e.target_commit,
        mergedAt: e.merged_at,
        detectedAt: e.detected_at
      })),
      total: events.length
    };
  } finally {
    coordinator.close();
  }
}

/**
 * Check for conflicts between current branch and target branch
 * v0.4: Performs dry-run rebase to detect conflicts
 */
export async function checkConflicts(
  input: CheckConflictsInput
): Promise<CheckConflictsOutput> {
  const repoPath = process.cwd();

  try {
    // Fetch latest refs
    execSync('git fetch origin', { cwd: repoPath, stdio: 'pipe' });

    // Check if branches exist
    try {
      execSync(`git rev-parse --verify ${input.currentBranch}`, { cwd: repoPath, stdio: 'pipe' });
      execSync(`git rev-parse --verify origin/${input.targetBranch}`, { cwd: repoPath, stdio: 'pipe' });
    } catch (error) {
      return {
        hasConflicts: false,
        conflictingFiles: [],
        summary: `Error: One or both branches do not exist`,
        guidance: ['Ensure both branches exist before checking for conflicts']
      };
    }

    // Perform dry-run rebase check using merge-tree
    try {
      const result = execSync(
        `git merge-tree $(git merge-base ${input.currentBranch} origin/${input.targetBranch}) ${input.currentBranch} origin/${input.targetBranch}`,
        { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' }
      );

      // If merge-tree output contains conflict markers, we have conflicts
      const hasConflicts = result.includes('<<<<<<<');

      if (!hasConflicts) {
        return {
          hasConflicts: false,
          conflictingFiles: [],
          summary: `No conflicts detected between '${input.currentBranch}' and 'origin/${input.targetBranch}'`,
          guidance: ['You can safely rebase or merge']
        };
      }

      // Extract conflicting files from merge-tree output
      const conflictingFiles: string[] = [];
      const lines = result.split('\n');
      let currentFile = '';

      for (const line of lines) {
        // Look for file paths in merge-tree output
        if (line.startsWith('changed in both')) {
          const match = line.match(/changed in both\s+(.+)$/);
          if (match && match[1]) {
            currentFile = match[1].trim();
            if (!conflictingFiles.includes(currentFile)) {
              conflictingFiles.push(currentFile);
            }
          }
        } else if (line.includes('<<<<<<<') && currentFile && !conflictingFiles.includes(currentFile)) {
          conflictingFiles.push(currentFile);
        }
      }

      return {
        hasConflicts: true,
        conflictingFiles,
        summary: `Conflicts detected in ${conflictingFiles.length} file(s) between '${input.currentBranch}' and 'origin/${input.targetBranch}'`,
        guidance: [
          'Review the conflicting files before rebasing',
          'Consider coordinating with other developers working on these files',
          'Use the rebase_assist tool with checkOnly=false to start an interactive rebase'
        ]
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        hasConflicts: false,
        conflictingFiles: [],
        summary: `Unable to check for conflicts: ${errorMessage}`,
        guidance: ['Ensure both branches are up to date and try again']
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      hasConflicts: false,
      conflictingFiles: [],
      summary: `Error checking conflicts: ${errorMessage}`
    };
  }
}

/**
 * Assist with rebasing current branch onto target branch
 * v0.4: Performs conflict check or actual rebase
 */
export async function rebaseAssist(
  input: RebaseAssistInput
): Promise<RebaseAssistOutput> {
  const repoPath = process.cwd();

  try {
    // Fetch latest refs
    execSync('git fetch origin', { cwd: repoPath, stdio: 'pipe' });

    // Get current branch
    const currentBranch = execSync('git branch --show-current', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: 'pipe'
    }).trim();

    if (!currentBranch) {
      return {
        success: false,
        output: '',
        hasConflicts: false,
        conflictingFiles: [],
        conflictSummary: 'Error: Not on any branch (detached HEAD)',
        error: 'Cannot rebase in detached HEAD state'
      };
    }

    // If checkOnly, just check for conflicts
    if (input.checkOnly) {
      const conflictCheck = await checkConflicts({
        currentBranch,
        targetBranch: input.targetBranch
      });

      return {
        success: !conflictCheck.hasConflicts,
        output: conflictCheck.summary,
        hasConflicts: conflictCheck.hasConflicts,
        conflictingFiles: conflictCheck.conflictingFiles,
        conflictSummary: conflictCheck.summary
      };
    }

    // Perform actual rebase
    try {
      const output = execSync(`git rebase origin/${input.targetBranch}`, {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: 'pipe'
      });

      return {
        success: true,
        output: output,
        hasConflicts: false,
        conflictingFiles: [],
        conflictSummary: `Successfully rebased '${currentBranch}' onto 'origin/${input.targetBranch}'`
      };
    } catch (error) {
      // Rebase failed - likely due to conflicts
      const errorOutput = error instanceof Error && 'stdout' in error ?
        (error as any).stdout : '';

      // Get list of conflicting files
      let conflictingFiles: string[] = [];
      try {
        const conflictsOutput = execSync('git diff --name-only --diff-filter=U', {
          cwd: repoPath,
          encoding: 'utf-8',
          stdio: 'pipe'
        });
        conflictingFiles = conflictsOutput.trim().split('\n').filter(f => f.length > 0);
      } catch {
        // Could not get conflicting files
      }

      // Abort the rebase to leave repo in clean state
      try {
        execSync('git rebase --abort', { cwd: repoPath, stdio: 'pipe' });
      } catch {
        // Rebase abort failed
      }

      return {
        success: false,
        output: errorOutput,
        hasConflicts: true,
        conflictingFiles,
        conflictSummary: `Rebase failed with conflicts in ${conflictingFiles.length} file(s). Rebase has been aborted.`,
        error: 'Rebase failed due to conflicts'
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      output: '',
      hasConflicts: false,
      conflictingFiles: [],
      conflictSummary: `Error during rebase: ${errorMessage}`,
      error: errorMessage
    };
  }
}
