/**
 * Basic smoke tests for MergeStrategies
 */

import { describe, it, expect } from 'vitest';
import {
  TrivialMergeStrategy,
  StructuralMergeStrategy,
  ConcurrentEditStrategy,
  FallbackStrategy,
  StrategyChain,
  createDefaultStrategyChain,
  ResolutionError
} from '../src/merge-strategies.js';
import { ASTAnalyzer } from '../src/ast-analyzer.js';
import type { Conflict } from '../src/conflict-detector.js';

describe('MergeStrategies', () => {
  describe('TrivialMergeStrategy', () => {
    const strategy = new TrivialMergeStrategy();

    it('should handle trivial conflicts', () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'TRIVIAL',
        severity: 'LOW',
        markers: []
      };

      expect(strategy.canHandle(conflict)).toBe(true);
    });

    it('should not handle non-trivial conflicts', () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'SEMANTIC',
        severity: 'HIGH',
        markers: []
      };

      expect(strategy.canHandle(conflict)).toBe(false);
    });

    it('should resolve whitespace-only conflicts', async () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'TRIVIAL',
        severity: 'LOW',
        markers: [{
          start: 0,
          divider: 1,
          end: 2,
          oursContent: 'function foo() {}',
          theirsContent: 'function foo() {}'
        }]
      };

      const resolution = await strategy.resolve(conflict);

      expect(resolution.strategy).toBe('TrivialMerge');
      expect(resolution.content).toBeTruthy();
    });

    it('should throw ResolutionError for non-trivial content', async () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'TRIVIAL',
        severity: 'LOW',
        markers: [{
          start: 0,
          divider: 1,
          end: 2,
          oursContent: 'const x = 1;',
          theirsContent: 'const x = 2;'
        }]
      };

      await expect(strategy.resolve(conflict)).rejects.toThrow(ResolutionError);
    });

    it('should identify no risks for trivial merges', () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'TRIVIAL',
        severity: 'LOW',
        markers: []
      };

      const risks = strategy.identifyRisks(conflict);

      expect(risks).toHaveLength(0);
    });
  });

  describe('StructuralMergeStrategy', () => {
    const analyzer = new ASTAnalyzer();
    const strategy = new StructuralMergeStrategy(analyzer);

    it('should handle structural conflicts with AST diff', () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'STRUCTURAL',
        severity: 'LOW',
        markers: [],
        analysis: {
          astDiff: {
            hasStructuralChanges: true,
            structuralDiff: {
              addedNodes: [],
              removedNodes: [],
              modifiedNodes: [],
              hasImportChanges: false,
              hasExportChanges: false
            }
          }
        }
      };

      expect(strategy.canHandle(conflict)).toBe(true);
    });

    it('should not handle conflicts without AST diff', () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'STRUCTURAL',
        severity: 'LOW',
        markers: []
      };

      expect(strategy.canHandle(conflict)).toBe(false);
    });

    it('should identify risks for structural merges', () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'STRUCTURAL',
        severity: 'LOW',
        markers: []
      };

      const risks = strategy.identifyRisks(conflict);

      expect(risks.length).toBeGreaterThan(0);
      expect(risks.some(r => r.includes('dependencies'))).toBe(true);
    });
  });

  describe('ConcurrentEditStrategy', () => {
    const strategy = new ConcurrentEditStrategy();

    it('should handle concurrent edits', () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'CONCURRENT_EDIT',
        severity: 'MEDIUM',
        markers: []
      };

      expect(strategy.canHandle(conflict)).toBe(true);
    });

    it('should resolve by keeping ours with annotations', async () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'CONCURRENT_EDIT',
        severity: 'MEDIUM',
        markers: [{
          start: 0,
          divider: 1,
          end: 2,
          oursContent: 'const x = 1;',
          theirsContent: 'const x = 2;'
        }]
      };

      const resolution = await strategy.resolve(conflict);

      expect(resolution.strategy).toBe('ConcurrentEdit');
      expect(resolution.content).toContain('CONFLICT');
      expect(resolution.content).toContain('Manual review required');
    });

    it('should identify manual review risk', () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'CONCURRENT_EDIT',
        severity: 'MEDIUM',
        markers: []
      };

      const risks = strategy.identifyRisks(conflict);

      expect(risks.some(r => r.includes('Manual review'))).toBe(true);
    });
  });

  describe('FallbackStrategy', () => {
    const strategy = new FallbackStrategy();

    it('should handle all conflicts', () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'SEMANTIC',
        severity: 'HIGH',
        markers: []
      };

      expect(strategy.canHandle(conflict)).toBe(true);
    });

    it('should always resolve by picking ours', async () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'SEMANTIC',
        severity: 'HIGH',
        markers: [{
          start: 0,
          divider: 1,
          end: 2,
          oursContent: 'const x = 1;',
          theirsContent: 'const x = 2;'
        }]
      };

      const resolution = await strategy.resolve(conflict);

      expect(resolution.strategy).toBe('Fallback');
      expect(resolution.content).toBe('const x = 1;');
    });

    it('should include severity in risks', () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'SEMANTIC',
        severity: 'HIGH',
        markers: []
      };

      const risks = strategy.identifyRisks(conflict);

      expect(risks.some(r => r.includes('HIGH'))).toBe(true);
    });
  });

  describe('StrategyChain', () => {
    it('should apply strategies in order', async () => {
      const strategies = [
        new TrivialMergeStrategy(),
        new FallbackStrategy()
      ];

      const chain = new StrategyChain(strategies);

      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'SEMANTIC',
        severity: 'HIGH',
        markers: [{
          start: 0,
          divider: 1,
          end: 2,
          oursContent: 'const x = 1;',
          theirsContent: 'const x = 2;'
        }]
      };

      const { resolution, strategy } = await chain.resolve(conflict);

      // Should use Fallback since Trivial can't handle SEMANTIC
      expect(strategy.name).toBe('Fallback');
    });

    it('should use first applicable strategy', async () => {
      const strategies = [
        new TrivialMergeStrategy(),
        new FallbackStrategy()
      ];

      const chain = new StrategyChain(strategies);

      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'TRIVIAL',
        severity: 'LOW',
        markers: [{
          start: 0,
          divider: 1,
          end: 2,
          oursContent: '  const x = 1;  ',
          theirsContent: 'const x = 1;'
        }]
      };

      const { resolution, strategy } = await chain.resolve(conflict);

      // Should use TrivialMerge
      expect(strategy.name).toBe('TrivialMerge');
    });

    it('should get applicable strategies', () => {
      const strategies = [
        new TrivialMergeStrategy(),
        new FallbackStrategy()
      ];

      const chain = new StrategyChain(strategies);

      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'TRIVIAL',
        severity: 'LOW',
        markers: []
      };

      const applicable = chain.getApplicableStrategies(conflict);

      // Both should be applicable (TrivialMerge + Fallback)
      expect(applicable.length).toBe(2);
    });
  });

  describe('createDefaultStrategyChain', () => {
    it('should create chain without AST analyzer', () => {
      const chain = createDefaultStrategyChain();

      expect(chain).toBeInstanceOf(StrategyChain);
    });

    it('should create chain with AST analyzer', () => {
      const analyzer = new ASTAnalyzer();
      const chain = createDefaultStrategyChain(analyzer);

      expect(chain).toBeInstanceOf(StrategyChain);

      // Should include StructuralMergeStrategy when analyzer provided
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'STRUCTURAL',
        severity: 'LOW',
        markers: [],
        analysis: {
          astDiff: {
            hasStructuralChanges: true,
            structuralDiff: {
              addedNodes: [],
              removedNodes: [],
              modifiedNodes: [],
              hasImportChanges: false,
              hasExportChanges: false
            }
          }
        }
      };

      const applicable = chain.getApplicableStrategies(conflict);
      expect(applicable.some(s => s.name === 'StructuralMerge')).toBe(true);
    });
  });

  describe('ResolutionError', () => {
    it('should preserve conflict reference', () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'SEMANTIC',
        severity: 'HIGH',
        markers: []
      };

      const error = new ResolutionError('Test error', conflict);

      expect(error.name).toBe('ResolutionError');
      expect(error.message).toBe('Test error');
      expect(error.conflict).toBe(conflict);
    });
  });
});
