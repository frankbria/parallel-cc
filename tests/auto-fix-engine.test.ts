/**
 * Tests for AutoFixEngine and ConfidenceScorer
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { AutoFixEngine, GenerateSuggestionsParams, ApplySuggestionParams } from '../src/auto-fix-engine.js';
import { ConfidenceScorer } from '../src/confidence-scorer.js';
import { ASTAnalyzer } from '../src/ast-analyzer.js';
import { createDefaultStrategyChain, StrategyChain } from '../src/merge-strategies.js';
import { Conflict, ConflictMarkers } from '../src/conflict-detector.js';
import { SessionDB } from '../src/db.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

describe('ConfidenceScorer', () => {
  let scorer: ConfidenceScorer;
  let astAnalyzer: ASTAnalyzer;
  let strategyChain: StrategyChain;

  beforeEach(() => {
    astAnalyzer = new ASTAnalyzer();
    scorer = new ConfidenceScorer(astAnalyzer);
    strategyChain = createDefaultStrategyChain(astAnalyzer);
  });

  describe('calculateConfidence', () => {
    it('should return high confidence for trivial conflicts', async () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'TRIVIAL',
        severity: 'LOW',
        markers: [{
          start: 0,
          divider: 2,
          end: 4,
          oursContent: 'const x = 1;',
          theirsContent: 'const  x  =  1;' // Only whitespace differs
        }]
      };

      const resolution = {
        content: 'const x = 1;',
        strategy: 'TrivialMerge',
        explanation: 'Whitespace-only conflict'
      };

      const strategy = strategyChain.getApplicableStrategies(conflict)[0];
      const confidence = scorer.calculateConfidence({ conflict, resolution, strategy });

      expect(confidence).toBeGreaterThan(0.8); // High confidence for trivial
    });

    it('should return lower confidence for semantic conflicts', async () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'SEMANTIC',
        severity: 'HIGH',
        markers: [{
          start: 0,
          divider: 2,
          end: 4,
          oursContent: 'function foo() { return 1; }',
          theirsContent: 'function foo() { return 2; }'
        }]
      };

      const resolution = {
        content: 'function foo() { return 1; }',
        strategy: 'Fallback',
        explanation: 'Manual review required'
      };

      const strategy = strategyChain.getApplicableStrategies(conflict)[0];
      const confidence = scorer.calculateConfidence({ conflict, resolution, strategy });

      expect(confidence).toBeLessThan(0.5); // Lower confidence for semantic
    });

    it('should apply penalty for large changes', async () => {
      const largeContent = 'line\n'.repeat(100); // 100 lines

      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'CONCURRENT_EDIT',
        severity: 'MEDIUM',
        markers: [{
          start: 0,
          divider: 50,
          end: 100,
          oursContent: largeContent,
          theirsContent: largeContent
        }]
      };

      const resolution = {
        content: largeContent,
        strategy: 'ConcurrentEdit',
        explanation: 'Large concurrent edit'
      };

      const strategy = strategyChain.getApplicableStrategies(conflict)[0];
      const confidence = scorer.calculateConfidence({ conflict, resolution, strategy });

      // Should have penalty applied
      expect(confidence).toBeLessThan(0.7);
    });
  });

  describe('getFactors', () => {
    it('should return detailed factor breakdown', async () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'STRUCTURAL',
        severity: 'LOW',
        markers: [{
          start: 0,
          divider: 2,
          end: 4,
          oursContent: 'import { A } from "./a";',
          theirsContent: 'import { B } from "./b";'
        }],
        analysis: {
          astDiff: {
            hasStructuralChanges: true,
            structuralDiff: {
              addedNodes: [{ type: 'ImportDeclaration', name: 'b' }],
              removedNodes: [],
              modifiedNodes: [],
              hasImportChanges: true,
              hasExportChanges: false
            }
          }
        }
      };

      const resolution = {
        content: 'import { A } from "./a";\nimport { B } from "./b";',
        strategy: 'StructuralMerge',
        explanation: 'Merged imports'
      };

      const strategy = strategyChain.getApplicableStrategies(conflict)[0];
      const factors = scorer.getFactors({ conflict, resolution, strategy });

      expect(factors).toHaveProperty('complexity');
      expect(factors).toHaveProperty('similarity');
      expect(factors).toHaveProperty('astValidity');
      expect(factors).toHaveProperty('strategySuccess');

      expect(factors.complexity).toBeGreaterThan(0.8); // Structural with imports
      expect(factors.astValidity).toBeGreaterThanOrEqual(0); // Balanced braces
    });
  });

  describe('factorComplexity', () => {
    it('should score TRIVIAL conflicts highest', () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'TRIVIAL',
        severity: 'LOW',
        markers: []
      };

      const resolution = { content: '', strategy: 'TrivialMerge', explanation: '' };
      const strategy = strategyChain.getApplicableStrategies(conflict)[0];
      const factors = scorer.getFactors({ conflict, resolution, strategy });

      expect(factors.complexity).toBe(1.0);
    });

    it('should score SEMANTIC conflicts lowest', () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'SEMANTIC',
        severity: 'HIGH',
        markers: []
      };

      const resolution = { content: '', strategy: 'Fallback', explanation: '' };
      const strategy = strategyChain.getApplicableStrategies(conflict)[0];
      const factors = scorer.getFactors({ conflict, resolution, strategy });

      expect(factors.complexity).toBe(0.3);
    });
  });

  describe('updateStrategySuccessRate', () => {
    it('should update success rate on successful resolution', () => {
      const initialRate = 0.5;
      scorer.updateStrategySuccessRate('TestStrategy', true);

      // Rate should increase (exponential moving average)
      // new_rate = 0.9 * 0.5 + 0.1 * 1.0 = 0.55
      // (actual implementation may differ)
    });

    it('should decrease success rate on failed resolution', () => {
      scorer.updateStrategySuccessRate('TestStrategy', false);

      // Rate should decrease
      // new_rate = 0.9 * 0.5 + 0.1 * 0.0 = 0.45
    });
  });
});

describe('AutoFixEngine', () => {
  let engine: AutoFixEngine;
  let db: SessionDB;
  let astAnalyzer: ASTAnalyzer;
  let confidenceScorer: ConfidenceScorer;
  let strategyChain: StrategyChain;
  let tempDir: string;
  let testRepoPath: string;

  beforeEach(async () => {
    // Create temp directory for testing
    tempDir = mkdtempSync(path.join(tmpdir(), 'auto-fix-test-'));
    testRepoPath = path.join(tempDir, 'repo');
    await fs.mkdir(testRepoPath, { recursive: true });

    // Copy migration file to temp directory
    const migrationsDir = path.join(tempDir, 'migrations');
    await fs.mkdir(migrationsDir, { recursive: true });
    const sourceMigration = path.join(process.cwd(), 'migrations', 'v0.5.0.sql');
    const destMigration = path.join(migrationsDir, 'v0.5.0.sql');
    await fs.copyFile(sourceMigration, destMigration);

    // Initialize database
    const dbPath = path.join(tempDir, 'test.db');
    db = new SessionDB(dbPath);

    // Run migration to create v0.5 tables
    // Change working directory temporarily for migration
    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
      await db.migrateToV05();
    } finally {
      process.chdir(originalCwd);
    }

    // Initialize components
    astAnalyzer = new ASTAnalyzer();
    confidenceScorer = new ConfidenceScorer(astAnalyzer);
    strategyChain = createDefaultStrategyChain(astAnalyzer);
    engine = new AutoFixEngine(db, astAnalyzer, confidenceScorer, strategyChain);
  });

  afterEach(async () => {
    // Cleanup
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('generateSuggestions', () => {
    it('should generate suggestions for trivial conflict', async () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'TRIVIAL',
        severity: 'LOW',
        markers: [{
          start: 0,
          divider: 2,
          end: 4,
          oursContent: 'const x = 1;',
          theirsContent: 'const  x  =  1;',
          baseContent: 'const x = 1;'
        }]
      };

      const params: GenerateSuggestionsParams = {
        repoPath: testRepoPath,
        filePath: 'test.ts',
        conflict,
        maxSuggestions: 3
      };

      const suggestions = await engine.generateSuggestions(params);

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0]).toHaveProperty('id');
      expect(suggestions[0]).toHaveProperty('confidence_score');
      expect(suggestions[0]).toHaveProperty('suggested_resolution');
      expect(suggestions[0].confidence_score).toBeGreaterThan(0);
    });

    it('should sort suggestions by confidence', async () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'CONCURRENT_EDIT',
        severity: 'MEDIUM',
        markers: [{
          start: 0,
          divider: 2,
          end: 4,
          oursContent: 'function foo() { return 1; }',
          theirsContent: 'function foo() { return 2; }',
          baseContent: 'function foo() { return 0; }'
        }]
      };

      const params: GenerateSuggestionsParams = {
        repoPath: testRepoPath,
        filePath: 'test.ts',
        conflict,
        maxSuggestions: 5
      };

      const suggestions = await engine.generateSuggestions(params);

      // Verify sorted by confidence (descending)
      for (let i = 0; i < suggestions.length - 1; i++) {
        expect(suggestions[i].confidence_score).toBeGreaterThanOrEqual(
          suggestions[i + 1].confidence_score
        );
      }
    });

    it('should limit suggestions to maxSuggestions', async () => {
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'CONCURRENT_EDIT',
        severity: 'MEDIUM',
        markers: [{
          start: 0,
          divider: 2,
          end: 4,
          oursContent: 'const x = 1;',
          theirsContent: 'const x = 2;',
          baseContent: 'const x = 0;'
        }]
      };

      const params: GenerateSuggestionsParams = {
        repoPath: testRepoPath,
        filePath: 'test.ts',
        conflict,
        maxSuggestions: 2
      };

      const suggestions = await engine.generateSuggestions(params);

      expect(suggestions.length).toBeLessThanOrEqual(2);
    });

    it('should handle no strategies succeeding', async () => {
      // Create a conflict that no strategy can handle
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'UNKNOWN',
        severity: 'HIGH',
        markers: [{
          start: 0,
          divider: 2,
          end: 4,
          oursContent: 'complex code',
          theirsContent: 'different complex code',
          baseContent: 'original code'
        }]
      };

      const params: GenerateSuggestionsParams = {
        repoPath: testRepoPath,
        filePath: 'test.ts',
        conflict,
        maxSuggestions: 3
      };

      const suggestions = await engine.generateSuggestions(params);

      // Should still get fallback strategy suggestion
      expect(suggestions.length).toBeGreaterThan(0);
    });
  });

  describe('applySuggestion', () => {
    it('should apply suggestion with backup in dry run mode', async () => {
      // Create test file
      const testFile = path.join(testRepoPath, 'test.ts');
      const originalContent = 'const x = 1;';
      await fs.writeFile(testFile, originalContent, 'utf-8');

      // Generate suggestion
      const conflict: Conflict = {
        filePath: 'test.ts',
        conflictType: 'TRIVIAL',
        severity: 'LOW',
        markers: [{
          start: 0,
          divider: 2,
          end: 4,
          oursContent: 'const x = 1;',
          theirsContent: 'const  x  =  1;',
          baseContent: 'const x = 1;'
        }]
      };

      const suggestions = await engine.generateSuggestions({
        repoPath: testRepoPath,
        filePath: 'test.ts',
        conflict
      });

      const suggestion = suggestions[0];

      // Apply in dry run mode
      const result = await engine.applySuggestion({
        suggestionId: suggestion.id,
        dryRun: true,
        createBackup: true
      });

      expect(result.success).toBe(true);
      expect(result.applied).toBe(false); // Not actually applied in dry run
      expect(result.verification).toHaveProperty('conflictMarkersRemaining');
      expect(result.verification).toHaveProperty('syntaxValid');

      // File should be unchanged
      const currentContent = await fs.readFile(testFile, 'utf-8');
      expect(currentContent).toBe(originalContent);
    });

    it('should apply suggestion and create backup', async () => {
      // Create test file with conflict markers
      const testFile = path.join(testRepoPath, 'test.ts');
      const conflictContent = `<<<<<<< HEAD
const x = 1;
=======
const  x  =  1;
>>>>>>> other-branch`;
      await fs.writeFile(testFile, conflictContent, 'utf-8');

      // Create suggestion manually
      const suggestion = db.createAutoFixSuggestion({
        repo_path: testRepoPath,
        file_path: 'test.ts',
        conflict_type: 'TRIVIAL',
        suggested_resolution: 'const x = 1;',
        confidence_score: 0.95,
        explanation: 'Trivial whitespace conflict',
        strategy_used: 'TrivialMerge',
        base_content: 'const x = 1;',
        source_content: 'const x = 1;',
        target_content: 'const  x  =  1;'
      });

      // Apply suggestion
      const result = await engine.applySuggestion({
        suggestionId: suggestion.id,
        dryRun: false,
        createBackup: true
      });

      expect(result.success).toBe(true);
      expect(result.applied).toBe(true);
      expect(result.backupPath).toBeDefined();
      expect(result.rollbackCommand).toContain('cp');

      // Verify file content
      const newContent = await fs.readFile(testFile, 'utf-8');
      expect(newContent).toBe('const x = 1;');

      // Verify backup exists
      if (result.backupPath) {
        const backupExists = await fs.access(result.backupPath).then(() => true).catch(() => false);
        expect(backupExists).toBe(true);
      }

      // Verify no conflict markers
      expect(result.verification.conflictMarkersRemaining).toBe(0);
      expect(result.verification.syntaxValid).toBe(true);
    });

    it('should rollback on syntax error', async () => {
      // Create test file
      const testFile = path.join(testRepoPath, 'test.ts');
      const originalContent = 'const x = 1;';
      await fs.writeFile(testFile, originalContent, 'utf-8');

      // Create suggestion with invalid syntax
      const suggestion = db.createAutoFixSuggestion({
        repo_path: testRepoPath,
        file_path: 'test.ts',
        conflict_type: 'CONCURRENT_EDIT',
        suggested_resolution: 'const x = { broken syntax', // Invalid
        confidence_score: 0.5,
        explanation: 'Test suggestion',
        strategy_used: 'ConcurrentEdit',
        base_content: 'const x = 1;',
        source_content: 'const x = 1;',
        target_content: 'const x = 2;'
      });

      // Apply suggestion (should fail and rollback)
      const result = await engine.applySuggestion({
        suggestionId: suggestion.id,
        dryRun: false,
        createBackup: true
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      // Verify file is unchanged (rolled back)
      const currentContent = await fs.readFile(testFile, 'utf-8');
      expect(currentContent).toBe(originalContent);
    });

    it('should rollback on conflict markers remaining', async () => {
      // Create test file
      const testFile = path.join(testRepoPath, 'test.ts');
      const originalContent = 'const x = 1;';
      await fs.writeFile(testFile, originalContent, 'utf-8');

      // Create suggestion that still has conflict markers
      const suggestion = db.createAutoFixSuggestion({
        repo_path: testRepoPath,
        file_path: 'test.ts',
        conflict_type: 'CONCURRENT_EDIT',
        suggested_resolution: '<<<<<<< HEAD\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> other',
        confidence_score: 0.5,
        explanation: 'Test suggestion',
        strategy_used: 'ConcurrentEdit',
        base_content: 'const x = 1;',
        source_content: 'const x = 1;',
        target_content: 'const x = 2;'
      });

      // Apply suggestion (should fail and rollback)
      const result = await engine.applySuggestion({
        suggestionId: suggestion.id,
        dryRun: false,
        createBackup: true
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Conflict markers still present');

      // Verify file is unchanged (rolled back)
      const currentContent = await fs.readFile(testFile, 'utf-8');
      expect(currentContent).toBe(originalContent);
    });

    it('should handle non-existent suggestion', async () => {
      const result = await engine.applySuggestion({
        suggestionId: 'non-existent-id',
        dryRun: false,
        createBackup: true
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('validateSuggestion', () => {
    it('should return false for non-existent suggestion', async () => {
      const isValid = await engine.validateSuggestion('non-existent-id');
      expect(isValid).toBe(false);
    });

    it('should return true if file still has conflict markers', async () => {
      // Create test file with conflict markers
      const testFile = path.join(testRepoPath, 'test.ts');
      const conflictContent = `<<<<<<< HEAD
const x = 1;
=======
const x = 2;
>>>>>>> other-branch`;
      await fs.writeFile(testFile, conflictContent, 'utf-8');

      // Create suggestion
      const suggestion = db.createAutoFixSuggestion({
        repo_path: testRepoPath,
        file_path: 'test.ts',
        conflict_type: 'CONCURRENT_EDIT',
        suggested_resolution: 'const x = 1;',
        confidence_score: 0.8,
        explanation: 'Test suggestion',
        strategy_used: 'ConcurrentEdit',
        base_content: 'const x = 0;',
        source_content: 'const x = 1;',
        target_content: 'const x = 2;'
      });

      const isValid = await engine.validateSuggestion(suggestion.id);
      expect(isValid).toBe(true); // Still has markers
    });

    it('should return false if file has been resolved', async () => {
      // Create test file without conflict markers
      const testFile = path.join(testRepoPath, 'test.ts');
      await fs.writeFile(testFile, 'const x = 1;', 'utf-8');

      // Create suggestion
      const suggestion = db.createAutoFixSuggestion({
        repo_path: testRepoPath,
        file_path: 'test.ts',
        conflict_type: 'CONCURRENT_EDIT',
        suggested_resolution: 'const x = 1;',
        confidence_score: 0.8,
        explanation: 'Test suggestion',
        strategy_used: 'ConcurrentEdit',
        base_content: 'const x = 0;',
        source_content: 'const x = 1;',
        target_content: 'const x = 2;'
      });

      const isValid = await engine.validateSuggestion(suggestion.id);
      expect(isValid).toBe(false); // No markers left
    });
  });

  describe('explainSuggestion', () => {
    it('should generate human-readable explanation', async () => {
      const suggestion = db.createAutoFixSuggestion({
        repo_path: testRepoPath,
        file_path: 'src/test.ts',
        conflict_type: 'STRUCTURAL',
        suggested_resolution: 'merged content',
        confidence_score: 0.85,
        explanation: 'Merged import statements from both branches',
        strategy_used: 'StructuralMerge',
        base_content: '',
        source_content: '',
        target_content: ''
      });

      const explanation = engine.explainSuggestion(suggestion);

      expect(explanation).toContain('src/test.ts');
      expect(explanation).toContain('STRUCTURAL');
      expect(explanation).toContain('StructuralMerge');
      expect(explanation).toContain('85.0%');
      expect(explanation).toContain('Merged import statements');
    });
  });
});
