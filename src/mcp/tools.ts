/**
 * MCP tool implementations for parallel-cc
 */

import { Coordinator } from '../coordinator.js';
import type {
  GetParallelStatusInput,
  GetParallelStatusOutput,
  GetMySessionOutput,
  NotifyWhenMergedInput,
  NotifyWhenMergedOutput
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
 * Note: This is a stub for v0.3. Full implementation in v0.4.
 * Currently just acknowledges the subscription.
 */
export async function notifyWhenMerged(
  input: NotifyWhenMergedInput
): Promise<NotifyWhenMergedOutput> {
  // v0.3: Just acknowledge the subscription
  // v0.4 will implement actual git polling and notifications
  return {
    subscribed: true,
    message: `Watching branch '${input.branch}' for merge. Note: Merge detection will be implemented in v0.4. Use 'get_parallel_status' to check current session states.`
  };
}
