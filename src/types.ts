/**
 * Core type definitions for parallel-cc
 */

// ============================================================================
// E2B Sandbox Types (v1.0) - Defined early for use in Session interface
// ============================================================================

/**
 * Execution mode for sessions
 */
export type ExecutionMode = 'local' | 'e2b';

/**
 * E2B sandbox status
 */
export enum SandboxStatus {
  INITIALIZING = 'INITIALIZING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  TIMEOUT = 'TIMEOUT'
}

// ============================================================================
// Core Session Types
// ============================================================================

export interface Session {
  id: string;
  pid: number;
  repo_path: string;
  worktree_path: string;
  worktree_name: string | null;
  is_main_repo: boolean;
  created_at: string;
  last_heartbeat: string;
  // v1.0: Optional E2B fields (for backward compatibility)
  execution_mode?: ExecutionMode;
  sandbox_id?: string | null;
  prompt?: string | null;
  status?: string | null;
  output_log?: string | null;
  // v1.1: Git configuration tracking
  git_user?: string | null;
  git_email?: string | null;
  ssh_key_provided?: boolean;
  // v1.1: Cost tracking
  budget_limit?: number | null;
  cost_estimate?: number | null;
  actual_cost?: number | null;
  // v1.1: Template tracking
  template_name?: string | null;
}

export interface SessionRow {
  id: string;
  pid: number;
  repo_path: string;
  worktree_path: string;
  worktree_name: string | null;
  is_main_repo: number; // SQLite stores booleans as 0/1
  created_at: string;
  last_heartbeat: string;
  // v1.0: Optional E2B fields (for backward compatibility)
  execution_mode?: ExecutionMode;
  sandbox_id?: string | null;
  prompt?: string | null;
  status?: string | null;
  output_log?: string | null;
  // v1.1: Git configuration tracking
  git_user?: string | null;
  git_email?: string | null;
  ssh_key_provided?: number; // SQLite stores booleans as 0/1
  // v1.1: Cost tracking
  budget_limit?: number | null;
  cost_estimate?: number | null;
  actual_cost?: number | null;
  // v1.1: Template tracking
  template_name?: string | null;
}

export interface RegisterResult {
  sessionId: string;
  worktreePath: string;
  worktreeName: string | null;
  isNew: boolean;
  isMainRepo: boolean;
  parallelSessions: number;
}

export interface StatusResult {
  repoPath: string;
  totalSessions: number;
  sessions: SessionInfo[];
}

export interface SessionInfo {
  sessionId: string;
  pid: number;
  worktreePath: string;
  worktreeName: string | null;
  isMainRepo: boolean;
  createdAt: string;
  lastHeartbeat: string;
  isAlive: boolean;
  durationMinutes: number;
}

export interface CleanupResult {
  removed: number;
  sessions: string[];
  worktreesRemoved: string[];
}

export interface GtrResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface GtrListEntry {
  branch: string;
  path: string;
  isMain: boolean;
}

// Configuration
export interface Config {
  dbPath: string;
  staleThresholdMinutes: number;
  autoCleanupWorktrees: boolean;
  worktreePrefix: string;
}

export const DEFAULT_CONFIG: Config = {
  dbPath: '~/.parallel-cc/coordinator.db',
  staleThresholdMinutes: 10,
  autoCleanupWorktrees: true,
  worktreePrefix: 'parallel-'
};

// ============================================================================
// Merge Detection Types (v0.4)
// ============================================================================

/**
 * Database row for merge_events table
 */
export interface MergeEventRow {
  id: string;
  repo_path: string;
  branch_name: string;
  source_commit: string;
  target_branch: string;
  target_commit: string;
  merged_at: string;
  detected_at: string;
  notification_sent: number; // SQLite boolean (0/1)
}

/**
 * Merge event model (TypeScript booleans)
 */
export interface MergeEvent {
  id: string;
  repo_path: string;
  branch_name: string;
  source_commit: string;
  target_branch: string;
  target_commit: string;
  merged_at: string;
  detected_at: string;
  notification_sent: boolean;
}

/**
 * Database row for subscriptions table
 */
export interface SubscriptionRow {
  id: string;
  session_id: string;
  repo_path: string;
  branch_name: string;
  target_branch: string;
  created_at: string;
  notified_at: string | null;
  is_active: number; // SQLite boolean (0/1)
}

/**
 * Subscription model (TypeScript booleans)
 */
