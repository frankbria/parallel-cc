/**
 * Usage Example: Core Conflict Resolution Engine
 *
 * Demonstrates how to use ConflictDetector, ASTAnalyzer, and MergeStrategies
 * together for intelligent conflict detection and resolution.
 */

import { ConflictDetector } from '../src/conflict-detector.js';
import { ASTAnalyzer } from '../src/ast-analyzer.js';
import {
  createDefaultStrategyChain,
  TrivialMergeStrategy,
  StructuralMergeStrategy,
  ConcurrentEditStrategy,
  FallbackStrategy,
  ResolutionError
} from '../src/merge-strategies.js';
import { logger } from '../src/logger.js';

/**
 * Example 1: Basic conflict detection
 */
async function example1_basicDetection() {
  console.log('\n=== Example 1: Basic Conflict Detection ===\n');

  const detector = new ConflictDetector('/path/to/repo', undefined, logger);

  const report = await detector.detectConflicts({
    currentBranch: 'feature/my-feature',
    targetBranch: 'main',
    analyzeSemantics: false // Text-based only
  });

  console.log(`Conflicts detected: ${report.hasConflicts}`);
  console.log(`Total conflicts: ${report.summary.totalConflicts}`);
  console.log(`Auto-fixable: ${report.summary.autoFixableCount}`);
  console.log('\nBy type:');
  console.log(`  TRIVIAL: ${report.summary.byType.TRIVIAL}`);
  console.log(`  STRUCTURAL: ${report.summary.byType.STRUCTURAL}`);
  console.log(`  SEMANTIC: ${report.summary.byType.SEMANTIC}`);
  console.log(`  CONCURRENT_EDIT: ${report.summary.byType.CONCURRENT_EDIT}`);
  console.log('\nBy severity:');
  console.log(`  LOW: ${report.summary.bySeverity.LOW}`);
  console.log(`  MEDIUM: ${report.summary.bySeverity.MEDIUM}`);
  console.log(`  HIGH: ${report.summary.bySeverity.HIGH}`);

  return report;
}

/**
 * Example 2: Conflict detection with AST analysis
 */
async function example2_astAnalysis() {
  console.log('\n=== Example 2: AST-Enhanced Conflict Detection ===\n');

  const astAnalyzer = new ASTAnalyzer();
  const detector = new ConflictDetector('/path/to/repo', astAnalyzer, logger);

  const report = await detector.detectConflicts({
    currentBranch: 'feature/my-feature',
    targetBranch: 'main',
    analyzeSemantics: true // Enable AST analysis
  });

  for (const conflict of report.conflicts) {
    console.log(`\nFile: ${conflict.filePath}`);
    console.log(`Type: ${conflict.conflictType}`);
    console.log(`Severity: ${conflict.severity}`);
    console.log(`Markers: ${conflict.markers.length}`);

    if (conflict.analysis?.astDiff) {
      const diff = conflict.analysis.astDiff.structuralDiff;
      if (diff) {
        console.log(`AST Analysis:`);
        console.log(`  Added nodes: ${diff.addedNodes.length}`);
        console.log(`  Removed nodes: ${diff.removedNodes.length}`);
        console.log(`  Modified nodes: ${diff.modifiedNodes.length}`);
        console.log(`  Import changes: ${diff.hasImportChanges}`);
        console.log(`  Export changes: ${diff.hasExportChanges}`);
      }
    }
  }

  return report;
}

/**
 * Example 3: Automatic conflict resolution
 */
