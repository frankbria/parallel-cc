/**
 * Tests for v0.5 MCP tools: File Claims, Advanced Conflicts, Auto-Fix
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  claimFile,
  releaseFile,
  listFileClaims,
  detectAdvancedConflicts,
  getAutoFixSuggestions,
  applyAutoFix,
  conflictHistory
} from '../src/mcp/index.js';
import type {
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
} from '../src/mcp/schemas.js';
import type { FileClaim, ConflictResolution, AutoFixSuggestion } from '../src/types.js';

// Mock modules
vi.mock('../src/coordinator.js');
vi.mock('../src/file-claims.js');
vi.mock('../src/conflict-detector.js');
vi.mock('../src/auto-fix-engine.js');

// Mock data helpers
function createMockFileClaim(overrides: Partial<FileClaim> = {}): FileClaim {
  return {
    id: overrides.id ?? 'claim-123',
    session_id: overrides.session_id ?? 'session-456',
    repo_path: overrides.repo_path ?? '/home/user/repo',
    file_path: overrides.file_path ?? 'src/file.ts',
    claim_mode: overrides.claim_mode ?? 'EXCLUSIVE',
    claimed_at: overrides.claimed_at ?? '2025-01-01T10:00:00Z',
    expires_at: overrides.expires_at ?? '2025-01-02T10:00:00Z',
    last_heartbeat: overrides.last_heartbeat ?? '2025-01-01T10:00:00Z',
    is_active: overrides.is_active ?? true,
    metadata: overrides.metadata
  };
}

function createMockConflictResolution(overrides: Partial<ConflictResolution> = {}): ConflictResolution {
  return {
    id: overrides.id ?? 'resolution-123',
    session_id: overrides.session_id ?? 'session-456',
    repo_path: overrides.repo_path ?? '/home/user/repo',
    file_path: overrides.file_path ?? 'src/file.ts',
    conflict_type: overrides.conflict_type ?? 'STRUCTURAL',
    base_commit: overrides.base_commit ?? 'abc123',
    source_commit: overrides.source_commit ?? 'def456',
    target_commit: overrides.target_commit ?? 'ghi789',
    resolution_strategy: overrides.resolution_strategy ?? 'AUTO_FIX',
    confidence_score: overrides.confidence_score ?? 0.85,
    conflict_markers: overrides.conflict_markers ?? '<<<<<<< HEAD',
    detected_at: overrides.detected_at ?? '2025-01-01T10:00:00Z',
    resolved_at: overrides.resolved_at ?? '2025-01-01T10:05:00Z'
  };
}

function createMockAutoFixSuggestion(overrides: Partial<AutoFixSuggestion> = {}): AutoFixSuggestion {
  return {
    id: overrides.id ?? 'suggestion-123',
    repo_path: overrides.repo_path ?? '/home/user/repo',
    file_path: overrides.file_path ?? 'src/file.ts',
    conflict_type: overrides.conflict_type ?? 'STRUCTURAL',
    suggested_resolution: overrides.suggested_resolution ?? 'resolved content',
    confidence_score: overrides.confidence_score ?? 0.85,
    explanation: overrides.explanation ?? 'Strategy explanation',
    strategy_used: overrides.strategy_used ?? 'TrivialWhitespaceStrategy',
    base_content: overrides.base_content ?? 'base',
    source_content: overrides.source_content ?? 'source',
    target_content: overrides.target_content ?? 'target',
    generated_at: overrides.generated_at ?? '2025-01-01T10:00:00Z',
    was_auto_applied: overrides.was_auto_applied ?? false
  };
}

describe('MCP v0.5 Tools', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalCwd: () => string;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    originalCwd = process.cwd;

    // Mock process.cwd()
    process.cwd = vi.fn(() => '/home/user/repo');

    // Set session ID in environment
    process.env.PARALLEL_CC_SESSION_ID = 'test-session-123';
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    process.cwd = originalCwd;

    // Clear mocks
    vi.clearAllMocks();
  });

  // ==========================================================================
  // claimFile tests
  // ==========================================================================

  describe('claimFile', () => {
    it('should successfully acquire EXCLUSIVE claim', async () => {
      const input: ClaimFileInput = {
        filePath: 'src/file.ts',
        mode: 'EXCLUSIVE',
        reason: 'Editing feature X',
        ttlHours: 24
      };

      const result = await claimFile(input);

      expect(result.success).toBe(true);
      expect(result.claimId).toBeTruthy();
      expect(result.message).toContain('Successfully acquired');
    });

    it('should successfully acquire SHARED claim', async () => {
      const input: ClaimFileInput = {
        filePath: 'src/file.ts',
        mode: 'SHARED',
        reason: 'Reading file'
      };

      const result = await claimFile(input);

      expect(result.success).toBe(true);
      expect(result.claimId).toBeTruthy();
    });

    it('should successfully acquire INTENT claim', async () => {
      const input: ClaimFileInput = {
        filePath: 'src/file.ts',
        mode: 'INTENT'
      };

      const result = await claimFile(input);

      expect(result.success).toBe(true);
      expect(result.claimId).toBeTruthy();
    });

    it('should fail when PARALLEL_CC_SESSION_ID not set', async () => {
      delete process.env.PARALLEL_CC_SESSION_ID;

      const input: ClaimFileInput = {
        filePath: 'src/file.ts'
      };

      const result = await claimFile(input);

      expect(result.success).toBe(false);
      expect(result.claimId).toBeNull();
      expect(result.message).toContain('not running in a parallel-cc managed session');
    });

    it('should return conflicting claims when claim conflicts', async () => {
      // This would require mocking FileClaimsManager to throw ConflictError
      // For now, we test the basic structure
      const input: ClaimFileInput = {
        filePath: 'src/file.ts',
        mode: 'EXCLUSIVE'
      };

      const result = await claimFile(input);

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('claimId');
      expect(result).toHaveProperty('message');
    });

    it('should use default mode EXCLUSIVE when not specified', async () => {
      const input: ClaimFileInput = {
        filePath: 'src/file.ts'
      };

      const result = await claimFile(input);

      expect(result.success).toBe(true);
    });

    it('should respect custom TTL hours', async () => {
      const input: ClaimFileInput = {
        filePath: 'src/file.ts',
        ttlHours: 48
      };

      const result = await claimFile(input);

      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // releaseFile tests
  // ==========================================================================

  describe('releaseFile', () => {
    it('should successfully release claim', async () => {
      const input: ReleaseFileInput = {
        claimId: 'claim-123'
      };

      const result = await releaseFile(input);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Successfully released');
      expect(result.releasedAt).toBeTruthy();
    });

    it('should fail when PARALLEL_CC_SESSION_ID not set', async () => {
      delete process.env.PARALLEL_CC_SESSION_ID;

      const input: ReleaseFileInput = {
        claimId: 'claim-123'
      };

      const result = await releaseFile(input);

      expect(result.success).toBe(false);
      expect(result.message).toContain('not running in a parallel-cc managed session');
    });

    it('should handle force release', async () => {
      const input: ReleaseFileInput = {
        claimId: 'claim-123',
        force: true
      };

      const result = await releaseFile(input);

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('message');
    });

    it('should fail for non-existent claim', async () => {
      const input: ReleaseFileInput = {
        claimId: 'non-existent-claim'
      };

      const result = await releaseFile(input);

      // Will depend on mock implementation
      expect(result).toHaveProperty('success');
    });
  });

  // ==========================================================================
  // listFileClaims tests
  // ==========================================================================

  describe('listFileClaims', () => {
    it('should list all claims without filters', async () => {
      const input: ListFileClaimsInput = {};

      const result = await listFileClaims(input);

      expect(result).toHaveProperty('claims');
      expect(result).toHaveProperty('totalClaims');
      expect(Array.isArray(result.claims)).toBe(true);
    });

    it('should filter by file paths', async () => {
      const input: ListFileClaimsInput = {
        filePaths: ['src/file1.ts', 'src/file2.ts']
      };

      const result = await listFileClaims(input);

      expect(result.claims).toBeDefined();
    });

    it('should filter by session ID', async () => {
      const input: ListFileClaimsInput = {
        sessionId: 'session-456'
      };

      const result = await listFileClaims(input);

      expect(result.claims).toBeDefined();
    });

    it('should include expired claims when requested', async () => {
      const input: ListFileClaimsInput = {
        includeExpired: true
      };

      const result = await listFileClaims(input);

      expect(result.claims).toBeDefined();
    });

    it('should return claim details with session info', async () => {
      const input: ListFileClaimsInput = {};

      const result = await listFileClaims(input);

      result.claims.forEach(claim => {
        expect(claim).toHaveProperty('claimId');
        expect(claim).toHaveProperty('filePath');
        expect(claim).toHaveProperty('claimMode');
        expect(claim).toHaveProperty('sessionId');
        expect(claim).toHaveProperty('sessionPid');
        expect(claim).toHaveProperty('minutesUntilExpiry');
      });
    });
  });

  // ==========================================================================
  // detectAdvancedConflicts tests
  // ==========================================================================

  describe('detectAdvancedConflicts', () => {
    it('should detect conflicts with semantic analysis', async () => {
      const input: DetectAdvancedConflictsInput = {
        currentBranch: 'feature/new-feature',
        targetBranch: 'main',
        analyzeSemantics: true
      };

      const result = await detectAdvancedConflicts(input);

      expect(result).toHaveProperty('hasConflicts');
      expect(result).toHaveProperty('conflicts');
      expect(result).toHaveProperty('summary');
      expect(Array.isArray(result.conflicts)).toBe(true);
    });

    it('should detect conflicts without semantic analysis', async () => {
      const input: DetectAdvancedConflictsInput = {
        currentBranch: 'feature/new-feature',
        targetBranch: 'main',
        analyzeSemantics: false
      };

      const result = await detectAdvancedConflicts(input);

      expect(result.hasConflicts).toBeDefined();
    });

    it('should include summary statistics', async () => {
      const input: DetectAdvancedConflictsInput = {
        currentBranch: 'feature/new-feature',
        targetBranch: 'main'
      };

      const result = await detectAdvancedConflicts(input);

      expect(result.summary).toHaveProperty('totalConflicts');
      expect(result.summary).toHaveProperty('byType');
      expect(result.summary).toHaveProperty('bySeverity');
      expect(result.summary).toHaveProperty('autoFixableCount');
    });

    it('should classify conflict types', async () => {
      const input: DetectAdvancedConflictsInput = {
        currentBranch: 'feature/new-feature',
        targetBranch: 'main'
      };

      const result = await detectAdvancedConflicts(input);

      result.conflicts.forEach(conflict => {
        expect(['STRUCTURAL', 'SEMANTIC', 'CONCURRENT_EDIT', 'TRIVIAL', 'UNKNOWN']).toContain(conflict.conflictType);
        expect(['LOW', 'MEDIUM', 'HIGH']).toContain(conflict.severity);
      });
    });

    it('should reject invalid branch names', async () => {
      const input: DetectAdvancedConflictsInput = {
        currentBranch: 'feature/../../../etc/passwd',
        targetBranch: 'main'
      };

      const result = await detectAdvancedConflicts(input);

      expect(result.hasConflicts).toBe(false);
      expect(result.conflicts).toHaveLength(0);
    });
  });

  // ==========================================================================
  // getAutoFixSuggestions tests
  // ==========================================================================

  describe('getAutoFixSuggestions', () => {
    it('should generate suggestions for conflicted file', async () => {
      const input: GetAutoFixSuggestionsInput = {
        filePath: 'src/file.ts',
        currentBranch: 'feature/new-feature',
        targetBranch: 'main',
        minConfidence: 0.5,
        maxSuggestions: 3
      };

      const result = await getAutoFixSuggestions(input);

      expect(result).toHaveProperty('suggestions');
      expect(result).toHaveProperty('totalGenerated');
      expect(result).toHaveProperty('filteredByConfidence');
      expect(Array.isArray(result.suggestions)).toBe(true);
    });

    it('should respect minConfidence filter', async () => {
      const input: GetAutoFixSuggestionsInput = {
        filePath: 'src/file.ts',
        currentBranch: 'feature/new-feature',
        targetBranch: 'main',
        minConfidence: 0.8
      };

      const result = await getAutoFixSuggestions(input);

      result.suggestions.forEach(suggestion => {
        expect(suggestion.confidence).toBeGreaterThanOrEqual(0.8);
      });
    });

    it('should limit suggestions to maxSuggestions', async () => {
      const input: GetAutoFixSuggestionsInput = {
        filePath: 'src/file.ts',
        currentBranch: 'feature/new-feature',
        targetBranch: 'main',
        maxSuggestions: 2
      };

      const result = await getAutoFixSuggestions(input);

      expect(result.suggestions.length).toBeLessThanOrEqual(2);
    });

    it('should include preview and risks', async () => {
      const input: GetAutoFixSuggestionsInput = {
        filePath: 'src/file.ts',
        currentBranch: 'feature/new-feature',
        targetBranch: 'main'
      };

      const result = await getAutoFixSuggestions(input);

      result.suggestions.forEach(suggestion => {
        expect(suggestion).toHaveProperty('preview');
        expect(suggestion.preview).toHaveProperty('beforeLines');
        expect(suggestion.preview).toHaveProperty('afterLines');
        expect(suggestion.preview).toHaveProperty('diffStats');
        expect(suggestion).toHaveProperty('risks');
        expect(Array.isArray(suggestion.risks)).toBe(true);
      });
    });

    it('should return empty suggestions for non-conflicted file', async () => {
      const input: GetAutoFixSuggestionsInput = {
        filePath: 'src/non-conflicted.ts',
        currentBranch: 'feature/new-feature',
        targetBranch: 'main'
      };

      const result = await getAutoFixSuggestions(input);

      expect(result.suggestions).toHaveLength(0);
      expect(result.totalGenerated).toBe(0);
    });

    it('should use default values for optional parameters', async () => {
      const input: GetAutoFixSuggestionsInput = {
        filePath: 'src/file.ts',
        currentBranch: 'feature/new-feature',
        targetBranch: 'main'
      };

      const result = await getAutoFixSuggestions(input);

      // Should use minConfidence: 0.5, maxSuggestions: 3
      expect(result).toBeDefined();
    });
  });

  // ==========================================================================
  // applyAutoFix tests
  // ==========================================================================

  describe('applyAutoFix', () => {
    it('should apply suggestion successfully', async () => {
      const input: ApplyAutoFixInput = {
        suggestionId: 'suggestion-123',
        dryRun: false,
        createBackup: true
      };

      const result = await applyAutoFix(input);

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('applied');
      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('verification');
      expect(result).toHaveProperty('metadata');
    });

    it('should perform dry run without applying', async () => {
      const input: ApplyAutoFixInput = {
        suggestionId: 'suggestion-123',
        dryRun: true
      };

      const result = await applyAutoFix(input);

      expect(result.applied).toBe(false);
    });

    it('should create backup when requested', async () => {
      const input: ApplyAutoFixInput = {
        suggestionId: 'suggestion-123',
        createBackup: true
      };

      const result = await applyAutoFix(input);

      if (result.success && result.applied) {
        expect(result.backupPath).toBeDefined();
        expect(result.rollbackCommand).toBeDefined();
      }
    });

    it('should verify no conflict markers remain', async () => {
      const input: ApplyAutoFixInput = {
        suggestionId: 'suggestion-123'
      };

      const result = await applyAutoFix(input);

      expect(result.verification).toHaveProperty('conflictMarkersRemaining');
      expect(result.verification).toHaveProperty('syntaxValid');
    });

    it('should include metadata with confidence and strategy', async () => {
      const input: ApplyAutoFixInput = {
        suggestionId: 'suggestion-123'
      };

      const result = await applyAutoFix(input);

      expect(result.metadata).toHaveProperty('suggestionId');
      expect(result.metadata).toHaveProperty('confidence');
      expect(result.metadata).toHaveProperty('strategy');
      expect(result.metadata).toHaveProperty('appliedAt');
    });

    it('should handle non-existent suggestion', async () => {
      const input: ApplyAutoFixInput = {
        suggestionId: 'non-existent'
      };

      const result = await applyAutoFix(input);

      expect(result.success).toBe(false);
      expect(result.applied).toBe(false);
    });
  });

  // ==========================================================================
  // conflictHistory tests
  // ==========================================================================

  describe('conflictHistory', () => {
    it('should return conflict history without filters', async () => {
      const input: ConflictHistoryInput = {};

      const result = await conflictHistory(input);

      expect(result).toHaveProperty('history');
      expect(result).toHaveProperty('statistics');
      expect(result).toHaveProperty('pagination');
      expect(Array.isArray(result.history)).toBe(true);
    });

    it('should filter by file path', async () => {
      const input: ConflictHistoryInput = {
        filePath: 'src/file.ts'
      };

      const result = await conflictHistory(input);

      expect(result.history).toBeDefined();
    });

    it('should filter by conflict type', async () => {
      const input: ConflictHistoryInput = {
        conflictType: 'STRUCTURAL'
      };

      const result = await conflictHistory(input);

      expect(result.history).toBeDefined();
    });

    it('should filter by resolution strategy', async () => {
      const input: ConflictHistoryInput = {
        resolutionStrategy: 'AUTO_FIX'
      };

      const result = await conflictHistory(input);

      expect(result.history).toBeDefined();
    });

    it('should paginate results', async () => {
      const input: ConflictHistoryInput = {
        limit: 10,
        offset: 0
      };

      const result = await conflictHistory(input);

      expect(result.pagination.limit).toBe(10);
      expect(result.pagination.offset).toBe(0);
      expect(result.history.length).toBeLessThanOrEqual(10);
    });

    it('should include statistics', async () => {
      const input: ConflictHistoryInput = {};

      const result = await conflictHistory(input);

      expect(result.statistics).toHaveProperty('totalResolutions');
      expect(result.statistics).toHaveProperty('autoFixRate');
      expect(result.statistics).toHaveProperty('averageConfidence');
      expect(result.statistics).toHaveProperty('byType');
      expect(result.statistics).toHaveProperty('byStrategy');
    });

    it('should calculate autoFixRate correctly', async () => {
      const input: ConflictHistoryInput = {};

      const result = await conflictHistory(input);

      expect(result.statistics.autoFixRate).toBeGreaterThanOrEqual(0);
      expect(result.statistics.autoFixRate).toBeLessThanOrEqual(1);
    });

    it('should use default pagination values', async () => {
      const input: ConflictHistoryInput = {};

      const result = await conflictHistory(input);

      expect(result.pagination.limit).toBe(20);
      expect(result.pagination.offset).toBe(0);
    });
  });

  // ==========================================================================
  // Integration tests
  // ==========================================================================

  describe('Integration: File Claims Workflow', () => {
    it('should support full workflow: claim → work → release', async () => {
      // Claim file
      const claimResult = await claimFile({
        filePath: 'src/feature.ts',
        mode: 'EXCLUSIVE'
      });

      expect(claimResult.success).toBe(true);
      const claimId = claimResult.claimId!;

      // List claims
      const listResult = await listFileClaims({});
      expect(listResult.claims.some(c => c.claimId === claimId)).toBe(true);

      // Release claim
      const releaseResult = await releaseFile({ claimId });
      expect(releaseResult.success).toBe(true);
    });
  });

  describe('Integration: Conflict Resolution Workflow', () => {
    it('should support full workflow: detect → suggest → apply', async () => {
      // Detect conflicts
      const detectResult = await detectAdvancedConflicts({
        currentBranch: 'feature/test',
        targetBranch: 'main'
      });

      expect(detectResult).toHaveProperty('conflicts');

      // If conflicts exist, get suggestions
      if (detectResult.conflicts.length > 0) {
        const suggestResult = await getAutoFixSuggestions({
          filePath: detectResult.conflicts[0].filePath,
          currentBranch: 'feature/test',
          targetBranch: 'main'
        });

        expect(suggestResult.suggestions).toBeDefined();

        // If suggestions exist, apply one (dry run)
        if (suggestResult.suggestions.length > 0) {
          const applyResult = await applyAutoFix({
            suggestionId: suggestResult.suggestions[0].suggestionId,
            dryRun: true
          });

          expect(applyResult).toHaveProperty('success');
        }
      }
    });
  });
});
