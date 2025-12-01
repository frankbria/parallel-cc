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
// notify_when_merged schemas (v0.4)
// ============================================================================

export const NotifyWhenMergedInputSchema = {
  branch: z.string().describe('Branch name to watch for merge'),
  targetBranch: z.string().optional().default('main').describe('Target branch (default: main)')
};

export const NotifyWhenMergedOutputSchema = {
  subscribed: z.boolean(),
  message: z.string()
};

export type NotifyWhenMergedInput = {
  branch: string;
  targetBranch?: string;
};

export type NotifyWhenMergedOutput = {
  subscribed: boolean;
  message: string;
};

// ============================================================================
// check_merge_status schemas (v0.4)
// ============================================================================

export const MergeEventInfoSchema = z.object({
  branchName: z.string(),
  targetBranch: z.string(),
  sourceCommit: z.string(),
  targetCommit: z.string(),
  mergedAt: z.string(),
  detectedAt: z.string()
});

export const CheckMergeStatusInputSchema = {
  branch: z.string().describe('Branch name to check merge status for')
};

export const CheckMergeStatusOutputSchema = {
  isMerged: z.boolean(),
  mergeEvent: MergeEventInfoSchema.nullable(),
  message: z.string()
};

export type MergeEventInfo = {
  branchName: string;
  targetBranch: string;
  sourceCommit: string;
  targetCommit: string;
  mergedAt: string;
  detectedAt: string;
};

export type CheckMergeStatusInput = {
  branch: string;
};

export type CheckMergeStatusOutput = {
  isMerged: boolean;
  mergeEvent: MergeEventInfo | null;
  message: string;
};

// ============================================================================
// check_conflicts schemas (v0.4)
// ============================================================================

export const CheckConflictsInputSchema = {
  currentBranch: z.string().describe('Current branch name'),
  targetBranch: z.string().describe('Target branch to check conflicts against')
};

export const CheckConflictsOutputSchema = {
  hasConflicts: z.boolean(),
  conflictingFiles: z.array(z.string()),
  summary: z.string(),
  guidance: z.array(z.string()).optional()
};

export type CheckConflictsInput = {
  currentBranch: string;
  targetBranch: string;
};

export type CheckConflictsOutput = {
  hasConflicts: boolean;
  conflictingFiles: string[];
  summary: string;
  guidance?: string[];
};

// ============================================================================
// rebase_assist schemas (v0.4)
// ============================================================================

export const RebaseAssistInputSchema = {
  targetBranch: z.string().describe('Target branch to rebase onto'),
  checkOnly: z.boolean().optional().default(false).describe('If true, only check for conflicts without performing rebase')
};

export const RebaseAssistOutputSchema = {
  success: z.boolean(),
  output: z.string(),
  hasConflicts: z.boolean(),
  conflictingFiles: z.array(z.string()),
  conflictSummary: z.string(),
  error: z.string().optional()
};

export type RebaseAssistInput = {
  targetBranch: string;
  checkOnly?: boolean;
};

export type RebaseAssistOutput = {
  success: boolean;
  output: string;
  hasConflicts: boolean;
  conflictingFiles: string[];
  conflictSummary: string;
  error?: string;
};

// ============================================================================
// get_merge_events schemas (v0.4)
// ============================================================================

export const GetMergeEventsInputSchema = {
  repo_path: z.string().optional().describe('Repository path (defaults to cwd)'),
  limit: z.number().optional().default(50).describe('Maximum number of merge events to return (default: 50)')
};

export const GetMergeEventsOutputSchema = {
  events: z.array(MergeEventInfoSchema),
  total: z.number()
};

export type GetMergeEventsInput = {
  repo_path?: string;
  limit?: number;
};

export type GetMergeEventsOutput = {
  events: MergeEventInfo[];
  total: number;
};
