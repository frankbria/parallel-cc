# CLAUDE.md - parallel-cc

## Project Overview

`parallel-cc` is a coordinator for running multiple Claude Code sessions in parallel on the same repository. It uses git worktrees to isolate each session's work and supports autonomous execution via E2B cloud sandboxes.

**Current Version:** 2.0.0

## Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run dev          # Watch mode
npm run lint         # Run ESLint
npm test             # Run tests (Vitest)
npm test -- --run    # Single run
npm test -- --coverage  # With coverage
```

## Source Structure

```
src/
├── cli.ts              # Commander-based CLI entry point
├── cli-deprecation.ts  # Deprecation warning helpers (v2.0)
├── coordinator.ts      # Core logic - session management
├── db.ts               # SQLite operations via better-sqlite3
├── config.ts           # Configuration management (v1.1)
├── budget-tracker.ts   # Budget/cost tracking (v1.1)
├── gtr.ts              # Wrapper for gtr CLI commands
├── hooks-installer.ts  # Hook + alias + MCP configuration
├── merge-detector.ts   # Merge detection polling logic
├── file-claims.ts      # File access coordination
├── conflict-detector.ts # Conflict detection & classification
├── types.ts            # TypeScript type definitions
├── mcp/                # MCP server module
│   ├── index.ts        # Server setup and tool registration
│   ├── tools.ts        # Tool implementations (16 tools)
│   └── schemas.ts      # Zod schemas for inputs/outputs
└── e2b/                # E2B sandbox module
    ├── sandbox-manager.ts    # E2B sandbox lifecycle
    ├── file-sync.ts          # Upload/download with compression
    ├── claude-runner.ts      # Autonomous Claude execution
    ├── ssh-key-injector.ts   # SSH key injection for private repos
    └── templates.ts          # Template management

scripts/
├── claude-parallel.sh  # Wrapper script (main entry point)
├── heartbeat.sh        # PostToolUse hook for stale detection
└── install.sh          # Installation script

templates/              # Built-in sandbox templates
├── node-20-typescript.json
├── python-3.12-fastapi.json
└── full-stack-nextjs.json
```

## Key Concepts

1. **Wrapper Script** - `claude-parallel` wraps `claude`, handling session registration
2. **Sessions** - Each Claude Code process tracked in SQLite by PID and session ID
3. **Worktrees** - Parallel sessions get isolated git worktrees via `gtr`
4. **Heartbeats** - PostToolUse hook updates timestamps for stale detection
5. **MCP Server** - Exposes 16 tools for session/conflict management
6. **E2B Sandboxes** - Autonomous Claude execution in isolated cloud VMs (v1.0)
7. **Budget Tracking** - Cost controls for E2B sandbox usage (v1.1)

## CLI Commands (v2.0)

Commands use subcommand structure. Old hyphenated commands show deprecation warnings.

**Core:**
| Command | Description |
|---------|-------------|
| `register --repo <path> --pid <n>` | Register session, create worktree if needed |
| `release --pid <n>` | Release session, cleanup worktree |
| `heartbeat --pid <n>` | Update session heartbeat |
| `status [--repo <path>]` | Show active sessions |
| `cleanup` | Remove stale sessions/worktrees |
| `doctor` | Check system health |
| `update` | Update database schema to v1.1.0 |

**MCP & Merge:**
| Command | Description |
|---------|-------------|
| `mcp serve` | Start MCP server (stdio) |
| `watch merges` | Start merge detection daemon |
| `merge status` | Show merge events history |

**Installation:**
| Command | Description |
|---------|-------------|
| `install --all` | Install hooks + alias + MCP + update db |
| `install --hooks --global/--local` | Install heartbeat hooks |
| `install --alias` | Add claude=claude-parallel to shell |
| `install --mcp` | Configure MCP server |
| `install --status` | Check installation status |

**Sandbox (E2B):**
| Command | Description |
|---------|-------------|
| `sandbox run --repo . --prompt "..."` | Execute in E2B sandbox |
| `sandbox logs --session-id <id>` | View execution logs |
| `sandbox download --session-id <id>` | Download results |
| `sandbox kill --session-id <id>` | Terminate sandbox |
| `sandbox list` | List sandbox sessions |

**Configuration:**
| Command | Description |
|---------|-------------|
| `config set <key> <value>` | Set configuration value |
| `config get <key>` | Get configuration value |
| `config list` | Display all config values |
| `budget status` | Show budget/spending status |
| `templates list` | List sandbox templates |
| `templates show <name>` | Show template details |

## Database

SQLite at `~/.parallel-cc/coordinator.db`. Key tables:
- `sessions` - Active session tracking (PID, repo, worktree, E2B state, costs)
- `merge_events` - Detected merge events
- `subscriptions` - Merge notification subscriptions
- `budget_tracking` - Cost tracking by period

Run `parallel-cc update` to apply migrations.

## Integration Flow

1. User runs `claude-parallel` (or aliased `claude`)
2. Wrapper calls `parallel-cc register --repo <path> --pid $$`
3. If parallel session exists, creates worktree via `gtr new`
4. Returns JSON with `worktreePath` and `sessionId`
5. Wrapper exports `PARALLEL_CC_SESSION_ID`, `cd`s to worktree, `exec`s claude
6. On exit, trap calls `parallel-cc release --pid $$` to cleanup

## E2B Sandbox Usage

**When to use E2B:** Long-running autonomous tasks (30+ min), plan-driven implementations, TDD workflows, "walk away" tasks.

**When to use local:** Interactive dev, quick iterations, local service access, debugging.

```bash
# Basic execution
parallel-cc sandbox run --repo . --prompt "Implement feature X"

# With authentication
parallel-cc sandbox run --repo . --prompt "Fix bug" --auth-method oauth

# Auto-generate branch
parallel-cc sandbox run --repo . --prompt "Add feature" --branch auto

# Use template
parallel-cc sandbox run --repo . --prompt "Build API" --use-template python-3.12-fastapi

# Git-live mode (auto PR)
parallel-cc sandbox run --repo . --prompt "Fix bug" --git-live
```

**Environment Variables:**
- `ANTHROPIC_API_KEY` - For API key auth mode
- `GITHUB_TOKEN` - For git-live PR creation
- `PARALLEL_CC_GIT_USER`, `PARALLEL_CC_GIT_EMAIL` - Override git identity

## Coding Standards

- TypeScript strict mode, ES modules
- Async/await over callbacks
- Vitest for testing, >85% coverage enforced
- Subcommands preferred over hyphenated names (e.g., `mcp serve` not `mcp-serve`)
