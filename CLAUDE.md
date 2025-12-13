# CLAUDE.md - parallel-cc

## Project Overview

`parallel-cc` is a coordinator for running multiple Claude Code sessions in parallel on the same repository. It uses git worktrees to isolate each session's work.

**Current Version:** 1.0.0

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     parallel-cc Architecture                 │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  User Interaction                                            │
│  ────────────────                                            │
│  claude-parallel (wrapper script)                            │
│       │                                                      │
│       ├──► parallel-cc register → checks/creates worktree   │
│       │         │                                            │
│       │         └──► gtr new (if parallel session exists)   │
│       │                                                      │
│       ├──► export PARALLEL_CC_SESSION_ID (v0.3)             │
│       │                                                      │
│       └──► exec claude (in worktree directory)              │
│                                                              │
│  On exit: parallel-cc release → cleanup worktree            │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  MCP Server (v0.5)                                          │
│  ─────────────────                                          │
│  parallel-cc mcp-serve (stdio transport)                    │
│       │                                                      │
│       ├──► Session Management (v0.3-v0.4)                   │
│       │   ├──► get_parallel_status - query active sessions  │
│       │   ├──► get_my_session - current session info        │
│       │   ├──► notify_when_merged - subscribe to merges     │
│       │   ├──► check_merge_status - check if merged         │
│       │   ├──► check_conflicts - preview conflicts          │
│       │   ├──► rebase_assist - help with rebasing           │
│       │   └──► get_merge_events - list merge history        │
│       │                                                      │
│       └──► Conflict Resolution (v0.5)                       │
│           ├──► claimFile - acquire file access lock         │
│           ├──► releaseFile - release file claim             │
│           ├──► listFileClaims - query active claims         │
│           ├──► detectAdvancedConflicts - AST analysis       │
│           ├──► getAutoFixSuggestions - AI-powered fixes     │
│           ├──► applyAutoFix - apply suggestion              │
│           └──► conflictHistory - resolution history         │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Installation & Configuration (v0.3)                         │
│  ───────────────────────────────────                         │
│  parallel-cc install --all (hooks + alias + MCP)            │
│       │                                                      │
│       ├──► Hooks: ~/.claude/settings.json (global)          │
│       │         or ./.claude/settings.json (local)          │
│       │                                                      │
│       ├──► Alias: ~/.bashrc / ~/.zshrc / config.fish        │
│       │                                                      │
│       └──► MCP: mcpServers config in ~/.claude.json         │
│                                                              │
│  PostToolUse hook → parallel-cc-heartbeat.sh                │
│       └──► Updates session last_heartbeat in SQLite         │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Merge Detection Daemon (v0.4)                              │
│  ─────────────────────────────                              │
│  parallel-cc watch-merges                                   │
│       │                                                      │
│       ├──► Polls git for merged branches                    │
│       ├──► Records merge events in SQLite                   │
│       └──► Notifies subscribed sessions                     │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Data Layer                                                  │
│  ──────────                                                  │
│  ~/.parallel-cc/coordinator.db (SQLite)                     │
│       ├── sessions table (PID, repo, worktree, heartbeat)   │
│       ├── merge_events table (v0.4 - detected merges)       │
│       ├── subscriptions table (v0.4 - merge watchers)       │
│       ├── file_claims table (v0.5 - file access locks)      │
│       ├── conflict_resolutions (v0.5 - conflict tracking)   │
│       ├── auto_fix_suggestions (v0.5 - AI fixes)            │
│       └── indexes for fast lookup                           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Source Files

