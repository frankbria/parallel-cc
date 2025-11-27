# CLAUDE.md - parallel-cc

## Project Overview

`parallel-cc` is a coordinator for running multiple Claude Code sessions in parallel on the same repository. It uses git worktrees to isolate each session's work.

**Current Version:** 0.2.1

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
│       └──► exec claude (in worktree directory)              │
│                                                              │
│  On exit: parallel-cc release → cleanup worktree            │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Hook Integration (v0.2.1)                                   │
│  ─────────────────────────                                   │
│  parallel-cc install --hooks                                 │
│       │                                                      │
│       ├──► ~/.claude/settings.json (global)                 │
│       │         or                                           │
│       └──► ./.claude/settings.json (local)                  │
│                                                              │
│  PostToolUse hook → parallel-cc-heartbeat.sh                │
│       └──► Updates session last_heartbeat in SQLite         │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Data Layer                                                  │
│  ──────────                                                  │
│  ~/.parallel-cc/coordinator.db (SQLite)                     │
│       ├── sessions table (PID, repo, worktree, heartbeat)   │
│       └── indexes for fast lookup                           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Source Files

```
src/
├── cli.ts             # Commander-based CLI entry point (v0.2.1)
├── coordinator.ts     # Core logic - session management
├── db.ts              # SQLite operations via better-sqlite3
├── gtr.ts             # Wrapper for gtr CLI commands (v1.x and v2.x)
├── hooks-installer.ts # Hook configuration management (v0.2.1)
├── logger.ts          # Logging utilities
└── types.ts           # TypeScript type definitions

scripts/
├── claude-parallel.sh  # Wrapper script (main entry point for users)
├── heartbeat.sh        # PostToolUse hook for stale detection
├── install.sh          # Installation script (interactive hook setup)
└── uninstall.sh        # Removal script

tests/
└── hooks-installer.test.ts  # Unit tests (41 tests, 92%+ coverage)

vitest.config.ts  # Test framework configuration (project root)
```

## Key Concepts

1. **Wrapper Script** - `claude-parallel` wraps the `claude` command, handling registration before launch
2. **Sessions** - Each Claude Code process is tracked in SQLite by PID
3. **Worktrees** - Parallel sessions get isolated git worktrees via `gtr` (v1.x or v2.x auto-detected)
4. **Heartbeats** - Optional PostToolUse hook updates timestamps for stale detection
5. **Auto-cleanup** - Dead sessions and their worktrees are cleaned up automatically
6. **Hook Installer** - CLI tool to configure Claude Code settings for heartbeat integration

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
- 41 tests, 100% passing
- hooks-installer.ts: 92%+ coverage
- Global coverage target (>85%) deferred to v0.3

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

# Test hook installation (v0.2.1)
node dist/cli.js install --status
node dist/cli.js install --hooks --local --repo /tmp/test-repo

# Test wrapper script
./scripts/claude-parallel.sh --help
```

## Database Schema

SQLite database at `~/.parallel-cc/coordinator.db`:

```sql
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

CREATE INDEX idx_sessions_repo ON sessions(repo_path);
CREATE INDEX idx_sessions_pid ON sessions(pid);
CREATE INDEX idx_sessions_heartbeat ON sessions(last_heartbeat);
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
| `install --hooks` | Install heartbeat hooks (interactive) |
| `install --hooks --global` | Install hooks to ~/.claude/settings.json |
| `install --hooks --local` | Install hooks to ./.claude/settings.json |
| `install --hooks --uninstall` | Remove installed hooks |
| `install --status` | Check hook installation status |

## Integration Flow

1. User runs `claude-parallel` (or aliased `claude`)
2. Wrapper gets repo path via `git rev-parse --show-toplevel`
3. Wrapper calls `parallel-cc register --repo <path> --pid $$`
4. Coordinator checks for existing sessions in SQLite
5. If parallel session exists, coordinator calls `gtr new` to create worktree
6. Coordinator returns JSON with `worktreePath`
7. Wrapper `cd`s to worktree path
8. Wrapper `exec`s `claude` in the new directory
9. On exit, trap calls `parallel-cc release --pid $$`
10. Coordinator removes session and cleans up worktree

## Version History

| Version | Status | Key Features |
|---------|--------|--------------|
| v0.1 | ✅ Complete | Project foundation, types, schema |
| v0.2 | ✅ Complete | CLI, SQLite, wrapper script |
| v0.2.1 | ✅ Current | Hook installer CLI, Vitest testing |
| v0.3 | Planned | MCP server, >85% test coverage |
| v0.4 | Planned | Branch merge detection |
| v0.5 | Planned | File-level conflict detection |
| v1.0 | Planned | E2B sandbox integration |

## Planned: MCP Server (v0.3)

Will expose tools for Claude to query:
- `get_parallel_status` - See what other sessions are doing
- `get_my_session` - Check current session info
- `notify_when_merged` - Alert when parallel branches merge

## Coding Standards

- TypeScript strict mode
- ES modules (type: "module")
- Async/await over callbacks
- Explicit error handling
- Meaningful variable names
- Vitest for unit testing
- >85% test coverage target (enforced in v0.3+)
