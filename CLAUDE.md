# CLAUDE.md - parallel-cc

## Project Overview

`parallel-cc` is a coordinator for running multiple Claude Code sessions in parallel on the same repository. It uses git worktrees to isolate each session's work.

**Current Version:** 0.3.0

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
│  MCP Server (v0.3)                                          │
│  ─────────────────                                          │
│  parallel-cc mcp-serve (stdio transport)                    │
│       │                                                      │
│       ├──► get_parallel_status - query active sessions      │
│       ├──► get_my_session - current session info            │
│       └──► notify_when_merged - branch watch (stub)         │
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
├── cli.ts             # Commander-based CLI entry point
├── coordinator.ts     # Core logic - session management
├── db.ts              # SQLite operations via better-sqlite3
├── gtr.ts             # Wrapper for gtr CLI commands (v1.x and v2.x)
├── hooks-installer.ts # Hook + alias + MCP configuration
├── logger.ts          # Logging utilities
├── types.ts           # TypeScript type definitions
└── mcp/               # MCP server module (v0.3)
    ├── index.ts       # Server setup and tool registration
    ├── tools.ts       # Tool implementations
    └── schemas.ts     # Zod schemas for inputs/outputs

scripts/
├── claude-parallel.sh  # Wrapper script (main entry point for users)
├── heartbeat.sh        # PostToolUse hook for stale detection
├── install.sh          # Installation script (interactive hook setup)
└── uninstall.sh        # Removal script

tests/
├── db.test.ts              # SessionDB tests (55 tests)
├── coordinator.test.ts     # Coordinator tests (37 tests)
├── gtr.test.ts             # GtrWrapper tests (49 tests)
├── hooks-installer.test.ts # Hook installer tests (76 tests)
└── mcp.test.ts             # MCP tools tests (50 tests)

vitest.config.ts  # Test framework configuration (project root)
```

## Key Concepts

1. **Wrapper Script** - `claude-parallel` wraps the `claude` command, handling registration before launch
2. **Sessions** - Each Claude Code process is tracked in SQLite by PID and session ID
3. **Worktrees** - Parallel sessions get isolated git worktrees via `gtr` (v1.x or v2.x auto-detected)
4. **Heartbeats** - Optional PostToolUse hook updates timestamps for stale detection
5. **Auto-cleanup** - Dead sessions and their worktrees are cleaned up automatically
6. **Hook Installer** - CLI tool to configure Claude Code settings for heartbeat integration
7. **MCP Server** - Exposes tools for Claude to query session status (v0.3)

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
- 267 tests, 100% passing
- Overall coverage: >85%
- db.ts: 98%+ coverage
- coordinator.ts: 100% coverage
- gtr.ts: 100% coverage
- hooks-installer.ts: 86%+ coverage

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
| `mcp-serve` | Start MCP server (stdio transport) |
| `install --all` | Install hooks globally + alias + MCP |
| `install --interactive` | Prompted installation for all options |
| `install --hooks` | Install heartbeat hooks (interactive) |
| `install --hooks --global` | Install hooks to ~/.claude/settings.json |
| `install --hooks --local` | Install hooks to ./.claude/settings.json |
| `install --alias` | Add claude=claude-parallel to shell profile |
| `install --mcp` | Configure MCP server in Claude settings |
| `install --uninstall` | Remove installed hooks/alias/MCP |
| `install --status` | Check installation status |

## MCP Server Tools (v0.3)

The MCP server exposes three tools for Claude Code to query:

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

### `notify_when_merged`
Subscribe to notifications when a branch is merged (stub in v0.3, full implementation in v0.4).
```typescript
// Input: { branch: string }
// Output: { subscribed: boolean, message: string }
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
| v0.3 | ✅ Current | MCP server, >85% test coverage |
| v0.4 | Planned | Branch merge detection |
| v0.5 | Planned | File-level conflict detection |
| v1.0 | Planned | E2B sandbox integration |

## Coding Standards

- TypeScript strict mode
- ES modules (type: "module")
- Async/await over callbacks
- Explicit error handling
- Meaningful variable names
- Vitest for unit testing
- >85% test coverage enforced
