# E2B Sandbox Integration Plan

## Problem Statement

Integrate E2B sandboxes with parallel-cc to enable autonomous Claude Code execution in isolated cloud environments. This allows pre-approved, long-running tasks to execute in secure sandboxes with full permissions while maintaining the parallel worktree coordination system.

## Current State Analysis

### parallel-cc Architecture

* **Wrapper system**: `claude-parallel.sh` wraps Claude Code CLI, manages worktree coordination
* **Session tracking**: SQLite-based coordinator tracks PIDs, worktrees, heartbeats
* **Git integration**: Uses `gtr` (git-worktree-runner) for worktree creation/management
* **Local execution**: All Claude Code sessions run on local machine with shared filesystem
* **Permission model**: Standard Claude Code permissions apply (user must approve actions)

### E2B Capabilities (Researched)

* **Fast sandbox startup**: ~150ms spin-up time for isolated VMs
* **Prebuilt template exists**: `anthropic-claude-code` template includes Claude Code pre-installed
* **File system access**: Upload/download files via SDK (`sandbox.files.write()`, `sandbox.files.read()`)
* **Command execution**: Run shell commands via `sandbox.commands.run()` with configurable timeouts
* **Git support**: Can clone repositories, run git commands inside sandbox
* **Environment variables**: Pass `ANTHROPIC_API_KEY` and other secrets securely
* **Persistence options**: Sandboxes can run up to 24 hours (Pro) or 1 hour (Hobby)
* **No git worktree support**: E2B sandboxes cannot directly access or create local git worktrees

### Key Integration Challenges

1. **Architecture mismatch**: parallel-cc manages local worktrees; E2B creates cloud-isolated VMs
2. **Filesystem isolation**: Sandbox cannot access local git worktrees or shared filesystem
3. **Repository sync**: Need to upload entire repo/worktree to sandbox, then download results
4. **Coordination model**: Cannot use PID-based session tracking (sandbox processes run remotely)
5. **Cost considerations**: Each sandbox costs API credits; long-running sessions can be expensive

## Proposed Solution

### Integration Architecture

Create a **hybrid execution model** with two modes:

#### Mode 1: Local Execution (Default)

* Current behavior: local Claude Code with worktree coordination
* Use for: Interactive development, manual oversight, rapid iteration

#### Mode 2: E2B Sandbox Execution (New)

* Claude Code runs in isolated E2B sandbox with `--dangerously-skip-permissions`
* Use for: Long-running autonomous tasks, pre-approved plans, unsafe operations
* Git repository uploaded to sandbox at start, results downloaded at completion

### Implementation Approach

**Option A: Parallel Coordination Layer** (Recommended)

* Extend `parallel-cc` to coordinate both local and E2B sessions
* E2B sessions tracked in SQLite with `execution_mode` field
* Upload worktree contents to sandbox, execute, download results back to worktree
* Maintains worktree-per-session model for consistency

**Option B: Separate E2B Wrapper**

* Create standalone `claude-e2b` wrapper independent of parallel-cc
* No worktree coordination; operates directly on repository
* Simpler but loses parallel session awareness

## Detailed Design: Option A (Recommended)

### 1. New CLI Commands

```bash
# Execute prompt in E2B sandbox
parallel-cc sandbox-run --repo /path/to/repo --prompt "Implement auth system" \
  --timeout 3600 --upload-repo

# Execute with pre-created worktree
parallel-cc sandbox-run --worktree-name parallel-abc123 \
  --prompt "Run tests and fix failures" --timeout 1800

# Monitor E2B sandbox sessions
parallel-cc status --sandbox-only
parallel-cc sandbox-logs --session-id e2b-abc123

# Download sandbox results without terminating
parallel-cc sandbox-download --session-id e2b-abc123 --output ./results
```

### 2. Execution Flow

