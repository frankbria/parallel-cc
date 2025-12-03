/**
 * File Claims Manager for parallel-cc v0.5
 *
 * Manages file access claims across parallel sessions to prevent concurrent editing conflicts.
 * Implements three claim modes: EXCLUSIVE (blocks all), SHARED (allows read), INTENT (non-blocking).
 */

import { SessionDB } from './db.js';
import { Logger, logger as defaultLogger } from './logger.js';
import { validateFilePath } from './db-validators.js';
import type { FileClaim, ClaimMode } from './types.js';

/**
 * Parameters for acquiring a file claim
 */
export interface AcquireClaimParams {
  sessionId: string;
  repoPath: string;
  filePath: string;
  mode: ClaimMode;
  reason?: string;
  ttlHours?: number;
}

/**
 * Filters for querying file claims
 */
export interface ClaimFilters {
  repoPath?: string;
  sessionId?: string;
  filePaths?: string[];
  includeExpired?: boolean;
}

/**
 * Parameters for checking if files can be claimed
 */
export interface CheckClaimsParams {
  repoPath: string;
  filePaths: string[];
  requestedMode: ClaimMode;
  excludeSessionId?: string;
}

/**
 * Result of checking if files can be claimed
 */
export interface CheckClaimsResult {
  available: boolean;
  conflicts: Array<{
    filePath: string;
    existingClaim: FileClaim;
    reason: string;
  }>;
}

/**
 * Error thrown when a claim conflicts with an existing claim
 */
export class ConflictError extends Error {
  constructor(
    message: string,
    public conflictingClaim: FileClaim
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}

/**
 * Manages file access claims for parallel sessions
 */
export class FileClaimsManager {
  private db: SessionDB;
  private logger: Logger;

  constructor(db: SessionDB, logger?: Logger) {
    this.db = db;
    this.logger = logger ?? defaultLogger;
  }

  /**
   * Acquire a claim on a file
   * @throws ConflictError if incompatible EXCLUSIVE claim exists
   * @throws Error if session not found or file path invalid
   */
  async acquireClaim(params: AcquireClaimParams): Promise<FileClaim> {
    // 1. Validate file path (security)
    validateFilePath(params.repoPath, params.filePath);

    // 2. Validate session exists
    const session = this.db.getSessionById(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }

    // 3. Check for existing incompatible claims
    const conflicts = await this.checkClaims({
      repoPath: params.repoPath,
      filePaths: [params.filePath],
      requestedMode: params.mode,
      excludeSessionId: params.sessionId
    });

    if (!conflicts.available) {
      throw new ConflictError(
        `Cannot acquire ${params.mode} claim: ${conflicts.conflicts[0].reason}`,
        conflicts.conflicts[0].existingClaim
      );
    }

    // 4. Acquire claim via database (transaction-safe)
    const claim = this.db.acquireClaim({
      session_id: params.sessionId,
      repo_path: params.repoPath,
      file_path: params.filePath,
      claim_mode: params.mode,
      ttl_hours: params.ttlHours,
      metadata: params.reason ? { reason: params.reason } : undefined
    });

    this.logger.info(`Acquired ${params.mode} claim on ${params.filePath} for session ${params.sessionId}`);
    return claim;
  }

  /**
   * Release a claim by ID
   * @param claimId - Claim ID to release
   * @param sessionId - Session ID (for validation)
   * @param force - If true, release even if owned by another session
   * @returns true if released, false if already released
   */
  async releaseClaim(claimId: string, sessionId: string, force = false): Promise<boolean> {
    // Verify claim ownership unless forced
    if (!force) {
      const claims = this.db.listClaims({ session_id: sessionId, is_active: true });
      const claim = claims.find(c => c.id === claimId);

      if (!claim) {
        this.logger.warn(`Cannot release claim ${claimId}: not owned by session ${sessionId}`);
        return false;
      }
    }

    const released = this.db.releaseClaim(claimId, force);

    if (released) {
      this.logger.info(`Released claim ${claimId}`);
    }

    return released;
  }

