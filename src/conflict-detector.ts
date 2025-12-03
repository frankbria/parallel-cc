/**
 * Conflict Detection Module for parallel-cc v0.5
 *
 * Detects and classifies merge/rebase conflicts using git merge-tree
 * for three-way analysis and optional AST-based semantic detection.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { Logger } from './logger.js';
import type { ASTAnalyzer, ASTDiff } from './ast-analyzer.js';
import type { ConflictType } from './types.js';

const execAsync = promisify(exec);

/**
 * Severity levels for conflicts
 */
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH';

/**
 * Parsed conflict markers from file content
 */
export interface ConflictMarkers {
  /** Line number where conflict starts (<<<<<<< marker) */
  start: number;
  /** Line number of divider (======= marker) */
  divider: number;
  /** Line number where conflict ends (>>>>>>> marker) */
  end: number;
  /** Content from current branch (ours) */
  oursContent: string;
  /** Content from incoming branch (theirs) */
  theirsContent: string;
  /** Content from common ancestor (base), if available */
  baseContent?: string;
}

/**
 * A detected conflict in a file
 */
export interface Conflict {
  /** Path to the conflicting file (relative to repo) */
  filePath: string;
  /** Type of conflict detected */
  conflictType: ConflictType;
  /** Severity of the conflict */
  severity: Severity;
  /** All conflict markers found in the file */
  markers: ConflictMarkers[];
  /** Optional AST-based analysis */
  analysis?: {
    /** AST structural differences */
    astDiff?: ASTDiff;
    /** Semantic context description */
    semanticContext?: string;
  };
}

/**
 * Summary statistics for a conflict report
 */
export interface ConflictSummary {
  /** Total number of conflicts */
  totalConflicts: number;
  /** Conflicts grouped by type */
  byType: Record<ConflictType, number>;
  /** Conflicts grouped by severity */
  bySeverity: Record<Severity, number>;
  /** Number of conflicts that can be auto-fixed */
  autoFixableCount: number;
}

/**
 * Complete conflict detection report
 */
export interface ConflictReport {
  /** Whether any conflicts were detected */
  hasConflicts: boolean;
  /** List of all conflicts */
  conflicts: Conflict[];
  /** Summary statistics */
  summary: ConflictSummary;
}

/**
 * Parameters for conflict detection
 */
export interface DetectConflictsParams {
  /** Current branch name */
  currentBranch: string;
  /** Target branch to compare against */
  targetBranch: string;
  /** Whether to perform AST-based semantic analysis */
  analyzeSemantics?: boolean;
}

/**
 * Parameters for conflict classification
 */
export interface ClassifyConflictParams {
  /** Path to the conflicting file */
  filePath: string;
  /** Parsed conflict markers */
  markers: ConflictMarkers;
  /** Optional AST diff from analyzer */
  astDiff?: ASTDiff;
}

/**
 * ConflictDetector - Detects and analyzes merge conflicts
 *
 * Uses git merge-tree for three-way analysis and optional AST analysis
 * for semantic conflict detection.
 */
export class ConflictDetector {
  constructor(
    private repoPath: string,
    private astAnalyzer?: ASTAnalyzer,
    private logger?: Logger
  ) {}

