# parallel-cc

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/frankbria/parallel-cc)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> Coordinate parallel Claude Code sessions using git worktrees + E2B cloud sandboxes for autonomous execution.

**parallel-cc** enables both interactive and autonomous Claude Code workflows:
- **Local mode**: Parallel worktree coordination for interactive development
- **E2B Sandbox mode**: Long-running autonomous execution in isolated cloud VMs

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

### Local Parallel Sessions
- 🔄 **Automatic worktree creation** - No manual setup required
- 🗄️ **SQLite-based coordination** - Fast, reliable session tracking
- 🧹 **Auto-cleanup** - Worktrees removed when sessions end
- 💓 **Heartbeat monitoring** - Detect and clean up stale sessions
- 🎯 **Zero configuration** - Works out of the box
- 🔀 **Merge detection** - Know when parallel branches are merged
- ⚠️ **Conflict checking** - Preview rebase conflicts before they happen
- 🤖 **MCP integration** - Claude can query session status and assist with rebases
- 🔒 **File claims** - Coordinate exclusive/shared file access across parallel sessions
- 🧠 **Conflict resolution** - Track and resolve semantic, structural, and concurrent edit conflicts
- ⚡ **Auto-fix suggestions** - AI-generated conflict resolutions with confidence scores
- 🔍 **AST analysis** - Deep semantic conflict detection using abstract syntax trees

### E2B Sandbox Execution
- ☁️ **Cloud sandboxes** - Execute Claude Code in isolated E2B VMs
- ⏱️ **Long-running tasks** - Up to 1 hour of uninterrupted execution
- 🔐 **Security hardened** - Shell injection prevention, input validation, resource cleanup
- 📦 **Intelligent file sync** - Compressed upload/download with selective sync
- 🔄 **Cross-process reconnection** - Access sandboxes created in separate CLI invocations
- 🎮 **Full CLI control** - Run, monitor, download, and kill sandbox sessions
- 💰 **Cost tracking** - Automatic warnings at 30min and 50min usage marks

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
6. ✅ **Prompt to install heartbeat hooks** (global or local)
7. ✅ Provide shell-specific setup instructions

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

The uninstall script offers to remove configurations (hooks, alias, MCP) before removing installed files. Session data is preserved unless manually deleted.

### Recommended: Create an alias

Add to your `~/.bashrc` or `~/.zshrc`:

```bash
alias claude='claude-parallel'
```

Now every time you run `claude`, it automatically handles parallel coordination!

### Optional: Complete Setup with One Command

For the best experience, run the full installation which sets up both the heartbeat hook and shell alias:

```bash
# Full installation (recommended)
parallel-cc install --all

# Or step-by-step:
parallel-cc install --hooks --global  # Heartbeat hook
parallel-cc install --alias           # Shell alias

# Interactive mode - prompts for each option
parallel-cc install --interactive

# Check installation status
parallel-cc install --status
```

Or add manually to `~/.claude/settings.json`:

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

### System & Installation
```bash
# Check system health
parallel-cc doctor

# Installation & configuration
parallel-cc install --all                # Install everything (hooks + alias + MCP)
parallel-cc install --interactive        # Prompted installation
parallel-cc install --hooks              # Interactive hook installation
parallel-cc install --hooks --global     # Install hooks globally
parallel-cc install --hooks --local      # Install hooks locally
parallel-cc install --alias              # Add claude=claude-parallel alias
parallel-cc install --alias --uninstall  # Remove alias
parallel-cc install --mcp                # Configure MCP server in Claude settings
parallel-cc install --status             # Check installation status

# Database management
parallel-cc migrate                      # Migrate to latest version (1.0.0)
parallel-cc migrate --version 1.0.0      # Migrate to specific version
```

### Session Management
```bash
# Show active sessions
parallel-cc status
parallel-cc status --repo /path/to/repo
parallel-cc status --json
parallel-cc status --sandbox-only        # Show only E2B sandbox sessions

# Session lifecycle (usually handled by wrapper)
parallel-cc register --repo /path/to/repo --pid $$
parallel-cc release --pid $$
parallel-cc cleanup                      # Clean up stale sessions
```

### Merge & Conflict Management
```bash
# Merge detection
parallel-cc watch-merges                 # Start merge detection daemon
parallel-cc watch-merges --once          # Run single merge detection poll
parallel-cc merge-status                 # Show merge events history
parallel-cc merge-status --subscriptions # Show active merge subscriptions

# File claims & conflict resolution
parallel-cc claims                       # List active file claims
parallel-cc claims --file src/app.ts     # Filter by file path
parallel-cc conflicts                    # View conflict resolution history
parallel-cc conflicts --type SEMANTIC    # Filter by conflict type
parallel-cc suggestions                  # List auto-fix suggestions
parallel-cc suggestions --min-confidence 0.8  # Filter by confidence threshold
```

