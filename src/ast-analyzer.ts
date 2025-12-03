/**
 * AST Analysis Module for parallel-cc v0.5
 *
 * Parses TypeScript/JavaScript files to detect structural and semantic
 * changes using Babel parser. Enables smart conflict detection beyond
 * simple text-based diff.
 */

import * as babelParser from '@babel/parser';
import traverseDefault from '@babel/traverse';
import * as t from '@babel/types';
import { readFile, stat } from 'fs/promises';
import * as path from 'path';

// Handle ESM/CJS interop for @babel/traverse
const traverse = (traverseDefault as any).default || traverseDefault;

/**
 * Simplified AST node representation
 */
export interface ASTNode {
  /** Node type (e.g., 'FunctionDeclaration', 'ImportDeclaration') */
  type: string;
  /** Node name/identifier (if applicable) */
  name?: string;
  /** Source location (line/column) */
  loc?: { start: number; end: number };
}

/**
 * Structural differences between two ASTs
 */
export interface StructuralDiff {
  /** Nodes added in the new version */
  addedNodes: ASTNode[];
  /** Nodes removed from the old version */
  removedNodes: ASTNode[];
  /** Nodes that exist in both but were modified */
  modifiedNodes: ASTNode[];
  /** Whether import statements changed */
  hasImportChanges: boolean;
  /** Whether export statements changed */
  hasExportChanges: boolean;
}

/**
 * AST-based diff result
 */
export interface ASTDiff {
  /** Whether any structural changes were detected */
  hasStructuralChanges: boolean;
  /** Detailed structural diff (if changes detected) */
  structuralDiff?: StructuralDiff;
}

/**
 * Cache entry for parsed ASTs
 */
interface ASTCacheEntry {
  ast: t.File;
  mtime: number; // File modification time
}

/**
 * ASTAnalyzer - Parse and analyze code structure
 *
 * Uses Babel parser with error recovery for robust parsing.
 * Implements graceful degradation: returns null on parse errors
 * rather than throwing, allowing fallback to text-based detection.
 */
export class ASTAnalyzer {
  /** Cache of parsed ASTs keyed by file path */
  private astCache = new Map<string, ASTCacheEntry>();

  /** Timeout for AST parsing (5 seconds) */
  private readonly PARSE_TIMEOUT_MS = 5000;

  /** Babel parser plugins for TypeScript/JSX */
  private readonly PARSER_PLUGINS: babelParser.ParserPlugin[] = [
    'typescript',
    'jsx',
    'decorators-legacy',
    'classProperties'
  ];

  /**
   * Parse file to AST with error recovery
   *
   * CRITICAL: Graceful degradation on parse errors (architecture review requirement)
   * Returns null on parse failure to allow fallback to text-based detection.
   *
   * @param filePath - Path to file (used for cache key)
   * @param content - File content to parse
   * @returns Parsed AST or null on error
   */
  async parseFile(filePath: string, content: string): Promise<t.File | null> {
    try {
      // Check cache first
      const cached = await this.getCachedAST(filePath);
      if (cached) {
        return cached;
      }

      // Parse with timeout
      const ast = await this.parseWithTimeout(content, filePath);

      if (ast) {
        // Cache the result (use current time as mtime for in-memory content)
        this.astCache.set(filePath, {
          ast,
          mtime: Date.now()
        });
      }

      return ast;
    } catch (error) {
      // Graceful degradation: return null on parse error
      // Caller should fall back to text-based detection
      return null;
    }
  }

  /**
   * Detect structural changes between two ASTs
   *
   * Compares top-level declarations (functions, classes, imports, exports)
   * and identifies additions, removals, and modifications.
   *
   * @param ast1 - Original AST
   * @param ast2 - Modified AST
   * @returns Structural diff
   */
  detectStructuralChanges(ast1: t.File, ast2: t.File): StructuralDiff {
    const nodes1 = this.extractTopLevelNodes(ast1);
    const nodes2 = this.extractTopLevelNodes(ast2);

    const addedNodes: ASTNode[] = [];
    const removedNodes: ASTNode[] = [];
    const modifiedNodes: ASTNode[] = [];

    // Build maps for efficient lookup
    const nodes1Map = new Map(nodes1.map(n => [this.nodeKey(n), n]));
    const nodes2Map = new Map(nodes2.map(n => [this.nodeKey(n), n]));

    // Find added and modified nodes
    for (const node2 of nodes2) {
      const key = this.nodeKey(node2);
      const node1 = nodes1Map.get(key);

      if (!node1) {
        // Node added in ast2
        addedNodes.push(node2);
      } else {
        // Node exists in both - check if modified
        // (Simplified: we'd need deeper comparison in production)
        // For now, assume same key = not modified at this level
      }
    }

    // Find removed nodes
    for (const node1 of nodes1) {
      const key = this.nodeKey(node1);
      if (!nodes2Map.has(key)) {
        removedNodes.push(node1);
      }
    }

    // Check for import/export changes
    const hasImportChanges = this.hasNodeTypeChanges(nodes1, nodes2, 'ImportDeclaration');
    const hasExportChanges =
      this.hasNodeTypeChanges(nodes1, nodes2, 'ExportNamedDeclaration') ||
      this.hasNodeTypeChanges(nodes1, nodes2, 'ExportDefaultDeclaration') ||
      this.hasNodeTypeChanges(nodes1, nodes2, 'ExportAllDeclaration');

    return {
      addedNodes,
      removedNodes,
      modifiedNodes,
      hasImportChanges,
      hasExportChanges
    };
  }

