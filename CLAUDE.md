# CLAUDE.md - parallel-cc

## Project Overview

`parallel-cc` is a coordinator for running multiple Claude Code sessions in parallel on the same repository. It uses git worktrees to isolate each session's work.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     parallel-cc Architecture                 │
├─────────────────────────────────────────────────────────────┤
│                                                              │
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
└─────────────────────────────────────────────────────────────┘
```

## Source Files

```
src/
├── cli.ts         # Commander-based CLI entry point
├── coordinator.ts # Core logic - session management
├── db.ts          # SQLite operations via better-sqlite3
├── gtr.ts         # Wrapper for gtr CLI commands (supports v1.x and v2.x)
└── types.ts       # TypeScript type definitions

scripts/
├── claude-parallel.sh  # Wrapper script (main entry point for users)
├── heartbeat.sh        # Optional hook for stale detection
└── install.sh          # Installation script
```

## Key Concepts

1. **Wrapper Script** - `claude-parallel` wraps the `claude` command, handling registration before launch
2. **Sessions** - Each Claude Code process is tracked in SQLite by PID
3. **Worktrees** - Parallel sessions get isolated git worktrees via `gtr` (v1.x or v2.x auto-detected)
4. **Heartbeats** - Optional PostToolUse hook updates timestamps for stale detection
5. **Auto-cleanup** - Dead sessions and their worktrees are cleaned up automatically

## Development Commands

```bash
npm install        # Install dependencies
npm run build      # Compile TypeScript
npm run dev        # Watch mode
npm run lint       # Run ESLint
npm test           # Run tests
```

## Testing Locally

```bash
# Build first
npm run build

# Test commands
node dist/cli.js doctor
node dist/cli.js status
node dist/cli.js register --repo $(pwd) --pid $$ --json
node dist/cli.js release --pid $$

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

## Future: MCP Server (v0.3)

Will expose tools for Claude to query:
- `get_parallel_status` - See what other sessions are doing
- `get_my_session` - Check current session info
- `notify_merge` - Alert when parallel branches merge

## Coding Standards

- TypeScript strict mode
- ES modules (type: "module")
- Async/await over callbacks
- Explicit error handling
- Meaningful variable names
