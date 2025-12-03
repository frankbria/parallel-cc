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

// ============================================================================
// claim_file schemas (v0.5)
// ============================================================================

export const ClaimFileInputSchema = {
  filePath: z.string().describe('Relative path from repository root'),
  mode: z.enum(['EXCLUSIVE', 'SHARED', 'INTENT']).default('EXCLUSIVE').describe('Claim mode: EXCLUSIVE blocks all, SHARED allows read, INTENT is non-blocking'),
  reason: z.string().optional().describe('Why claiming this file'),
  ttlHours: z.number().min(1).max(72).default(24).describe('Time-to-live in hours (default: 24)')
};

export const ConflictingClaimSchema = z.object({
  claimId: z.string(),
  sessionId: z.string(),
  mode: z.string(),
  claimedAt: z.string(),
  expiresAt: z.string()
});

export const ClaimFileOutputSchema = {
  success: z.boolean(),
  claimId: z.string().nullable(),
  message: z.string(),
  conflictingClaims: z.array(ConflictingClaimSchema).optional(),
  escalationAvailable: z.boolean().optional()
};

export type ClaimFileInput = {
  filePath: string;
  mode?: 'EXCLUSIVE' | 'SHARED' | 'INTENT';
  reason?: string;
  ttlHours?: number;
};

export type ClaimFileOutput = {
  success: boolean;
  claimId: string | null;
  message: string;
  conflictingClaims?: Array<{
    claimId: string;
    sessionId: string;
    mode: string;
    claimedAt: string;
    expiresAt: string;
  }>;
  escalationAvailable?: boolean;
};

// ============================================================================
// release_file schemas (v0.5)
// ============================================================================

export const ReleaseFileInputSchema = {
  claimId: z.string().uuid().describe('Claim ID to release'),
  force: z.boolean().default(false).describe('Force release even if not owned')
};

export const ReleaseFileOutputSchema = {
  success: z.boolean(),
  message: z.string(),
  releasedAt: z.string().optional()
};

export type ReleaseFileInput = {
  claimId: string;
  force?: boolean;
};

export type ReleaseFileOutput = {
  success: boolean;
  message: string;
  releasedAt?: string;
};

// ============================================================================
// list_file_claims schemas (v0.5)
// ============================================================================

export const ListFileClaimsInputSchema = {
  filePaths: z.array(z.string()).optional().describe('Filter by specific file paths'),
  sessionId: z.string().optional().describe('Filter by session ID'),
  includeExpired: z.boolean().default(false).describe('Include expired claims')
};

export const FileClaimInfoSchema = z.object({
  claimId: z.string(),
  filePath: z.string(),
  claimMode: z.enum(['EXCLUSIVE', 'SHARED', 'INTENT']),
  sessionId: z.string(),
  sessionPid: z.number(),
  worktreeName: z.string().nullable(),
  claimedAt: z.string(),
  expiresAt: z.string(),
  minutesUntilExpiry: z.number(),
  reason: z.string().optional()
});

export const ListFileClaimsOutputSchema = {
  claims: z.array(FileClaimInfoSchema),
  totalClaims: z.number()
};

export type ListFileClaimsInput = {
  filePaths?: string[];
  sessionId?: string;
  includeExpired?: boolean;
};

export type ListFileClaimsOutput = {
  claims: Array<{
    claimId: string;
    filePath: string;
    claimMode: 'EXCLUSIVE' | 'SHARED' | 'INTENT';
    sessionId: string;
    sessionPid: number;
    worktreeName: string | null;
    claimedAt: string;
    expiresAt: string;
    minutesUntilExpiry: number;
    reason?: string;
  }>;
  totalClaims: number;
};

// ============================================================================
// detect_advanced_conflicts schemas (v0.5)
// ============================================================================

export const DetectAdvancedConflictsInputSchema = {
  currentBranch: z.string().describe('Current branch name'),
  targetBranch: z.string().describe('Target branch name'),
  analyzeSemantics: z.boolean().default(true).describe('Perform AST-based semantic analysis')
};