async function example3_automaticResolution() {
  console.log('\n=== Example 3: Automatic Conflict Resolution ===\n');

  const astAnalyzer = new ASTAnalyzer();
  const detector = new ConflictDetector('/path/to/repo', astAnalyzer, logger);

  const report = await detector.detectConflicts({
    currentBranch: 'feature/my-feature',
    targetBranch: 'main',
    analyzeSemantics: true
  });

  if (!report.hasConflicts) {
    console.log('No conflicts detected!');
    return;
  }

  // Create strategy chain
  const strategyChain = createDefaultStrategyChain(astAnalyzer);

  console.log(`\nResolving ${report.conflicts.length} conflicts...\n`);

  const results = [];

  for (const conflict of report.conflicts) {
    try {
      const { resolution, strategy } = await strategyChain.resolve(conflict);

      console.log(`✓ ${conflict.filePath}`);
      console.log(`  Strategy: ${strategy.name}`);
      console.log(`  Explanation: ${strategy.explain(conflict, resolution)}`);

      const risks = strategy.identifyRisks(conflict);
      if (risks.length > 0) {
        console.log(`  Risks:`);
        risks.forEach(risk => console.log(`    - ${risk}`));
      }

      results.push({ conflict, resolution, strategy });
    } catch (error) {
      console.error(`✗ ${conflict.filePath}`);
      console.error(`  Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\n${results.length}/${report.conflicts.length} conflicts resolved`);

  return results;
}

/**
 * Example 4: Manual strategy selection
 */
async function example4_manualStrategies() {
  console.log('\n=== Example 4: Manual Strategy Selection ===\n');

  const astAnalyzer = new ASTAnalyzer();
  const detector = new ConflictDetector('/path/to/repo', astAnalyzer, logger);

  const report = await detector.detectConflicts({
    currentBranch: 'feature/my-feature',
    targetBranch: 'main',
    analyzeSemantics: true
  });

  if (!report.hasConflicts) {
    console.log('No conflicts detected!');
    return;
  }

  // Create individual strategies
  const strategies = [
    new TrivialMergeStrategy(),
    new StructuralMergeStrategy(astAnalyzer),
    new ConcurrentEditStrategy(),
    new FallbackStrategy()
  ];

  for (const conflict of report.conflicts) {
    console.log(`\n${conflict.filePath} (${conflict.conflictType})`);

    // Find applicable strategies
    const applicable = strategies.filter(s => s.canHandle(conflict));
    console.log(`Applicable strategies: ${applicable.map(s => s.name).join(', ')}`);

    // Try each strategy in order
    for (const strategy of applicable) {
      try {
        const resolution = await strategy.resolve(conflict);
        console.log(`✓ Resolved with ${strategy.name}`);
        console.log(`  ${strategy.explain(conflict, resolution)}`);
        break; // Success - move to next conflict
      } catch (error) {
        if (error instanceof ResolutionError) {
          console.log(`  ${strategy.name} failed: ${error.message}`);
          continue; // Try next strategy
        }
        throw error; // Unexpected error
      }
    }
  }
}

/**
 * Example 5: AST analyzer standalone usage
 */
async function example5_astAnalyzer() {
  console.log('\n=== Example 5: AST Analyzer Standalone ===\n');

  const analyzer = new ASTAnalyzer();

  // Example code snippets
  const code1 = `
    import { foo } from 'bar';

    function hello() {
      console.log('world');
    }

    export default hello;
  `;

  const code2 = `
    import { foo, baz } from 'bar';
    import { qux } from 'quux';

    function hello() {
      console.log('world');
    }

    function goodbye() {
      console.log('farewell');
    }

    export default hello;
    export { goodbye };
  `;

  // Parse both versions
  const ast1 = await analyzer.parseFile('example.ts', code1);
  const ast2 = await analyzer.parseFile('example.ts', code2);

  if (ast1 && ast2) {
    console.log('Both files parsed successfully');

    // Detect structural changes
    const diff = analyzer.detectStructuralChanges(ast1, ast2);

    console.log('\nStructural Diff:');
    console.log(`  Added nodes: ${diff.addedNodes.length}`);
    diff.addedNodes.forEach(node => {
      console.log(`    - ${node.type}: ${node.name || '(anonymous)'}`);
    });

    console.log(`  Removed nodes: ${diff.removedNodes.length}`);
    diff.removedNodes.forEach(node => {
      console.log(`    - ${node.type}: ${node.name || '(anonymous)'}`);
    });

    console.log(`  Modified nodes: ${diff.modifiedNodes.length}`);

    console.log(`\n  Import changes: ${diff.hasImportChanges}`);
    console.log(`  Export changes: ${diff.hasExportChanges}`);
  }

  // Check whitespace-only changes
  const code3 = '  function  hello()  {  }  ';
  const code4 = 'function hello() {}';

  const isWhitespaceOnly = analyzer.onlyWhitespaceChanges(code3, code4);
  console.log(`\nWhitespace-only change: ${isWhitespaceOnly}`);

  // Clean up cache
  analyzer.clearCache();
  console.log('Cache cleared');
}

/**
 * Example 6: Complete workflow
 */
async function example6_completeWorkflow() {
  console.log('\n=== Example 6: Complete Resolution Workflow ===\n');

  const repoPath = '/path/to/repo';
  const currentBranch = 'feature/my-feature';
  const targetBranch = 'main';

  // Step 1: Setup
  const astAnalyzer = new ASTAnalyzer();
  const detector = new ConflictDetector(repoPath, astAnalyzer, logger);
  const strategyChain = createDefaultStrategyChain(astAnalyzer);

  // Step 2: Detect conflicts
  console.log('Step 1: Detecting conflicts...');
  const report = await detector.detectConflicts({
    currentBranch,
    targetBranch,
    analyzeSemantics: true
  });

  if (!report.hasConflicts) {
    console.log('✓ No conflicts - safe to merge!');
    return;
  }

  console.log(`✗ Found ${report.summary.totalConflicts} conflicts`);
  console.log(`  Auto-fixable: ${report.summary.autoFixableCount}`);

  // Step 3: Categorize conflicts
  console.log('\nStep 2: Categorizing conflicts...');
  const autoFixable = report.conflicts.filter(
    c => c.conflictType === 'TRIVIAL' || c.conflictType === 'STRUCTURAL'
  );
  const manualReview = report.conflicts.filter(
    c => c.conflictType === 'SEMANTIC' || c.conflictType === 'CONCURRENT_EDIT'
  );

  console.log(`  ${autoFixable.length} can be auto-fixed`);
  console.log(`  ${manualReview.length} require manual review`);

  // Step 4: Auto-resolve where possible
  console.log('\nStep 3: Auto-resolving conflicts...');
  const resolved = [];
  const failed = [];

  for (const conflict of autoFixable) {
    try {
      const { resolution, strategy } = await strategyChain.resolve(conflict);
      console.log(`  ✓ ${conflict.filePath} (${strategy.name})`);
      resolved.push({ conflict, resolution, strategy });
    } catch (error) {
      console.log(`  ✗ ${conflict.filePath} (failed)`);
      failed.push(conflict);
    }
  }

  // Step 5: Report results
  console.log('\nStep 4: Summary');
  console.log(`  Resolved: ${resolved.length}`);
  console.log(`  Failed auto-fix: ${failed.length}`);
  console.log(`  Manual review needed: ${manualReview.length}`);

  if (manualReview.length > 0) {
    console.log('\nFiles requiring manual review:');
    manualReview.forEach(c => {
      console.log(`  - ${c.filePath} (${c.conflictType}, severity: ${c.severity})`);
    });
  }

  // Step 6: Cleanup
  astAnalyzer.clearCache();
  console.log('\nCleanup complete');
}

/**
 * Main entry point
 */
async function main() {
  console.log('='.repeat(70));
  console.log('Conflict Resolution Engine - Usage Examples');
  console.log('='.repeat(70));

  try {
    // Run examples
    // Note: These will fail without a real git repo
    // Uncomment as needed for testing

    // await example1_basicDetection();
    // await example2_astAnalysis();
    // await example3_automaticResolution();
    // await example4_manualStrategies();
    await example5_astAnalyzer(); // This one works without git repo
    // await example6_completeWorkflow();

  } catch (error) {
    console.error('\nError:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