```
src/
├── cli.ts              # Commander-based CLI entry point
├── coordinator.ts      # Core logic - session management
├── db.ts               # SQLite operations via better-sqlite3
├── db-validators.ts    # Database input validation (v0.5)
├── gtr.ts              # Wrapper for gtr CLI commands (v1.x and v2.x)
├── hooks-installer.ts  # Hook + alias + MCP configuration
├── logger.ts           # Logging utilities
├── merge-detector.ts   # Merge detection polling logic (v0.4)
├── file-claims.ts      # File access coordination (v0.5)
├── conflict-detector.ts # Conflict detection & classification (v0.5)
├── ast-analyzer.ts     # AST-based semantic analysis (v0.5)
├── auto-fix-engine.ts  # AI-powered resolution generation (v0.5)
├── confidence-scorer.ts # Confidence scoring for suggestions (v0.5)
├── merge-strategies.ts # Conflict resolution strategies (v0.5)
├── types.ts            # TypeScript type definitions
└── mcp/                # MCP server module (v0.5)
    ├── index.ts        # Server setup and tool registration
    ├── tools.ts        # Tool implementations (16 tools)
    └── schemas.ts      # Zod schemas for inputs/outputs

scripts/
├── claude-parallel.sh  # Wrapper script (main entry point for users)
├── heartbeat.sh        # PostToolUse hook for stale detection
├── install.sh          # Installation script (interactive hook setup)
└── uninstall.sh        # Removal script

tests/
├── db.test.ts                      # SessionDB tests
├── coordinator.test.ts             # Coordinator tests
├── gtr.test.ts                     # GtrWrapper tests
├── hooks-installer.test.ts         # Hook installer tests
├── merge-detector.test.ts          # Merge detection tests
├── file-claims.test.ts             # File claims tests (v0.5)
├── conflict-detector.basic.test.ts # Conflict detector tests (v0.5)
├── ast-analyzer.basic.test.ts      # AST analyzer tests (v0.5)
├── auto-fix-engine.test.ts         # Auto-fix engine tests (v0.5)
├── merge-strategies.basic.test.ts  # Merge strategies tests (v0.5)
├── integration.test.ts             # End-to-end integration tests (v0.5)
└── mcp-tools-smoke.test.ts         # MCP tools smoke tests (v0.5)

Total: 441 tests, 100% passing, 87.5% function coverage

vitest.config.ts  # Test framework configuration (project root)
```

## Key Concepts

1. **Wrapper Script** - `claude-parallel` wraps the `claude` command, handling registration before launch
2. **Sessions** - Each Claude Code process is tracked in SQLite by PID and session ID
3. **Worktrees** - Parallel sessions get isolated git worktrees via `gtr` (v1.x or v2.x auto-detected)
4. **Heartbeats** - Optional PostToolUse hook updates timestamps for stale detection
5. **Auto-cleanup** - Dead sessions and their worktrees are cleaned up automatically
6. **Hook Installer** - CLI tool to configure Claude Code settings for heartbeat integration
7. **MCP Server** - Exposes 16 tools for session management and conflict resolution (v0.3-v0.5)
8. **Merge Detection** - Polls git to detect when branches are merged, notifies subscribers (v0.4)
9. **File Claims** - Coordinate EXCLUSIVE/SHARED/INTENT file access across parallel sessions (v0.5)
10. **Conflict Detection** - AST-based semantic analysis for TRIVIAL/CONCURRENT/STRUCTURAL/SEMANTIC conflicts (v0.5)
11. **Auto-Fix Suggestions** - AI-powered conflict resolution with confidence scoring (v0.5)
12. **E2B Sandbox Execution** - Autonomous Claude Code execution in isolated cloud VMs (v1.0)
13. **Plan-Driven Workflows** - Execute implementation plans (PLAN.md) autonomously in sandboxes (v1.0)
14. **File Sync** - Intelligent upload/download with compression and selective sync (v1.0)

## Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run dev          # Watch mode
npm run lint         # Run ESLint
npm test             # Run tests (Vitest)
npm test -- --coverage  # Run tests with coverage report
```

## Testing

**Framework:** Vitest 2.1.x with v8 coverage

**Current Status:**
- 303 tests, 100% passing
- Key file coverage:
  - merge-detector.ts: 87%+ coverage
  - db.ts: 83%+ coverage
  - coordinator.ts: 67%+ coverage
  - gtr.ts: 100% coverage
  - mcp/tools.ts: 60%+ coverage (100% function coverage)

**Running Tests:**
```bash
npm test              # Watch mode
npm test -- --run     # Single run
npm test -- --coverage  # With coverage report
```

## Testing Locally

```bash
# Build first
npm run build

