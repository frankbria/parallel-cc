# parallel-cc Roadmap & Future Specs

## Version History

- **v0.1** - Project structure, types, schema design ✅
- **v0.2** - CLI + SQLite + wrapper script ✅ (current)

---

## v0.3 - MCP Server for Status Queries

### Overview
Add an MCP server so Claude Code can query the coordinator mid-session to understand what other sessions are doing.

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

## Installation Improvements

### v0.2.1 - Local Repo Hook Installation

Add `--install-hooks` flag to configure hooks for the current repo:

```bash
# Install hooks to current repo's .claude/settings.json
parallel-cc install --hooks

# Creates/updates .claude/settings.json in current repo
```

**Behavior:**
1. Check if `.claude/settings.json` exists
2. If exists, merge hooks (preserve existing config)
3. If not, create with just the parallel-cc hooks
4. Add `.claude/` to `.gitignore` if not already there (optional, prompt user)

**Config added:**
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

### v0.2.2 - Interactive Heartbeat Hook Setup (PRIORITY)

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

**Hook Configuration Added:**
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

**Alternative:** Also support `--hooks` flag for non-interactive mode:
```bash
parallel-cc install --hooks          # Prompts for global/local
parallel-cc install --hooks --global # Adds to ~/.claude/settings.json
parallel-cc install --hooks --local  # Adds to ./.claude/settings.json
```

### v0.2.3 - Interactive Alias Setup (PRIORITY)

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

**Alternative:** Also support `--alias` flag for non-interactive mode:
```bash
parallel-cc install --alias  # Adds alias without prompting
```

### v0.2.4 - Full Installation Command

Combine all installation options:

```bash
# Full installation with all options
parallel-cc install --all

# Equivalent to:
parallel-cc install --hooks --global --alias

# Interactive mode (prompts for each option)
parallel-cc install --interactive
```

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