### E2B Sandbox Execution
```bash
# Run Claude Code in cloud sandbox
parallel-cc sandbox-run --repo . --prompt "Implement feature X"
parallel-cc sandbox-run --repo . --prompt-file PLAN.md

# Authentication options
parallel-cc sandbox-run --repo . --prompt "Fix bug" --auth-method api-key  # Use ANTHROPIC_API_KEY
parallel-cc sandbox-run --repo . --prompt "Fix bug" --auth-method oauth    # Use Claude subscription

# Branch management
parallel-cc sandbox-run --repo . --prompt "Add feature" --branch auto               # Auto-generate branch + commit
parallel-cc sandbox-run --repo . --prompt "Fix issue #42" --branch feature/issue-42 # Specify branch name
parallel-cc sandbox-run --repo . --prompt "Refactor"                                # Default: uncommitted changes

# Monitoring & control
parallel-cc sandbox-logs --session-id <id>       # View sandbox logs
parallel-cc sandbox-logs --session-id <id> --follow  # Stream logs in real-time
parallel-cc sandbox-download --session-id <id>   # Download results without terminating
parallel-cc sandbox-kill --session-id <id>       # Terminate running sandbox

# Testing
parallel-cc sandbox-run --dry-run --repo .       # Test setup without execution
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

## 🚀 E2B Sandbox Integration

Run autonomous Claude Code sessions in isolated cloud sandboxes for truly hands-free development.

### Quick Start

```bash
# Prerequisites: E2B account and API key
export E2B_API_KEY="your-key-here"

# One-time setup: Migrate database to v1.0.0 for E2B features
parallel-cc migrate --version 1.0.0

# Step 1: Plan interactively (local)
cd ~/projects/myrepo
claude  # Create PLAN.md with implementation steps
git commit PLAN.md -m "plan: feature implementation"

# Step 2: Execute autonomously (E2B sandbox)
parallel-cc sandbox-run --repo . --prompt "Execute PLAN.md with TDD approach"
# Walk away - Claude works unattended for 30+ minutes in isolated sandbox

# Step 3: Review results
cd parallel-e2b-abc123  # worktree with completed work
git diff main
pytest tests/  # verify locally
git push origin HEAD:feature/my-feature
```

### Why E2B Sandboxes?

- **Truly Autonomous**: Execute long-running tasks (up to 1 hour) without supervision
- **Safe Execution**: Sandboxes run with `--dangerously-skip-permissions` safely in isolated VMs
- **Plan-Driven**: Claude autonomously follows PLAN.md or custom prompts step-by-step
- **Real-Time Monitoring**: Stream output and check progress anytime
- **Cost-Effective**: ~$0.10/hour for E2B compute time
- **Git Integration**: Results automatically committed in worktrees for easy review

### Usage Examples

```bash
# Basic execution with TDD approach
parallel-cc sandbox-run --repo . --prompt "Implement feature X with tests"

# Execute from plan file
parallel-cc sandbox-run --repo . --prompt-file PLAN.md

# Full example with branch and OAuth auth
parallel-cc sandbox-run \
  --repo . \
  --prompt "Implement auth system" \
  --auth-method oauth \
  --branch auto
```

For complete E2B command reference, see the [CLI Commands](#-cli-commands) section above.

### Setup Requirements

1. **E2B Account**: Sign up at https://e2b.dev (free tier available)
2. **E2B API Key**: Set `E2B_API_KEY` environment variable
3. **Claude Authentication** (choose one):
   - **API Key**: Set `ANTHROPIC_API_KEY` (pay-as-you-go)
   - **OAuth**: Run `/login` in Claude Code (uses your Pro subscription)
4. **Cost Awareness**: E2B charges ~$0.10/hour for sandbox compute time

See [docs/E2B_GUIDE.md](./docs/E2B_GUIDE.md) for complete setup instructions and troubleshooting.

## 🗺️ Roadmap

### Current Version: v1.0 🚀

**Core Features:**
- ✅ Parallel worktree coordination with automatic session management
- ✅ SQLite-based session tracking with heartbeat monitoring
- ✅ MCP server integration with 16 tools for Claude Code
- ✅ Branch merge detection and rebase assistance
- ✅ Advanced conflict resolution with AST analysis
- ✅ AI-powered auto-fix suggestions with confidence scoring
- ✅ E2B sandbox integration for autonomous execution
- ✅ Plan-driven workflows with real-time monitoring
- ✅ Intelligent file sync and cost tracking

### What's Next

**v1.1 - Enhanced E2B Features** (Planned)
- [ ] Parallel sandbox execution (multiple tasks simultaneously)
- [ ] Pause/resume functionality for long-running tasks
- [ ] Private repository support with SSH key management
- [ ] Enhanced cost optimization and budget controls
- [ ] Sandbox templates for common workflows

See [ROADMAP.md](./ROADMAP.md) for detailed specifications, implementation plans, and complete version history.

## 🔍 Troubleshooting

### "parallel-cc not found"

Make sure `~/.local/bin` is in your PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### "gtr not found"

Install gtr from https://github.com/coderabbitai/git-worktree-runner

**Note:** `parallel-cc` supports both:
- gtr v1.x (standalone `gtr` command)
- gtr v2.x (`git gtr` subcommand)

The tool auto-detects which version you have installed.

### Sessions not cleaning up

Run manual cleanup:

```bash
parallel-cc cleanup
```

### Check system health

```bash
parallel-cc doctor
```

This checks dependencies (gtr, git, jq), database location, configuration, and MCP server status.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

## 📄 License

MIT © [Frank Bria](https://github.com/frankbria)

---

**Built with ❤️ using TypeScript, SQLite, and git worktrees**
