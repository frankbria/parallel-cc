/**
 * MCP tool implementations for parallel-cc
 */

import { Coordinator } from '../coordinator.js';
import { SessionDB } from '../db.js';
import { FileClaimsManager, ConflictError } from '../file-claims.js';
import { ConflictDetector } from '../conflict-detector.js';
import { ASTAnalyzer } from '../ast-analyzer.js';
import { AutoFixEngine } from '../auto-fix-engine.js';
import { ConfidenceScorer } from '../confidence-scorer.js';
import { createDefaultStrategyChain } from '../merge-strategies.js';
import { logger as defaultLogger } from '../logger.js';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * Validate that a string is a valid git ref name to prevent command injection
 * Git ref names cannot contain: space, ~, ^, :, ?, *, [, \, control chars
 * and cannot start with - or .
 */
function isValidGitRef(ref: string): boolean {
  if (!ref || ref.length > 255) return false;
  // Allow alphanumeric, dots, underscores, hyphens, and forward slashes
  // Must start with alphanumeric
  return /^[a-zA-Z0-9][a-zA-Z0-9._\/-]*$/.test(ref);
}

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
  RebaseAssistOutput,
  ClaimFileInput,
  ClaimFileOutput,
  ReleaseFileInput,
  ReleaseFileOutput,
  ListFileClaimsInput,
  ListFileClaimsOutput,
  DetectAdvancedConflictsInput,
  DetectAdvancedConflictsOutput,
  GetAutoFixSuggestionsInput,
  GetAutoFixSuggestionsOutput,
  ApplyAutoFixInput,
  ApplyAutoFixOutput,
  ConflictHistoryInput,
  ConflictHistoryOutput
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
      total: allEvents.length
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

  // Validate branch names to prevent command injection
  if (!isValidGitRef(input.currentBranch) || !isValidGitRef(input.targetBranch)) {
    return {
      hasConflicts: false,
      conflictingFiles: [],
      summary: 'Error: Invalid branch name format',
      guidance: ['Branch names contain invalid characters']
    };
  }

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

  // Validate target branch name to prevent command injection
  if (!isValidGitRef(input.targetBranch)) {
    return {
      success: false,
      output: '',
      hasConflicts: false,
      conflictingFiles: [],
      conflictSummary: 'Error: Invalid target branch name format',
      error: 'Target branch name contains invalid characters'
    };
  }

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

// ============================================================================
// v0.5 MCP Tools - File Claims, Advanced Conflicts, Auto-Fix
// ============================================================================

/**
 * Claim a file to prevent concurrent edits
 * v0.5: Acquire exclusive, shared, or intent claim on a file
 */
export async function claimFile(
  input: ClaimFileInput
): Promise<ClaimFileOutput> {
  const sessionId = process.env.PARALLEL_CC_SESSION_ID;

  if (!sessionId) {
    return {
      success: false,
      claimId: null,
      message: 'Not running in a parallel-cc managed session (PARALLEL_CC_SESSION_ID not set)'
    };
  }

  const coordinator = new Coordinator();
  try {
    const repoPath = process.cwd();
    const fileClaimsManager = new FileClaimsManager(coordinator.getDB(), defaultLogger);

    try {
      const claim = await fileClaimsManager.acquireClaim({
        sessionId,
        repoPath,
        filePath: input.filePath,
        mode: input.mode || 'EXCLUSIVE',
        reason: input.reason,
        ttlHours: input.ttlHours
      });

      return {
        success: true,
        claimId: claim.id,
        message: `Successfully acquired ${claim.claim_mode} claim on ${input.filePath} (expires at ${claim.expires_at})`
      };
    } catch (error) {
      if (error instanceof ConflictError) {
        // Return conflicting claim details
        const conflictingClaim = error.conflictingClaim;
        const session = coordinator.getDB().getSessionById(conflictingClaim.session_id);

        return {
          success: false,
          claimId: null,
          message: `Cannot acquire claim: ${error.message}`,
          conflictingClaims: [{
            claimId: conflictingClaim.id,
            sessionId: conflictingClaim.session_id,
            mode: conflictingClaim.claim_mode,
            claimedAt: conflictingClaim.claimed_at,
            expiresAt: conflictingClaim.expires_at
          }],
          escalationAvailable: input.mode === 'INTENT' || input.mode === 'SHARED'
        };
      }
      throw error;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      claimId: null,
      message: `Failed to acquire claim: ${errorMessage}`
    };
  } finally {
    coordinator.close();
  }
}

/**
 * Release a file claim
 * v0.5: Release a previously acquired claim
 */
export async function releaseFile(
  input: ReleaseFileInput
): Promise<ReleaseFileOutput> {
  const sessionId = process.env.PARALLEL_CC_SESSION_ID;

  if (!sessionId) {
    return {
      success: false,
      message: 'Not running in a parallel-cc managed session (PARALLEL_CC_SESSION_ID not set)'
    };
  }

  const coordinator = new Coordinator();
  try {
    const fileClaimsManager = new FileClaimsManager(coordinator.getDB(), defaultLogger);

    const released = await fileClaimsManager.releaseClaim(
      input.claimId,
      sessionId,
      input.force
    );

    if (released) {
      return {
        success: true,
        message: `Successfully released claim ${input.claimId}`,
        releasedAt: new Date().toISOString()
      };
    } else {
      return {
        success: false,
        message: `Claim ${input.claimId} not found or not owned by current session`
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to release claim: ${errorMessage}`
    };
  } finally {
    coordinator.close();
  }
}

/**
 * List active file claims
 * v0.5: Query file claims with filters
 */
export async function listFileClaims(
  input: ListFileClaimsInput
): Promise<ListFileClaimsOutput> {
  const coordinator = new Coordinator();
  try {
    const repoPath = process.cwd();
    const fileClaimsManager = new FileClaimsManager(coordinator.getDB(), defaultLogger);

    const claims = fileClaimsManager.listClaims({
      repoPath,
      sessionId: input.sessionId,
      filePaths: input.filePaths,
      includeExpired: input.includeExpired
    });

    // Get session info for each claim
    const claimsWithSessionInfo = claims.map(claim => {
      const session = coordinator.getDB().getSessionById(claim.session_id);
      const now = new Date();
      const expiresAt = new Date(claim.expires_at);
      const minutesUntilExpiry = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / (1000 * 60)));

      return {
        claimId: claim.id,
        filePath: claim.file_path,
        claimMode: claim.claim_mode,
        sessionId: claim.session_id,
        sessionPid: session?.pid || 0,
        worktreeName: session?.worktree_name || null,
        claimedAt: claim.claimed_at,
        expiresAt: claim.expires_at,
        minutesUntilExpiry,
        reason: claim.metadata?.reason as string | undefined
      };
    });

    return {
      claims: claimsWithSessionInfo,
      totalClaims: claimsWithSessionInfo.length
    };
  } finally {
    coordinator.close();
  }
}

/**
 * Detect advanced conflicts with semantic analysis
 * v0.5: Use ConflictDetector for AST-based conflict classification
 */
export async function detectAdvancedConflicts(
  input: DetectAdvancedConflictsInput
): Promise<DetectAdvancedConflictsOutput> {
  // Validate branch names
  if (!isValidGitRef(input.currentBranch) || !isValidGitRef(input.targetBranch)) {
    return {
      hasConflicts: false,
      conflicts: [],
      summary: {
        totalConflicts: 0,
        byType: {},
        bySeverity: {},
        autoFixableCount: 0
      }
    };
  }

  const repoPath = process.cwd();
  const astAnalyzer = new ASTAnalyzer();
  const conflictDetector = new ConflictDetector(repoPath, astAnalyzer, defaultLogger);

  try {
    const report = await conflictDetector.detectConflicts({
      currentBranch: input.currentBranch,
      targetBranch: input.targetBranch,
      analyzeSemantics: input.analyzeSemantics ?? true
    });

    // Estimate auto-fixable conflicts (TRIVIAL and some STRUCTURAL)
    const autoFixableCount = report.conflicts.filter(
      c => c.conflictType === 'TRIVIAL' || (c.conflictType === 'STRUCTURAL' && c.severity === 'LOW')
    ).length;

    return {
      hasConflicts: report.hasConflicts,
      conflicts: report.conflicts.map(c => ({
        filePath: c.filePath,
        conflictType: c.conflictType,
        severity: c.severity,
        markers: c.markers,
        analysis: c.analysis
      })),
      summary: {
        totalConflicts: report.summary.totalConflicts,
        byType: report.summary.byType,
        bySeverity: report.summary.bySeverity,
        autoFixableCount
      }
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      hasConflicts: false,
      conflicts: [],
      summary: {
        totalConflicts: 0,
        byType: { error: 1 },
        bySeverity: {},
        autoFixableCount: 0
      }
    };
  }
}

/**
 * Get auto-fix suggestions for conflicts
 * v0.5: Generate AI-powered resolution suggestions
 */
export async function getAutoFixSuggestions(
  input: GetAutoFixSuggestionsInput
): Promise<GetAutoFixSuggestionsOutput> {
  const repoPath = process.cwd();
  const coordinator = new Coordinator();

  try {
    // Detect conflicts first
    const astAnalyzer = new ASTAnalyzer();
    const conflictDetector = new ConflictDetector(repoPath, astAnalyzer, defaultLogger);

    const report = await conflictDetector.detectConflicts({
      currentBranch: input.currentBranch,
      targetBranch: input.targetBranch,
      analyzeSemantics: true
    });

    // Find conflict for the requested file
    const conflict = report.conflicts.find(c => c.filePath === input.filePath);
    if (!conflict) {
      return {
        suggestions: [],
        totalGenerated: 0,
        filteredByConfidence: 0
      };
    }

    // Generate suggestions
    const confidenceScorer = new ConfidenceScorer(astAnalyzer, defaultLogger);
    const strategyChain = createDefaultStrategyChain(astAnalyzer);
    const autoFixEngine = new AutoFixEngine(
      coordinator.getDB(),
      astAnalyzer,
      confidenceScorer,
      strategyChain,
      defaultLogger
    );

    const allSuggestions = await autoFixEngine.generateSuggestions({
      repoPath,
      filePath: input.filePath,
      conflict,
      maxSuggestions: input.maxSuggestions || 3
    });

    const minConfidence = input.minConfidence ?? 0.5;
    const filtered = allSuggestions.filter(s => s.confidence_score >= minConfidence);

    // Generate preview for each suggestion
    const suggestions = filtered.map(s => {
      const beforeLines = s.source_content.split('\n');
      const afterLines = s.suggested_resolution.split('\n');

      const linesAdded = afterLines.filter(line => !beforeLines.includes(line)).length;
      const linesRemoved = beforeLines.filter(line => !afterLines.includes(line)).length;

      const canAutoApply = s.confidence_score >= 0.7;
      const risks: string[] = [];

      if (s.confidence_score < 0.8) {
        risks.push('Medium confidence - review carefully before applying');
      }
      if (conflict.severity === 'HIGH') {
        risks.push('High severity conflict - may require manual review');
      }
      if (conflict.conflictType === 'SEMANTIC') {
        risks.push('Semantic conflict - verify business logic after applying');
      }

      return {
        suggestionId: s.id,
        confidence: s.confidence_score,
        strategy: s.strategy_used,
        explanation: s.explanation,
        preview: {
          beforeLines: beforeLines.slice(0, 10),
          afterLines: afterLines.slice(0, 10),
          diffStats: {
            linesAdded,
            linesRemoved
          }
        },
        conflictType: s.conflict_type,
        canAutoApply,
        risks
      };
    });

    return {
      suggestions,
      totalGenerated: allSuggestions.length,
      filteredByConfidence: allSuggestions.length - filtered.length
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to generate suggestions: ${errorMessage}`);
  } finally {
    coordinator.close();
  }
}

/**
 * Apply an auto-fix suggestion
 * v0.5: Apply AI-generated resolution with safety checks
 */
export async function applyAutoFix(
  input: ApplyAutoFixInput
): Promise<ApplyAutoFixOutput> {
  const coordinator = new Coordinator();

  try {
    const repoPath = process.cwd();
    const astAnalyzer = new ASTAnalyzer();
    const confidenceScorer = new ConfidenceScorer(astAnalyzer, defaultLogger);
    const strategyChain = createDefaultStrategyChain(astAnalyzer);

    const autoFixEngine = new AutoFixEngine(
      coordinator.getDB(),
      astAnalyzer,
      confidenceScorer,
      strategyChain,
      defaultLogger
    );

    const result = await autoFixEngine.applySuggestion({
      suggestionId: input.suggestionId,
      dryRun: input.dryRun ?? false,
      createBackup: input.createBackup ?? true
    });

    return {
      success: result.success,
      applied: result.applied,
      message: result.success
        ? `Auto-fix ${result.applied ? 'applied' : 'validated'} successfully`
        : result.error || 'Failed to apply auto-fix',
      filePath: result.filePath,
      backupPath: result.backupPath,
      rollbackCommand: result.rollbackCommand,
      verification: result.verification,
      metadata: result.metadata
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      applied: false,
      message: `Failed to apply auto-fix: ${errorMessage}`,
      filePath: '',
      verification: {
        conflictMarkersRemaining: -1,
        syntaxValid: false,
        diffStats: { linesChanged: 0 }
      },
      metadata: {
        suggestionId: input.suggestionId,
        confidence: 0,
        strategy: 'unknown',
        appliedAt: new Date().toISOString()
      }
    };
  } finally {
    coordinator.close();
  }
}

/**
 * Get conflict resolution history with statistics
 * v0.5: Query conflict resolutions and calculate metrics
 */
export async function conflictHistory(
  input: ConflictHistoryInput
): Promise<ConflictHistoryOutput> {
  const coordinator = new Coordinator();

  try {
    const repoPath = process.cwd();

    // Get conflict resolutions
    const allResolutions = coordinator.getDB().getConflictResolutions({
      repo_path: repoPath,
      file_path: input.filePath,
      conflict_type: input.conflictType,
      resolution_strategy: input.resolutionStrategy
    });

    // Paginate
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 20;
    const paginatedResolutions = allResolutions.slice(offset, offset + limit);

    // Get suggestions for each resolution to fetch strategies
    const history = paginatedResolutions.map(r => {
      let autoFixStrategy: string | undefined;
      let explanation: string | undefined;

      if (r.auto_fix_suggestion_id) {
        const suggestions = coordinator.getDB().getAutoFixSuggestions({
          id: r.auto_fix_suggestion_id
        });
        if (suggestions.length > 0) {
          autoFixStrategy = suggestions[0].strategy_used;
          explanation = suggestions[0].explanation;
        }
      }

      return {
        resolutionId: r.id,
        filePath: r.file_path,
        conflictType: r.conflict_type,
        resolutionStrategy: r.resolution_strategy,
        confidence: r.confidence_score,
        detectedAt: r.detected_at,
        resolvedAt: r.resolved_at,
        autoFixStrategy,
        wasAutoApplied: r.resolution_strategy === 'AUTO_FIX',
        explanation
      };
    });

    // Calculate statistics
    const totalResolutions = allResolutions.length;
    const autoFixCount = allResolutions.filter(r => r.resolution_strategy === 'AUTO_FIX').length;
    const autoFixRate = totalResolutions > 0 ? autoFixCount / totalResolutions : 0;

    const confidenceScores = allResolutions
      .filter(r => r.confidence_score !== null && r.confidence_score !== undefined)
      .map(r => r.confidence_score as number);
    const averageConfidence = confidenceScores.length > 0
      ? confidenceScores.reduce((a, b) => a + b, 0) / confidenceScores.length
      : 0;

    const byType: Record<string, number> = {};
    const byStrategy: Record<string, number> = {};

    allResolutions.forEach(r => {
      byType[r.conflict_type] = (byType[r.conflict_type] || 0) + 1;
      byStrategy[r.resolution_strategy] = (byStrategy[r.resolution_strategy] || 0) + 1;
    });

    return {
      history,
      statistics: {
        totalResolutions,
        autoFixRate,
        averageConfidence,
        byType,
        byStrategy
      },
      pagination: {
        offset,
        limit,
        total: totalResolutions
      }
    };
  } finally {
    coordinator.close();
  }
}