  /**
   * Check if files can be claimed (pre-flight check)
   * @returns conflicts if any
   */
  async checkClaims(params: CheckClaimsParams): Promise<CheckClaimsResult> {
    const conflicts: CheckClaimsResult['conflicts'] = [];

    for (const filePath of params.filePaths) {
      // Get active claims for this file
      const existingClaims = this.db.listClaims({
        repo_path: params.repoPath,
        file_path: filePath,
        is_active: true,
        include_stale: false
      });

      // Filter out own session if requested
      const otherClaims = params.excludeSessionId
        ? existingClaims.filter(c => c.session_id !== params.excludeSessionId)
        : existingClaims;

      // Check compatibility
      for (const existing of otherClaims) {
        if (!this.isCompatible(params.requestedMode, existing.claim_mode)) {
          conflicts.push({
            filePath,
            existingClaim: existing,
            reason: `Incompatible ${existing.claim_mode} claim held by session ${existing.session_id}`
          });
        }
      }
    }

    return {
      available: conflicts.length === 0,
      conflicts
    };
  }

  /**
   * List active claims with filters
   */
  listClaims(filters?: ClaimFilters): FileClaim[] {
    const dbFilters: Parameters<typeof this.db.listClaims>[0] = {
      repo_path: filters?.repoPath,
      session_id: filters?.sessionId,
      is_active: true,
      include_stale: filters?.includeExpired ?? false
    };

    // Get all claims first
    let claims = this.db.listClaims(dbFilters);

    // Filter by file paths if specified
    if (filters?.filePaths && filters.filePaths.length > 0) {
      claims = claims.filter(c => filters.filePaths?.includes(c.file_path));
    }

    return claims;
  }

  /**
   * Escalate claim from INTENT → SHARED → EXCLUSIVE
   * @throws ConflictError if escalation blocked
   * @throws Error if claim not found or escalation path invalid
   */
  async escalateClaim(claimId: string, newMode: ClaimMode): Promise<FileClaim> {
    const claims = this.db.listClaims({ is_active: true, include_stale: false });
    const claim = claims.find(c => c.id === claimId);

    if (!claim) {
      throw new Error(`Claim not found: ${claimId}`);
    }

    // Validate escalation path
    if (!this.canEscalate(claim.claim_mode, newMode)) {
      throw new Error(`Cannot escalate from ${claim.claim_mode} to ${newMode}`);
    }

    // Check if escalation would conflict
    const conflicts = await this.checkClaims({
      repoPath: claim.repo_path,
      filePaths: [claim.file_path],
      requestedMode: newMode,
      excludeSessionId: claim.session_id
    });

    if (!conflicts.available) {
      throw new ConflictError(
        `Cannot escalate to ${newMode}: ${conflicts.conflicts[0].reason}`,
        conflicts.conflicts[0].existingClaim
      );
    }

    // Escalate via database update
    const updated = this.db.updateClaim(claimId, {
      claim_mode: newMode,
      escalated_from: claim.claim_mode
    });

    this.logger.info(`Escalated claim ${claimId} from ${claim.claim_mode} to ${newMode}`);
    return updated;
  }

  /**
   * Cleanup stale claims (expired or dead sessions)
   * Called by heartbeat hook and periodic cleanup
   */
  async cleanupStaleClaims(repoPath?: string): Promise<number> {
    const cleaned = this.db.cleanupStaleClaims(repoPath);
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} stale claims${repoPath ? ` in ${repoPath}` : ''}`);
    }
    return cleaned;
  }

  /**
   * Force release all claims for a session
   * Called on session cleanup
   */
  async releaseAllForSession(sessionId: string): Promise<number> {
    const released = this.db.releaseAllForSession(sessionId);
    if (released > 0) {
      this.logger.info(`Released ${released} claims for session ${sessionId}`);
    }
    return released;
  }

  /**
   * Check if two claim modes are compatible
   * EXCLUSIVE blocks all, SHARED allows SHARED+INTENT, INTENT allows all
   */
  private isCompatible(requested: ClaimMode, existing: ClaimMode): boolean {
    const COMPATIBILITY: Record<ClaimMode, ClaimMode[]> = {
      EXCLUSIVE: [],                    // Blocks all
      SHARED: ['SHARED', 'INTENT'],     // Allows read-only + planning
      INTENT: ['SHARED', 'INTENT']      // Non-blocking
    };

    // If existing is EXCLUSIVE, nothing compatible
    if (existing === 'EXCLUSIVE') return false;

    // Check if requested is compatible with existing
    return COMPATIBILITY[existing].includes(requested);
  }

  /**
   * Check if escalation path is valid
   * INTENT → SHARED → EXCLUSIVE (only forward, no downgrades)
   */
  private canEscalate(current: ClaimMode, target: ClaimMode): boolean {
    const levels = { INTENT: 0, SHARED: 1, EXCLUSIVE: 2 };
    return levels[target] > levels[current];
  }
}
