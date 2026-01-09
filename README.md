# parallel-cc

[![Follow on X](https://img.shields.io/twitter/follow/FrankBria18044?style=social)](https://x.com/FrankBria18044)
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
- [E2B Sandbox Integration](#-e2b-sandbox-integration)
- [What's New](#-whats-new)
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
- 🌿 **Branch management** - Auto-generate branches, custom naming, or uncommitted changes
- 🚀 **Git Live mode** - Push directly to remote and create PRs automatically
- 🔑 **Dual authentication** - Support for both API key and OAuth methods

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
# Clone and install (interactive)
git clone https://github.com/frankbria/parallel-cc.git
cd parallel-cc
./scripts/install.sh

# Or non-interactive installation with all features
./scripts/install.sh --all
```

The install script will:
1. ✅ Check all dependencies (Node.js 20+, git, jq, gtr)
2. ✅ Build the TypeScript project
3. ✅ Install CLI and wrapper scripts to `~/.local/bin`
4. ✅ Create the database directory
5. ✅ Verify installation with `parallel-cc doctor`
6. ✅ **Prompt to install heartbeat hooks** (global or local) - or install automatically with `--all`
7. ✅ Provide shell-specific setup instructions

**Non-interactive installation:**
Use `./scripts/install.sh --all` to install everything automatically:
- Installs heartbeat hooks globally (`~/.claude/settings.json`)
- Configures shell alias (`claude=claude-parallel`)
- Sets up MCP server integration
- No prompts, ideal for automation/CI/CD

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

# Git Live mode - Push and create PR automatically
parallel-cc sandbox-run --repo . --prompt "Fix bug" --git-live
parallel-cc sandbox-run --repo . --prompt "Add feature" --git-live --target-branch develop
parallel-cc sandbox-run --repo . --prompt "Fix #42" --git-live --branch feature/issue-42

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

### Branch Management Modes

**1. Uncommitted Changes (Default)**
```bash
parallel-cc sandbox-run --repo . --prompt "Fix issue #84"
# Results downloaded as uncommitted tracked files
# Full control: review with git status/diff, then commit manually
```

**Benefits:**
- ✅ Full control over commit message and branch name
- ✅ Review changes before committing
- ✅ Stage changes selectively

**2. Auto-Generated Branch**
```bash
parallel-cc sandbox-run --repo . --prompt "Fix issue #84" --branch auto
# Creates: e2b/fix-issue-84-2025-12-13-23-45
# Auto-commits with descriptive message
```

**Benefits:**
- ✅ One-step branch creation and commit
- ✅ Descriptive branch name from prompt
- ✅ Ready to push immediately

**3. Custom Branch Name**
```bash
parallel-cc sandbox-run --repo . --prompt "Fix issue #84" --branch feature/issue-84
# Creates specified branch and commits
```

**Benefits:**
- ✅ Control over branch naming convention
- ✅ Matches team's branch patterns
- ✅ One-step creation and commit

### Git Live Mode (NEW!)

**What is Git Live Mode?**

Git Live Mode (`--git-live`) pushes results directly to a remote feature branch and creates a pull request automatically, bypassing the local download workflow. Perfect for autonomous "walk away" tasks.

**Quick Example:**
```bash
# Basic git-live: Push and create PR automatically
parallel-cc sandbox-run --repo . --prompt "Fix bug" --git-live

# With custom target branch (default: main)
parallel-cc sandbox-run --repo . --prompt "Add feature" --git-live --target-branch develop

# Full example with all options
parallel-cc sandbox-run \
  --repo . \
  --prompt "Implement auth system" \
  --auth-method oauth \
  --git-live \
  --target-branch main \
  --branch feature/auth-system
```

**What Happens:**
1. Execution completes in E2B sandbox
2. Changes committed in sandbox with descriptive message
3. Feature branch pushed to remote (auto-generated or custom name)
4. Pull request created using `gh` CLI
5. PR URL returned immediately

**Requirements:**
- `GITHUB_TOKEN` environment variable must be set
- Token needs repo access (push, PR creation)
- Get token at: https://github.com/settings/tokens

**Parallel Session Warning:**

When `--git-live` is used with multiple parallel sessions active, you'll see a warning prompt. You can choose to:
- **Continue** (`y`): Proceed with git-live, accepting potential PR conflicts
- **Switch** (`n`): Automatically fall back to download mode

**When to Use Git Live:**
- ✅ Single autonomous task with clear scope
- ✅ No other parallel sessions active
- ✅ Want immediate PR for review
- ✅ Trust the execution quality
- ✅ "Walk away and review later" workflow

**When to Use Download Mode (Default):**
- ✅ Multiple parallel sessions
- ✅ Want to review changes before committing
- ✅ Need to stage changes selectively
- ✅ Interactive development workflow

### Authentication Methods

**1. API Key Authentication (Default)**
```bash
export ANTHROPIC_API_KEY="sk-ant-api03-..."
parallel-cc sandbox-run --repo . --prompt "Task" --auth-method api-key
```

**2. OAuth Authentication**
```bash
# First, login within Claude Code session
claude
/login  # Follow prompts

# Then use OAuth mode
parallel-cc sandbox-run --repo . --prompt "Task" --auth-method oauth
```

### Usage Examples

```bash
# Basic execution with TDD approach
parallel-cc sandbox-run --repo . --prompt "Implement feature X with tests"

# Execute from plan file
parallel-cc sandbox-run --repo . --prompt-file PLAN.md

# Full example with OAuth and auto branch
parallel-cc sandbox-run \
  --repo . \
  --prompt "Implement auth system" \
  --auth-method oauth \
  --branch auto

# Git Live mode with custom branch
parallel-cc sandbox-run \
  --repo . \
  --prompt "Fix issue #123" \
  --git-live \
  --branch feature/issue-123 \
  --target-branch develop
```

### Setup Requirements

1. **E2B Account**: Sign up at https://e2b.dev (free tier available)
2. **E2B API Key**: Set `E2B_API_KEY` environment variable
3. **Claude Authentication** (choose one):
   - **API Key**: Set `ANTHROPIC_API_KEY` (pay-as-you-go)
   - **OAuth**: Run `/login` in Claude Code (uses your Pro subscription)
4. **GitHub Token** (for git-live mode): Set `GITHUB_TOKEN` environment variable
5. **Cost Awareness**: E2B charges ~$0.10/hour for sandbox compute time

See [docs/E2B_GUIDE.md](./docs/E2B_GUIDE.md) for complete setup instructions and troubleshooting.

## 🎉 What's New

### v1.0.0 - Git Live Mode & Enhanced Branch Management (December 2024)

**New Features:**
- 🚀 **Git Live Mode** - Autonomous PR creation directly from E2B sandboxes
  - Push results to remote branches automatically
  - Create pull requests with `gh` CLI integration
  - Parallel session detection and warnings
  - Configurable target branches

- 🌿 **Enhanced Branch Management**
  - `--branch auto` - Auto-generate descriptive branch names from prompts
  - `--branch <name>` - Custom branch naming
  - Default mode: Uncommitted changes for full control
  - Smart branch name slugification (max 50 chars, kebab-case)

- 🔧 **Installation Improvements**
  - `./scripts/install.sh --all` - Non-interactive installation
  - Automatic setup of hooks, alias, and MCP server
  - Ideal for automation and CI/CD pipelines

**Security Enhancements:**
- Shell injection prevention in git commit messages
- Branch name validation and sanitization
- Target branch validation
- Input validation for all E2B commands

**Bug Fixes:**
- Fixed GITHUB_TOKEN passing to gh CLI in sandboxes
- Improved error handling in OAuth authentication
- Better file sync reliability for E2B downloads
- Migration system improvements with automatic updates

### v1.0.0 - E2B Sandbox Integration (December 2024)

**Major Features:**
- ☁️ E2B cloud sandbox execution for autonomous development
- 🔑 Dual authentication support (API key and OAuth)
- 📦 Intelligent file sync with compression
- 💰 Cost tracking and warnings
- 🔒 Enhanced security with shell injection prevention

See [ROADMAP.md](./ROADMAP.md) for detailed version history and future plans.

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
- ✅ Git Live mode for autonomous PR creation
- ✅ Enhanced branch management with auto-generation

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

### E2B Sandbox Issues

**"E2B API key not found"**
```bash
export E2B_API_KEY="your-key-here"
```

**"Claude authentication failed"**
- For API key mode: Set `ANTHROPIC_API_KEY`
- For OAuth mode: Run `/login` in Claude Code first

**"Git Live mode - GITHUB_TOKEN required"**
```bash
export GITHUB_TOKEN="ghp_..."  # Get from https://github.com/settings/tokens
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

## 📄 License

MIT © [Frank Bria](https://github.com/frankbria)

---

**Built with ❤️ using TypeScript, SQLite, and git worktrees**
