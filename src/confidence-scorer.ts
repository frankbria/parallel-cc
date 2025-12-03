/**
 * Confidence Scoring Module for parallel-cc v0.5
 *
 * Calculates confidence scores for auto-fix suggestions using multiple
 * weighted factors: complexity, similarity, AST validity, and strategy
 * historical success.
 */

import type { Conflict } from './conflict-detector.js';
import type { Resolution, MergeStrategy } from './merge-strategies.js';
import type { ASTAnalyzer } from './ast-analyzer.js';
import type { Logger } from './logger.js';

/**
 * Individual confidence factors breakdown
 */
export interface ConfidenceFactors {
  /** Conflict complexity factor (0.0-1.0) */
  complexity: number;
  /** Code similarity factor (0.0-1.0) */
  similarity: number;
  /** AST validity factor (0.0-1.0) */
  astValidity: number;
  /** Strategy success rate factor (0.0-1.0) */
  strategySuccess: number;
}

/**
 * ConfidenceScorer - Calculate confidence scores for auto-fix suggestions
 *
 * Uses a weighted combination of factors:
 * - 30% Complexity: Simple conflicts → higher score
 * - 25% Similarity: Similar code → higher score
 * - 25% AST Validity: Valid AST after resolution → higher score
 * - 20% Strategy Success: Strategy's historical success → higher score
 *
 * Applies penalties for:
 * - Semantic conflicts: 30% reduction
 * - Large changes (>50 lines): 20% reduction
 */
export class ConfidenceScorer {
  /** Weight for complexity factor */
  private readonly WEIGHT_COMPLEXITY = 0.30;
  /** Weight for similarity factor */
  private readonly WEIGHT_SIMILARITY = 0.25;
  /** Weight for AST validity factor */
  private readonly WEIGHT_AST_VALIDITY = 0.25;
  /** Weight for strategy success factor */
  private readonly WEIGHT_STRATEGY_SUCCESS = 0.20;

  /** Penalty multiplier for semantic conflicts */
  private readonly SEMANTIC_PENALTY = 0.7;
  /** Penalty multiplier for large changes (>50 lines) */
  private readonly LARGE_CHANGE_PENALTY = 0.8;
  /** Threshold for "large change" (in lines) */
  private readonly LARGE_CHANGE_THRESHOLD = 50;

  /** Strategy success rates (in production, would be from database) */
  private strategySuccessRates = new Map<string, number>([
    ['TrivialMerge', 0.98],
    ['StructuralMerge', 0.85],
    ['ConcurrentEdit', 0.60],
    ['Fallback', 0.40]
  ]);

  constructor(
    private astAnalyzer: ASTAnalyzer,
    private logger?: Logger
  ) {}

  /**
   * Calculate confidence score for a resolution
   *
   * Combines multiple weighted factors and applies penalties.
   *
   * @param params - Conflict, resolution, and strategy
   * @returns Confidence score (0.0-1.0)
   */
  calculateConfidence(params: {
    conflict: Conflict;
    resolution: Resolution;
    strategy: MergeStrategy;
  }): number {
    const { conflict, resolution, strategy } = params;

    this.logger?.debug('Calculating confidence score', {
      filePath: conflict.filePath,
      conflictType: conflict.conflictType,
      strategy: strategy.name
    });

    // Calculate individual factors
    const factors = this.getFactors(params);

    // Weighted combination
    let confidence =
      this.WEIGHT_COMPLEXITY * factors.complexity +
      this.WEIGHT_SIMILARITY * factors.similarity +
      this.WEIGHT_AST_VALIDITY * factors.astValidity +
      this.WEIGHT_STRATEGY_SUCCESS * factors.strategySuccess;

    // Apply penalties
    if (conflict.conflictType === 'SEMANTIC') {
      this.logger?.debug('Applying semantic conflict penalty', { penalty: this.SEMANTIC_PENALTY });
      confidence *= this.SEMANTIC_PENALTY;
    }

    const linesChanged = this.countLines(resolution.content);
    if (linesChanged > this.LARGE_CHANGE_THRESHOLD) {
      this.logger?.debug('Applying large change penalty', {
        linesChanged,
        penalty: this.LARGE_CHANGE_PENALTY
      });
      confidence *= this.LARGE_CHANGE_PENALTY;
    }

    // Clamp to [0.0, 1.0]
    const final = Math.max(0.0, Math.min(1.0, confidence));

    this.logger?.debug('Confidence calculation complete', {
      factors,
      beforePenalties: confidence,
      afterPenalties: final
    });

    return final;
  }

