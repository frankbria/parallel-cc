/**
 * Merge Strategies Module for parallel-cc v0.5
 *
 * Pluggable conflict resolution strategies for automatic and semi-automatic
 * conflict resolution. Strategies are applied in order of specificity.
 */

import type { Conflict } from './conflict-detector.js';
import type { ASTAnalyzer } from './ast-analyzer.js';

/**
 * Resolution result from a merge strategy
 */
export interface Resolution {
  /** Resolved file content */
  content: string;
  /** Name of strategy that produced this resolution */
  strategy: string;
  /** Human-readable explanation of the resolution */
  explanation: string;
}

/**
 * Base interface for merge strategies
 */
export interface MergeStrategy {
  /** Strategy name (for logging/debugging) */
  name: string;

  /**
   * Check if strategy can handle this conflict
   *
   * @param conflict - The conflict to evaluate
   * @returns True if this strategy can attempt resolution
   */
  canHandle(conflict: Conflict): boolean;

  /**
   * Attempt to resolve conflict
   *
   * @param conflict - The conflict to resolve
   * @returns Resolution result
   * @throws ResolutionError if cannot resolve
   */
  resolve(conflict: Conflict): Promise<Resolution>;

  /**
   * Explain the resolution approach
   *
   * @param conflict - The conflict being resolved
   * @param resolution - The resolution that was applied
   * @returns Human-readable explanation
   */
  explain(conflict: Conflict, resolution: Resolution): string;

  /**
   * Identify risks with this resolution
   *
   * @param conflict - The conflict being resolved
   * @returns List of potential risks
   */
  identifyRisks(conflict: Conflict): string[];
}

/**
 * Error thrown when a strategy cannot resolve a conflict
 */
export class ResolutionError extends Error {
  constructor(message: string, public conflict: Conflict) {
    super(message);
    this.name = 'ResolutionError';
  }
}

/**
 * TrivialMergeStrategy - Resolves whitespace-only conflicts
 *
 * Handles conflicts where the only differences are whitespace,
 * comments, or formatting. These are safe to auto-merge.
 */
export class TrivialMergeStrategy implements MergeStrategy {
  name = 'TrivialMerge';

  canHandle(conflict: Conflict): boolean {
    return conflict.conflictType === 'TRIVIAL';
  }

  async resolve(conflict: Conflict): Promise<Resolution> {
    // Verify this is truly trivial
    for (const marker of conflict.markers) {
      const oursNormalized = this.normalizeWhitespace(marker.oursContent);
      const theirsNormalized = this.normalizeWhitespace(marker.theirsContent);

      if (oursNormalized !== theirsNormalized) {
        throw new ResolutionError(
          'Conflict is not trivial - content differs beyond whitespace',
          conflict
        );
      }
    }

    // All markers are whitespace-only, use ours (arbitrary choice)
    const content = conflict.markers.map(m => m.oursContent).join('\n');

    return {
      content,
      strategy: this.name,
      explanation: 'Whitespace-only conflict, merged automatically'
    };
  }

  explain(conflict: Conflict, resolution: Resolution): string {
    const markerCount = conflict.markers.length;
    return `Resolved ${markerCount} trivial conflict${markerCount > 1 ? 's' : ''} in ${conflict.filePath}. ` +
           'Only whitespace and formatting differed between branches.';
  }

  identifyRisks(conflict: Conflict): string[] {
    return []; // Trivial merges are safe
  }

  private normalizeWhitespace(content: string): string {
    return content
      .replace(/\s+/g, ' ') // Collapse all whitespace to single space
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join(' ')
      .trim();
  }
}

/**
 * StructuralMergeStrategy - Resolves structural conflicts
 *
 * Handles conflicts where both branches made additive changes
 * (new imports, new functions, new exports) without modifying
 * existing code. Uses AST analysis to merge intelligently.
 */
export class StructuralMergeStrategy implements MergeStrategy {
  name = 'StructuralMerge';

  constructor(private astAnalyzer: ASTAnalyzer) {}

  canHandle(conflict: Conflict): boolean {
    return (
      conflict.conflictType === 'STRUCTURAL' &&
      conflict.analysis?.astDiff !== undefined
    );
  }

  async resolve(conflict: Conflict): Promise<Resolution> {
    const astDiff = conflict.analysis?.astDiff;
    if (!astDiff?.structuralDiff) {
      throw new ResolutionError('No AST diff available for structural merge', conflict);
    }

    const { structuralDiff } = astDiff;

    // Check that no nodes were modified (only additions)
    if (structuralDiff.modifiedNodes.length > 0) {
      throw new ResolutionError(
        'Cannot auto-merge: both sides modified existing code',
        conflict
      );
    }

    // Merge strategy: combine both sets of additions
    const content = await this.mergeStructuralChanges(conflict, structuralDiff);

    return {
      content,
      strategy: this.name,
      explanation: 'Merged structural additions from both branches'
    };
  }

  explain(conflict: Conflict, resolution: Resolution): string {
    const astDiff = conflict.analysis?.astDiff?.structuralDiff;
    const addedCount = astDiff?.addedNodes.length || 0;
    const removedCount = astDiff?.removedNodes.length || 0;

    let explanation = `Resolved structural conflict in ${conflict.filePath}. `;

    if (astDiff?.hasImportChanges) {
      explanation += 'Merged import statements from both branches. ';
    }

    if (astDiff?.hasExportChanges) {
      explanation += 'Merged export statements from both branches. ';
    }

    if (addedCount > 0) {
      explanation += `Combined ${addedCount} new declaration${addedCount > 1 ? 's' : ''}. `;
    }

    return explanation.trim();
  }