export const ConflictMarkerSchema = z.object({
  start: z.number(),
  divider: z.number(),
  end: z.number(),
  oursContent: z.string(),
  theirsContent: z.string()
});

export const ConflictAnalysisSchema = z.object({
  astDiff: z.any().optional(),
  semanticContext: z.string().optional()
});

export const AdvancedConflictSchema = z.object({
  filePath: z.string(),
  conflictType: z.enum(['STRUCTURAL', 'SEMANTIC', 'CONCURRENT_EDIT', 'TRIVIAL', 'UNKNOWN']),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  markers: z.array(ConflictMarkerSchema),
  analysis: ConflictAnalysisSchema.optional()
});

export const ConflictSummarySchema = z.object({
  totalConflicts: z.number(),
  byType: z.record(z.string(), z.number()),
  bySeverity: z.record(z.string(), z.number()),
  autoFixableCount: z.number()
});

export const DetectAdvancedConflictsOutputSchema = {
  hasConflicts: z.boolean(),
  conflicts: z.array(AdvancedConflictSchema),
  summary: ConflictSummarySchema
};

export type DetectAdvancedConflictsInput = {
  currentBranch: string;
  targetBranch: string;
  analyzeSemantics?: boolean;
};

export type DetectAdvancedConflictsOutput = {
  hasConflicts: boolean;
  conflicts: Array<{
    filePath: string;
    conflictType: 'STRUCTURAL' | 'SEMANTIC' | 'CONCURRENT_EDIT' | 'TRIVIAL' | 'UNKNOWN';
    severity: 'LOW' | 'MEDIUM' | 'HIGH';
    markers: Array<{
      start: number;
      divider: number;
      end: number;
      oursContent: string;
      theirsContent: string;
    }>;
    analysis?: {
      astDiff?: any;
      semanticContext?: string;
    };
  }>;
  summary: {
    totalConflicts: number;
    byType: Record<string, number>;
    bySeverity: Record<string, number>;
    autoFixableCount: number;
  };
};

// ============================================================================
// get_auto_fix_suggestions schemas (v0.5)
// ============================================================================

export const GetAutoFixSuggestionsInputSchema = {
  filePath: z.string().describe('File path with conflicts'),
  currentBranch: z.string().describe('Current branch name'),
  targetBranch: z.string().describe('Target branch name'),
  minConfidence: z.number().min(0).max(1).default(0.5).describe('Minimum confidence threshold (0-1)'),
  maxSuggestions: z.number().min(1).max(10).default(3).describe('Maximum suggestions to return')
};

export const SuggestionPreviewSchema = z.object({
  beforeLines: z.array(z.string()),
  afterLines: z.array(z.string()),
  diffStats: z.object({
    linesAdded: z.number(),
    linesRemoved: z.number()
  })
});

export const AutoFixSuggestionSchema = z.object({
  suggestionId: z.string(),
  confidence: z.number(),
  strategy: z.string(),
  explanation: z.string(),
  preview: SuggestionPreviewSchema,
  conflictType: z.string(),
  canAutoApply: z.boolean(),
  risks: z.array(z.string())
});

export const GetAutoFixSuggestionsOutputSchema = {
  suggestions: z.array(AutoFixSuggestionSchema),
  totalGenerated: z.number(),
  filteredByConfidence: z.number()
};

export type GetAutoFixSuggestionsInput = {
  filePath: string;
  currentBranch: string;
  targetBranch: string;
  minConfidence?: number;
  maxSuggestions?: number;
};

export type GetAutoFixSuggestionsOutput = {
  suggestions: Array<{
    suggestionId: string;
    confidence: number;
    strategy: string;
    explanation: string;
    preview: {
      beforeLines: string[];
      afterLines: string[];
      diffStats: {
        linesAdded: number;
        linesRemoved: number;
      };
    };
    conflictType: string;
    canAutoApply: boolean;
    risks: string[];
  }>;
  totalGenerated: number;
  filteredByConfidence: number;
};

// ============================================================================
// apply_auto_fix schemas (v0.5)
// ============================================================================