export interface Subscription {
  id: string;
  session_id: string;
  repo_path: string;
  branch_name: string;
  target_branch: string;
  created_at: string;
  notified_at: string | null;
  is_active: boolean;
}

/**
 * Result of merge detection poll
 */
export interface MergeDetectionResult {
  newMerges: MergeEvent[];
  notificationsSent: number;
  subscriptionsChecked: number;
  errors: string[];
}

/**
 * Conflict detection result
 */
export interface ConflictInfo {
  hasConflicts: boolean;
  conflictingFiles: string[];
  summary: string;
}

/**
 * Rebase assistance result
 */
export interface RebaseResult {
  success: boolean;
  output: string;
  conflicts?: ConflictInfo;
  error?: string;
}

/**
 * Branch status information
 */
export interface BranchStatus {
  name: string;
  commit: string;
  upstreamBranch: string | null;
  isMerged: boolean;
  behindBy: number;
  aheadBy: number;
}

// ============================================================================
// v0.5 Types - File Claims, Conflict Resolution, Auto-Fix Suggestions
// ============================================================================

/**
 * Claim mode for file access locks
 */
export type ClaimMode = 'EXCLUSIVE' | 'SHARED' | 'INTENT';

/**
 * Type of conflict detected
 */
export type ConflictType = 'STRUCTURAL' | 'SEMANTIC' | 'CONCURRENT_EDIT' | 'TRIVIAL' | 'UNKNOWN';

/**
 * Strategy used to resolve a conflict
 */
export type ResolutionStrategy = 'AUTO_FIX' | 'MANUAL' | 'HYBRID' | 'ABANDONED';

/**
 * Database row for file_claims table
 */
export interface FileClaimRow {
  id: string;
  session_id: string;
  repo_path: string;
  file_path: string;
  claim_mode: ClaimMode;
  claimed_at: string;
  expires_at: string;
  last_heartbeat: string;
  escalated_from: string | null;
  metadata: string | null;
  is_active: number; // SQLite boolean (0/1)
  released_at: string | null;
  deleted_at: string | null;
  deleted_reason: string | null;
}

/**
 * File claim model (TypeScript booleans)
 */
export interface FileClaim {
  id: string;
  session_id: string;
  repo_path: string;
  file_path: string;
  claim_mode: ClaimMode;
  claimed_at: string;
  expires_at: string;
  last_heartbeat: string;
  escalated_from?: string;
  metadata?: Record<string, unknown>;
  is_active: boolean;
  released_at?: string;
  deleted_at?: string;
  deleted_reason?: string;
}

/**
 * Database row for conflict_resolutions table
 */
export interface ConflictResolutionRow {
  id: string;
  session_id: string | null;
  repo_path: string;
  file_path: string;
  conflict_type: ConflictType;
  base_commit: string;
  source_commit: string;
  target_commit: string;
  resolution_strategy: ResolutionStrategy;
  confidence_score: number | null;
  conflict_markers: string;
  resolved_content: string | null;
  detected_at: string;
  resolved_at: string | null;
  auto_fix_suggestion_id: string | null;
  metadata: string | null;
  deleted_at: string | null;
  deleted_reason: string | null;
}

/**
 * Conflict resolution model (TypeScript types)
 */
export interface ConflictResolution {
  id: string;
  session_id?: string;
  repo_path: string;
  file_path: string;
  conflict_type: ConflictType;
  base_commit: string;
  source_commit: string;
  target_commit: string;
  resolution_strategy: ResolutionStrategy;
  confidence_score?: number;
  conflict_markers: string;
  resolved_content?: string;
  detected_at: string;
  resolved_at?: string;
  auto_fix_suggestion_id?: string;
  metadata?: Record<string, unknown>;
  deleted_at?: string;
  deleted_reason?: string;
}

/**
 * Database row for auto_fix_suggestions table
 */
export interface AutoFixSuggestionRow {
  id: string;
  conflict_resolution_id: string | null;
  repo_path: string;
  file_path: string;
  conflict_type: ConflictType;
  suggested_resolution: string;
  confidence_score: number;
  explanation: string;
  strategy_used: string;
  base_content: string;
  source_content: string;
  target_content: string;
  generated_at: string;
  applied_at: string | null;
  was_auto_applied: number; // SQLite boolean (0/1)
  metadata: string | null;
  deleted_at: string | null;
  deleted_reason: string | null;
}