  /**
   * Get detailed breakdown of confidence factors
   *
   * Useful for debugging and explaining scores to users.
   *
   * @param params - Conflict, resolution, and strategy
   * @returns Individual factor scores
   */
  getFactors(params: {
    conflict: Conflict;
    resolution: Resolution;
    strategy: MergeStrategy;
  }): ConfidenceFactors {
    const { conflict, resolution, strategy } = params;

    return {
      complexity: this.factorComplexity(conflict),
      similarity: this.factorSimilarity(conflict),
      astValidity: this.factorASTValiditySync(resolution.content),
      strategySuccess: this.factorStrategySuccess(strategy)
    };
  }

  /**
   * Factor: Conflict complexity
   *
   * Scoring rules:
   * - TRIVIAL → 1.0 (highest confidence)
   * - STRUCTURAL with imports → 0.9
   * - STRUCTURAL other → 0.7
   * - CONCURRENT_EDIT (<5 lines) → 0.6
   * - CONCURRENT_EDIT (≥5 lines) → 0.4
   * - SEMANTIC → 0.3
   * - UNKNOWN → 0.2 (lowest confidence)
   *
   * @param conflict - The conflict being resolved
   * @returns Complexity score (0.0-1.0)
   */
  private factorComplexity(conflict: Conflict): number {
    const { conflictType, markers, analysis } = conflict;

    switch (conflictType) {
      case 'TRIVIAL':
        return 1.0;

      case 'STRUCTURAL':
        // Higher confidence if only imports/exports changed
        if (analysis?.astDiff?.structuralDiff) {
          const diff = analysis.astDiff.structuralDiff;
          if (diff.hasImportChanges || diff.hasExportChanges) {
            return 0.9;
          }
        }
        return 0.7;

      case 'CONCURRENT_EDIT': {
        // Score based on number of conflicting lines
        const totalLines = markers.reduce((sum, m) => {
          const oursLines = this.countLines(m.oursContent);
          const theirsLines = this.countLines(m.theirsContent);
          return sum + Math.max(oursLines, theirsLines);
        }, 0);

        return totalLines < 5 ? 0.6 : 0.4;
      }

      case 'SEMANTIC':
        return 0.3;

      case 'UNKNOWN':
      default:
        return 0.2;
    }
  }

  /**
   * Factor: Code similarity between ours and theirs
   *
   * Uses Levenshtein distance normalized to [0, 1].
   * Higher similarity → higher confidence.
   *
   * Scoring:
   * - >80% similarity → 0.8-1.0
   * - 50-80% similarity → 0.5-0.8
   * - <50% similarity → 0.0-0.5
   *
   * @param conflict - The conflict being resolved
   * @returns Similarity score (0.0-1.0)
   */
  private factorSimilarity(conflict: Conflict): number {
    if (conflict.markers.length === 0) {
      return 0.5; // Neutral score for no markers
    }

    // Calculate average similarity across all markers
    const similarities = conflict.markers.map(marker => {
      const ours = marker.oursContent;
      const theirs = marker.theirsContent;

      // Use simple line-based similarity (production would use Levenshtein)
      const oursLines = ours.split('\n').filter(l => l.trim().length > 0);
      const theirsLines = theirs.split('\n').filter(l => l.trim().length > 0);

      // Count matching lines
      const matchingLines = oursLines.filter(line =>
        theirsLines.some(theirLine => this.normalizeForComparison(line) === this.normalizeForComparison(theirLine))
      ).length;

      const maxLines = Math.max(oursLines.length, theirsLines.length);
      if (maxLines === 0) return 1.0; // Both empty → perfect similarity

      return matchingLines / maxLines;
    });

    // Average similarity
    const avgSimilarity = similarities.reduce((sum, s) => sum + s, 0) / similarities.length;

    // Map to confidence score
    if (avgSimilarity >= 0.8) {
      // High similarity: map [0.8, 1.0] → [0.8, 1.0]
      return 0.8 + (avgSimilarity - 0.8) * 1.0;
    } else if (avgSimilarity >= 0.5) {
      // Medium similarity: map [0.5, 0.8] → [0.5, 0.8]
      return 0.5 + (avgSimilarity - 0.5) * 1.0;
    } else {
      // Low similarity: map [0.0, 0.5] → [0.0, 0.5]
      return avgSimilarity;
    }
  }

