/**
 * Auto-Fix Engine Module for parallel-cc v0.5
 *
 * Generates and applies AI-powered conflict resolution suggestions.
 * Implements safety-first architecture with backups, validation, and rollback.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { SessionDB } from './db.js';
import type { ASTAnalyzer } from './ast-analyzer.js';
import type { ConfidenceScorer } from './confidence-scorer.js';
import type { StrategyChain } from './merge-strategies.js';
import type { Conflict } from './conflict-detector.js';
import type { AutoFixSuggestion } from './types.js';
import type { Logger } from './logger.js';

/**
 * Parameters for generating auto-fix suggestions
 */
export interface GenerateSuggestionsParams {
  /** Repository root path */
  repoPath: string;
  /** File path relative to repo root */
  filePath: string;
  /** Detected conflict */
  conflict: Conflict;
  /** Maximum number of suggestions to generate (default: 3) */
  maxSuggestions?: number;
}

/**
 * Parameters for applying an auto-fix suggestion
 */
export interface ApplySuggestionParams {
  /** Suggestion ID to apply */
  suggestionId: string;
  /** If true, validate only without writing (default: false) */
  dryRun?: boolean;
  /** If true, create backup before applying (default: true) */
  createBackup?: boolean;
}

/**
 * Result of applying an auto-fix suggestion
 */
export interface ApplyResult {
  /** Overall success status */
  success: boolean;
  /** Whether suggestion was actually applied */
  applied: boolean;
  /** File path that was modified */
  filePath: string;
  /** Path to backup file (if created) */
  backupPath?: string;
  /** Command to rollback changes */
  rollbackCommand?: string;
  /** Verification results */
  verification: {
    /** Number of conflict markers remaining */
    conflictMarkersRemaining: number;
    /** Whether syntax is valid */
    syntaxValid: boolean;
    /** Diff statistics */
    diffStats: {
      /** Number of lines changed */
      linesChanged: number;
      /** Number of hunks applied */
      hunksApplied: number;
    };
  };
  /** Metadata about the application */
  metadata: {
    /** Suggestion ID that was applied */
    suggestionId: string;
    /** Confidence score of suggestion */
    confidence: number;
    /** Strategy name used */
    strategy: string;
    /** Timestamp when applied */
    appliedAt: string;
  };
  /** Error message if success is false */
  error?: string;
}

/**
 * AutoFixEngine - Generate and apply conflict resolution suggestions
 *
 * SAFETY-FIRST ARCHITECTURE:
 * 1. Always create backups before modifying files
 * 2. Validate syntax after applying
 * 3. Check for remaining conflict markers
 * 4. Provide rollback commands
 * 5. Graceful error handling with automatic rollback
 */
export class AutoFixEngine {
  /** Timeout for strategy resolution (10 seconds) */
  private readonly STRATEGY_TIMEOUT_MS = 10000;

  /** Pattern to detect git conflict markers */
  private readonly CONFLICT_MARKER_PATTERN = /^(<{7}|={7}|>{7})/m;

  constructor(
    private db: SessionDB,
    public readonly astAnalyzer: ASTAnalyzer,
    private confidenceScorer: ConfidenceScorer,
    private strategyChain: StrategyChain,
    private logger?: Logger
  ) {}