/**
 * Auto-fix suggestion model (TypeScript types)
 */
export interface AutoFixSuggestion {
  id: string;
  conflict_resolution_id?: string;
  repo_path: string;
  file_path: string;
  conflict_type: ConflictType;
  suggested_resolution: string;
  confidence_score: number;
  explanation: string;
  strategy_used: string;
  base_content: string;
  source_content: string;
  target_content: string;
  generated_at: string;
  applied_at?: string;
  was_auto_applied: boolean;
  metadata?: Record<string, unknown>;
  deleted_at?: string;
  deleted_reason?: string;
}

/**
 * Parameters for acquiring a file claim
 */
export interface AcquireClaimParams {
  session_id: string;
  repo_path: string;
  file_path: string;
  claim_mode: ClaimMode;
  ttl_hours?: number; // Default: 24
  escalated_from?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Filters for querying file claims
 */
export interface ClaimFilters {
  session_id?: string;
  repo_path?: string;
  file_path?: string;
  claim_mode?: ClaimMode;
  is_active?: boolean;
  include_stale?: boolean;
}

/**
 * Parameters for creating a conflict resolution
 */
export interface CreateConflictResolutionParams {
  session_id?: string;
  repo_path: string;
  file_path: string;
  conflict_type: ConflictType;
  base_commit: string;
  source_commit: string;
  target_commit: string;
  resolution_strategy: ResolutionStrategy;
  confidence_score?: number;
  conflict_markers: string;
  resolved_content?: string;
  auto_fix_suggestion_id?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Filters for querying conflict resolutions
 */
export interface ConflictFilters {
  session_id?: string;
  repo_path?: string;
  file_path?: string;
  conflict_type?: ConflictType;
  resolution_strategy?: ResolutionStrategy;
  is_resolved?: boolean;
  min_confidence?: number;
}

/**
 * Parameters for creating an auto-fix suggestion
 */
export interface CreateAutoFixSuggestionParams {
  conflict_resolution_id?: string;
  repo_path: string;
  file_path: string;
  conflict_type: ConflictType;
  suggested_resolution: string;
  confidence_score: number;
  explanation: string;
  strategy_used: string;
  base_content: string;
  source_content: string;
  target_content: string;
  metadata?: Record<string, unknown>;
}

/**
 * Filters for querying auto-fix suggestions
 */
export interface SuggestionFilters {
  id?: string;
  conflict_resolution_id?: string;
  repo_path?: string;
  file_path?: string;
  conflict_type?: ConflictType;
  is_applied?: boolean;
  min_confidence?: number;
}

// Note: ExecutionMode and SandboxStatus are defined at the top of the file

/**
 * E2B session configuration
 */
export interface E2BSessionConfig {
  claudeVersion?: string; // e.g., "1.0.0" or "latest"
  e2bSdkVersion: string; // Pin E2B SDK version
  sandboxImage: string; // Recommended: "anthropic-claude-code" (pre-installed Claude Code). Fallback: "base" or custom images auto-install via apt-get (Debian/Ubuntu required) then npm install -g @anthropic-ai/claude-code
  timeoutMinutes?: number; // Default: 60
  warningThresholds?: number[]; // Default: [30, 50] minutes
  budgetWarningThresholds?: number[]; // Default: [0.5, 0.8] (50%, 80% of budget)
}

/**
 * E2B session extends base session with sandbox-specific fields
 */
export interface E2BSession extends Session {
  execution_mode: 'e2b';
  sandbox_id: string;
  prompt: string;
  status: SandboxStatus;
  output_log?: string;
}

/**
 * E2B session database row (SQLite representation)
 */
export interface E2BSessionRow extends SessionRow {
  execution_mode: ExecutionMode;
  sandbox_id: string | null;
  prompt: string | null;
  status: string | null;
  output_log: string | null;
}

/**
 * Sandbox health check result
 */
export interface SandboxHealthCheck {
  isHealthy: boolean;
  sandboxId: string;
  status: SandboxStatus;
  lastHeartbeat: Date;
  message?: string;
  error?: string;
}

/**
 * Sandbox termination result
 */
export interface SandboxTerminationResult {
  success: boolean;
  sandboxId: string;
  cleanedUp: boolean;
  error?: string;
}

/**
 * Sandbox timeout warning
 */
export interface TimeoutWarning {
  sandboxId: string;
  elapsedMinutes: number;
  warningLevel: 'soft' | 'hard';
  message: string;
  estimatedCost?: string;
}

// ============================================================================
// Type Guards (v1.0)
// ============================================================================

/**
 * Type guard to check if a session is an E2B session
 *
 * @param session - Session to check
 * @returns true if session is E2BSession
 */
export function isE2BSession(session: Session | E2BSession): session is E2BSession {
  return 'execution_mode' in session && session.execution_mode === 'e2b';
}

/**
 * Type guard to check if a session is a local session
 *
 * @param session - Session to check
 * @returns true if session is a standard local Session
 */
export function isLocalSession(session: Session | E2BSession): session is Session {
  return !('execution_mode' in session) || session.execution_mode === 'local';
}

// ============================================================================
// Budget Tracking Types (v1.1)
// ============================================================================

/**
 * Budget period type for tracking spending over time
 */
export type BudgetPeriod = 'daily' | 'weekly' | 'monthly';

/**
 * Database row for budget_tracking table
 */
export interface BudgetTrackingRow {
  id: string;
  period: BudgetPeriod;
  period_start: string;
  budget_limit: number | null;
  spent: number;
  created_at: string;
}

/**
 * Budget tracking model (TypeScript types)
 */
export interface BudgetTracking {
  id: string;
  period: BudgetPeriod;
  periodStart: string;
  budgetLimit?: number;
  spent: number;
  createdAt: string;
}

/**
 * Budget configuration for user settings
 */
export interface BudgetConfig {
  /** Monthly spending limit in USD */
  monthlyLimit?: number;
  /** Default per-session budget in USD */
  perSessionDefault?: number;
  /** Warning thresholds as percentages (e.g., [0.5, 0.8] for 50% and 80%) */
  warningThresholds?: number[];
  /** E2B hourly rate in USD (default: 0.10) - allows updating if pricing changes */
  e2bHourlyRate?: number;
}

/**
 * Budget status report for CLI command
 */
export interface BudgetStatus {
  currentPeriod: {
    period: BudgetPeriod;
    start: string;
    limit?: number;
    spent: number;
    remaining?: number;
  };
  sessions: Array<{
    sessionId: string;
    sandboxId?: string;
    budgetLimit?: number;
    costEstimate?: number;
    status?: string;
    createdAt: string;
  }>;
  totalSpent: number;
  remainingBudget?: number;
}

/**
 * Budget warning during sandbox execution (similar to TimeoutWarning)
 */
export interface BudgetWarning {
  sandboxId: string;
  currentCost: number;
  budgetLimit: number;
  percentUsed: number;
  warningLevel: 'soft' | 'hard';
  message: string;
}

/**
 * Error thrown when budget is exceeded
 */
export class BudgetExceededError extends Error {
  public readonly sandboxId: string;
  public readonly currentCost: number;
  public readonly budgetLimit: number;