# Test core commands
node dist/cli.js doctor
node dist/cli.js status
node dist/cli.js register --repo $(pwd) --pid $$ --json
node dist/cli.js release --pid $$

# Test hook installation
node dist/cli.js install --status
node dist/cli.js install --hooks --local --repo /tmp/test-repo

# Test MCP installation (v0.3)
node dist/cli.js install --mcp
node dist/cli.js mcp-serve  # Start MCP server (stdio)

# Test wrapper script
./scripts/claude-parallel.sh --help
```

## Database Schema

SQLite database at `~/.parallel-cc/coordinator.db`:

```sql
-- Sessions table (core)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  repo_path TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  worktree_name TEXT,
  is_main_repo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Merge events table (v0.4)
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

-- Subscriptions table (v0.4)
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

CREATE INDEX idx_sessions_repo ON sessions(repo_path);
CREATE INDEX idx_sessions_pid ON sessions(pid);
CREATE INDEX idx_sessions_heartbeat ON sessions(last_heartbeat);
CREATE INDEX idx_merge_events_repo ON merge_events(repo_path);
CREATE INDEX idx_merge_events_branch ON merge_events(branch_name);
CREATE INDEX idx_subscriptions_session ON subscriptions(session_id);
CREATE INDEX idx_subscriptions_active ON subscriptions(is_active);
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `register --repo <path> --pid <n>` | Register a session, create worktree if needed |
| `release --pid <n>` | Release session, cleanup worktree |
| `heartbeat --pid <n>` | Update session heartbeat timestamp |
| `status [--repo <path>]` | Show active sessions |
| `cleanup` | Remove stale sessions and worktrees |
| `doctor` | Check system health |
| `mcp-serve` | Start MCP server (stdio transport) |
| `update` | Update database schema to latest version (v1.0.0) - runs all necessary migrations |
| `watch-merges` | Start merge detection daemon (v0.4) |
| `watch-merges --once` | Run single merge detection poll (v0.4) |
| `merge-status` | Show merge events history (v0.4) |
| `merge-status --subscriptions` | Show active merge subscriptions (v0.4) |
| `install --all` | Install hooks globally + alias + MCP + update database |
| `install --interactive` | Prompted installation for all options |
| `install --hooks` | Install heartbeat hooks (interactive) |
| `install --hooks --global` | Install hooks to ~/.claude/settings.json |
| `install --hooks --local` | Install hooks to ./.claude/settings.json |
| `install --alias` | Add claude=claude-parallel to shell profile |
| `install --mcp` | Configure MCP server in Claude settings |
| `install --uninstall` | Remove installed hooks/alias/MCP |
| `install --status` | Check installation status |

## MCP Server Tools (v0.4)

The MCP server exposes seven tools for Claude Code to query:

### `get_parallel_status`
Returns info about all active sessions in the current repo.
```typescript
// Input: { repo_path?: string }
// Output: { sessions: SessionInfo[], totalSessions: number }
```

### `get_my_session`
Returns info about the current session (requires PARALLEL_CC_SESSION_ID env var).
```typescript
// Output: { sessionId, worktreePath, worktreeName, isMainRepo, startedAt, parallelSessions }
```

### `notify_when_merged` (v0.4)
Subscribe to notifications when a branch is merged to the target branch.
```typescript
// Input: { branch: string, targetBranch?: string }
// Output: { subscribed: boolean, message: string }
```

### `check_merge_status` (v0.4)
Check if a branch has been merged to the target branch.
```typescript
// Input: { branch: string }
// Output: { isMerged: boolean, mergeEvent?: MergeEventInfo, message: string }
```

### `check_conflicts` (v0.4)
Check for merge/rebase conflicts between branches.
```typescript
// Input: { currentBranch: string, targetBranch: string }
// Output: { hasConflicts: boolean, conflictingFiles: string[], summary: string, guidance?: string[] }
```