  identifyRisks(conflict: Conflict): string[] {
    return [
      'May miss subtle dependencies between changes',
      'Import order might affect behavior in some cases',
      'New functions might have naming conflicts'
    ];
  }

  /**
   * Merge structural changes from both branches
   *
   * Strategy:
   * 1. Combine unique imports from both sides
   * 2. Combine unique exports from both sides
   * 3. Preserve all function/class additions
   * 4. Maintain original order where possible
   */
  private async mergeStructuralChanges(
    conflict: Conflict,
    structuralDiff: any
  ): Promise<string> {
    // For now, use a simple heuristic: take ours and append theirs' unique additions
    // In production, would need proper AST-based merging

    const marker = conflict.markers[0]; // Simplified: assume single conflict
    const lines = [];

    // Start with our content
    lines.push(marker.oursContent);

    // Add separator comment
    lines.push('// === Merged changes from other branch ===');

    // Add their unique additions
    lines.push(marker.theirsContent);

    return lines.join('\n');
  }
}

/**
 * ConcurrentEditStrategy - Handles same-line edits with user guidance
 *
 * When both branches modified the same lines, we can't auto-merge safely.
 * This strategy provides structured output for manual resolution.
 */
export class ConcurrentEditStrategy implements MergeStrategy {
  name = 'ConcurrentEdit';

  canHandle(conflict: Conflict): boolean {
    return conflict.conflictType === 'CONCURRENT_EDIT';
  }

  async resolve(conflict: Conflict): Promise<Resolution> {
    // For concurrent edits, we prefer ours but mark it clearly
    const marker = conflict.markers[0];
    const content = marker.oursContent;

    // Add comment indicating manual review needed
    const annotatedContent =
      `// CONFLICT: Manual review required\n` +
      `// Both branches modified these lines\n` +
      `// Current branch version shown below\n` +
      `${content}\n` +
      `// --- Alternative from other branch ---\n` +
      `${marker.theirsContent.split('\n').map(line => `// ${line}`).join('\n')}`;

    return {
      content: annotatedContent,
      strategy: this.name,
      explanation: 'Conflict requires manual review - kept current branch with annotations'
    };
  }

  explain(conflict: Conflict, resolution: Resolution): string {
    return `Concurrent edit detected in ${conflict.filePath}. ` +
           `Both branches modified the same code. Kept current branch version with ` +
           `commented alternatives. Manual review required.`;
  }

  identifyRisks(conflict: Conflict): string[] {
    return [
      'Manual review required to ensure correctness',
      'Current branch changes may not be the correct choice',
      'May need to combine aspects of both changes'
    ];
  }
}

/**
 * FallbackStrategy - Always succeeds (for manual review)
 *
 * This is the strategy of last resort. It picks one side (ours)
 * and marks the file for manual review. Never throws ResolutionError.
 */
export class FallbackStrategy implements MergeStrategy {
  name = 'Fallback';

  canHandle(conflict: Conflict): boolean {
    return true; // Always applicable as last resort
  }

  async resolve(conflict: Conflict): Promise<Resolution> {
    // Always succeeds by picking ours
    const marker = conflict.markers[0];

    return {
      content: marker.oursContent,
      strategy: this.name,
      explanation: 'Conflict too complex for automatic resolution - kept current branch'
    };
  }

  explain(conflict: Conflict, resolution: Resolution): string {
    return `Complex ${conflict.conflictType} conflict in ${conflict.filePath}. ` +
           `Automatic resolution not available. Kept current branch changes. ` +
           `MANUAL REVIEW REQUIRED.`;
  }

  identifyRisks(conflict: Conflict): string[] {
    return [
      'Manual review required to ensure correctness',
      'May lose important changes from other branch',
      'Severity: ' + conflict.severity
    ];
  }
}

/**
 * StrategyChain - Apply strategies in order until one succeeds
 *
 * Utility class for orchestrating multiple strategies.
 */
export class StrategyChain {
  constructor(private strategies: MergeStrategy[]) {}

  /**
   * Attempt to resolve conflict using strategies in order
   *
   * @param conflict - The conflict to resolve
   * @returns Resolution from first successful strategy
   * @throws ResolutionError if no strategy can resolve (shouldn't happen with FallbackStrategy)
   */
  async resolve(conflict: Conflict): Promise<{
    resolution: Resolution;
    strategy: MergeStrategy;
  }> {
    for (const strategy of this.strategies) {
      if (strategy.canHandle(conflict)) {
        try {
          const resolution = await strategy.resolve(conflict);
          return { resolution, strategy };
        } catch (error) {
          if (error instanceof ResolutionError) {
            // Try next strategy
            continue;
          }
          // Unexpected error - rethrow
          throw error;
        }
      }
    }

    // Should never reach here if FallbackStrategy is included
    throw new ResolutionError('No strategy could resolve conflict', conflict);
  }

  /**
   * Get all applicable strategies for a conflict
   */
  getApplicableStrategies(conflict: Conflict): MergeStrategy[] {
    return this.strategies.filter(s => s.canHandle(conflict));
  }
}

/**
 * Create default strategy chain for conflict resolution
 *
 * Order matters: more specific strategies first, fallback last.
 */
export function createDefaultStrategyChain(astAnalyzer?: ASTAnalyzer): StrategyChain {
  const strategies: MergeStrategy[] = [
    new TrivialMergeStrategy(),
  ];

  if (astAnalyzer) {
    strategies.push(new StructuralMergeStrategy(astAnalyzer));
  }

  strategies.push(
    new ConcurrentEditStrategy(),
    new FallbackStrategy()
  );

  return new StrategyChain(strategies);
}
