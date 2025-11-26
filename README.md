# parallel-cc

Coordinate parallel Claude Code sessions using git worktrees.

## The Problem

When you open multiple Claude Code sessions in the same repository, they can step on each other:
- Git index locks when both try to commit
- Build artifacts conflict
- Dependencies get corrupted
- General chaos ensues

## The Solution

`parallel-cc` automatically detects when you're starting a parallel session and creates an isolated git worktree for you. Each Claude Code instance works in its own space, then changes merge cleanly.

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                    Session Startup Flow                      │
├─────────────────────────────────────────────────────────────┤
│  1. You run: claude-parallel (or aliased 'claude')           │
│  2. Wrapper checks for existing sessions in this repo        │
│  3. If parallel session exists → creates worktree via gtr    │
│  4. Wrapper cd's into worktree, then launches claude         │
│  5. Claude Code works in isolated worktree                   │
│  6. On exit → session released, worktree cleaned up          │
└─────────────────────────────────────────────────────────────┘
```

## Requirements

- Node.js 20+
- [gtr (git-worktree-runner)](https://github.com/coderabbitai/git-worktree-runner)
- `jq` (for JSON parsing in wrapper script)

## Installation

```bash
# Clone and install
git clone https://github.com/yourusername/parallel-cc
cd parallel-cc
./scripts/install.sh
```

The install script will:
1. Build the TypeScript project
2. Create symlinks in `~/.local/bin`
3. Install the `claude-parallel` wrapper script
4. Create the database directory

### Recommended: Create an alias

Add to your `~/.bashrc` or `~/.zshrc`:

```bash
alias claude='claude-parallel'
```

Now every time you run `claude`, it automatically handles parallel coordination!

### Optional: Add heartbeat hook

For better stale session detection, add to `~/.claude/settings.json`:

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

## Usage

Just open multiple terminals and run `claude` (or `claude-parallel`) in each:

```bash
# Terminal 1
cd ~/projects/myrepo
claude  # Gets the main repo

# Terminal 2
cd ~/projects/myrepo
claude  # Automatically gets a worktree!
# Output: 📂 Parallel session detected - working in worktree
#         Path: /home/user/projects/myrepo-worktrees/parallel-m4x2k9...
```

That's it! Each session is isolated. When you're done, just exit claude normally - the worktree is cleaned up automatically.

## CLI Commands

```bash
# Check system health
parallel-cc doctor

# Show active sessions
parallel-cc status
parallel-cc status --repo /path/to/repo
parallel-cc status --json

# Manual registration (usually done by wrapper)
parallel-cc register --repo /path/to/repo --pid $$

# Manual release (usually done by wrapper)
parallel-cc release --pid $$

# Clean up stale sessions
parallel-cc cleanup
```

## How Sessions Work

1. **First session** in a repo gets the main repository
2. **Subsequent sessions** automatically get a new worktree
3. **Heartbeats** track active sessions (optional PostToolUse hook)
4. **Stale detection** cleans up crashed sessions after 10 minutes
5. **Auto-cleanup** removes worktrees when sessions end

## Configuration

Default config (in `src/types.ts`):

```typescript
{
  dbPath: '~/.parallel-cc/coordinator.db',
  staleThresholdMinutes: 10,
  autoCleanupWorktrees: true,
  worktreePrefix: 'parallel-'
}
```

## Merging Work from Worktrees

After working in a worktree, you'll want to merge your changes:

```bash
# In the worktree, commit your changes
git add .
git commit -m "feat: my feature"

# Option 1: Push and create PR
git push -u origin $(git branch --show-current)
# Then create PR on GitHub/GitLab

# Option 2: Merge directly to main
cd ~/projects/myrepo  # Go to main repo
git merge <worktree-branch-name>
```

## Roadmap

- [x] v0.1 - Project structure
- [x] v0.2 - CLI + SQLite + wrapper script
- [ ] v0.3 - MCP server for status queries
- [ ] v0.4 - Branch merge detection + notifications
- [ ] v0.5 - File-level conflict detection

## Troubleshooting

### "parallel-cc not found"

Make sure `~/.local/bin` is in your PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### "gtr not found"

Install gtr from https://github.com/coderabbitai/git-worktree-runner

### Sessions not cleaning up

Run manual cleanup:

```bash
parallel-cc cleanup
```

### Check system health

```bash
parallel-cc doctor
```

## License

MIT
