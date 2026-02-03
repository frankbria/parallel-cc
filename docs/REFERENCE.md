# parallel-cc Technical Reference

This document provides detailed technical specifications for developers and advanced users.

**Version:** 2.0.0
**Last Updated:** 2026-02-03

## Table of Contents

- [Database Schema](#database-schema)
- [MCP Server Tools](#mcp-server-tools)
- [Git Identity Configuration](#git-identity-configuration)
- [SSH Key Injection](#ssh-key-injection)
- [Testing](#testing)
- [E2B Cost Expectations](#e2b-cost-expectations)

---

## Database Schema

SQLite database at `~/.parallel-cc/coordinator.db`:

### Sessions Table

Core session tracking with E2B sandbox and cost tracking extensions.

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  repo_path TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  worktree_name TEXT,
  is_main_repo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
  -- v1.0: E2B sandbox columns
  execution_mode TEXT DEFAULT 'local',
  sandbox_id TEXT,
  prompt TEXT,
  status TEXT,
  output_log TEXT,
  -- v1.1: Git configuration tracking
  git_user TEXT,
  git_email TEXT,
  ssh_key_provided INTEGER DEFAULT 0,
  -- v1.1: Cost tracking
  budget_limit REAL,
  cost_estimate REAL,
  actual_cost REAL,
  -- v1.1: Template tracking
  template_name TEXT
);

CREATE INDEX idx_sessions_repo ON sessions(repo_path);
CREATE INDEX idx_sessions_pid ON sessions(pid);
CREATE INDEX idx_sessions_heartbeat ON sessions(last_heartbeat);
```

### Merge Events Table

Tracks detected branch merges for notification system.

```sql
CREATE TABLE merge_events (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  target_branch TEXT NOT NULL DEFAULT 'main',
  target_commit TEXT NOT NULL,
  merged_at TEXT NOT NULL DEFAULT (datetime('now')),
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  notification_sent INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_merge_events_repo ON merge_events(repo_path);
CREATE INDEX idx_merge_events_branch ON merge_events(branch_name);
```

### Subscriptions Table

Manages merge notification subscriptions.

```sql
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  target_branch TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  notified_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_subscriptions_session ON subscriptions(session_id);
CREATE INDEX idx_subscriptions_active ON subscriptions(is_active);
```

### Budget Tracking Table

Cost tracking by period for E2B sandbox usage.

```sql
CREATE TABLE budget_tracking (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL,           -- 'daily', 'weekly', 'monthly'
  period_start TEXT NOT NULL,
  budget_limit REAL,
  spent REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_budget_period ON budget_tracking(period, period_start);
```

### Running Migrations

```bash
# Update to latest schema version
parallel-cc update
```

---

## MCP Server Tools

The MCP server (`parallel-cc mcp serve`) exposes 16 tools for Claude Code integration.

### Session Management Tools

#### `get_parallel_status`
Returns info about all active sessions in the current repo.
```typescript
// Input
{ repo_path?: string }

// Output
{ sessions: SessionInfo[], totalSessions: number }
```

#### `get_my_session`
Returns info about the current session (requires PARALLEL_CC_SESSION_ID env var).
```typescript
// Output
{
  sessionId: string,
  worktreePath: string,
  worktreeName: string,
  isMainRepo: boolean,
  startedAt: string,
  parallelSessions: number
}
```

### Merge Detection Tools

#### `notify_when_merged`
Subscribe to notifications when a branch is merged to the target branch.
```typescript
// Input
{ branch: string, targetBranch?: string }

// Output
{ subscribed: boolean, message: string }
```

#### `check_merge_status`
Check if a branch has been merged to the target branch.
```typescript
// Input
{ branch: string }

// Output
{ isMerged: boolean, mergeEvent?: MergeEventInfo, message: string }
```

#### `check_conflicts`
Check for merge/rebase conflicts between branches.
```typescript
// Input
{ currentBranch: string, targetBranch: string }

// Output
{
  hasConflicts: boolean,
  conflictingFiles: string[],
  summary: string,
  guidance?: string[]
}
```

#### `rebase_assist`
Assist with rebasing current branch onto a target branch.
```typescript
// Input
{ targetBranch: string, checkOnly?: boolean }

// Output
{
  success: boolean,
  output: string,
  hasConflicts: boolean,
  conflictingFiles: string[],
  conflictSummary: string
}
```

#### `get_merge_events`
Get history of detected merge events for a repository.
```typescript
// Input
{ repo_path?: string, limit?: number }

// Output
{ events: MergeEventInfo[], total: number }
```

### File Claims Tools (v0.5)

#### `claimFile`
Acquire file access lock (EXCLUSIVE, SHARED, or INTENT).
```typescript
// Input
{ filePath: string, claimType: 'EXCLUSIVE' | 'SHARED' | 'INTENT' }

// Output
{ success: boolean, claimId?: string, message: string }
```

#### `releaseFile`
Release a previously acquired file claim.
```typescript
// Input
{ claimId: string }

// Output
{ success: boolean, message: string }
```

#### `listFileClaims`
Query active file claims for a repository.
```typescript
// Input
{ repo_path?: string, filePath?: string }

// Output
{ claims: FileClaim[], total: number }
```

### Conflict Resolution Tools (v0.5)

#### `detectAdvancedConflicts`
AST-based semantic analysis for conflict detection.
```typescript
// Input
{ filePath: string, baseBranch?: string }

// Output
{
  conflictType: 'TRIVIAL' | 'CONCURRENT' | 'STRUCTURAL' | 'SEMANTIC',
  severity: 'LOW' | 'MEDIUM' | 'HIGH',
  details: string,
  suggestions: string[]
}
```

#### `getAutoFixSuggestions`
Get AI-powered conflict resolution suggestions.
```typescript
// Input
{ conflictId: string }

// Output
{
  suggestions: AutoFixSuggestion[],
  bestMatch?: AutoFixSuggestion
}
```

#### `applyAutoFix`
Apply a suggested conflict resolution.
```typescript
// Input
{ suggestionId: string }

// Output
{ success: boolean, message: string, diff?: string }
```

#### `conflictHistory`
View resolution history for conflicts.
```typescript
// Input
{ repo_path?: string, limit?: number }

// Output
{ resolutions: ConflictResolution[], total: number }
```

---

## Git Identity Configuration

Commits made in E2B sandboxes use a configurable git identity with a four-tier priority system.

### Priority Order

| Priority | Source | Example |
|----------|--------|---------|
| 1 (Highest) | CLI Flags | `--git-user "John" --git-email "john@example.com"` |
| 2 | Environment Variables | `PARALLEL_CC_GIT_USER`, `PARALLEL_CC_GIT_EMAIL` |
| 3 | Local Git Config | Auto-detected from repository |
| 4 (Lowest) | Default | `"E2B Sandbox" <sandbox@e2b.dev>` |

### Usage Examples

```bash
# Default: auto-detect from local git config
parallel-cc sandbox run --repo . --prompt "Fix bug"

# Override with CLI flags (both required together)
parallel-cc sandbox run --repo . --prompt "Fix bug" \
  --git-user "CI Bot" \
  --git-email "ci@example.com"

# Set via environment variables
export PARALLEL_CC_GIT_USER="Deploy Bot"
export PARALLEL_CC_GIT_EMAIL="deploy@example.com"
parallel-cc sandbox run --repo . --prompt "Deploy feature"
```

### Notes

- Both `--git-user` and `--git-email` must be provided together for CLI override
- Partial configuration (only one flag) triggers a warning and uses fallback
- Auto-detection reads from local git config (repository-level or global)
- Default identity maintains backward compatibility

---

## SSH Key Injection

SSH key injection enables access to private Git repositories within E2B sandboxes. This is an opt-in security feature.

### Usage

```bash
# Basic SSH key injection
parallel-cc sandbox run --repo . --prompt "Clone private repo" \
  --ssh-key ~/.ssh/id_ed25519

# Non-interactive (CI/CD) - requires explicit confirmation
parallel-cc sandbox run --repo . --prompt "Build private deps" \
  --ssh-key ~/.ssh/deploy_key --confirm-ssh-key --json

# With OAuth and git-live
parallel-cc sandbox run --repo . --prompt "Update dependencies" \
  --ssh-key ~/.ssh/id_ed25519 --auth-method oauth --git-live
```

### Security Flow

1. **Validation**: Key file existence, permissions (warns if not 600/400), format verification
2. **Security Warning**: Interactive prompt explaining risks (skippable with `--confirm-ssh-key`)
3. **Injection**: Key written to sandbox's `~/.ssh` with 600 permissions
4. **Known Hosts**: GitHub, GitLab, Bitbucket automatically added
5. **SSH Config**: StrictHostKeyChecking set to `accept-new`
6. **Cleanup**: Key removed from sandbox after execution (in finally block)

### Security Considerations

- SSH keys are transmitted over encrypted connection (E2B uses TLS)
- Keys are stored temporarily in sandbox memory/disk
- Keys are cleaned up after execution completes (even on errors)
- Passphrase-protected keys won't work (non-interactive mode)
- All key-related data is redacted from logs automatically

### Best Practices

- Use dedicated deploy keys with minimal permissions (read-only when possible)
- Rotate keys regularly
- Monitor key usage in your git provider's dashboard
- Prefer repository-specific deploy keys over personal SSH keys
- Never use production keys for development/testing

### Supported Key Types

| Type | File | Recommendation |
|------|------|----------------|
| Ed25519 | `id_ed25519` | Recommended |
| RSA | `id_rsa` | Widely supported |
| ECDSA | `id_ecdsa` | Good alternative |
| DSA | `id_dsa` | Deprecated |

### Troubleshooting

| Error | Solution |
|-------|----------|
| "Permission denied (publickey)" | Ensure key is added to GitHub/GitLab |
| "Bad permissions" | Run `chmod 600 ~/.ssh/id_*` |
| "Invalid key format" | Verify file is a private key (not .pub) |
| "Passphrase required" | Use a key without passphrase for automation |

---

## Testing

### Framework

- **Test Framework**: Vitest 2.1.x with v8 coverage
- **Configuration**: `vitest.config.ts` in project root

### Current Status

- 311 tests (303 unit/integration + 8 E2E), 100% passing
- Key file coverage:
  - merge-detector.ts: 87%+ coverage
  - db.ts: 83%+ coverage
  - coordinator.ts: 67%+ coverage
  - gtr.ts: 100% coverage
  - mcp/tools.ts: 60%+ coverage (100% function coverage)

### Running Tests

```bash
npm test              # Watch mode (all tests)
npm test -- --run     # Single run (all tests)
npm test -- --coverage  # With coverage report

# Run specific test file
npm test tests/db.test.ts -- --run

# Run E2E tests only
npm test tests/e2b/e2e-workflow.test.ts -- --run

# Run specific test suite
npm test -- -t "Standard Workflow"
npm test -- -t "Git-Live Workflow"
npm test -- -t "Timeout Enforcement"
```

### E2E Workflow Tests

Comprehensive end-to-end tests validating the complete E2B sandboxing workflow.

**Test Coverage:**
1. Standard Workflow: Kickoff → Upload → Execute → Download → Continue
2. Git-Live Workflow: Kickoff → Upload → Execute → Push → PR
3. Timeout Enforcement: Soft warnings (30min, 50min) + hard termination (60min)
4. Error Recovery: Network failures, sandbox failures, upload/download errors
5. Continuation: Seamless local continuation after file retrieval
6. Concurrent Sessions: Multiple E2B sessions with proper isolation

**Characteristics:**
- Duration: ~2-3s per test, ~15-20s total suite
- Mocking Strategy: E2B SDK fully mocked (no API calls), real filesystem/database/git operations
- Prerequisites: None! No E2B_API_KEY required, no internet connection needed

---

## E2B Cost Expectations

### Pricing Model

- **Base Rate**: $0.10 per hour per sandbox
- **Billing**: Per-second granularity (minimum 1 minute)
- **Free Tier**: $10 credit for new accounts

### Typical Costs

| Task Duration | Cost |
|---------------|------|
| 10 minutes | ~$0.017 |
| 30 minutes | ~$0.050 |
| 60 minutes | ~$0.100 |
| Monthly (20 tasks @ 30min) | ~$1.00 |

### Cost Optimization Tips

1. **Set appropriate timeouts** - Don't default to 60min for quick tasks
2. **Use `--dry-run`** - Test setup before committing to execution
3. **Monitor active sandboxes** - Kill idle sandboxes promptly
4. **Use local development** - Plan and design locally (free)
5. **Reserve E2B** - For complex, time-consuming implementations

### Budget Tracking

```bash
# Check current budget status
parallel-cc budget status

# Set daily/weekly/monthly limits via config
parallel-cc config set budget.daily 5.00
parallel-cc config set budget.monthly 50.00
```

---

## Version History

| Version | Key Features |
|---------|--------------|
| v0.1-v0.2 | Project foundation, CLI, SQLite, wrapper script |
| v0.3 | MCP server, >85% test coverage |
| v0.4 | Branch merge detection, rebase assistance |
| v0.5 | File claims, AST conflict detection, AI auto-fix |
| v1.0 | E2B sandbox integration for autonomous execution |
| v1.1 | Sandbox templates, budget tracking, SSH key injection |
| v2.0 | CLI subcommand structure with backward-compatible deprecation |