  constructor(sandboxId: string, currentCost: number, budgetLimit: number) {
    super(`Budget exceeded for sandbox ${sandboxId}: $${currentCost.toFixed(2)} >= $${budgetLimit.toFixed(2)}`);
    this.name = 'BudgetExceededError';
    this.sandboxId = sandboxId;
    this.currentCost = currentCost;
    this.budgetLimit = budgetLimit;
  }
}

// ============================================================================
// Sandbox Template Types (v1.1)
// ============================================================================

/**
 * Template type identifier
 */
export type TemplateType = 'built-in' | 'custom';

/**
 * Template metadata for additional context
 */
export interface TemplateMetadata {
  author?: string;
  version?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Sandbox template definition (JSON serializable)
 */
export interface SandboxTemplate {
  name: string;
  description: string;
  e2bTemplate: string;
  setupCommands?: string[];
  environment?: Record<string, string>;
  metadata?: TemplateMetadata;
}

/**
 * Template with type information for listing
 */
export interface TemplateListEntry {
  name: string;
  description: string;
  type: TemplateType;
  e2bTemplate: string;
}

/**
 * Result of template operations
 */
export interface TemplateOperationResult {
  success: boolean;
  message: string;
  template?: SandboxTemplate;
  error?: string;
}

/**
 * Result of template validation
 */
export interface TemplateValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * Project type detection result
 */
export interface ProjectTypeDetection {
  detected: boolean;
  suggestedTemplate?: string;
  reason?: string;
  detectedFiles?: string[];
}
