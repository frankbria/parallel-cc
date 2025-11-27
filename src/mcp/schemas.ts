/**
 * Zod schemas for MCP tool inputs and outputs
 */

import { z } from 'zod';

// ============================================================================
// get_parallel_status schemas
// ============================================================================

export const GetParallelStatusInputSchema = {
  repo_path: z.string().optional().describe('Repository path (defaults to cwd)')
};

export const SessionInfoSchema = z.object({
  pid: z.number(),
  worktreePath: z.string(),
  worktreeName: z.string().nullable(),
  isMainRepo: z.boolean(),
  durationMinutes: z.number(),
  isAlive: z.boolean()
});

export const GetParallelStatusOutputSchema = {
  sessions: z.array(SessionInfoSchema),
  totalSessions: z.number()
};

export type GetParallelStatusInput = {
  repo_path?: string;
};

export type GetParallelStatusOutput = {
  sessions: Array<{
    pid: number;
    worktreePath: string;
    worktreeName: string | null;
    isMainRepo: boolean;
    durationMinutes: number;
    isAlive: boolean;
  }>;
  totalSessions: number;
};

// ============================================================================
// get_my_session schemas
// ============================================================================

export const GetMySessionInputSchema = {
  // No inputs - uses PARALLEL_CC_SESSION_ID env var
};

export const GetMySessionOutputSchema = {
  sessionId: z.string().nullable(),
  worktreePath: z.string().nullable(),
  worktreeName: z.string().nullable(),
  isMainRepo: z.boolean().nullable(),
  startedAt: z.string().nullable(),
  parallelSessions: z.number(),
  error: z.string().optional()
};

export type GetMySessionOutput = {
  sessionId: string | null;
  worktreePath: string | null;
  worktreeName: string | null;
  isMainRepo: boolean | null;
  startedAt: string | null;
  parallelSessions: number;
  error?: string;
};

// ============================================================================
// notify_when_merged schemas (stub for v0.3, full implementation in v0.4)
// ============================================================================

export const NotifyWhenMergedInputSchema = {
  branch: z.string().describe('Branch name to watch for merge')
};

export const NotifyWhenMergedOutputSchema = {
  subscribed: z.boolean(),
  message: z.string()
};

export type NotifyWhenMergedInput = {
  branch: string;
};

export type NotifyWhenMergedOutput = {
  subscribed: boolean;
  message: string;
};