```
┌─────────────────────────────────────────────────────────────┐
│              E2B Sandbox Execution Flow                      │
├─────────────────────────────────────────────────────────────┤
│ 1. User: parallel-cc sandbox-run --prompt "task"            │
│ 2. Coordinator: Create worktree via gtr (if needed)         │
│ 3. Coordinator: Register E2B session in SQLite              │
│ 4. E2B SDK: Create sandbox with anthropic-claude-code       │
│ 5. Upload: Sync worktree files to sandbox filesystem        │
│ 6. Execute: Run Claude Code with --dangerously-skip-perms   │
│ 7. Monitor: Stream output, update heartbeat in DB           │
│ 8. Download: Sync modified files back to worktree           │
│ 9. Cleanup: Terminate sandbox, update session status        │
└─────────────────────────────────────────────────────────────┘
```

### 3. Database Schema Changes

```sql
-- Add to existing sessions table
ALTER TABLE sessions ADD COLUMN execution_mode TEXT DEFAULT 'local';
-- Values: 'local' | 'e2b'

ALTER TABLE sessions ADD COLUMN sandbox_id TEXT;
-- E2B sandbox ID for remote sessions

ALTER TABLE sessions ADD COLUMN prompt TEXT;
-- Initial prompt/task for sandbox sessions

ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'active';
-- Values: 'active' | 'completed' | 'failed' | 'timeout'

ALTER TABLE sessions ADD COLUMN output_log TEXT;
-- Path to log file with sandbox output
```

### 4. New TypeScript Modules

```
src/
├── e2b/
│   ├── sandbox-manager.ts    # Create/manage E2B sandboxes
│   ├── file-sync.ts          # Upload/download repo files
│   ├── claude-runner.ts      # Execute Claude Code in sandbox
│   └── output-monitor.ts     # Stream and capture output
├── types.ts                   # Add E2B-related types
└── coordinator.ts             # Extend for E2B sessions
```

### 5. Configuration

```typescript
// src/types.ts additions
export interface E2BConfig {
  apiKey: string;                    // E2B_API_KEY
  template: string;                   // 'anthropic-claude-code'
  defaultTimeout: number;             // 3600 seconds (1 hour)
  uploadIgnorePatterns: string[];     // ['.git', 'node_modules', '.next']
  downloadOnlyChanged: boolean;       // true
}

export interface SandboxSession extends Session {
  execution_mode: 'local' | 'e2b';
  sandbox_id?: string;
  prompt?: string;
  status: 'active' | 'completed' | 'failed' | 'timeout';
  output_log?: string;
}
```

### 6. File Synchronization Strategy

**Upload Phase** (before execution):

* Use `.gitignore` patterns to exclude `node_modules`, build artifacts
* Create tarball of worktree, upload via `sandbox.files.write()`
* Initialize git in sandbox: `git init && git add . && git commit -m "Initial"`

**Download Phase** (after execution):

* Run `git diff --name-only` to identify changed files
* Download only modified files via `sandbox.files.read()`
* Apply changes to local worktree
* Optionally: commit changes with message "[E2B] Task completed"

### 7. Permission Handling

E2B sandbox execution ALWAYS uses `--dangerously-skip-permissions`:

```bash
# Inside sandbox
echo "$PROMPT" | claude -p --dangerously-skip-permissions --output-format stream-json
```

Rationale: Sandbox is isolated VM; user explicitly opted into autonomous execution.

### 8. Safety Measures

* **Cost limits**: Track sandbox runtime, warn at 30min/50min marks
* **Timeout enforcement**: Kill sandbox after configured timeout (default 1 hour)
* **Output streaming**: Real-time log visibility for monitoring
* **Interrupt mechanism**: `parallel-cc sandbox-kill --session-id` to terminate
* **Dry-run mode**: `--dry-run` flag to test upload/download without execution

### 9. User Experience

#### Typical Workflow (Plan → Execute → Review)