### `rebase_assist` (v0.4)
Assist with rebasing current branch onto a target branch.
```typescript
// Input: { targetBranch: string, checkOnly?: boolean }
// Output: { success: boolean, output: string, hasConflicts: boolean, conflictingFiles: string[], conflictSummary: string }
```

### `get_merge_events` (v0.4)
Get history of detected merge events for a repository.
```typescript
// Input: { repo_path?: string, limit?: number }
// Output: { events: MergeEventInfo[], total: number }
```

## Integration Flow

1. User runs `claude-parallel` (or aliased `claude`)
2. Wrapper gets repo path via `git rev-parse --show-toplevel`
3. Wrapper calls `parallel-cc register --repo <path> --pid $$`
4. Coordinator checks for existing sessions in SQLite
5. If parallel session exists, coordinator calls `gtr new` to create worktree
6. Coordinator returns JSON with `worktreePath` and `sessionId`
7. Wrapper exports `PARALLEL_CC_SESSION_ID` for MCP tools
8. Wrapper `cd`s to worktree path
9. Wrapper `exec`s `claude` in the new directory
10. On exit, trap calls `parallel-cc release --pid $$`
11. Coordinator removes session and cleans up worktree

## Version History

| Version | Status | Key Features |
|---------|--------|--------------|
| v0.1 | ✅ Complete | Project foundation, types, schema |
| v0.2 | ✅ Complete | CLI, SQLite, wrapper script |
| v0.2.1 | ✅ Complete | Hook installer CLI, Vitest testing |
| v0.2.4 | ✅ Complete | Shell alias setup, full install command |
| v0.3 | ✅ Complete | MCP server, >85% test coverage |
| v0.4 | ✅ Complete | Branch merge detection, rebase assistance, conflict checking |
| v0.5 | ✅ Complete | File claims, AST conflict detection, AI auto-fix, 441 tests (100%) |
| v1.0 | ✅ Current | E2B sandbox integration for autonomous execution |

## E2B Sandbox Integration (v1.0)

### Overview

E2B integration enables autonomous Claude Code execution in isolated cloud sandboxes. This transforms parallel-cc from a worktree coordinator into a complete autonomous development platform.

### Usage Patterns

**When to Use E2B Sandboxes:**
- Long-running tasks (30+ minutes) that require uninterrupted execution
- Complex implementations following detailed plans (PLAN.md)
- Test-driven development workflows (write tests, implement, verify)
- Large-scale refactoring with automated testing
- Tasks where you want to "walk away" and review results later

**When to Use Local Execution:**
- Interactive development requiring frequent user input
- Quick iterations and experimentation
- Tasks requiring access to local services (databases, APIs)
- Short tasks (<10 minutes) where overhead isn't worth it
- Debugging and troubleshooting

### Safety Guardrails

**Automatic Protections:**
1. **Worktree Isolation** - E2B sessions always run in dedicated worktrees, never main branch
2. **Timeout Enforcement** - Hard limit at 1 hour (configurable down to 10 minutes)
3. **Warning System** - Alerts at 30-minute and 50-minute marks
4. **Credential Scanning** - Automatic detection and exclusion of sensitive files
5. **Manual Review Required** - All changes must be reviewed before merging

**Timeout Settings:**
- Default: 60 minutes (E2B free tier limit)
- Minimum: 10 minutes
- Warnings: 30 minutes (50%), 50 minutes (83%)
- Hard termination: At timeout limit, no grace period

**Security Notes:**
- Sandboxes run with `--dangerously-skip-permissions` flag (safe because sandboxed)
- No access to local machine or network
- Credentials automatically excluded via .gitignore and .e2bignore
- Review all changes in worktree before merging to main

### E2B vs Local Execution Decision Matrix