  /**
   * Detect conflicts between branches
   *
   * Uses git merge-tree for three-way analysis without modifying the working tree.
   *
   * @param params - Detection parameters
   * @returns Comprehensive conflict report
   */
  async detectConflicts(params: DetectConflictsParams): Promise<ConflictReport> {
    const { currentBranch, targetBranch, analyzeSemantics = false } = params;

    this.logger?.debug('Starting conflict detection', { currentBranch, targetBranch, analyzeSemantics });

    try {
      // Find merge base (common ancestor)
      const mergeBase = await this.findMergeBase(currentBranch, targetBranch);
      this.logger?.debug('Found merge base', { mergeBase });

      // Run git merge-tree to simulate merge
      const mergeTreeOutput = await this.runGitMergeTree(mergeBase, currentBranch, targetBranch);

      // Parse conflicts from merge-tree output
      const conflicts = await this.parseConflictsFromMergeTree(
        mergeTreeOutput,
        analyzeSemantics
      );

      // Build summary statistics
      const summary = this.buildSummary(conflicts);

      return {
        hasConflicts: conflicts.length > 0,
        conflicts,
        summary
      };
    } catch (error) {
      this.logger?.error('Conflict detection failed', error);
      throw new Error(`Conflict detection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Classify a conflict by type
   *
   * Classification logic:
   * - TRIVIAL: Only whitespace/formatting changes
   * - STRUCTURAL: AST changes (imports, exports, function additions)
   * - SEMANTIC: Same code modified differently
   * - CONCURRENT_EDIT: Both sides modified same lines
   *
   * @param params - Classification parameters
   * @returns Conflict type
   */
  classifyConflict(params: ClassifyConflictParams): ConflictType {
    const { filePath, markers, astDiff } = params;

    // Check for trivial conflicts (whitespace only)
    if (this.isTrivialConflict(markers)) {
      return 'TRIVIAL';
    }

    // Use AST diff if available
    if (astDiff?.hasStructuralChanges && this.astAnalyzer) {
      const diff = astDiff.structuralDiff;
      if (diff) {
        // Only structural additions (imports, new functions)
        if (diff.modifiedNodes.length === 0 &&
            (diff.hasImportChanges || diff.hasExportChanges || diff.addedNodes.length > 0)) {
          return 'STRUCTURAL';
        }
      }
      // Both sides modified same code elements
      return 'SEMANTIC';
    }

    // Fallback: concurrent edit
    return 'CONCURRENT_EDIT';
  }

  /**
   * Calculate conflict severity
   *
   * Severity calculation:
   * - HIGH: Multiple conflicts, semantic/concurrent edits
   * - MEDIUM: Single conflict, semantic/concurrent edits
   * - LOW: Trivial or structural conflicts
   *
   * @param conflict - The conflict to assess
   * @returns Severity level
   */
  calculateSeverity(conflict: Conflict): Severity {
    const { conflictType, markers } = conflict;

    // Trivial conflicts are always low severity
    if (conflictType === 'TRIVIAL') {
      return 'LOW';
    }

    // Structural conflicts are low to medium
    if (conflictType === 'STRUCTURAL') {
      return markers.length > 2 ? 'MEDIUM' : 'LOW';
    }

    // Semantic and concurrent edits are medium to high
    if (conflictType === 'SEMANTIC' || conflictType === 'CONCURRENT_EDIT') {
      return markers.length > 2 ? 'HIGH' : 'MEDIUM';
    }

    // Unknown defaults to high (conservative)
    return 'HIGH';
  }

  /**
   * Find the merge base (common ancestor) between two branches
   */
  private async findMergeBase(branch1: string, branch2: string): Promise<string> {
    try {
      const { stdout } = await execAsync(
        `git merge-base ${this.escapeShellArg(branch1)} ${this.escapeShellArg(branch2)}`,
        { cwd: this.repoPath, timeout: 5000 }
      );
      return stdout.trim();
    } catch (error) {
      throw new Error(`Failed to find merge base: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Run git merge-tree command for three-way merge simulation
   *
   * git merge-tree shows what a merge would look like without touching the working tree
   */
  private async runGitMergeTree(
    base: string,
    ours: string,
    theirs: string
  ): Promise<string> {
    try {
      const { stdout } = await execAsync(
        `git merge-tree ${this.escapeShellArg(base)} ${this.escapeShellArg(ours)} ${this.escapeShellArg(theirs)}`,
        { cwd: this.repoPath, timeout: 10000, maxBuffer: 10 * 1024 * 1024 } // 10MB buffer
      );
      return stdout;
    } catch (error) {
      throw new Error(`git merge-tree failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Parse conflicts from git merge-tree output
   *
   * merge-tree output format shows files with conflict markers
   */
  private async parseConflictsFromMergeTree(
    mergeTreeOutput: string,
    analyzeSemantics: boolean
  ): Promise<Conflict[]> {
    const conflicts: Conflict[] = [];

    // Parse merge-tree output to find conflicting files
    // merge-tree shows the merged result with conflict markers
    const lines = mergeTreeOutput.split('\n');
    let currentFile = '';
    let fileContent: string[] = [];
    let inConflictFile = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check for conflict markers
      if (line.includes('<<<<<<<')) {
        inConflictFile = true;
      }

      // Collect file content when in conflict
      if (inConflictFile) {
        fileContent.push(line);

        // End of conflict section
        if (line.includes('>>>>>>>')) {
          // Parse this conflict section
          const content = fileContent.join('\n');
          const markers = this.parseConflictMarkers(content);

          if (markers.length > 0) {
            // Extract file path from merge-tree output (simplified)
            // In real implementation, would need proper parsing
            const filePath = this.extractFilePathFromMergeTree(lines, i);

            // Perform AST analysis if requested
            let astDiff: ASTDiff | undefined;
            if (analyzeSemantics && this.astAnalyzer && this.isAnalyzableFile(filePath)) {
              try {
                const oursContent = markers[0].oursContent;
                const theirsContent = markers[0].theirsContent;

                const oursAst = await this.astAnalyzer.parseFile(filePath, oursContent);
                const theirsAst = await this.astAnalyzer.parseFile(filePath, theirsContent);

                if (oursAst && theirsAst) {
                  const structuralDiff = this.astAnalyzer.detectStructuralChanges(oursAst, theirsAst);
                  astDiff = {
                    hasStructuralChanges: structuralDiff.addedNodes.length > 0 ||
                                         structuralDiff.removedNodes.length > 0 ||
                                         structuralDiff.modifiedNodes.length > 0,
                    structuralDiff
                  };
                }
              } catch (error) {
                this.logger?.warn(`AST analysis failed for ${filePath}: ${error}`);
              }
            }

            // Classify conflict
            const conflictType = this.classifyConflict({ filePath, markers: markers[0], astDiff });

            // Build conflict object
            const conflict: Conflict = {
              filePath,
              conflictType,
              severity: 'MEDIUM', // Will be calculated
              markers,
              analysis: astDiff ? { astDiff } : undefined
            };

            // Calculate severity
            conflict.severity = this.calculateSeverity(conflict);

            conflicts.push(conflict);
          }

          // Reset for next conflict
          fileContent = [];
          inConflictFile = false;
        }
      }
    }

    return conflicts;
  }

  /**
   * Parse conflict markers from file content
   *
   * Standard git conflict markers:
   * <<<<<<< HEAD (or branch name)
   * ... ours content ...
   * =======
   * ... theirs content ...
   * >>>>>>> branch-name
   */
  private parseConflictMarkers(content: string): ConflictMarkers[] {
    const markers: ConflictMarkers[] = [];
    const lines = content.split('\n');

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Look for conflict start marker
      if (line.startsWith('<<<<<<<')) {
        const start = i;
        let baseMarker = -1;
        let divider = -1;
        let end = -1;

        // Find base marker (diff3), divider, and end
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].startsWith('|||||||')) {
            baseMarker = j;
          } else if (lines[j].startsWith('=======')) {
            divider = j;
          } else if (lines[j].startsWith('>>>>>>>')) {
            end = j;
            break;
          }
        }

        if (divider !== -1 && end !== -1) {
          let oursContent: string;
          let theirsContent: string;
          let baseContent: string | undefined;

          // Check if this is a diff3-style conflict (with base section)
          if (baseMarker !== -1 && baseMarker < divider) {
            // Three-way conflict: ours | base | theirs
            oursContent = lines.slice(start + 1, baseMarker).join('\n');
            baseContent = lines.slice(baseMarker + 1, divider).join('\n');
            theirsContent = lines.slice(divider + 1, end).join('\n');
          } else {
            // Two-way conflict: ours | theirs
            oursContent = lines.slice(start + 1, divider).join('\n');
            theirsContent = lines.slice(divider + 1, end).join('\n');
            baseContent = undefined;
          }

          markers.push({
            start,
            divider,
            end,
            oursContent,
            theirsContent,
            baseContent
          });

          i = end + 1;
          continue;
        }
      }

      i++;
    }

    return markers;
  }

  /**
   * Check if conflict is trivial (whitespace/formatting only)
   */
  private isTrivialConflict(marker: ConflictMarkers): boolean {
    const ours = this.normalizeWhitespace(marker.oursContent);
    const theirs = this.normalizeWhitespace(marker.theirsContent);
    return ours === theirs;
  }

  /**
   * Normalize whitespace for comparison
   */
  private normalizeWhitespace(content: string): string {
    return content
      .replace(/\s+/g, ' ') // Collapse all whitespace to single space
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join(' ')
      .trim();
  }

  /**
   * Extract file path from merge-tree output
   *
   * LIMITATION: git merge-tree outputs structured format with OID lines
   * and "Conflicted file info" sections, not standard diff markers.
   * This simplified implementation searches for diff-like markers which
   * may not be present. A production implementation should parse the
   * structured format properly.
   *
   * Expected git merge-tree format:
   * - OID lines with commit hashes
   * - "Conflicted file info" section with mode/oid tuples
   * - File content with conflict markers
   *
   * @param lines - Lines of merge-tree output
   * @param currentIndex - Current line index
   * @returns Extracted file path or 'unknown'
   */
  private extractFilePathFromMergeTree(lines: string[], currentIndex: number): string {
    // Look backwards for file path indicator
    for (let i = currentIndex; i >= Math.max(0, currentIndex - 50); i--) {
      const line = lines[i];

      // Check for diff-style markers (may not be present in merge-tree output)
      if (line.startsWith('+++') || line.startsWith('---')) {
        const match = line.match(/[+-]{3}\s+[ab]\/(.*)/);
        if (match) return match[1];
      }

      // Check for "Conflicted file info" line (actual merge-tree format)
      if (line.includes('Conflicted file info')) {
        const nextLine = lines[i + 1];
        if (nextLine) {
          // Extract path from tuple format: mode oid stage path
          const match = nextLine.match(/\d+\s+[0-9a-f]+\s+\d+\s+(.*)/);
          if (match) return match[1];
        }
      }
    }
    return 'unknown';
  }

  /**
   * Check if file can be analyzed with AST parser
   */
  private isAnalyzableFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ['.ts', '.tsx', '.js', '.jsx'].includes(ext);
  }

  /**
   * Build summary statistics from conflicts
   */
  private buildSummary(conflicts: Conflict[]): ConflictSummary {
    const summary: ConflictSummary = {
      totalConflicts: conflicts.length,
      byType: {
        TRIVIAL: 0,
        STRUCTURAL: 0,
        SEMANTIC: 0,
        CONCURRENT_EDIT: 0,
        UNKNOWN: 0
      },
      bySeverity: {
        LOW: 0,
        MEDIUM: 0,
        HIGH: 0
      },
      autoFixableCount: 0
    };

    for (const conflict of conflicts) {
      summary.byType[conflict.conflictType]++;
      summary.bySeverity[conflict.severity]++;

      // Trivial and structural conflicts are auto-fixable
      if (conflict.conflictType === 'TRIVIAL' || conflict.conflictType === 'STRUCTURAL') {
        summary.autoFixableCount++;
      }
    }

    return summary;
  }

  /**
   * Escape shell argument to prevent injection
   */
  private escapeShellArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
}
