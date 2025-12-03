# Migration Guide: v0.4 → v0.5

This guide helps you upgrade from parallel-cc v0.4 to v0.5, which introduces advanced conflict resolution, file claims, and AI-powered auto-fix suggestions.

## Overview

**v0.5** adds intelligent conflict detection and resolution capabilities for managing parallel development workflows:

- 🔒 **File Claims System** - Coordinate exclusive/shared file access across sessions
- 🧠 **Conflict Detection** - Track semantic, structural, and concurrent edit conflicts
- ⚡ **Auto-Fix Suggestions** - AI-generated conflict resolutions with confidence scores
- 🔍 **AST Analysis** - Deep semantic analysis using Babel parser

## What's New

### 1. File Claims System

Coordinate file access across parallel sessions with three lock modes:

- **EXCLUSIVE** - Only one session can modify the file
- **SHARED** - Multiple sessions can read, limited modifications
- **INTENT** - Signal intention to modify without locking

**New MCP Tools:**
```typescript
// Acquire a file claim
claimFile({ filePath: 'src/app.ts', mode: 'EXCLUSIVE' })

// Release a claim
releaseFile({ claimId: 'claim-id' })

// List all claims
listFileClaims({ sessionId: 'session-id' })
```

**New CLI Commands:**
```bash
parallel-cc claims                    # List active file claims
parallel-cc claims --file src/app.ts  # Filter by file
parallel-cc claims --session <id>     # Filter by session
```

### 2. Conflict Detection & Resolution

Track conflicts with detailed classification:

- **TRIVIAL** - Identical changes (auto-resolvable)
- **CONCURRENT_EDIT** - Simple edits to same lines
- **STRUCTURAL** - Changes to function signatures, class structures
- **SEMANTIC** - Logic conflicts requiring human review

**New MCP Tools:**
```typescript
// Detect conflicts between branches
detectAdvancedConflicts({
  currentBranch: 'feature/auth',
  targetBranch: 'main',
  analyzeSemantics: true  // Enable AST analysis
})

// Get conflict history
conflictHistory({
  filePath: 'src/app.ts',
  conflictType: 'SEMANTIC',
  limit: 20
})
```

**New CLI Commands:**
```bash
parallel-cc conflicts                      # View conflict history
parallel-cc conflicts --type SEMANTIC      # Filter by type
parallel-cc conflicts --resolved           # Only resolved conflicts
parallel-cc conflicts --file src/app.ts    # Filter by file
```

### 3. Auto-Fix Suggestions

AI-generated conflict resolutions with confidence scoring:

**New MCP Tools:**
```typescript
// Get auto-fix suggestions for a file
getAutoFixSuggestions({
  filePath: 'src/app.ts',
  currentBranch: 'feature/auth',
  targetBranch: 'main',
  minConfidence: 0.7  // Filter by confidence threshold
})

// Apply a suggestion
applyAutoFix({
  suggestionId: 'suggestion-id',
  dryRun: false
})
```

**New CLI Commands:**
```bash
parallel-cc suggestions                          # List all suggestions
parallel-cc suggestions --min-confidence 0.8     # High confidence only
parallel-cc suggestions --file src/app.ts        # Filter by file
parallel-cc suggestions --applied                # Show applied suggestions
```

### 4. Enhanced MCP Server

**New Tools Added (9 total for v0.5):**
- `claimFile` - Acquire file claim
- `releaseFile` - Release file claim
- `listFileClaims` - Query active claims
- `detectAdvancedConflicts` - Check for conflicts with AST analysis
- `getAutoFixSuggestions` - Generate AI-powered fixes
- `applyAutoFix` - Apply suggested resolution
- `conflictHistory` - View conflict resolution history

**Existing Tools (from v0.4):**
- `get_parallel_status` - Query active sessions
- `get_my_session` - Current session info
- `notify_when_merged` - Subscribe to merge events
- `check_merge_status` - Check if branch merged
- `check_conflicts` - Basic conflict checking
- `rebase_assist` - Rebase assistance
- `get_merge_events` - Merge event history

## Migration Steps

### Step 1: Update parallel-cc

```bash
cd /path/to/parallel-cc
git pull origin main
npm install
npm run build
```

### Step 2: Run Database Migration

The v0.5 schema adds three new tables:

```bash
# Migrate database schema
parallel-cc migrate

# Output:
# ✓ Migration to v0.5 completed successfully
#   Added tables: file_claims, conflict_resolutions, auto_fix_suggestions
```

**What gets created:**

```sql
-- File claims table
CREATE TABLE file_claims (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  claim_mode TEXT NOT NULL,  -- 'EXCLUSIVE', 'SHARED', 'INTENT'
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  metadata TEXT,  -- JSON
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Conflict resolutions table
CREATE TABLE conflict_resolutions (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  conflict_type TEXT NOT NULL,  -- 'TRIVIAL', 'CONCURRENT_EDIT', etc.
  resolution_strategy TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  confidence_score REAL,
  auto_fix_suggestion_id TEXT,
  metadata TEXT  -- JSON
);

-- Auto-fix suggestions table
CREATE TABLE auto_fix_suggestions (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  conflict_type TEXT NOT NULL,
  strategy_used TEXT NOT NULL,
  suggested_resolution TEXT NOT NULL,
  confidence_score REAL NOT NULL,
  explanation TEXT,
  generated_at TEXT NOT NULL,
  applied_at TEXT,
  was_auto_applied INTEGER NOT NULL DEFAULT 0,
  metadata TEXT  -- JSON
);
```

**Indexes created:**
- `idx_file_claims_session` - Fast session claim lookups
- `idx_file_claims_file` - Fast file claim lookups
- `idx_conflict_resolutions_repo_file` - Fast conflict queries
- `idx_auto_fix_suggestions_repo_file` - Fast suggestion queries

### Step 3: Verify Installation

```bash
# Check CLI version
parallel-cc --version
# Should show: 0.5.0

# Test new commands
parallel-cc claims
parallel-cc conflicts
parallel-cc suggestions

# Verify MCP tools (if MCP server configured)
# Claude Code should now see the new v0.5 tools
```

### Step 4: Update MCP Configuration (Optional)

If you've customized your MCP server configuration, ensure it's using the latest:

```bash
parallel-cc install --mcp --status
```

The MCP server automatically exposes all v0.5 tools when you run `parallel-cc mcp-serve`.

## Breaking Changes

### ⚠️ None

v0.5 is **fully backward compatible** with v0.4:

- ✅ All v0.4 commands work unchanged
- ✅ Database migration is additive (no data loss)
- ✅ Existing sessions continue to work
- ✅ All v0.4 MCP tools remain available
- ✅ Configuration format unchanged

## New Configuration Options

No new configuration required! v0.5 features work out-of-the-box.

**Optional tuning** (in code if needed):

```typescript
// File claims default TTL
const DEFAULT_CLAIM_TTL_HOURS = 24;

// Auto-fix confidence thresholds
const MIN_CONFIDENCE = 0.5;  // Minimum to show suggestion
const AUTO_APPLY_THRESHOLD = 0.9;  // Auto-apply if confidence >= 90%

// AST analysis (enabled by default for .ts, .tsx, .js, .jsx files)
const ENABLE_AST_ANALYSIS = true;
```

## Usage Examples

### Example 1: Coordinating File Edits

**Scenario:** Two Claude sessions working on overlapping files

```bash
# Session 1 (main repo)
$ parallel-cc claims
Active File Claims: 0

# Session 1 claims exclusive access
# (via MCP tool: claimFile({ filePath: 'src/auth.ts', mode: 'EXCLUSIVE' }))

# Session 2 (worktree) tries to claim same file
$ parallel-cc claims
Active File Claims: 1
  🔴 src/auth.ts
    Mode: EXCLUSIVE
    Session: a1b2c3d4...
    Expires: 2024-03-20T15:30:00Z

# Session 2 knows to wait or work on different files
```

### Example 2: Pre-Merge Conflict Detection

**Scenario:** Check for conflicts before merging feature branch

```bash
# Claude uses MCP tool to check conflicts
detectAdvancedConflicts({
  currentBranch: 'feature/new-api',
  targetBranch: 'main',
  analyzeSemantics: true
})

# Response shows:
{
  hasConflicts: true,
  conflicts: [
    {
      file: 'src/api/users.ts',
      type: 'STRUCTURAL',
      severity: 'HIGH',
      description: 'Function signature changed in both branches'
    }
  ],
  summary: '1 structural conflict detected'
}

# View CLI output
$ parallel-cc conflicts --file src/api/users.ts
Conflict Resolution History: 1

  ○ src/api/users.ts
    Type: STRUCTURAL
    Strategy: MANUAL_RESOLUTION
    Confidence: N/A
    Detected: 2024-03-20T14:15:00Z
```