| Scenario | Mode | Reason |
|----------|------|--------|
| "Implement auth system following PLAN.md" | E2B | Long-running, plan-driven, autonomous |
| "Add a console.log statement" | Local | Quick, interactive |
| "Refactor codebase with comprehensive tests" | E2B | Long-running, verification required |
| "Debug failing test" | Local | Interactive, requires local environment |
| "Generate API documentation" | E2B | Time-consuming, deterministic |
| "Explore architectural options" | Local | Interactive, requires discussion |
| "Run full test suite and fix failures" | E2B | Autonomous, verification-driven |
| "Quick prototype of UI component" | Local | Interactive, visual feedback needed |

### CLI Commands (E2B-Specific)

```bash
# Execute autonomous task
parallel-cc sandbox-run --repo . --prompt "Implement feature X"
parallel-cc sandbox-run --repo . --prompt-file PLAN.md

# Monitor active sandboxes
parallel-cc status --sandbox-only
parallel-cc sandbox-logs --session-id <id> --follow

# Download results without terminating
parallel-cc sandbox-download --session-id <id>

# Kill running sandbox
parallel-cc sandbox-kill --session-id <id>

# Test setup without execution
parallel-cc sandbox-run --dry-run --repo .
```

### Authentication

E2B sandboxes support two authentication methods for Claude CLI:

**1. API Key Authentication (Default)**
- Uses `ANTHROPIC_API_KEY` environment variable
- Billed directly to your Anthropic API account
- Best for: Pay-as-you-go usage, testing, or when not using Claude Pro subscription

```bash
# Set API key
export ANTHROPIC_API_KEY="sk-ant-api03-..."

# Run with API key auth (default)
parallel-cc sandbox-run --repo . --prompt "Task" --auth-method api-key
```

**2. OAuth Authentication**
- Uses your Claude subscription credentials
- Requires active Claude Pro or Team subscription
- Best for: Regular users who want to use their subscription quota

```bash
# Ensure you're logged in (run this within Claude Code session)
# Start Claude Code:
claude

# Then run /login and follow prompts
/login

# Exit Claude Code (Ctrl-D), then run with OAuth auth
parallel-cc sandbox-run --repo . --prompt "Task" --auth-method oauth
```

**Authentication Method Selection:**
- `--auth-method api-key` (default): Pass ANTHROPIC_API_KEY to sandbox
- `--auth-method oauth`: Copy ~/.claude/.credentials.json to sandbox

**Important Notes:**
- API key method requires ANTHROPIC_API_KEY env var to be set
- OAuth method requires running `/login` within Claude Code first to generate credentials
- OAuth credentials are securely copied from ~/.claude/.credentials.json to sandbox
- Both methods work identically once authenticated

### Cost Expectations

**E2B Pricing:**
- Base rate: $0.10 per hour per sandbox
- Billed per-second (minimum 1 minute)
- Free tier: $10 credit for new accounts

**Typical Costs:**
- 10-minute task: ~$0.017
- 30-minute task: ~$0.050
- 60-minute task: ~$0.100
- Monthly (20 tasks @ 30min): ~$1.00

**Cost Optimization:**
- Use appropriate timeouts (don't default to 60min for quick tasks)
- Test with `--dry-run` before executing
- Monitor active sandboxes and kill idle ones
- Use local development for planning and design
- Reserve E2B for complex, time-consuming implementations

### Database Schema (E2B Extensions)

```sql
-- v1.0: E2B session tracking
ALTER TABLE sessions ADD COLUMN execution_mode TEXT DEFAULT 'local';
ALTER TABLE sessions ADD COLUMN sandbox_id TEXT;
ALTER TABLE sessions ADD COLUMN prompt TEXT;
ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'active';
ALTER TABLE sessions ADD COLUMN output_log TEXT;
```

### File Structure (E2B Modules)

```
src/e2b/
├── sandbox-manager.ts    # E2B sandbox lifecycle management
├── file-sync.ts          # Upload/download with compression
├── claude-runner.ts      # Autonomous Claude execution
└── output-monitor.ts     # Real-time output streaming
```

## Coding Standards

- TypeScript strict mode
- ES modules (type: "module")
- Async/await over callbacks
- Explicit error handling
- Meaningful variable names
- Vitest for unit testing
- >85% test coverage enforced