  /**
   * Factor: AST validity (synchronous version)
   *
   * Checks if resolved content parses to a valid AST.
   * Valid AST → 1.0, invalid → 0.0
   *
   * @param resolvedContent - The resolved file content
   * @returns AST validity score (0.0 or 1.0)
   */
  private factorASTValiditySync(resolvedContent: string): number {
    // For now, use a simple heuristic: check for balanced braces
    // In production, would actually parse the AST
    const openBraces = (resolvedContent.match(/\{/g) || []).length;
    const closeBraces = (resolvedContent.match(/\}/g) || []).length;

    const openParens = (resolvedContent.match(/\(/g) || []).length;
    const closeParens = (resolvedContent.match(/\)/g) || []).length;

    const openBrackets = (resolvedContent.match(/\[/g) || []).length;
    const closeBrackets = (resolvedContent.match(/\]/g) || []).length;

    // Check balance
    const isBalanced =
      openBraces === closeBraces &&
      openParens === closeParens &&
      openBrackets === closeBrackets;

    return isBalanced ? 1.0 : 0.0;
  }

  /**
   * Factor: AST validity (asynchronous version with actual parsing)
   *
   * Actually parses the content to verify AST validity.
   * More accurate but slower than sync version.
   *
   * @param resolvedContent - The resolved file content
   * @returns AST validity score (0.0 or 1.0)
   */
  private async factorASTValidity(resolvedContent: string): Promise<number> {
    try {
      // Attempt to parse
      const ast = await this.astAnalyzer.parseFile('temp.ts', resolvedContent);
      return ast !== null ? 1.0 : 0.0;
    } catch {
      return 0.0;
    }
  }

  /**
   * Factor: Strategy historical success rate
   *
   * Uses predefined success rates for each strategy.
   * In production, would query database for actual historical data.
   *
   * @param strategy - The strategy being used
   * @returns Strategy success score (0.0-1.0)
   */
  private factorStrategySuccess(strategy: MergeStrategy): number {
    const successRate = this.strategySuccessRates.get(strategy.name);
    return successRate !== undefined ? successRate : 0.5; // Default to neutral
  }

  /**
   * Count non-empty lines in content
   */
  private countLines(content: string): number {
    return content.split('\n').filter(line => line.trim().length > 0).length;
  }

  /**
   * Normalize line for comparison (remove whitespace, lowercase)
   */
  private normalizeForComparison(line: string): string {
    return line.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /**
   * Update strategy success rate (for learning)
   *
   * In production, this would persist to database.
   *
   * @param strategyName - Name of the strategy
   * @param wasSuccessful - Whether the resolution was successful
   */
  updateStrategySuccessRate(strategyName: string, wasSuccessful: boolean): void {
    const currentRate = this.strategySuccessRates.get(strategyName) || 0.5;

    // Simple exponential moving average: new_rate = 0.9 * old_rate + 0.1 * new_result
    const newResult = wasSuccessful ? 1.0 : 0.0;
    const newRate = 0.9 * currentRate + 0.1 * newResult;

    this.strategySuccessRates.set(strategyName, newRate);

    this.logger?.debug('Updated strategy success rate', {
      strategy: strategyName,
      wasSuccessful,
      oldRate: currentRate,
      newRate
    });
  }
}