```bash
# STEP 1: Planning session (interactive, local Claude Code)
$ cd ~/projects/myapp
$ claude  # (aliased to claude-parallel)
> "Help me plan out the auth refactor with tests"
[Interactive back-and-forth with Claude]
[Claude creates .apm/Implementation_Plan.md or PLAN.md]
> "Great, commit this plan"
$ git add PLAN.md
$ git commit -m "plan: auth refactor with comprehensive tests"

# STEP 2: Handoff to autonomous sandbox (new terminal)
$ cd ~/projects/myapp
$ parallel-cc sandbox-run --repo . \
    --prompt "Execute the plan in PLAN.md. Follow TDD approach, run tests after each change."
📦 Creating worktree: parallel-e2b-a1b2c3
☁️  Starting E2B sandbox (anthropic-claude-code)...
📤 Uploading 147 files including PLAN.md (3.4 MB)...
🤖 Launching Claude Code with autonomous permissions...

[Streaming output - walk away, get coffee]
> Claude: Reading PLAN.md...
> Claude: I'll start with Phase 1: Write failing tests
> Running: pytest tests/test_auth.py -v
> Creating tests/test_auth.py with 12 test cases...
> Running: pytest tests/test_auth.py -v
> All tests failing as expected. Committing baseline.
> Claude: Phase 2: Implement core auth logic
[... 25 minutes of autonomous work ...]
> Running: pytest tests/ --cov=src/auth
> Coverage: 94% (47/50 lines)
> Claude: Phase 4 complete. All tests passing.

✅ Task completed!
📥 Downloading 15 modified files...
💾 Saved to worktree: parallel-e2b-a1b2c3
🔗 Next: Review changes and merge to main

# STEP 3: Review and merge (back to local)
$ cd ~/projects/myapp
$ parallel-cc status
Active Sessions: 1
  ● Session parallel-e2b-a1b2c3 (completed)
    Path: /home/user/projects/myapp-worktrees/parallel-e2b-a1b2c3
    Duration: 27m

$ cd ../myapp-worktrees/parallel-e2b-a1b2c3
$ git log --oneline -5
f8a3b21 [E2B] Complete auth refactor - all tests passing
3c7e9d4 Phase 3: Add password hashing with bcrypt
8b2f1a0 Phase 2: Implement JWT token generation
4e9c7f3 Phase 1: Add comprehensive test suite (12 tests)
a1b2c3d plan: auth refactor with comprehensive tests

$ git diff main
[Review all changes]

$ pytest tests/ --cov  # Verify locally
======================== 12 passed in 2.3s ========================
Coverage: 94%

$ git push origin HEAD:feature/auth-refactor
$ gh pr create --title "Auth refactor with comprehensive tests" --body "Autonomous implementation of PLAN.md"
```

#### Alternative: Execute from committed plan

```bash
# Reference plan file directly
$ parallel-cc sandbox-run --repo . --prompt-file PLAN.md

# Or use APM Implementation Plan
$ parallel-cc sandbox-run --repo . --prompt-file .apm/Implementation_Plan.md \
    --focus-phase 4  # Execute only Phase 4 tasks
```

## Implementation Phases

### Phase 1: Foundation (Week 1-2)

* Install E2B SDK dependencies (`npm install e2b @e2b/code-interpreter`)
* Create `src/e2b/` module structure
* Implement basic sandbox creation/termination
* Add E2B session types to database schema
* Build file upload/download utilities

### Phase 2: Core Execution (Week 3-4)

* Implement `sandbox-run` command
* Build Claude Code execution logic with streaming output
* Create output monitoring and logging system
* Add timeout and interruption mechanisms
* Implement basic file sync (full upload/download)

### Phase 3: Optimization (Week 5)

* Optimize file sync (differential downloads)
* Add cost tracking and warnings
* Improve error handling and recovery
* Create comprehensive logging

### Phase 4: Polish & Testing (Week 6)

* Add `--dry-run` mode
* Build sandbox session monitoring UI
* Write integration tests
* Update documentation
* Add example workflows

## Alternative Approaches Considered

