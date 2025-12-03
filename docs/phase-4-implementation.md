# Phase 4: Auto-Fix Suggestion Engine Implementation

## Overview

Phase 4 implements the auto-fix suggestion generation and application system for parallel-cc v0.5. This system uses AI-powered conflict resolution strategies with confidence scoring to automatically suggest and apply fixes for merge conflicts.

## Implementation Summary

### Module 1: Confidence Scorer (`src/confidence-scorer.ts`)

**Purpose:** Calculate confidence scores for auto-fix suggestions using multiple weighted factors.

**Architecture:**
- **Weighted Factors (Total: 100%)**
  - 30% Complexity: Simple conflicts → higher score
  - 25% Similarity: Similar code → higher score
  - 25% AST Validity: Valid AST after resolution → higher score
  - 20% Strategy Success: Strategy's historical success → higher score

**Scoring Algorithm:**
```typescript
// Base confidence calculation
confidence =
  0.30 * complexityScore +
  0.25 * similarityScore +
  0.25 * astValidityScore +
  0.20 * strategySuccessScore;

// Apply penalties
if (conflictType === 'SEMANTIC') confidence *= 0.7;
if (linesChanged > 50) confidence *= 0.8;

return clamp(confidence, 0.0, 1.0);
```

**Complexity Scoring Rules:**
- TRIVIAL → 1.0 (highest confidence)
- STRUCTURAL with imports → 0.9
- STRUCTURAL other → 0.7
- CONCURRENT_EDIT (<5 lines) → 0.6
- CONCURRENT_EDIT (≥5 lines) → 0.4
- SEMANTIC → 0.3
- UNKNOWN → 0.2 (lowest confidence)

**Key Features:**
1. Multi-factor confidence calculation
2. Adaptive penalty system for complex scenarios
3. Strategy success rate tracking with exponential moving average
4. Detailed factor breakdown for debugging

**Safety Mechanisms:**
- All scores clamped to [0.0, 1.0]
- Conservative scoring for unknown conflict types
- Penalty for semantic conflicts (30% reduction)
- Penalty for large changes (20% reduction)

### Module 2: Auto-Fix Engine (`src/auto-fix-engine.ts`)

**Purpose:** Generate and apply conflict resolution suggestions with safety-first architecture.

**Core Operations:**

#### 1. Generate Suggestions
```typescript
async generateSuggestions(params: GenerateSuggestionsParams): Promise<AutoFixSuggestion[]>
```

**Process:**
1. Get all applicable strategies for conflict
2. Try each strategy with 10-second timeout
3. Calculate confidence score for each resolution
4. Generate human-readable explanation
5. Store suggestion in database
6. Sort by confidence (highest first)
7. Return top N suggestions

**Features:**
- Tries multiple strategies until `maxSuggestions` reached
- Graceful handling of strategy failures
- Stores all metadata (base/source/target content)
- Automatic ranking by confidence

#### 2. Apply Suggestion
```typescript
async applySuggestion(params: ApplySuggestionParams): Promise<ApplyResult>
```

**Safety Protocol:**
1. **Validate** suggestion exists
2. **Read** current file content
3. **Dry run** (if requested): validate without applying
4. **Backup** original file with `.bak.{timestamp}` suffix
5. **Write** resolved content
6. **Verify** no conflict markers remain
7. **Validate** syntax (for JS/TS files)
8. **Mark** as applied in database
9. **Rollback** on any error

**Safety Mechanisms:**
- Always creates backups before modification (unless disabled)
- Checks for remaining conflict markers using regex: `/^(<{7}|={7}|>{7})/m`
- Validates syntax using AST parser for TypeScript/JavaScript files
- Automatic rollback on any verification failure
- Provides rollback command: `cp "${backupPath}" "${originalPath}"`
- Synchronous backup writes (ensure completion before modification)

**Error Handling:**
- Catches all file operation errors
- Gracefully handles parse failures
- Returns detailed error messages
- Always rolls back on failure

#### 3. Validation
```typescript
async validateSuggestion(suggestionId: string): Promise<boolean>
```