### Example 3: AI-Powered Conflict Resolution

**Scenario:** Get auto-fix suggestions for detected conflicts

```bash
# Claude generates suggestions via MCP
getAutoFixSuggestions({
  filePath: 'src/api/users.ts',
  currentBranch: 'feature/new-api',
  targetBranch: 'main',
  minConfidence: 0.7
})

# Returns AI-generated fixes with explanations
{
  suggestions: [
    {
      id: 'fix-1234',
      strategy: 'MERGE_BOTH',
      confidence: 0.85,
      explanation: 'Both changes are complementary - function signature can include both parameter sets',
      resolution: '...(merged code)...'
    }
  ]
}

# View via CLI
$ parallel-cc suggestions --min-confidence 0.8
Auto-Fix Suggestions: 1

  ○ src/api/users.ts
    Strategy: MERGE_BOTH
    Confidence: 85.0%
    Type: STRUCTURAL
    Generated: 2024-03-20T14:20:00Z
    Explanation: Both changes are complementary...
```

## Testing the Migration

### 1. Test File Claims

```bash
# Terminal 1
parallel-cc register --repo $(pwd) --pid $$ --json

# Terminal 2 (parallel session)
parallel-cc register --repo $(pwd) --pid $$ --json

# Both sessions should list claims
parallel-cc claims
```

### 2. Test Conflict Detection

```bash
# Create a test branch with conflicts
git checkout -b test-conflicts
# Make conflicting changes...
git commit -am "test changes"

# Check for conflicts via CLI
parallel-cc conflicts
```

### 3. Test Auto-Fix Suggestions

```bash
# Generate suggestions for a conflict
parallel-cc suggestions --file path/to/conflicting/file.ts
```

## Rollback Instructions

If you need to revert to v0.4:

```bash
# 1. Checkout v0.4 code
git checkout v0.4.0
npm install
npm run build

# 2. Database is forward-compatible - no action needed
# The v0.5 tables won't cause issues with v0.4

# 3. (Optional) Remove v0.5 tables if desired
# WARNING: This deletes all file claims and conflict history
sqlite3 ~/.parallel-cc/coordinator.db <<EOF
DROP TABLE IF EXISTS file_claims;
DROP TABLE IF EXISTS conflict_resolutions;
DROP TABLE IF EXISTS auto_fix_suggestions;
EOF
```

## Troubleshooting

### "Migration already applied" error

This is normal if you run `parallel-cc migrate` twice. The migration is idempotent.

### MCP tools not appearing in Claude

1. Restart Claude Code
2. Verify MCP configuration:
   ```bash
   parallel-cc install --mcp --status
   ```
3. Check MCP server is running:
   ```bash
   parallel-cc doctor
   ```

### File claims not expiring

Claims expire after 24 hours by default. Check active claims:

```bash
parallel-cc claims
```

Stale claims are cleaned up during session registration and cleanup.

### AST analysis not working

AST analysis requires valid TypeScript/JavaScript syntax. Check:
- File has `.ts`, `.tsx`, `.js`, or `.jsx` extension
- Code is parseable (no syntax errors)
- Babel parser is installed (included in dependencies)

## Getting Help

- **Issues:** https://github.com/frankbria/parallel-cc/issues
- **Discussions:** https://github.com/frankbria/parallel-cc/discussions
- **Documentation:** https://github.com/frankbria/parallel-cc/blob/main/README.md

## Next Steps

After migration:

1. ✅ Try the new `parallel-cc claims` command
2. ✅ Explore conflict detection with `parallel-cc conflicts`
3. ✅ Experiment with auto-fix suggestions
4. ✅ Use new MCP tools in Claude Code workflows
5. ✅ Check out [ROADMAP.md](../ROADMAP.md) for what's coming in v1.0

---

**Welcome to v0.5! 🎉**

The advanced conflict resolution features make parallel development workflows safer and more intelligent. We're excited to see how you use them!