### Approach B: Direct E2B Wrapper (Simpler, Limited)

Create standalone `parallel-cc-sandbox` tool:

```bash
# No worktree coordination
parallel-cc-sandbox --repo . --prompt "task"
```

**Pros**: Simpler implementation, fewer moving parts
**Cons**: No parallel session awareness, can't leverage existing coordinator, loses worktree-per-session model

### Approach C: MCP Server Integration

Expose E2B execution as MCP tool that Claude Code can invoke:

```typescript
// Claude Code calls MCP tool
execute_in_sandbox({ prompt: "task", timeout: 3600 })
```

**Pros**: Native Claude Code integration, fits existing patterns
**Cons**: Complex MCP setup, requires Claude Code v0.3 features, harder to monitor/control

## Open Questions

1. **Repository size limits**: E2B has file upload limits; need to test with large repos (>100MB)
2. **Git credentials**: How to handle private repo dependencies inside sandbox? Options:
    * Upload SSH keys (security risk)
    * Use GitHub PAT via env var (better)
    * Skip private deps (simplest)
3. **Parallel E2B sessions**: Should we limit concurrent E2B sessions per user (cost control)?
4. **Result persistence**: Should sandbox outputs be archived long-term for audit/replay?
5. **Integration with roadmap**: How does this relate to v0.3 MCP server? Could MCP expose E2B execution?

## Dependencies

* E2B API key (sign up at e2b.dev)
* E2B SDK: `npm install e2b` (v1.x)
* Anthropic API key (for Claude Code in sandbox)
* Sufficient E2B credit balance

## Success Metrics

* Can execute 30+ minute autonomous Claude Code tasks without intervention
* File sync works for repos up to 500MB
* Output streaming provides real-time visibility
* Cost per sandbox session is predictable and reasonable (<$5 for 1-hour task)
* Local worktree changes integrate cleanly after sandbox execution

## Risks & Mitigations

* **Risk**: E2B costs spiral for long-running tasks
    * **Mitigation**: Enforce timeout limits, add cost warnings, provide cost estimates
* **Risk**: File sync fails for large repos or complex git states
    * **Mitigation**: Add `--dry-run` mode, extensive testing, clear error messages
* **Risk**: Sandbox Claude Code produces incorrect/destructive changes
    * **Mitigation**: Always execute in worktree (not main), require user review before merge
* **Risk**: E2B API downtime blocks critical workflows
    * **Mitigation**: Keep local execution as default, E2B is opt-in only

## Critical Validation Questions

Before implementation, we must validate these unknowns with quick experiments:

### 1. E2B Sandbox File Upload Limits & Performance

**Question**: What's the realistic size limit for repo uploads? How long does it take?

**Test**: 

* Upload a 50MB, 200MB, and 500MB test directory to E2B sandbox
* Measure upload time and identify failures
* Test with many small files (10k+ files) vs few large files

**Blocker if**: Upload takes >5 minutes for typical monorepo or fails above 100MB

### 2. Claude Code Version in anthropic-claude-code Template

**Question**: Does the E2B template have the latest Claude Code with all features we need?

**Test**:

* Spin up `anthropic-claude-code` sandbox
* Run `claude update` to ensure latest version (always do this before execution)
* Run `claude --version` to verify
* Test `--dangerously-skip-permissions` and `--output-format stream-json` flags
* Verify it can read committed files (PLAN.md) and execute multi-step plans

**Implementation Note**: Sandbox execution flow must ALWAYS run `claude update` after creation and before task execution to ensure latest features.

**Blocker if**: Template is broken or `claude update` fails

### 3. Git Operations Inside Sandbox

**Question**: How do we handle git operations since Claude runs autonomously without git access?

**Implementation Decision**: 

* Claude Code in sandbox has NO git access (no commits during execution)
* Sandbox filesystem starts clean with uploaded worktree files
* After execution completes, WE (parallel-cc) handle all git operations:
    * Identify changed files via filesystem comparison or simple diff
    * Create git commits locally in the worktree with appropriate messages
    * Example: `git commit -m "[E2B Auto] Implemented auth refactor from PLAN.md"`