**Checks:**
- Suggestion exists in database
- File still has conflict markers (suggestion still applicable)
- File hasn't been resolved manually

### Integration with Database

The modules integrate with the Phase 2 database schema:

```typescript
// Create suggestion
db.createAutoFixSuggestion({
  repo_path: string,
  file_path: string,
  conflict_type: ConflictType,
  suggested_resolution: string,
  confidence_score: number,
  explanation: string,
  strategy_used: string,
  base_content: string,
  source_content: string,
  target_content: string,
  metadata?: Record<string, unknown>
});

// Mark as applied
db.markSuggestionApplied(suggestionId, wasAutoApplied);

// Query suggestions
db.getAutoFixSuggestions({
  id?: string,
  conflict_resolution_id?: string,
  repo_path?: string,
  file_path?: string,
  conflict_type?: ConflictType,
  is_applied?: boolean,
  min_confidence?: number
});
```

### Integration with Phase 3 (Conflict Detection & Strategies)

The auto-fix engine uses the Phase 3 components:

```typescript
// Use ConflictDetector to identify conflicts
const conflictReport = await detector.detectConflicts({
  currentBranch,
  targetBranch,
  analyzeSemantics: true
});

// Use StrategyChain to resolve conflicts
const { resolution, strategy } = await strategyChain.resolve(conflict);

// Use ASTAnalyzer for syntax validation
const ast = await astAnalyzer.parseFile(filePath, content);
const isValid = ast !== null;

// Use ConfidenceScorer to rank suggestions
const confidence = confidenceScorer.calculateConfidence({
  conflict,
  resolution,
  strategy
});
```

## Testing

**Test Coverage:** 21 tests across two modules

### ConfidenceScorer Tests (8 tests)
1. ✅ High confidence for trivial conflicts
2. ✅ Lower confidence for semantic conflicts
3. ✅ Penalty for large changes
4. ✅ Detailed factor breakdown
5. ✅ TRIVIAL conflicts score highest (1.0)
6. ✅ SEMANTIC conflicts score lowest (0.3)
7. ✅ Success rate increases on successful resolution
8. ✅ Success rate decreases on failed resolution

### AutoFixEngine Tests (13 tests)

**Generation (4 tests):**
1. ✅ Generate suggestions for trivial conflict
2. ✅ Sort suggestions by confidence
3. ✅ Limit suggestions to maxSuggestions
4. ✅ Handle no strategies succeeding (fallback)

**Application (5 tests):**
5. ✅ Apply suggestion in dry run mode
6. ✅ Apply suggestion and create backup
7. ✅ Rollback on syntax error
8. ✅ Rollback on conflict markers remaining
9. ✅ Handle non-existent suggestion

**Validation (3 tests):**
10. ✅ Return false for non-existent suggestion
11. ✅ Return true if file still has conflict markers
12. ✅ Return false if file has been resolved

**Explanation (1 test):**
13. ✅ Generate human-readable explanation

## Usage Example

```typescript
import { AutoFixEngine } from './auto-fix-engine.js';
import { ConfidenceScorer } from './confidence-scorer.js';
import { ASTAnalyzer } from './ast-analyzer.js';
import { createDefaultStrategyChain } from './merge-strategies.js';

// Initialize components
const astAnalyzer = new ASTAnalyzer();
const confidenceScorer = new ConfidenceScorer(astAnalyzer);
const strategyChain = createDefaultStrategyChain(astAnalyzer);
const engine = new AutoFixEngine(
  db,
  astAnalyzer,
  confidenceScorer,
  strategyChain
);

// Generate suggestions
const suggestions = await engine.generateSuggestions({
  repoPath: '/path/to/repo',
  filePath: 'src/app.ts',
  conflict: detectedConflict,
  maxSuggestions: 3
});

// Review suggestions
for (const suggestion of suggestions) {
  console.log(engine.explainSuggestion(suggestion));
}

// Apply highest-confidence suggestion if confidence is high enough
const topSuggestion = suggestions[0];
if (topSuggestion.confidence_score >= 0.9) {
  const result = await engine.applySuggestion({
    suggestionId: topSuggestion.id,
    dryRun: false,
    createBackup: true
  });

  if (result.success) {
    console.log(`✅ Applied: ${result.filePath}`);
    console.log(`📦 Backup: ${result.backupPath}`);
    console.log(`↩️  Rollback: ${result.rollbackCommand}`);
  } else {
    console.error(`❌ Failed: ${result.error}`);
  }
}
```