export const ApplyAutoFixInputSchema = {
  suggestionId: z.string().uuid().describe('Suggestion ID to apply'),
  dryRun: z.boolean().default(false).describe('Validate only without writing'),
  createBackup: z.boolean().default(true).describe('Create backup before applying')
};

export const VerificationResultSchema = z.object({
  conflictMarkersRemaining: z.number(),
  syntaxValid: z.boolean(),
  diffStats: z.object({
    linesChanged: z.number()
  })
});

export const SuggestionMetadataSchema = z.object({
  suggestionId: z.string(),
  confidence: z.number(),
  strategy: z.string(),
  appliedAt: z.string()
});

export const ApplyAutoFixOutputSchema = {
  success: z.boolean(),
  applied: z.boolean(),
  message: z.string(),
  filePath: z.string(),
  backupPath: z.string().optional(),
  rollbackCommand: z.string().optional(),
  verification: VerificationResultSchema,
  metadata: SuggestionMetadataSchema
};

export type ApplyAutoFixInput = {
  suggestionId: string;
  dryRun?: boolean;
  createBackup?: boolean;
};

export type ApplyAutoFixOutput = {
  success: boolean;
  applied: boolean;
  message: string;
  filePath: string;
  backupPath?: string;
  rollbackCommand?: string;
  verification: {
    conflictMarkersRemaining: number;
    syntaxValid: boolean;
    diffStats: {
      linesChanged: number;
    };
  };
  metadata: {
    suggestionId: string;
    confidence: number;
    strategy: string;
    appliedAt: string;
  };
};

// ============================================================================
// conflict_history schemas (v0.5)
// ============================================================================

export const ConflictHistoryInputSchema = {
  filePath: z.string().optional().describe('Filter by file path'),
  conflictType: z.enum(['STRUCTURAL', 'SEMANTIC', 'CONCURRENT_EDIT', 'TRIVIAL']).optional().describe('Filter by conflict type'),
  resolutionStrategy: z.enum(['AUTO_FIX', 'MANUAL', 'HYBRID', 'ABANDONED']).optional().describe('Filter by resolution strategy'),
  limit: z.number().min(1).max(100).default(20).describe('Maximum results to return'),
  offset: z.number().min(0).default(0).describe('Pagination offset')
};

export const ConflictResolutionHistorySchema = z.object({
  resolutionId: z.string(),
  filePath: z.string(),
  conflictType: z.string(),
  resolutionStrategy: z.string(),
  confidence: z.number().optional(),
  detectedAt: z.string(),
  resolvedAt: z.string().optional(),
  autoFixStrategy: z.string().optional(),
  wasAutoApplied: z.boolean(),
  explanation: z.string().optional()
});

export const ConflictStatisticsSchema = z.object({
  totalResolutions: z.number(),
  autoFixRate: z.number(),
  averageConfidence: z.number(),
  byType: z.record(z.string(), z.number()),
  byStrategy: z.record(z.string(), z.number())
});

export const PaginationSchema = z.object({
  offset: z.number(),
  limit: z.number(),
  total: z.number()
});

export const ConflictHistoryOutputSchema = {
  history: z.array(ConflictResolutionHistorySchema),
  statistics: ConflictStatisticsSchema,
  pagination: PaginationSchema
};

export type ConflictHistoryInput = {
  filePath?: string;
  conflictType?: 'STRUCTURAL' | 'SEMANTIC' | 'CONCURRENT_EDIT' | 'TRIVIAL';
  resolutionStrategy?: 'AUTO_FIX' | 'MANUAL' | 'HYBRID' | 'ABANDONED';
  limit?: number;
  offset?: number;
};

export type ConflictHistoryOutput = {
  history: Array<{
    resolutionId: string;
    filePath: string;
    conflictType: string;
    resolutionStrategy: string;
    confidence?: number;
    detectedAt: string;
    resolvedAt?: string;
    autoFixStrategy?: string;
    wasAutoApplied: boolean;
    explanation?: string;
  }>;
  statistics: {
    totalResolutions: number;
    autoFixRate: number;
    averageConfidence: number;
    byType: Record<string, number>;
    byStrategy: Record<string, number>;
  };
  pagination: {
    offset: number;
    limit: number;
    total: number;
  };
};