**Test**:

* Verify we can reliably identify changed/new/deleted files after sandbox execution
* Test applying those changes to local worktree git repo
* Confirm commit metadata is correct (author, timestamp, message)

**Blocker if**: Cannot reliably detect file changes or apply them to git worktree

### 4. Streaming Output & Real-Time Monitoring

**Question**: Can we get real-time output from Claude Code running in sandbox?

**Test**:

* Run long-running command via `sandbox.commands.run()` with `on_stdout` callback
* Verify we receive incremental output (not just final result)
* Test behavior when output exceeds buffer limits
* Measure latency between sandbox action and local output

**Nice to Have**: Real-time streaming is ideal for UX but not a blocker

**Acceptable Fallback**: Batch output at intervals (every 30s) or completion-only output is workable for MVP

**Blocker if**: We get ZERO output visibility until completion (user has no idea if sandbox is working)

### 5. Sandbox Cost & Runtime Limits

**Question**: What does a 1-hour sandbox session actually cost? Are there hidden limits?

**Known Constraint**: E2B free tier limit is 1 hour max session time

**Test**:

* Run a 30-minute task in sandbox and check E2B billing
* Verify we can run for full 60 minutes without forced termination
* Test what happens when timeout is reached (graceful vs hard kill)
* Check if there are per-file or bandwidth charges on top of runtime

**Implementation Note**: Default timeout should be 3600s (1 hour) with warnings at 30min and 50min marks

**Blocker if**: Cost exceeds $10/hour or hidden limits cause failures before 1 hour

### 6. File Download Performance & Selective Sync

**Question**: Can we efficiently download only changed files? How fast?

**Test**:

* Upload 500 files, have sandbox modify 10 files
* Use `git diff --name-only` to identify changes
* Download only those 10 files via `sandbox.files.read()`
* Measure time and validate file contents match

**Blocker if**: Selective download fails or takes >1 minute for small changeset

### 7. Plan File Reading & Autonomous Execution

**Question**: Can Claude Code in sandbox read a committed PLAN.md and execute it autonomously?

**Test**:

* Upload repo with PLAN.md containing multi-phase task
* Run: `echo "Execute PLAN.md" | claude -p --dangerously-skip-permissions`
* Verify Claude actually reads the plan and follows it step-by-step
* Check if Claude can run tests, commit progress, and complete autonomously

**Blocker if**: Claude ignores plan or requires manual intervention

### 8. Error Handling & Sandbox Recovery

**Question**: What happens when Claude Code crashes or sandbox fails mid-task?

**Test**:

* Trigger various failures (syntax errors, OOM, network issues)
* Verify we can detect failure state from outside
* Test if we can reconnect to sandbox or recover partial work
* Check what state the sandbox is in after crash

**Blocker if**: We can't detect failures or lose all work on crash

## Validation Priority

**Must validate before starting implementation**:

1. #2 (Claude Code version) - if template is outdated, whole approach may need rethinking
2. #7 (Plan execution) - core use case; if this doesn't work, no point in building
3. #4 (Streaming output) - essential for usability; batch-only output is unacceptable

**Should validate during Phase 1**:

4. #1 (Upload limits) - determines what repo sizes we support
5. #3 (Git operations) - affects download strategy
6. #6 (Download performance) - optimization detail, not blocker

**Can validate during development**:

7. #5 (Costs) - important but not a technical blocker
8. #8 (Error handling) - part of normal development process

## Next Steps for Approval

1. **Run validation experiments** for critical questions #2, #7, #4 (2-3 hours)
2. Build quick prototype demonstrating end-to-end flow with small test repo
3. Review prototype results and confirm approach is viable
4. Estimate implementation timeline based on prototype learnings
5. Get user sign-off on refined CLI interface and workflow
