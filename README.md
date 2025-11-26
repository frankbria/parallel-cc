# parallel-cc

[![Version](https://img.shields.io/badge/version-0.2.0-blue.svg)](https://github.com/frankbria/parallel-cc)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> Coordinate parallel Claude Code sessions using git worktrees.

**parallel-cc** eliminates the chaos of running multiple Claude Code instances in the same repository by automatically creating isolated git worktrees for each session.

## 📑 Table of Contents

- [Features](#-features)
- [The Problem](#the-problem)
- [The Solution](#the-solution)
- [How It Works](#how-it-works)
- [Requirements](#-requirements)
- [Installation](#-installation)
- [Usage](#-usage)
- [CLI Commands](#-cli-commands)
- [How Sessions Work](#-how-sessions-work)
- [Configuration](#️-configuration)
- [Merging Work from Worktrees](#-merging-work-from-worktrees)
- [Roadmap](#️-roadmap)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#-contributing)
- [License](#-license)

## ✨ Features

- 🔄 **Automatic worktree creation** - No manual setup required
- 🗄️ **SQLite-based coordination** - Fast, reliable session tracking
- 🧹 **Auto-cleanup** - Worktrees removed when sessions end
- 💓 **Heartbeat monitoring** - Detect and clean up stale sessions
- 🎯 **Zero configuration** - Works out of the box

## The Problem

When you open multiple Claude Code sessions in the same repository, they can step on each other:
- ❌ Git index locks when both try to commit
- ❌ Build artifacts conflict
- ❌ Dependencies get corrupted
- ❌ General chaos ensues

## The Solution

✅ `parallel-cc` automatically detects when you're starting a parallel session and creates an isolated git worktree for you. Each Claude Code instance works in its own space, then changes merge cleanly.

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

## 📋 Requirements

- **Node.js** 20+
- **[gtr](https://github.com/coderabbitai/git-worktree-runner)** - Git worktree management
- **jq** - JSON parsing in wrapper script

## 🚀 Installation

```bash
# Clone and install
git clone https://github.com/frankbria/parallel-cc.git
cd parallel-cc
./scripts/install.sh
```

The install script will:
1. ✅ Check all dependencies (Node.js 20+, git, jq, gtr)
2. ✅ Build the TypeScript project
3. ✅ Install CLI and wrapper scripts to `~/.local/bin`
4. ✅ Create the database directory
5. ✅ Verify installation with `parallel-cc doctor`
6. ✅ Provide shell-specific setup instructions

### Advanced Installation

**Custom installation directory:**
```bash
export PARALLEL_CC_INSTALL_DIR="$HOME/bin"
export PARALLEL_CC_DATA_DIR="$HOME/.config/parallel-cc"
./scripts/install.sh
```

**Uninstall:**
```bash
./scripts/uninstall.sh
```

The uninstall script safely removes all installed files while preserving your session data.

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

## 📖 Usage

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

## 🔧 CLI Commands

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

## 🔄 How Sessions Work

1. **First session** in a repo gets the main repository
2. **Subsequent sessions** automatically get a new worktree
3. **Heartbeats** track active sessions (optional PostToolUse hook)
4. **Stale detection** cleans up crashed sessions after 10 minutes
5. **Auto-cleanup** removes worktrees when sessions end

## ⚙️ Configuration

Default config (in `src/types.ts`):

```typescript
{
  dbPath: '~/.parallel-cc/coordinator.db',
  staleThresholdMinutes: 10,
  autoCleanupWorktrees: true,
  worktreePrefix: 'parallel-'
}
```

## 🔀 Merging Work from Worktrees

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

## 🗺️ Roadmap

- [x] **v0.1** - Project structure
- [x] **v0.2** - CLI + SQLite + wrapper script
- [ ] **v0.3** - MCP server for status queries
- [ ] **v0.4** - Branch merge detection + notifications
- [ ] **v0.5** - File-level conflict detection

## 🔍 Troubleshooting

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

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

## 📄 License

MIT © [Frank Bria](https://github.com/frankbria)

---

**Built with ❤️ using TypeScript, SQLite, and git worktrees**
