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
- **[v0.2.3-v0.2.4](#installation-improvements)** - Shell alias setup + full installation command ✅
- **[v0.3](#v03---mcp-server-for-status-queries)** - MCP Server for Status Queries ✅
- **[v0.4](#v04---branch-merge-detection--rebase-assistance)** - Branch Merge Detection & Rebase Assistance ✅
- **[v0.5](#v05---advanced-conflict-resolution)** - Advanced Conflict Resolution & Auto-fix Suggestions ✅
- **[v1.0](#v10---e2b-sandbox-integration-)** - E2B Sandbox Integration (E2B-specific implementation) ✅ (current)

### Planned Versions
- **[v1.1](#v11---enhanced-e2b-features)** - Enhanced E2B Features (next - minor release)
- **[v1.5](#v15---multi-provider-sandbox-architecture)** - Provider-Agnostic Sandbox Architecture (major enhancement)
- **v2.0** - Enhanced observability and collaboration features (TBD)

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

**Status:** Completed ✅

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

**Status:** Completed ✅

### Overview
Added MCP server so Claude Code can query the coordinator mid-session to understand what other sessions are doing.

### Achievements
- **>85% test coverage** achieved across all source files (267 tests, 100% passing)
- Comprehensive tests for coordinator.ts (100%), db.ts (98%+), and gtr.ts (100%)
- Integration tests for all MCP server tools (50 tests)

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

**Status:** Completed ✅

### Overview
Proactively detect when parallel branches are merged and help coordinate rebases. Sessions can subscribe to merge notifications and Claude can assist with conflict checking and rebasing.

### Achievements
- **303 tests, 100% passing** with comprehensive coverage
- Merge detection daemon with polling and subscription system
- Conflict checking before rebase attempts
- Rebase assistance with detailed conflict reporting
- 7 MCP tools for full merge/rebase workflow support

### Features Delivered

#### Merge Detection Daemon
- `parallel-cc watch-merges` - Continuous polling for merged branches
- `parallel-cc watch-merges --once` - Single poll for testing
- Tracks merge events in SQLite with timestamps and notification status
- Automatic subscription notification system

#### MCP Tools (7 total)
1. **get_parallel_status** - Query active sessions in repo
2. **get_my_session** - Current session info (requires PARALLEL_CC_SESSION_ID)
3. **notify_when_merged** - Subscribe to merge notifications for a branch
4. **check_merge_status** - Check if a branch has been merged
5. **check_conflicts** - Preview rebase conflicts between branches
6. **rebase_assist** - Perform rebase with conflict detection
7. **get_merge_events** - List merge history for a repository

#### CLI Commands
- `watch-merges [--once]` - Start merge detection daemon
- `merge-status [--subscriptions]` - Show merge events or active subscriptions

### Database Schema (v0.4)
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
```

---

## v0.5 - Advanced Conflict Resolution

**Status:** Completed ✅ (Current Version)

**Implemented:** Comprehensive conflict resolution system with AST-based semantic analysis, file claims coordination, and AI-powered auto-fix suggestions.

**Testing:** 441 tests total (100% pass rate), 87.5% function coverage
**Security:** Zero critical vulnerabilities, comprehensive input validation
**Migration:** Complete migration guide provided for database schema updates

### Overview
Build on v0.4's conflict checking with advanced resolution capabilities. Provide intelligent auto-fix suggestions and file-level conflict prevention.

### Features

#### Merge Conflict Auto-fix Suggestions
- Analyze conflict patterns and suggest resolutions
- Detect common conflict types (import additions, function modifications)
- Provide AI-assisted merge suggestions via MCP

#### File Claim System
- Sessions register files they intend to modify
- Coordinator warns if another session has claimed the same file
- Claims can be advisory (warn) or exclusive (block)

#### Tools
```typescript
// Claim files before editing
claim_files({ files: string[], mode: 'advisory' | 'exclusive' })

// Check for file-level conflicts
check_file_conflicts({ files: string[] })
// Returns: { conflicts: [{ file, claimedBy, sessionId }] }

// Get auto-fix suggestions for conflicts
suggest_conflict_resolution({ conflictingFiles: string[] })
// Returns: { suggestions: [{ file, strategy, confidence }] }

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

**Status:** Completed ✅ (Major Milestone)

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

### Implementation Completed (December 2025)

**All phases completed with additional security hardening and robustness improvements:**

#### Core Features Delivered:
- ✅ E2B SDK integration (v1.13.2) with Sandbox.create() and Sandbox.connect()
- ✅ SandboxManager for lifecycle management (create, monitor, terminate, extend timeout)
- ✅ Intelligent file sync with compression (gzip level 6, 50MB checkpoints)
- ✅ Claude Code autonomous execution with output streaming
- ✅ Database schema extensions for E2B sessions
- ✅ All CLI commands (sandbox-run, sandbox-logs, sandbox-download, sandbox-kill)
- ✅ Sandbox reconnection support for cross-process access (critical bug fix)

#### Security & Robustness Enhancements:
- ✅ **Shell injection prevention** (CWE-78):
  - Prompt sanitization with newline/metacharacter escaping
  - Tar command execution via argv arrays (no shell interpolation)
  - Remote path whitelist validation ([A-Za-z0-9/_.-] only)
  - Local path traversal prevention
- ✅ **Resource cleanup guarantees**:
  - Try/finally blocks for tarball cleanup
  - Best-effort sandbox termination in error handlers
  - Cleanup errors logged but don't mask original errors
- ✅ **Test reliability**:
  - Test timeouts exceed execution timeouts (6min for 5min execution, 11min for 10min)
  - 82 sandbox-manager tests, 26 file-sync smoke tests, all passing
- ✅ **Cross-process support**:
  - getOrReconnectSandbox() method for accessing sandboxes created in separate CLI invocations
  - monitorSandboxHealth() with automatic reconnection
  - Fixed sandbox-download command to work across process boundaries

#### Files Delivered:
- `src/e2b/sandbox-manager.ts` - 499 lines, comprehensive lifecycle management
- `src/e2b/file-sync.ts` - 600+ lines, secure file operations
- `src/e2b/claude-runner.ts` - Autonomous execution engine
- `src/e2b/output-monitor.ts` - Real-time output streaming
- `tests/e2b/` - 150+ tests covering all modules
- `migrations/v1.0.0.sql` - Database schema migration
- `docs/E2B_GUIDE.md` - User-facing documentation
- `docs/SECURITY_AUDIT_v1.0.md` - Security review documentation

#### Test Coverage:
- Total: 441 tests, 100% passing
- Function coverage: 87.5%
- Key modules: sandbox-manager (100%), file-sync (100%), integration tests (100%)

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

## v1.1 - Enhanced E2B Features

**Status:** Planned (Next Minor Release)

### Overview

Incremental improvements to the E2B sandbox integration based on real-world usage feedback. Focuses on reliability, developer experience, and enterprise-readiness.

### Key Features

#### 1. Automatic Git Configuration in Sandboxes
**Priority: Critical**

Currently, git operations in E2B sandboxes fail or require manual configuration because:
- `git user.name` and `git user.email` are not configured
- SSH keys for private repositories are not available
- GitHub CLI authentication is incomplete

**Solution:**
- Auto-configure git identity from local environment or explicit flags
- Support `--git-user` and `--git-email` CLI flags
- Inject SSH keys for private repository access
- Pass GitHub CLI token for authenticated operations

```bash
# Example usage
parallel-cc sandbox-run --repo . --prompt "Task" \
  --git-user "Your Name" \
  --git-email "your@email.com" \
  --ssh-key ~/.ssh/id_ed25519
```

#### 2. Parallel Sandbox Execution
**Priority: High**

Run multiple independent E2B sandboxes simultaneously for different tasks.

```bash
# Run multiple tasks in parallel
parallel-cc sandbox-run-multi --repo . \
  --task "Implement auth module" \
  --task "Add unit tests" \
  --task "Update documentation"
```

#### 3. Private Repository Support
**Priority: High**

Enable E2B sandboxes to access private npm packages and git repositories.

- SSH key injection for git clone operations
- NPM token support for private packages
- GitHub PAT support for API operations
- Secure credential handling (never logged or exposed)

#### 4. Enhanced Cost Controls
**Priority: Medium**

Better visibility and control over E2B spending.

- Budget limits per session and globally
- Cost estimation before execution
- Detailed cost breakdown in session logs
- Monthly usage reports

#### 5. Sandbox Templates
**Priority: Medium**

Pre-configured sandbox environments for common workflows.

```bash
# Use pre-defined template
parallel-cc sandbox-run --repo . --template node-20-typescript
parallel-cc sandbox-run --repo . --template python-3.12-fastapi
```

Templates include:
- Pre-installed dependencies
- Optimized base images
- Common tooling (linters, formatters, test runners)

#### 6. E2B Integration Test Improvements
**Priority: High**

Fix and improve E2B integration tests:

- Skip tests gracefully when E2B_API_KEY is not available
- Add mock-based tests that don't require API access
- Improve test reliability and reduce flakiness
- Better error messages for test failures

### Database Schema Changes

```sql
-- v1.1.0: Git configuration tracking
ALTER TABLE sessions ADD COLUMN git_user TEXT;
ALTER TABLE sessions ADD COLUMN git_email TEXT;
ALTER TABLE sessions ADD COLUMN ssh_key_provided INTEGER DEFAULT 0;

-- v1.1.0: Cost tracking improvements
ALTER TABLE sessions ADD COLUMN budget_limit REAL;
ALTER TABLE sessions ADD COLUMN cost_estimate REAL;
ALTER TABLE sessions ADD COLUMN actual_cost REAL;
```

### Implementation Phases

**Phase 1 (Week 1-2): Git Configuration & Test Fixes**
- Implement git config injection in sandboxes
- Add CLI flags for git identity
- Fix/skip E2B integration tests appropriately
- Improve test error messages

**Phase 2 (Week 3-4): Private Repository Support**
- SSH key injection infrastructure
- NPM token support
- GitHub PAT handling
- Security audit of credential handling

**Phase 3 (Week 5-6): Parallel Execution & Cost Controls**
- Multi-task CLI command
- Session parallelization
- Budget limit enforcement
- Cost estimation and tracking

**Phase 4 (Week 7-8): Templates & Polish**
- Template system design
- Pre-built templates
- Documentation updates
- Integration testing

### Success Metrics

- ✅ Git operations work out-of-the-box in sandboxes
- ✅ Private repository access works with proper credentials
- ✅ All tests pass (or skip gracefully) without E2B_API_KEY
- ✅ Budget limits prevent unexpected costs
- ✅ Templates reduce setup time by 50%+

---

## v1.5 - Multi-Provider Sandbox Architecture

**Status:** Planned (Next Major Enhancement)

### Overview

**Strategic Evolution:** Transform parallel-cc's E2B-specific sandbox integration (v1.0) into a **provider-agnostic architecture** supporting multiple sandboxing backends. This enables users to choose the best sandbox provider for their use case, budget, and security requirements.

**Why v1.5:** This is a critical stepping stone between v1.0 (single provider) and v2.0 (advanced features). The abstraction layer built here will enable future innovations while maintaining backward compatibility with existing E2B workflows.

### Motivation

v1.0 proved the value of autonomous sandbox execution, but users have different needs:
- **Local development** → Want free, instant sandboxing without cloud costs
- **Enterprise teams** → Need SOC2/HIPAA compliance (Daytona)
- **Edge workloads** → Require ultra-low latency (Cloudflare Workers)
- **Cost optimization** → Want to switch providers based on task duration/complexity

### Provider Ecosystem

| Provider | Type | Best For | Startup | Cost | Compliance |
|----------|------|----------|---------|------|------------|
| **Native** (srt) | Local OS-level | Quick tasks, free dev | Instant | Free | N/A |
| **Docker** | Local container | Cross-platform dev | 2-5s | Free | N/A |
| **E2B** | Cloud VM | Long autonomous tasks | 150ms | $0.10/hr | Standard |
| **Daytona** | Cloud enterprise | Regulated industries | 90ms | Custom | SOC2, HIPAA |
| **Cloudflare** | Edge container | Short, distributed tasks | 100ms | Per-request | Standard |

### Architecture: SandboxProvider Interface

**Core Abstraction:**
```typescript
interface SandboxProvider {
  // Lifecycle
  create(config: SandboxConfig): Promise<SandboxInstance>;
  destroy(instanceId: string): Promise<void>;

  // File Operations
  uploadFiles(instanceId: string, files: FileList): Promise<UploadResult>;
  downloadFiles(instanceId: string): Promise<FileList>;

  // Execution
  execute(instanceId: string, command: string): AsyncGenerator<OutputChunk>;

  // Status
  isRunning(instanceId: string): Promise<boolean>;
  getMetrics(instanceId: string): Promise<SandboxMetrics>;
}
```

**Provider Implementations:**
- `NativeProvider` - Uses Anthropic's `srt` CLI (macOS Seatbelt, Linux bubblewrap)
- `DockerProvider` - Uses Docker CLI/SDK
- `E2BProvider` - Wraps existing E2B SDK (backward compatible)
- `DaytonaProvider` - Integrates Daytona SDK
- `CloudflareProvider` - Uses Cloudflare Workers API

### Key Features

#### 1. Provider Selection
```bash
# Via CLI flag (explicit)
parallel-cc sandbox-run --provider docker --repo . --prompt "Run tests"

# Via environment variable (default)
export SANDBOX_PROVIDER=native
parallel-cc sandbox-run --repo . --prompt "Quick fix"

# Via config file (project-specific)
# .parallel-cc.json: { "defaultProvider": "e2b" }
parallel-cc sandbox-run --repo . --prompt "Long task"
```

#### 2. Provider Auto-Selection
Smart provider selection based on task characteristics:
```typescript
// Heuristics:
// - Task duration < 5min → Native/Docker (free)
// - Task duration > 30min → E2B (reliable)
// - Requires GPU → E2B/Daytona
// - Enterprise repo → Daytona (compliance)
// - Edge deployment → Cloudflare
```

#### 3. Provider Fallback Chain
```yaml
providers:
  primary: native
  fallback:
    - docker      # If native fails
    - e2b         # If docker unavailable
  never:
    - cloudflare  # Too expensive for this use case
```

#### 4. Unified Configuration
```bash
# Provider-specific configs via env vars
NATIVE_SANDBOX_ROOT=/tmp/claude-sandbox
DOCKER_IMAGE=claude-code:latest
E2B_API_KEY=xxx
E2B_TEMPLATE=base-v2
DAYTONA_WORKSPACE_ID=xxx
CLOUDFLARE_ACCOUNT_ID=xxx
```

### Database Schema Changes

```sql
-- Extend sessions table to track provider
ALTER TABLE sessions ADD COLUMN provider TEXT DEFAULT 'local';
ALTER TABLE sessions ADD COLUMN provider_instance_id TEXT;
ALTER TABLE sessions ADD COLUMN provider_metadata TEXT; -- JSON blob

-- Provider usage tracking
CREATE TABLE provider_usage (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  session_id TEXT,
  duration_seconds INTEGER,
  cost_estimate REAL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
```

### Implementation Phases

**Phase 1: Abstraction Layer (Week 1-2)**
- Define `SandboxProvider` interface and types
- Extract E2B logic into `E2BProvider` class
- Refactor `SandboxManager` to use provider abstraction
- Add provider registry and factory pattern
- Update CLI to accept `--provider` flag
- Maintain 100% backward compatibility with v1.0

**Phase 2: Native Provider (Week 3)**
- Implement `NativeProvider` using Anthropic's srt CLI
- Test on macOS (Seatbelt) and Linux (bubblewrap)
- Add installation instructions for srt
- Performance benchmarks vs. E2B

**Phase 3: Docker Provider (Week 4)**
- Implement `DockerProvider` using Docker SDK
- Build official `claude-code` Docker image
- Cross-platform testing (macOS, Linux, Windows)
- Document Docker setup requirements

**Phase 4: Advanced Providers (Week 5-6)**
- Implement `DaytonaProvider` (if SDK available)
- Implement `CloudflareProvider` (experimental)
- Provider comparison benchmarks
- Cost optimization recommendations

**Phase 5: Polish (Week 7)**
- Provider auto-selection heuristics
- Fallback chain support
- Comprehensive testing (all providers)
- Migration guide from v1.0

### Reference Documentation

**Detailed Specification:** See `SANDBOX_INTEGRATION_PLAN.md` for:
- Complete provider API specifications
- Cross-platform OS considerations
- Detailed risk analysis per provider
- Performance benchmarks and trade-offs
- Security model for each provider
- Cost optimization strategies

### Success Metrics

- ✅ 100% backward compatibility with v1.0 E2B workflows
- ✅ At least 3 providers fully implemented (Native, Docker, E2B)
- ✅ Provider switching works seamlessly via config
- ✅ No performance regression for E2B users
- ✅ Local providers (Native/Docker) work offline
- ✅ Comprehensive test coverage across all providers

### Migration from v1.0

**Zero-Breaking Changes:**
```bash
# v1.0 commands continue to work (default to E2B)
parallel-cc sandbox-run --repo . --prompt "task"

# v1.5 adds new capability
parallel-cc sandbox-run --provider native --repo . --prompt "task"
```

**Configuration Migration:**
```bash
# Old (v1.0): E2B hardcoded
E2B_API_KEY=xxx

# New (v1.5): Provider-specific
SANDBOX_PROVIDER=e2b  # Explicit default
E2B_API_KEY=xxx
```

### Integration Points

**With v1.0:**
- Reuses all E2B code via `E2BProvider` wrapper
- Same database schema (extended, not replaced)
- Same CLI structure (new flags, not changed commands)

**With v2.0:**
- Provider abstraction enables advanced features:
  - Multi-provider task distribution
  - Cost-optimized provider selection
  - Hybrid local+cloud execution

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