## Safety Guarantees

### Before Application
1. Suggestion must exist in database
2. File content must be unchanged since suggestion generated
3. Backup is created with timestamp suffix

### During Application
4. File is written atomically
5. Conflict markers are checked immediately
6. Syntax is validated for TypeScript/JavaScript files

### After Application
7. Suggestion is marked as applied in database
8. Verification stats are recorded (lines changed, hunks applied)
9. Rollback command is provided

### On Error
10. Automatic rollback to backup
11. Original file is restored
12. Error message is returned
13. Database is NOT marked as applied

## Performance Considerations

**Timeouts:**
- Strategy resolution: 10 seconds
- AST parsing: 5 seconds (from ASTAnalyzer)

**Caching:**
- AST analyzer caches parsed ASTs by file path and mtime
- Confidence scorer maintains strategy success rates in memory

**Batch Operations:**
- Database operations are batched where possible
- File I/O uses async operations except for critical backup writes

## Future Enhancements (v0.6)

1. **Learning System**
   - Track actual resolution success/failure
   - Adjust strategy success rates based on real data
   - Persist strategy weights to database

2. **Advanced Similarity**
   - Use Levenshtein distance for more accurate similarity scoring
   - Consider semantic similarity (variable renaming, refactoring)

3. **Multi-File Resolutions**
   - Handle conflicts that span multiple files
   - Suggest coordinated changes

4. **Interactive Mode**
   - Present suggestions to user for selection
   - Allow manual editing before application
   - Learn from user preferences

## Files Created

1. `/home/frankbria/projects/parallel-cc/src/confidence-scorer.ts` (338 lines)
2. `/home/frankbria/projects/parallel-cc/src/auto-fix-engine.ts` (564 lines)
3. `/home/frankbria/projects/parallel-cc/tests/auto-fix-engine.test.ts` (629 lines)
4. `/home/frankbria/projects/parallel-cc/docs/phase-4-implementation.md` (this file)

**Total Lines of Code:** 1,531 lines

## Test Results

```
✅ All tests passing: 363/363
✅ Phase 4 tests: 21/21
✅ Code coverage maintained: >85%
```

## Architecture Review Compliance

✅ **Safety First:**
- Backups before modification
- Syntax validation after application
- Conflict marker detection
- Automatic rollback on errors
- Synchronous backup writes

✅ **Error Handling:**
- Graceful degradation on parse failures
- Meaningful error messages
- Try-catch-finally for cleanup
- Rollback on all failure paths

✅ **Performance:**
- Timeouts for long-running operations
- AST caching for repeated parsing
- Batch database operations
- Async file I/O (except critical operations)

✅ **Logging:**
- All suggestion generations logged
- All applications logged (success/failure)
- Confidence factor breakdowns logged
- Debug-level details for troubleshooting

## Integration Status

- ✅ Phase 2 (Database): Full integration via `createAutoFixSuggestion`, `markSuggestionApplied`, `getAutoFixSuggestions`
- ✅ Phase 3 (Conflict Detection): Uses `ConflictDetector`, `StrategyChain`, `ASTAnalyzer`
- ✅ Test Suite: All 363 tests passing
- ✅ Type Safety: Full TypeScript strict mode compliance
- ✅ Documentation: Complete API documentation and usage examples

## Next Steps for v0.5

Phase 4 is complete. The next phase (v0.5 final) would include:
1. MCP server integration for auto-fix suggestions
2. CLI commands for generating and applying suggestions
3. End-to-end testing with real git repositories
4. Performance benchmarking and optimization