  /**
   * Check if only whitespace/formatting changed
   *
   * Normalizes both strings and compares them.
   *
   * @param ours - Content from current branch
   * @param theirs - Content from incoming branch
   * @returns True if only whitespace differs
   */
  onlyWhitespaceChanges(ours: string, theirs: string): boolean {
    const normalized1 = this.normalizeCode(ours);
    const normalized2 = this.normalizeCode(theirs);
    return normalized1 === normalized2;
  }

  /**
   * Clear AST cache (for memory management)
   */
  clearCache(): void {
    this.astCache.clear();
  }

  /**
   * Extract top-level nodes (functions, classes, imports)
   *
   * Traverses AST and collects significant declaration nodes.
   */
  private extractTopLevelNodes(ast: t.File): ASTNode[] {
    const nodes: ASTNode[] = [];

    traverse(ast, {
      // Function declarations
      FunctionDeclaration(path: any) {
        if (path.parent.type === 'Program') {
          nodes.push({
            type: 'FunctionDeclaration',
            name: path.node.id?.name,
            loc: path.node.loc ? {
              start: path.node.loc.start.line,
              end: path.node.loc.end.line
            } : undefined
          });
        }
      },

      // Class declarations
      ClassDeclaration(path: any) {
        if (path.parent.type === 'Program') {
          nodes.push({
            type: 'ClassDeclaration',
            name: path.node.id?.name,
            loc: path.node.loc ? {
              start: path.node.loc.start.line,
              end: path.node.loc.end.line
            } : undefined
          });
        }
      },

      // Variable declarations (const/let/var at top level)
      VariableDeclaration(path: any) {
        if (path.parent.type === 'Program') {
          for (const decl of path.node.declarations) {
            if (t.isIdentifier(decl.id)) {
              nodes.push({
                type: 'VariableDeclaration',
                name: decl.id.name,
                loc: path.node.loc ? {
                  start: path.node.loc.start.line,
                  end: path.node.loc.end.line
                } : undefined
              });
            }
          }
        }
      },

      // Import declarations
      ImportDeclaration(path: any) {
        nodes.push({
          type: 'ImportDeclaration',
          name: path.node.source.value,
          loc: path.node.loc ? {
            start: path.node.loc.start.line,
            end: path.node.loc.end.line
          } : undefined
        });
      },

      // Export declarations
      ExportNamedDeclaration(path: any) {
        nodes.push({
          type: 'ExportNamedDeclaration',
          name: path.node.source?.value,
          loc: path.node.loc ? {
            start: path.node.loc.start.line,
            end: path.node.loc.end.line
          } : undefined
        });
      },

      ExportDefaultDeclaration(path: any) {
        nodes.push({
          type: 'ExportDefaultDeclaration',
          loc: path.node.loc ? {
            start: path.node.loc.start.line,
            end: path.node.loc.end.line
          } : undefined
        });
      },

      ExportAllDeclaration(path: any) {
        nodes.push({
          type: 'ExportAllDeclaration',
          name: path.node.source.value,
          loc: path.node.loc ? {
            start: path.node.loc.start.line,
            end: path.node.loc.end.line
          } : undefined
        });
      }
    });

    return nodes;
  }

  /**
   * Parse with timeout to prevent hanging on large files
   */
  private async parseWithTimeout(content: string, filePath: string): Promise<t.File | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(null); // Timeout - return null
      }, this.PARSE_TIMEOUT_MS);

      try {
        const ast = babelParser.parse(content, {
          sourceType: 'module',
          plugins: this.PARSER_PLUGINS,
          errorRecovery: true, // CRITICAL: Enable error recovery
          sourceFilename: filePath
        });

        clearTimeout(timer);
        resolve(ast);
      } catch (error) {
        clearTimeout(timer);
        resolve(null); // Parse error - return null
      }
    });
  }

  /**
   * Get cached AST if file hasn't changed
   */
  private async getCachedAST(filePath: string): Promise<t.File | null> {
    const cached = this.astCache.get(filePath);
    if (!cached) return null;

    try {
      // Check if file has been modified
      const stats = await stat(filePath);
      const currentMtime = stats.mtimeMs;

      if (currentMtime === cached.mtime) {
        return cached.ast;
      }

      // File modified, invalidate cache
      this.astCache.delete(filePath);
      return null;
    } catch {
      // File doesn't exist or can't be accessed
      // This is expected for in-memory content during conflict resolution
      return cached.ast;
    }
  }

  /**
   * Generate unique key for AST node
   */
  private nodeKey(node: ASTNode): string {
    return `${node.type}:${node.name || 'anonymous'}`;
  }

  /**
   * Check if nodes of specific type changed
   */
  private hasNodeTypeChanges(
    nodes1: ASTNode[],
    nodes2: ASTNode[],
    nodeType: string
  ): boolean {
    const count1 = nodes1.filter(n => n.type === nodeType).length;
    const count2 = nodes2.filter(n => n.type === nodeType).length;
    return count1 !== count2;
  }

  /**
   * Normalize code for whitespace comparison
   */
  private normalizeCode(code: string): string {
    return code
      .replace(/\s+/g, ' ') // Collapse all whitespace to single space
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('//'))
      .join(' ')
      .trim();
  }
}
