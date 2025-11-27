# parallel-cc Roadmap & Future Specs

## Document Purpose

This document serves as the definitive source of truth for parallel-cc's development roadmap. It is designed to be used by:
- **Human developers** planning and implementing features
- **AI agents** (Claude, etc.) understanding project scope and planning development tasks
- **Contributors** proposing enhancements and understanding project direction

All versions are linked for easy navigation, and each section includes status, overview, and implementation details suitable for both human and AI-driven development.

## Version Roadmap

### Completed Versions

- **[v0.1](#v01---project-foundation)** - Project structure, types, schema design ✅
- **[v0.2](#v02---core-infrastructure)** - CLI + SQLite + wrapper script ✅
- **[v0.2.1](#v021---hook-installation--configuration-priority)** - Hook Installation & Configuration ✅
- **[v0.2.3-v0.2.4](#installation-improvements)** - Shell alias setup + full installation command ✅ (current)

### Planned Versions
- **[v0.3](#v03---mcp-server-for-status-queries)** - MCP Server for Status Queries
- **[v0.4](#v04---branch-merge-detection--rebase-assistance)** - Branch Merge Detection & Rebase Assistance
- **[v0.5](#v05---file-level-conflict-detection)** - File-Level Conflict Detection
- **[v1.0](#v10---e2b-sandbox-integration-)** - E2B Sandbox Integration for Autonomous Execution (major milestone)

---

## v0.1 - Project Foundation

**Status:** Completed ✅

### Overview
Initial project architecture establishing the foundation for parallel Claude Code session coordination.

### Deliverables
- Project directory structure and build configuration
- TypeScript type definitions for sessions, worktrees, and coordinator state
- SQLite database schema design for session tracking
- Core domain models and interfaces

---

## v0.2 - Core Infrastructure

**Status:** Completed ✅ (Current Version)

### Overview
Implemented the complete CLI, database layer, and wrapper script for basic parallel session coordination.

### Key Features
- **CLI Commands:** `start`, `stop`, `status`, `list`, `cleanup`
- **Session Tracking:** SQLite database for persistent session state
- **Worktree Management:** Integration with `gtr` for git worktree coordination
- **Wrapper Script:** `claude-parallel` command that wraps Claude Code with automatic session registration
- **Heartbeat Monitoring:** Basic session liveness detection

### Components Delivered
- `src/coordinator.ts` - Core session management logic
- `src/cli/index.ts` - Command-line interface
- `scripts/claude-parallel.sh` - Wrapper script
- Installation and setup scripts

---

### v0.2.1 - Hook Installation & Configuration (PRIORITY)

**Status:** Completed ✅

**Overview:** Automate heartbeat hook setup both during initial installation and via CLI command for existing installations.

#### Installation Script Enhancement

Add optional prompt during `./scripts/install.sh` to automatically configure the heartbeat hook:

```bash
# During installation:
./scripts/install.sh

# ... after successful installation ...
# Prompt: "Would you like to add the heartbeat hook for better session tracking? [y/N]"
# Prompt: "Install globally (~/.claude/settings.json) or locally (current repo)? [global/local/skip]"
```

**Behavior:**
1. After successful installation, prompt user for heartbeat hook
2. If yes, ask: global vs local installation
3. **Global:** Add to `~/.claude/settings.json` (affects all repos)
4. **Local:** Add to `./.claude/settings.json` (current repo only)
5. Check if hooks already exist before adding
6. Preserve existing hooks when merging
7. Show confirmation message with file path

#### CLI Command for Post-Installation Setup

Add `--install-hooks` flag to configure hooks after installation:

```bash
# Configure hooks for current repo
parallel-cc install --hooks

# Non-interactive modes
parallel-cc install --hooks --global # Adds to ~/.claude/settings.json
parallel-cc install --hooks --local  # Adds to ./.claude/settings.json
```

**CLI Behavior:**
1. Interactive mode (just `--hooks`): Prompts for global/local
2. Check if `.claude/settings.json` exists
3. If exists, merge hooks (preserve existing config)
4. If not, create with just the parallel-cc hooks
5. Add `.claude/` to `.gitignore` if not already there (optional, prompt user)

#### Hook Configuration Added

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "~/.local/bin/parallel-cc-heartbeat.sh"
          }
        ]
      }
    ]
  }
}
```

---

## Installation Improvements

### v0.2.3 - Interactive Alias Setup

**Status:** Completed ✅

Add optional prompt during `./scripts/install.sh` to automatically configure the shell alias:

```bash
# During installation:
./scripts/install.sh

# ... after successful installation ...
# Prompt: "Would you like to add 'alias claude=claude-parallel' to your shell profile? [y/N]"
```

**Behavior:**
1. After successful installation, prompt user
2. Detect current shell from `$SHELL` (bash/zsh/fish)
3. Find appropriate profile file (~/.bashrc, ~/.zshrc, ~/.config/fish/config.fish)
4. Check if alias already exists
5. If yes: append alias to profile file
6. Show message: "✓ Alias added to ~/.bashrc - restart your shell or run: source ~/.bashrc"

**CLI Command:**
```bash
parallel-cc install --alias  # Adds alias to shell profile
parallel-cc install --alias --uninstall  # Removes alias
```

### v0.2.4 - Full Installation Command

**Status:** Completed ✅

Combine all installation options:

```bash
# Full installation with all options
parallel-cc install --all

# Equivalent to:
parallel-cc install --hooks --global --alias

# Interactive mode (prompts for each option)
parallel-cc install --interactive

# Check installation status
parallel-cc install --status
```

---

## v0.3 - MCP Server for Status Queries

**Status:** Planned

### Overview
Add an MCP server so Claude Code can query the coordinator mid-session to understand what other sessions are doing.

### Testing Requirements
- Achieve **>85% test coverage** across all source files
- Add comprehensive tests for coordinator.ts, db.ts, and gtr.ts modules
- Integration tests for MCP server tools

### Tools to Implement

#### `get_parallel_status`
Returns info about all active sessions in the current repo.

```typescript
// Input
{ repo_path?: string }

// Output
{
  sessions: [
    {
      pid: number,
      worktreePath: string,
      worktreeName: string,
      isMainRepo: boolean,
      durationMinutes: number,
      isAlive: boolean
    }
  ],
  totalSessions: number
}
```

**Use case:** Claude can say "There are 2 other sessions active - one has been running for 45 minutes in the auth-feature worktree."

#### `get_my_session`
Returns info about the current session.

```typescript
// Output
{
  sessionId: string,
  worktreePath: string,
  worktreeName: string | null,
  isMainRepo: boolean,
  startedAt: string,
  parallelSessions: number
}
```

**Use case:** Claude can check "Am I in a worktree or the main repo?"

#### `notify_when_merged`
Subscribe to notifications when a branch is merged to main.

```typescript
// Input
{ branch: string }

// Output  
{ subscribed: true }

// Later, MCP notification:
{ event: "branch_merged", branch: "feature-auth", mergedBy: "user" }
```

**Use case:** Claude working on frontend can be notified when the backend branch merges, prompting a rebase.

### Implementation Notes
- MCP server runs alongside CLI (same SQLite DB)
- Consider using `@modelcontextprotocol/sdk` for TypeScript
- Server started via `parallel-cc mcp-serve` or auto-started by Claude Code config

---

## v0.4 - Branch Merge Detection & Rebase Assistance

**Status:** Planned

### Overview
Proactively detect when parallel branches are merged and help coordinate rebases.

### Features

#### Merge Detection
- Poll git for merged branches every N seconds
- Detect when worktree branches have been merged to main
- Track merge events in SQLite

#### Rebase Prompts
When a parallel branch merges:
1. MCP server sends notification to active sessions
2. Claude can prompt: "The `auth-backend` branch was just merged. Want me to rebase your work?"
3. If yes, Claude runs `git fetch && git rebase origin/main`

#### Conflict Resolution Assistance
- Detect rebase conflicts
- Provide context about what the other branch changed
- Suggest resolution strategies

### Database Additions
```sql
CREATE TABLE merge_events (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  merged_at TEXT NOT NULL,
  merged_into TEXT DEFAULT 'main',
  notified_sessions TEXT  -- JSON array of session IDs notified
);

CREATE TABLE subscriptions (
  session_id TEXT,
  branch TEXT,
  created_at TEXT,
  PRIMARY KEY (session_id, branch)
);
```

---

## v0.5 - File-Level Conflict Detection

**Status:** Planned

### Overview
Track which files each session is modifying to warn about potential conflicts before they happen.

### Features

#### File Claim System
- Sessions register files they intend to modify
- Coordinator warns if another session has claimed the same file
- Claims can be advisory (warn) or exclusive (block)

#### Tools
```typescript
// Claim files before editing
claim_files({ files: string[], mode: 'advisory' | 'exclusive' })

// Check for conflicts
check_conflicts({ files: string[] }) 
// Returns: { conflicts: [{ file, claimedBy, sessionId }] }

// Release claims
release_files({ files: string[] })
```

#### PreToolUse Hook Integration
- Hook checks claims before Edit tool runs
- Can warn or block based on configuration

### Database Additions
```sql
CREATE TABLE file_claims (
  session_id TEXT,
  file_path TEXT,
  claim_mode TEXT DEFAULT 'advisory',
  claimed_at TEXT,
  PRIMARY KEY (session_id, file_path)
);
```

---

## v1.0 - E2B Sandbox Integration 🚀

**Status:** Planned (Major Milestone)

### Overview
**Game-changing feature:** Enable truly autonomous, long-running Claude Code execution in isolated E2B cloud sandboxes. This transforms parallel-cc from a worktree coordinator into a full autonomous development platform.

**Why this is v1.0:** This feature unlocks the "plan → execute → review" workflow that makes Claude Code genuinely autonomous for complex, multi-hour tasks while maintaining safety through worktree isolation.

### Core Workflow
```bash
# Step 1: Plan interactively (local Claude)
$ claude
> "Help me plan an auth refactor with comprehensive tests"
[Claude creates PLAN.md or .apm/Implementation_Plan.md]
$ git commit PLAN.md -m "plan: auth refactor"

# Step 2: Execute autonomously (E2B sandbox)
$ parallel-cc sandbox-run --repo . --prompt "Execute PLAN.md with TDD approach"
# Walk away for coffee - Claude works for 30+ minutes uninterrupted
# Sandbox automatically runs with --dangerously-skip-permissions

# Step 3: Review & merge (local)
$ cd parallel-e2b-abc123  # worktree with results
$ git diff main  # review all changes
$ pytest tests/  # verify locally
$ git push origin HEAD:feature/auth
```

### Key Features

#### Hybrid Execution Model
- **Mode 1 (Local)**: Current worktree coordination for interactive development
- **Mode 2 (E2B Sandbox)**: Cloud-isolated autonomous execution with full permissions
- Both modes tracked in same SQLite database with unified session management

#### Autonomous Execution
- Sandbox runs Claude Code with `--dangerously-skip-permissions` by design
- Safe because sandbox is isolated VM with no access to your system
- Supports 1-hour max execution time (E2B free tier limit)
- Real-time output streaming for monitoring progress
- Automatic warnings at 30min and 50min marks

#### Intelligent File Sync
- **Upload**: Compress and upload worktree excluding `.gitignore` patterns
- **Download**: Selective download of only changed files
- **Git Integration**: parallel-cc handles all git commits after execution
- Respects `.gitignore` to skip `node_modules`, build artifacts, etc.

#### Plan-Driven Execution
- Reads committed `PLAN.md` or `.apm/Implementation_Plan.md` from repo
- Claude autonomously follows multi-phase plans step-by-step
- Supports TDD workflows: write tests → run tests → implement → verify
- Optional `--prompt-file` flag to execute specific plan files

### New CLI Commands

```bash
# Execute autonomous task in sandbox
parallel-cc sandbox-run --repo . --prompt "Implement feature X"
parallel-cc sandbox-run --repo . --prompt-file PLAN.md
parallel-cc sandbox-run --repo . --prompt-file .apm/Implementation_Plan.md

# Monitor active sandbox sessions  
parallel-cc status --sandbox-only
parallel-cc sandbox-logs --session-id e2b-abc123

# Download results without terminating
parallel-cc sandbox-download --session-id e2b-abc123 --output ./results

# Kill running sandbox
parallel-cc sandbox-kill --session-id e2b-abc123

# Test upload/download without execution
parallel-cc sandbox-run --dry-run --repo .
```

### Database Schema Changes

```sql
-- Extend sessions table for E2B support
ALTER TABLE sessions ADD COLUMN execution_mode TEXT DEFAULT 'local';
ALTER TABLE sessions ADD COLUMN sandbox_id TEXT;
ALTER TABLE sessions ADD COLUMN prompt TEXT;
ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'active';
ALTER TABLE sessions ADD COLUMN output_log TEXT;
```

### Technical Architecture

```
┌─────────────────────────────────────────────┐
│     E2B Sandbox Execution Flow              │
├─────────────────────────────────────────────┤
│ 1. Create worktree via gtr                  │
│ 2. Register E2B session in SQLite           │
│ 3. Spin up anthropic-claude-code sandbox    │
│ 4. Run `claude update` (ensure latest)      │
│ 5. Upload worktree files (tarball)          │
│ 6. Execute: echo "$PROMPT" | claude -p      │
│    --dangerously-skip-permissions           │
│ 7. Stream output, monitor progress          │
│ 8. Download changed files only              │
│ 9. Create git commit in worktree            │
│ 10. Cleanup: terminate sandbox              │
└─────────────────────────────────────────────┘
```

### New TypeScript Modules

```
src/
├── e2b/
│   ├── sandbox-manager.ts    # Create/manage E2B sandboxes
│   ├── file-sync.ts          # Upload/download with compression
│   ├── claude-runner.ts      # Execute Claude Code in sandbox
│   └── output-monitor.ts     # Stream and capture output
├── types.ts                   # E2B config and session types
└── coordinator.ts             # Extended for E2B sessions
```

### Safety & Cost Controls

- **Isolation**: Sandbox has zero access to your local system
- **Worktree-only**: Never executes in main branch
- **Manual review**: All changes require your review before merge
- **Timeout enforcement**: Hard limit at 1 hour (configurable down)
- **Cost warnings**: Alerts at 30min and 50min marks
- **Interrupt mechanism**: Kill sandbox anytime with `sandbox-kill`
- **Dry-run mode**: Test upload/download without execution

### Dependencies

- E2B SDK: `npm install e2b` (v1.x)
- E2B API key: Sign up at https://e2b.dev
- Anthropic API key: For Claude Code in sandbox

### Success Metrics

- Execute 30+ minute autonomous tasks without intervention ✓
- File sync works for repos up to 500MB ✓
- Real-time or near-real-time output visibility ✓
- Cost <$5 per 1-hour sandbox session ✓
- Seamless git integration with worktrees ✓

### Implementation Phases

**Phase 1 (Week 1-2): Foundation**
- Install E2B SDK dependencies
- Implement sandbox creation/termination
- Build file upload/download with compression
- Add E2B session tracking to database
- Validate critical assumptions (Claude Code version, plan execution)

**Phase 2 (Week 3-4): Core Execution**
- Implement `sandbox-run` command
- Build Claude Code execution with `claude update`
- Stream output monitoring
- Add timeout and kill mechanisms
- Implement git commit creation after download

**Phase 3 (Week 5): Optimization**
- Optimize file sync (selective downloads)
- Add cost tracking and warnings
- Improve error handling and recovery
- Comprehensive logging

**Phase 4 (Week 6): Polish**
- Add `--dry-run` mode
- Build session monitoring UI
- Write integration tests
- Documentation and examples
- Real-world validation with large repos

### Integration Points

**With existing parallel-cc:**
- Uses same `gtr` worktree infrastructure
- Shares SQLite database with local sessions
- Compatible with `parallel-cc status` and other commands
- Works seamlessly with existing `claude-parallel` wrapper

**With APM (if using):**
- Can execute `.apm/Implementation_Plan.md` autonomously
- Optional `--focus-phase N` to run specific phases
- Integrates with APM memory logs for continuity

**With v0.3 MCP Server (future):**
- MCP could expose `execute_in_sandbox` tool
- Claude could decide when to delegate to sandbox
- Enables hybrid local + sandbox workflows

### Why This Makes parallel-cc Essential

Before E2B integration:
- parallel-cc solves git worktree coordination for parallel sessions
- Valuable but somewhat niche use case

After E2B integration:
- parallel-cc becomes a **complete autonomous development platform**
- Plan → Execute (unattended for hours) → Review workflow
- Safe experimentation without risking your local environment
- Enables true "AI pair programmer that works while you sleep" experience
- Worktree isolation provides safety net for autonomous execution

**This is the killer feature that makes parallel-cc a must-have tool.**

### Open Questions for Future Iterations

1. Private dependencies: GitHub PAT injection for private repos?
2. Multi-file plans: Support for task decomposition across multiple plan files?
3. Parallel E2B sessions: Run multiple independent tasks simultaneously?
4. Cost optimization: Sandbox pooling, pause/resume, cheaper tiers?
5. APM orchestrator integration: Deep integration with apm-fhb workflows?

---

## Future Ideas (Unscheduled)

### Session Naming
Allow users to name sessions for easier identification:
```bash
claude-parallel --name "backend-auth"
# Shows in status as "backend-auth" instead of "parallel-m4x2k9"
```

### Session Communication
Allow sessions to send messages to each other:
```typescript
send_message({ to: 'all' | sessionId, message: string })
// Other sessions see: "Session 'backend-auth' says: I'm about to refactor the User model"
```

### Worktree Templates
Pre-configure worktrees with specific setup:
```bash
parallel-cc config set worktree.postCreate "npm install && npm run build"
parallel-cc config set worktree.copyFiles ".env.local,.claude/settings.json"
```

### VS Code Extension
- Show active sessions in sidebar
- Click to open worktree in new window
- Visual indicators for file conflicts

### GitHub Integration
- Auto-create PR when worktree work is complete
- Link PRs from parallel sessions
- Show PR status in `parallel-cc status`

### Metrics & Analytics
- Track session durations
- Count worktrees created/cleaned
- Identify repos with most parallel usage

---

## Contributing Ideas

Have an idea? Open an issue with the `enhancement` label or add it to this file via PR.

When proposing a feature, please include:
1. **Problem:** What pain point does this solve?
2. **Solution:** How would it work?
3. **Scope:** Is it a CLI feature, MCP tool, or both?
4. **Dependencies:** Does it require changes to other components?