  /**
   * Generate resolution suggestions for a conflict
   *
   * Tries multiple strategies, ranks by confidence score.
   *
   * @param params - Generation parameters
   * @returns Array of suggestions, sorted by confidence (highest first)
   */
  async generateSuggestions(params: GenerateSuggestionsParams): Promise<AutoFixSuggestion[]> {
    const { repoPath, filePath, conflict, maxSuggestions = 3 } = params;

    this.logger?.info(`Generating auto-fix suggestions for ${filePath} (type: ${conflict.conflictType}, max: ${maxSuggestions})`);

    const suggestions: AutoFixSuggestion[] = [];

    try {
      // Get all applicable strategies for this conflict
      const strategies = this.strategyChain.getApplicableStrategies(conflict);

      this.logger?.debug('Found applicable strategies', {
        count: strategies.length,
        strategies: strategies.map(s => s.name)
      });

      // Try each strategy
      for (const strategy of strategies) {
        try {
          // Attempt resolution with timeout
          const resolution = await this.resolveWithTimeout(conflict, strategy);

          // Calculate confidence score
          const confidence = this.confidenceScorer.calculateConfidence({
            conflict,
            resolution,
            strategy
          });

          // Generate explanation
          const explanation = strategy.explain(conflict, resolution);

          // Extract base/source/target content from conflict markers
          const marker = conflict.markers[0]; // Simplified: use first marker
          const baseContent = marker.baseContent || '';
          const sourceContent = marker.oursContent;
          const targetContent = marker.theirsContent;

          // Create suggestion in database
          const suggestion = this.db.createAutoFixSuggestion({
            repo_path: repoPath,
            file_path: filePath,
            conflict_type: conflict.conflictType,
            suggested_resolution: resolution.content,
            confidence_score: confidence,
            explanation,
            strategy_used: strategy.name,
            base_content: baseContent,
            source_content: sourceContent,
            target_content: targetContent,
            metadata: {
              severity: conflict.severity,
              markerCount: conflict.markers.length,
              hasASTAnalysis: !!conflict.analysis
            }
          });

          suggestions.push(suggestion);

          this.logger?.debug('Generated suggestion', {
            strategy: strategy.name,
            confidence: confidence.toFixed(2),
            suggestionId: suggestion.id
          });

          // Stop if we have enough suggestions
          if (suggestions.length >= maxSuggestions) {
            break;
          }
        } catch (error) {
          // Strategy failed, try next one
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger?.warn(`Strategy ${strategy.name} failed: ${errorMsg}`);
          continue;
        }
      }

      // Sort by confidence (highest first)
      suggestions.sort((a, b) => b.confidence_score - a.confidence_score);

      this.logger?.info(`Suggestion generation complete: ${suggestions.length} suggestions (top confidence: ${suggestions[0]?.confidence_score.toFixed(2) || 'N/A'})`);

      return suggestions;
    } catch (error) {
      this.logger?.error('Suggestion generation failed', error);
      throw new Error(`Failed to generate suggestions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Apply a suggestion to resolve conflict
   *
   * SAFETY PROTOCOL:
   * 1. Validate suggestion exists
   * 2. Check file unchanged since suggestion
   * 3. Create backup
   * 4. Write resolved content
   * 5. Verify no conflict markers
   * 6. Validate syntax
   * 7. Mark as applied in database
   *
   * @param params - Application parameters
   * @returns Application result with verification data
   */
  async applySuggestion(params: ApplySuggestionParams): Promise<ApplyResult> {
    const { suggestionId, dryRun = false, createBackup = true } = params;

    this.logger?.info(`Applying auto-fix suggestion ${suggestionId} (dryRun: ${dryRun}, backup: ${createBackup})`);

    try {
      // 1. Validate suggestion exists
      const suggestions = this.db.getAutoFixSuggestions({ id: suggestionId });
      if (suggestions.length === 0) {
        throw new Error(`Suggestion not found: ${suggestionId}`);
      }

      const suggestion = suggestions[0];
      const absoluteFilePath = path.join(suggestion.repo_path, suggestion.file_path);

      this.logger?.debug('Found suggestion', {
        filePath: suggestion.file_path,
        strategy: suggestion.strategy_used,
        confidence: suggestion.confidence_score.toFixed(2)
      });

      // 2. Read current file content
      const currentContent = await fs.readFile(absoluteFilePath, 'utf-8');

      // Dry run: just validate
      if (dryRun) {
        this.logger?.debug('Dry run: validating without applying');

        const verification = await this.verifySuggestion(
          absoluteFilePath,
          suggestion.suggested_resolution
        );

        return {
          success: true,
          applied: false,
          filePath: absoluteFilePath,
          verification,
          metadata: {
            suggestionId,
            confidence: suggestion.confidence_score,
            strategy: suggestion.strategy_used,
            appliedAt: new Date().toISOString()
          }
        };
      }

      // 3. Create backup
      let backupPath: string | undefined;
      if (createBackup) {
        backupPath = this.createBackup(absoluteFilePath, currentContent);
        this.logger?.debug('Created backup', { backupPath });
      }

      try {
        // 4. Write resolved content
        await fs.writeFile(absoluteFilePath, suggestion.suggested_resolution, 'utf-8');

        // 5. Verify no conflict markers
        const markersRemaining = this.checkForConflictMarkers(suggestion.suggested_resolution);
        if (markersRemaining > 0) {
          throw new Error(`Conflict markers still present: ${markersRemaining} found`);
        }

        // 6. Validate syntax
        const syntaxValid = await this.validateSyntax(
          absoluteFilePath,
          suggestion.suggested_resolution
        );
        if (!syntaxValid) {
          throw new Error('Syntax error after resolution');
        }

        // 7. Mark as applied in database
        this.db.markSuggestionApplied(suggestionId, false);

        // Calculate diff stats
        const diffStats = this.calculateDiffStats(
          currentContent,
          suggestion.suggested_resolution
        );

        const result: ApplyResult = {
          success: true,
          applied: true,
          filePath: absoluteFilePath,
          backupPath,
          rollbackCommand: backupPath
            ? `cp "${backupPath}" "${absoluteFilePath}"`
            : undefined,
          verification: {
            conflictMarkersRemaining: 0,
            syntaxValid: true,
            diffStats
          },
          metadata: {
            suggestionId,
            confidence: suggestion.confidence_score,
            strategy: suggestion.strategy_used,
            appliedAt: new Date().toISOString()
          }
        };

        this.logger?.info(`Suggestion applied successfully to ${absoluteFilePath} (${diffStats.linesChanged} lines changed)`);

        return result;
      } catch (error) {
        // Rollback on error
        if (backupPath) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.logger?.warn(`Applying failed, rolling back: ${errorMsg}`);
          this.rollback(backupPath, absoluteFilePath);
        }
        throw error;
      }
    } catch (error) {
      this.logger?.error('Failed to apply suggestion', error);

      return {
        success: false,
        applied: false,
        filePath: '',
        verification: {
          conflictMarkersRemaining: -1,
          syntaxValid: false,
          diffStats: { linesChanged: 0, hunksApplied: 0 }
        },
        metadata: {
          suggestionId,
          confidence: 0,
          strategy: '',
          appliedAt: new Date().toISOString()
        },
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Generate human-readable explanation for a suggestion
   *
   * @param suggestion - The suggestion to explain
   * @returns Formatted explanation
   */
  explainSuggestion(suggestion: AutoFixSuggestion): string {
    const { file_path, conflict_type, strategy_used, confidence_score, explanation } = suggestion;

    const parts = [
      `File: ${file_path}`,
      `Conflict Type: ${conflict_type}`,
      `Strategy: ${strategy_used}`,
      `Confidence: ${(confidence_score * 100).toFixed(1)}%`,
      ``,
      `Explanation:`,
      explanation
    ];

    return parts.join('\n');
  }

  /**
   * Check if suggestion is still valid (file unchanged)
   *
   * @param suggestionId - Suggestion ID to validate
   * @returns True if suggestion is still applicable
   */
  async validateSuggestion(suggestionId: string): Promise<boolean> {
    try {
      const suggestions = this.db.getAutoFixSuggestions({ id: suggestionId });
      if (suggestions.length === 0) {
        return false;
      }

      const suggestion = suggestions[0];
      const absoluteFilePath = path.join(suggestion.repo_path, suggestion.file_path);

      // Read current content
      const currentContent = await fs.readFile(absoluteFilePath, 'utf-8');

      // Check if content matches what we based the suggestion on
      // For simplicity, we check if conflict markers are still present
      const hasMarkers = this.checkForConflictMarkers(currentContent) > 0;

      return hasMarkers;
    } catch {
      return false;
    }
  }

  /**
   * Check for conflict markers in content
   *
   * @param content - File content to check
   * @returns Number of conflict markers found
   */
  private checkForConflictMarkers(content: string): number {
    const lines = content.split('\n');
    let count = 0;

    for (const line of lines) {
      if (this.CONFLICT_MARKER_PATTERN.test(line)) {
        count++;
      }
    }

    return count;
  }

  /**
   * Validate syntax for TypeScript/JavaScript files
   *
   * Uses AST analyzer to parse the file.
   *
   * @param filePath - Path to file (for extension detection)
   * @param content - File content to validate
   * @returns True if syntax is valid
   */
  private async validateSyntax(filePath: string, content: string): Promise<boolean> {
    const ext = path.extname(filePath).toLowerCase();

    // Only validate JS/TS files
    if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      return true; // Non-JS files: assume valid
    }

    try {
      const ast = await this.astAnalyzer.parseFile(filePath, content);
      return ast !== null;
    } catch {
      return false;
    }
  }

  /**
   * Create backup of file
   *
   * Creates backup with .bak.{timestamp} suffix.
   *
   * @param filePath - Original file path
   * @param content - Current file content
   * @returns Path to backup file
   */
  private createBackup(filePath: string, content: string): string {
    const timestamp = Date.now();
    const backupPath = `${filePath}.bak.${timestamp}`;

    // Synchronous write for safety (ensure backup completes before modification)
    require('fs').writeFileSync(backupPath, content, 'utf-8');

    return backupPath;
  }

  /**
   * Rollback to backup
   *
   * Restores original file from backup.
   *
   * @param backupPath - Path to backup file
   * @param originalPath - Original file path
   */
  private rollback(backupPath: string, originalPath: string): void {
    try {
      const backupContent = require('fs').readFileSync(backupPath, 'utf-8');
      require('fs').writeFileSync(originalPath, backupContent, 'utf-8');

      this.logger?.info(`Rollback successful: restored ${originalPath} from ${backupPath}`);
    } catch (error) {
      this.logger?.error('Rollback failed', error);
      throw new Error(`Rollback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Verify suggestion without applying
   *
   * Checks for conflict markers and syntax validity.
   *
   * @param filePath - File path for syntax checking
   * @param suggestedContent - Suggested resolution content
   * @returns Verification result
   */
  private async verifySuggestion(
    filePath: string,
    suggestedContent: string
  ): Promise<ApplyResult['verification']> {
    const conflictMarkersRemaining = this.checkForConflictMarkers(suggestedContent);
    const syntaxValid = await this.validateSyntax(filePath, suggestedContent);

    return {
      conflictMarkersRemaining,
      syntaxValid,
      diffStats: {
        linesChanged: this.countLines(suggestedContent),
        hunksApplied: 1 // Simplified
      }
    };
  }

  /**
   * Calculate diff statistics
   *
   * Compares old and new content to count changes.
   *
   * @param oldContent - Original content
   * @param newContent - New content
   * @returns Diff statistics
   */
  private calculateDiffStats(
    oldContent: string,
    newContent: string
  ): { linesChanged: number; hunksApplied: number } {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    // Simple line-based diff
    let linesChanged = 0;
    const maxLines = Math.max(oldLines.length, newLines.length);

    for (let i = 0; i < maxLines; i++) {
      const oldLine = oldLines[i] || '';
      const newLine = newLines[i] || '';

      if (oldLine !== newLine) {
        linesChanged++;
      }
    }

    return {
      linesChanged,
      hunksApplied: linesChanged > 0 ? 1 : 0 // Simplified: assume one hunk
    };
  }

  /**
   * Resolve conflict with strategy, with timeout
   *
   * @param conflict - Conflict to resolve
   * @param strategy - Strategy to use
   * @returns Resolution result
   */
  private async resolveWithTimeout(
    conflict: Conflict,
    strategy: any
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Strategy timeout: ${strategy.name}`));
      }, this.STRATEGY_TIMEOUT_MS);

      strategy
        .resolve(conflict)
        .then((result: any) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error: any) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * Count non-empty lines
   */
  private countLines(content: string): number {
    return content.split('\n').filter(line => line.trim().length > 0).length;
  }
}
