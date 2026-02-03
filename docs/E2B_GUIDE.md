# E2B Sandbox Integration - Complete Guide

This guide covers everything you need to know about using parallel-cc with E2B sandboxes for autonomous Claude Code execution.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Quick Start](#quick-start)
- [CLI Command Reference](#cli-command-reference)
- [Workflows](#workflows)
- [Cost Management](#cost-management)
- [Security Best Practices](#security-best-practices)
- [Troubleshooting](#troubleshooting)
- [Advanced Usage](#advanced-usage)

## Overview

E2B sandbox integration enables truly autonomous Claude Code execution in isolated cloud environments. This allows you to:

- **Plan** your implementation locally with full context
- **Execute** the plan autonomously in a sandboxed VM (up to 1 hour)
- **Review** the completed work in a git worktree before merging

### Key Benefits

- **Hands-Free Development**: Walk away while Claude implements complex features
- **Safe Experimentation**: Sandbox isolation protects your local environment
- **Long-Running Tasks**: Execute tasks that take 30+ minutes without supervision
- **Plan-Driven Workflows**: Claude autonomously follows implementation plans
- **Git Integration**: Results automatically saved in worktrees for easy review

### Architecture

```
┌────────────────────────────────────────────────────────┐
│                 E2B Execution Flow                      │
├────────────────────────────────────────────────────────┤
│                                                         │
│  Local Machine                                          │
│  ─────────────                                          │
│  1. parallel-cc sandbox run --prompt "..."             │
│  2. Create worktree via gtr                            │
│  3. Register E2B session in SQLite                     │
│                                                         │
│  E2B Cloud Sandbox                                      │
│  ─────────────────                                      │
│  4. Spin up isolated VM (anthropic-claude-code)        │
│  5. Run 'claude update' (ensure latest version)        │
│  6. Upload worktree files (compressed tarball)         │
│  7. Execute: echo "$PROMPT" | claude -p \              │
│     --dangerously-skip-permissions                     │
│  8. Stream output to local machine                     │
│                                                         │
│  Back to Local Machine                                 │
│  ─────────────────────                                 │
│  9. Download changed files only (selective sync)       │
│  10. Create git commit in worktree                     │
│  11. Terminate sandbox (cleanup)                       │
│                                                         │
│  Review & Merge                                        │
│  ──────────────                                        │
│  12. cd parallel-e2b-abc123                            │
│  13. git diff main  # review changes                   │
│  14. Run tests locally                                 │
│  15. git push origin HEAD:feature/my-feature           │
│                                                         │
└────────────────────────────────────────────────────────┘
```

## Prerequisites

### 1. E2B Account

Sign up at [https://e2b.dev](https://e2b.dev)

**Free Tier:**
- $10 credit for new accounts
- Enough for ~100 hours of sandbox usage
- No credit card required to start

**Paid Plans:**
- Pay-as-you-go: $0.10/hour per sandbox
- Team plans available with volume discounts

### 2. API Keys

**E2B API Key:**
```bash
# Get from https://e2b.dev/dashboard
export E2B_API_KEY="e2b_your_api_key_here"
```

**Anthropic API Key:**
```bash
# Claude Code in sandbox uses your existing key
export ANTHROPIC_API_KEY="sk-ant-your_anthropic_key"
```

**Add to Shell Profile:**
```bash
# ~/.bashrc or ~/.zshrc
export E2B_API_KEY="e2b_your_api_key_here"
export ANTHROPIC_API_KEY="sk-ant-your_anthropic_key"
```

### 3. parallel-cc Installation

Ensure you have parallel-cc v1.0+ installed:

```bash
parallel-cc doctor
# Should show: E2B SDK: ✓ Installed (v1.13.2+)
```

If not installed:
```bash
cd ~/projects/parallel-cc
npm install
npm run build
./scripts/install.sh
```

## Setup

### Step 1: Verify Installation

```bash
# Check dependencies
parallel-cc doctor

# Expected output:
# ✓ Node.js: v20.x.x
# ✓ gtr: v2.x.x
# ✓ jq: v1.x
# ✓ E2B SDK: v1.13.2
# ✓ Database: ~/.parallel-cc/coordinator.db
# ✓ E2B API Key: Set
# ✓ Anthropic API Key: Set
```

### Step 2: Test E2B Connection

```bash
# Dry run (no execution, just test upload/download)
cd ~/projects/test-repo
parallel-cc sandbox run --dry-run --repo . --prompt "Test connection"

# Expected output:
# ✓ Worktree created: parallel-e2b-test123
# ✓ Sandbox created: sb_abc123
# ✓ Files uploaded: 45 files (1.2 MB compressed)
# ✓ Sandbox terminated
# ✓ Worktree cleaned up
```

### Step 3: Run First Autonomous Task

```bash
# Simple task to verify everything works
parallel-cc sandbox run --repo . \
  --prompt "Create a simple hello.js file that logs 'Hello from E2B sandbox!'"

# Monitor progress
parallel-cc status --sandbox-only

# Check results
cd parallel-e2b-<session-id>
cat hello.js
git diff main
```

## Quick Start

### Basic Workflow

```bash
# 1. Plan locally
cd ~/projects/myrepo
claude
> "Help me plan implementing user authentication with tests"
> [Claude creates PLAN.md]
git commit PLAN.md -m "plan: user authentication implementation"

# 2. Execute autonomously
parallel-cc sandbox run --repo . \
  --prompt "Execute PLAN.md using TDD approach. Write tests first, then implement features."

# 3. Monitor (optional)
parallel-cc status --sandbox-only
parallel-cc sandbox logs --session-id <id>

# 4. Review results
cd parallel-e2b-<session-id>
git log --oneline
git diff main
npm test  # or pytest, etc.

# 5. Merge when satisfied
git push origin HEAD:feature/auth
# Create PR on GitHub
```

### Using Custom Plan Files

```bash
# Execute a specific plan file
parallel-cc sandbox run --repo . --prompt-file ./docs/IMPLEMENTATION.md

# APM Integration (if using Autonomous Project Manager)
parallel-cc sandbox run --repo . --prompt-file .apm/Implementation_Plan.md

# Multi-phase execution
parallel-cc sandbox run --repo . \
  --prompt-file .apm/Implementation_Plan.md \
  --focus-phase 2  # Execute only Phase 2
```

## CLI Command Reference

### `sandbox run` - Execute Autonomous Task

Start a new autonomous execution in an E2B sandbox.

```bash
parallel-cc sandbox run [options]

Options:
  --repo <path>              Repository path (default: current directory)
  --prompt <text>            Task prompt for Claude to execute
  --prompt-file <path>       Path to file containing task prompt (alternative to --prompt)
  --timeout <minutes>        Execution timeout in minutes (default: 60, max: 60)
  --working-dir <path>       Working directory in sandbox (default: /workspace)
  --dry-run                  Test upload/download without execution
  --no-stream                Disable real-time output streaming
  --local-log <path>         Save full execution log to local file
  --skip-claude-update       Skip running 'claude update' (see note below)

Examples:
  # Simple prompt
  parallel-cc sandbox run --repo . --prompt "Add unit tests for auth module"

  # Execute plan file
  parallel-cc sandbox run --repo . --prompt-file PLAN.md

  # Custom timeout (30 minutes)
  parallel-cc sandbox run --repo . --prompt "Quick refactor" --timeout 30

  # Dry run (test without execution)
  parallel-cc sandbox run --repo . --dry-run

  # Save full log locally
  parallel-cc sandbox run --repo . \
    --prompt-file PLAN.md \
    --local-log ./sandbox-execution.log
```

### `status` - View Active Sessions

Show all active sessions, including E2B sandboxes.

```bash
parallel-cc status [options]

Options:
  --repo <path>              Filter by repository path
  --sandbox-only             Show only E2B sandbox sessions
  --json                     Output in JSON format

Examples:
  # Show all sessions
  parallel-cc status

  # Show only sandbox sessions
  parallel-cc status --sandbox-only

  # JSON output
  parallel-cc status --sandbox-only --json
```

**Output Format:**
```
Active Sessions (Total: 3)

Repository: /home/user/projects/myrepo
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Session ID: e2b-abc123
  Mode:         E2B Sandbox
  Sandbox ID:   sb_xyz789
  Status:       RUNNING
  Started:      2025-12-09 14:30:00 (15 minutes ago)
  Prompt:       Execute PLAN.md with TDD approach
  Worktree:     parallel-e2b-abc123
  Progress:     Installing dependencies... (last update: 30s ago)

Session ID: local-def456
  Mode:         Local
  PID:          12345
  Worktree:     parallel-local-def456
  Started:      2025-12-09 14:00:00 (45 minutes ago)
```

### `sandbox logs` - View Execution Logs

Stream real-time logs from a running sandbox or view historical logs.

```bash
parallel-cc sandbox logs --session-id <id> [options]

Options:
  --session-id <id>          E2B session ID (required)
  --tail <n>                 Show only last N lines (default: all)
  --follow                   Stream logs in real-time (like tail -f)
  --save <path>              Save logs to file

Examples:
  # View all logs
  parallel-cc sandbox logs --session-id e2b-abc123

  # Stream real-time
  parallel-cc sandbox logs --session-id e2b-abc123 --follow

  # Last 100 lines
  parallel-cc sandbox logs --session-id e2b-abc123 --tail 100

  # Save to file
  parallel-cc sandbox logs --session-id e2b-abc123 --save ./execution.log
```

### `sandbox download` - Download Results

Download files from a running or completed sandbox without terminating it.

```bash
parallel-cc sandbox download --session-id <id> [options]

Options:
  --session-id <id>          E2B session ID (required)
  --output <path>            Local directory to save files (default: ./sandbox-results)
  --selective                Download only changed files (default: true)
  --all                      Download all files (ignore change detection)

Examples:
  # Download changed files
  parallel-cc sandbox download --session-id e2b-abc123

  # Custom output directory
  parallel-cc sandbox download --session-id e2b-abc123 --output ./my-results

  # Download everything
  parallel-cc sandbox download --session-id e2b-abc123 --all
```

### `sandbox kill` - Terminate Sandbox

Immediately terminate a running sandbox and download results.

```bash
parallel-cc sandbox kill --session-id <id> [options]

Options:
  --session-id <id>          E2B session ID (required)
  --keep-worktree            Don't remove worktree after termination
  --no-download              Skip downloading results

Examples:
  # Terminate and download
  parallel-cc sandbox kill --session-id e2b-abc123

  # Terminate but keep worktree for inspection
  parallel-cc sandbox kill --session-id e2b-abc123 --keep-worktree

  # Emergency kill (no download)
  parallel-cc sandbox kill --session-id e2b-abc123 --no-download
```

### `sandbox health` - Check Sandbox Health

Check if a sandbox is still responsive and get health metrics.

```bash
parallel-cc sandbox health --session-id <id>

Output:
  Status:        RUNNING
  Uptime:        25 minutes
  CPU Usage:     45%
  Memory:        512 MB / 2 GB
  Disk:          1.2 GB / 10 GB
  Last Activity: 15 seconds ago
  Cost So Far:   $0.042
```

## Workflows

### Workflow 1: Plan-Driven Development

**Use Case:** Implementing a complex feature with multiple phases

```bash
# Step 1: Create detailed plan locally
cd ~/projects/myapp
claude

> "Help me create a comprehensive implementation plan for adding OAuth2 authentication"
> [Claude creates detailed PLAN.md with phases]

# Review and refine the plan
cat PLAN.md
# Edit as needed
git add PLAN.md
git commit -m "plan: OAuth2 authentication implementation"

# Step 2: Execute autonomously
parallel-cc sandbox run --repo . \
  --prompt "Execute PLAN.md step by step using TDD approach. Write comprehensive tests for each phase before implementation."

# Step 3: Monitor progress (optional)
parallel-cc status --sandbox-only
parallel-cc sandbox logs --session-id <id> --follow

# Step 4: Review results
cd parallel-e2b-<session-id>
git log --oneline --graph
git diff main --stat
npm test  # Verify all tests pass locally

# Step 5: Create PR
git push origin HEAD:feature/oauth2-auth
gh pr create --title "Add OAuth2 Authentication" --body "Implements PLAN.md"
```

### Workflow 2: Test-Driven Development

**Use Case:** Implementing features with comprehensive test coverage

```bash
# Step 1: Define the feature requirements
parallel-cc sandbox run --repo . \
  --prompt "Implement user profile management with the following TDD workflow:

  Phase 1: Write integration tests for profile CRUD operations
  Phase 2: Implement minimal profile model to pass tests
  Phase 3: Write unit tests for validation logic
  Phase 4: Implement comprehensive validation
  Phase 5: Write API endpoint tests
  Phase 6: Implement RESTful API endpoints

  Follow strict TDD: write tests first, run tests (expect failures), implement features, verify tests pass."

# Step 2: Monitor test execution
parallel-cc sandbox logs --session-id <id> --follow | grep -E "(PASS|FAIL|✓|✗)"

# Step 3: Review test coverage
cd parallel-e2b-<session-id>
npm test -- --coverage
# Expect >85% coverage per TDD approach
```

### Workflow 3: Refactoring with Safety

**Use Case:** Large-scale refactoring with automated verification

```bash
# Step 1: Commit current state
git add .
git commit -m "pre-refactor: stable baseline"

# Step 2: Execute refactoring in sandbox
parallel-cc sandbox run --repo . \
  --prompt "Refactor the authentication module to use dependency injection:

  1. Run all tests to establish baseline
  2. Extract auth logic into AuthService class
  3. Run tests after each change
  4. Update all imports and dependencies
  5. Verify all tests still pass
  6. Run full test suite with coverage

  If any tests fail, revert the problematic change and document why in REFACTOR_NOTES.md"

# Step 3: Verify results
cd parallel-e2b-<session-id>
npm test  # All tests should pass
git diff main  # Review refactored code
cat REFACTOR_NOTES.md  # Check for any issues
```

### Workflow 4: Documentation Generation

**Use Case:** Generate comprehensive documentation

```bash
parallel-cc sandbox run --repo . \
  --prompt "Generate comprehensive documentation:

  1. Analyze all source files in src/
  2. Create API.md with all public interfaces
  3. Create ARCHITECTURE.md with system design
  4. Create CONTRIBUTING.md with development guidelines
  5. Update README.md with usage examples
  6. Generate JSDoc comments for all public functions

  Use clear, professional language following technical writing best practices."
```

### Workflow 5: Multi-Repository Coordination

**Use Case:** Working on multiple related repositories

```bash
# Terminal 1: Backend implementation
cd ~/projects/backend
parallel-cc sandbox run --repo . \
  --prompt-file API_CHANGES.md

# Terminal 2: Frontend implementation (after backend changes)
cd ~/projects/frontend
parallel-cc sandbox run --repo . \
  --prompt "Update frontend to use new API endpoints defined in ../backend/API_CHANGES.md"

# Both execute in parallel, isolated in separate sandboxes
parallel-cc status --sandbox-only
```

## Cost Management

### Understanding E2B Costs

**Pricing Model:**
- **Base Rate**: $0.10 per hour per sandbox
- **Billed**: Per-second granularity (minimum 1 minute)
- **Free Tier**: $10 credit for new accounts

**Example Costs:**
- 10-minute task: ~$0.017
- 30-minute task: ~$0.050
- 60-minute task: ~$0.100
- 100 tasks @ 30min each: ~$5.00

### Cost Optimization Tips

#### 1. Set Appropriate Timeouts

```bash
# For quick tasks (10-15 minutes expected)
parallel-cc sandbox run --repo . --timeout 20 --prompt "Quick bugfix"

# For complex tasks (45-60 minutes expected)
parallel-cc sandbox run --repo . --timeout 60 --prompt-file PLAN.md
```

#### 2. Use Dry Runs for Testing

```bash
# Test your workflow without execution costs
parallel-cc sandbox run --dry-run --repo .

# Verify:
# - File upload works correctly
# - Gitignore patterns are respected
# - Prompt is properly formatted
```

#### 3. Monitor Active Sandboxes

```bash
# Check for forgotten sandboxes
parallel-cc status --sandbox-only

# Kill idle sandboxes
parallel-cc sandbox kill --session-id <id>
```

#### 4. Download Partial Results

```bash
# For long-running tasks, download intermediate results
parallel-cc sandbox download --session-id <id> --output ./checkpoint-1

# Review progress, decide whether to continue or kill
parallel-cc sandbox logs --session-id <id> --tail 50
```

#### 5. Use Local Development First

**Best Practice:**
- Plan and design locally (free)
- Test small changes locally (free)
- Use E2B for complex, time-consuming implementations
- Use E2B for tasks requiring uninterrupted execution

### Cost Tracking

```bash
# View cost estimates for active sandboxes
parallel-cc status --sandbox-only

# Example output shows cost so far:
# Session: e2b-abc123
# Uptime: 25 minutes
# Cost So Far: $0.042

# View historical costs (requires E2B dashboard)
# Visit https://e2b.dev/dashboard/usage
```

### Budget Alerts

Set up budget alerts in your E2B dashboard:
1. Visit https://e2b.dev/dashboard/settings
2. Set monthly budget limit (e.g., $20/month)
3. Configure email alerts at 50%, 80%, 100% of budget

## Security Best Practices

### Credential Management

#### 1. Never Commit Secrets

**CRITICAL:** parallel-cc automatically scans for and excludes credential files before upload.

**Always Excluded:**
- `.env`, `.env.local`, `.env.*`
- `*.pem`, `*.key`, `*.p12`, `*.pfx`
- `credentials.json`, `service-account.json`
- SSH keys: `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`
- AWS credentials: `.aws/credentials`
- GPG keys: `.gnupg/**`

**Additional Exclusions:**
Create `.e2bignore` in your repo root:
```
# Custom secrets
config/production.yml
internal/tokens.json

# Sensitive data
customer-data/
ssh-keys/
```

#### 2. Use Environment Variables

**Local Machine:**
```bash
# Set in shell profile
export DATABASE_URL="postgresql://localhost/myapp"
export STRIPE_SECRET_KEY="sk_test_..."
```

**In Sandbox:**
```bash
# Pass via prompt (only for non-sensitive demo data)
parallel-cc sandbox run --repo . \
  --prompt "Run tests using test database: postgresql://localhost/test_db"

# For production: Use E2B environment variables (future feature)
```

#### 3. Review Code Before Execution

```bash
# Always review prompts and plan files
cat PLAN.md

# Ensure no secrets are embedded in prompts
grep -i "password\|secret\|key" PLAN.md
```

#### 4. Audit Uploaded Files

```bash
# Dry run shows exactly what will be uploaded
parallel-cc sandbox run --dry-run --repo .

# Expected output:
# Files to upload (45 files, 1.2 MB):
#   src/app.js
#   src/utils.js
#   package.json
#   ...
# Excluded by .gitignore (12 files):
#   node_modules/
#   .env
#   dist/
```

### Network Security

#### 1. Sandbox Isolation

E2B sandboxes are fully isolated:
- **No access** to your local machine
- **No access** to your local network
- **Outbound internet** allowed (for package installation)
- **No inbound connections** to sandbox

#### 2. API Key Security

```bash
# Store API keys securely
chmod 600 ~/.bashrc  # Ensure only you can read

# Rotate keys regularly
# Visit https://e2b.dev/dashboard/api-keys

# Revoke compromised keys immediately
```

#### 3. Public Repository Risks

**If using public repositories:**
- Never commit credentials (use .gitignore)
- Assume sandbox logs may be visible to E2B staff
- Review git history for accidentally committed secrets

```bash
# Check for secrets in git history
git log -p | grep -i "password\|secret\|key"

# Remove secrets from history (if found)
git filter-branch --tree-filter 'rm -f config/secrets.yml' HEAD
```

### Data Privacy

#### 1. Sensitive Data Handling

**DO NOT upload:**
- Customer PII (personal identifiable information)
- Production database dumps
- Financial records
- Healthcare data (HIPAA)
- Any regulated data (GDPR, CCPA, etc.)

**Safe to upload:**
- Source code (if repository is already shared)
- Test data (anonymized/synthetic)
- Documentation
- Build configurations

#### 2. Code Review

```bash
# Review all changes before merging
cd parallel-e2b-<session-id>
git diff main

# Check for unexpected additions
git diff main --name-only | xargs grep -i "password\|secret\|token"
```

### Incident Response

**If you accidentally uploaded credentials:**

1. **Immediate Actions:**
   ```bash
   # Kill the sandbox immediately
   parallel-cc sandbox kill --session-id <id> --no-download

   # Rotate compromised credentials NOW
   # - Change passwords
   # - Regenerate API keys
   # - Revoke tokens
   ```

2. **Review Impact:**
   ```bash
   # Check sandbox logs for any usage
   parallel-cc sandbox logs --session-id <id> --save incident.log

   # Review what was uploaded
   cd parallel-e2b-<session-id>
   git log --all --full-history -- "*.env"
   ```

3. **Prevent Future Incidents:**
   ```bash
   # Add to .gitignore
   echo "config/production.yml" >> .gitignore

   # Add to .e2bignore
   echo "internal/secrets/" >> .e2bignore

   # Commit prevention
   git add .gitignore .e2bignore
   git commit -m "security: prevent credential uploads"
   ```

## Troubleshooting

### Common Issues

#### Issue: "E2B_API_KEY not set"

**Symptoms:**
```
Error: E2B_API_KEY environment variable not set
```

**Solution:**
```bash
# Set API key
export E2B_API_KEY="e2b_your_key_here"

# Verify
echo $E2B_API_KEY

# Add to shell profile for persistence
echo 'export E2B_API_KEY="e2b_your_key_here"' >> ~/.bashrc
source ~/.bashrc
```

#### Issue: "Sandbox creation timeout"

**Symptoms:**
```
Error: Timeout waiting for sandbox to start (waited 120 seconds)
```

**Possible Causes:**
- E2B service temporarily unavailable
- Network connectivity issues
- API key invalid or expired

**Solutions:**
```bash
# 1. Check E2B service status
curl -I https://e2b.dev

# 2. Verify API key
parallel-cc doctor

# 3. Check network connectivity
ping e2b.dev

# 4. Retry with increased timeout (future feature)
# Currently: Wait a few minutes and try again
```

#### Issue: "File upload failed"

**Symptoms:**
```
Error: Failed to upload files to sandbox (repository too large)
```

**Possible Causes:**
- Repository exceeds 500 MB limit
- Too many files (>100,000)
- Network interruption during upload

**Solutions:**
```bash
# 1. Check repository size
du -sh .
du -sh . --exclude=node_modules --exclude=.git

# 2. Add exclusions to .gitignore
echo "large-assets/" >> .gitignore
echo "*.iso" >> .gitignore

# 3. Use .e2bignore for E2B-specific exclusions
cat > .e2bignore << EOF
docs/videos/
test-data/large-files/
*.zip
*.tar.gz
EOF

# 4. Try again
parallel-cc sandbox run --repo . --prompt "..."
```

#### Issue: "Sandbox terminated unexpectedly"

**Symptoms:**
```
Warning: Sandbox terminated unexpectedly (status: FAILED)
Check logs for details: parallel-cc sandbox logs --session-id <id>
```

**Solutions:**
```bash
# 1. Check logs for errors
parallel-cc sandbox logs --session-id <id> | tail -100

# 2. Common causes:
# - Out of memory (reduce concurrent processes in prompt)
# - Disk full (exclude large build artifacts)
# - Claude Code crash (report to Anthropic)

# 3. Review downloaded files
cd parallel-e2b-<session-id>
cat .claude-error.log  # If exists

# 4. Retry with simpler task
parallel-cc sandbox run --repo . \
  --prompt "Run tests only" \
  --timeout 10
```

#### Issue: "Authentication failed in sandbox"

**Symptoms:**
```
Error in sandbox: ANTHROPIC_API_KEY not set or invalid
```

**Solution:**
```bash
# 1. Verify local API key
echo $ANTHROPIC_API_KEY

# 2. Test with Anthropic directly
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":100,"messages":[{"role":"user","content":"test"}]}'

# 3. Re-export with correct key
export ANTHROPIC_API_KEY="sk-ant-your-key"

# 4. Retry sandbox execution
parallel-cc sandbox run --repo . --prompt "..."
```

#### Issue: "Claude update failed"

**Symptoms:**
```
[INFO] Running claude update...
[WARN] Claude update failed: exit code 1
```

**Causes and Solutions:**

The `claude update` command may return non-zero exit codes even in non-error conditions:

1. **Already up-to-date**: When Claude is already at the latest version, `claude update` may return exit code 1 with a message like "Already at latest version". As of v1.1, this is handled gracefully and treated as success.

2. **Authentication required**: The update command requires `ANTHROPIC_API_KEY` to be set. Without it, the command will fail.
   ```bash
   # Solution: Set API key before running
   export ANTHROPIC_API_KEY="sk-ant-your-key"
   ```

3. **Permission issues**: In some E2B templates, global npm operations may fail. The update function uses `--yes` flag and handles these scenarios.

**When to use `--skip-claude-update`:**
- If you're using a recent E2B template with Claude Code 1.0.67+ pre-installed
- If you're experiencing persistent update failures and want to proceed with the installed version
- For faster sandbox startup when update isn't critical

```bash
# Skip update if experiencing issues
parallel-cc sandbox run --repo . \
  --prompt "..." \
  --skip-claude-update

# The installed version in the E2B template is typically recent enough
```

**Note:** The update function now detects "already up-to-date" messages in the output and treats them as success, even if the exit code is non-zero.

#### Issue: "Timeout warnings not appearing"

**Symptoms:**
No warnings at 30-minute or 50-minute marks

**Expected Behavior:**
```
[30:00] ⚠️  Warning: 30 minutes elapsed (50% of timeout)
[50:00] ⚠️  Warning: 50 minutes elapsed (83% of timeout)
```

**Solution:**
```bash
# Check logs (warnings go to stdout)
parallel-cc sandbox logs --session-id <id> --follow

# Warnings are logged but may be missed if not actively monitoring
# Use --local-log to save all output
parallel-cc sandbox run --repo . \
  --prompt "..." \
  --local-log ./execution.log

# Review log file later
grep "Warning" ./execution.log
```

### Performance Issues

#### Slow Upload Times

**Symptoms:** Upload taking >5 minutes for small repositories

**Solutions:**
```bash
# 1. Check repository size
du -sh .

# 2. Exclude unnecessary files
echo "node_modules/" >> .gitignore
echo "*.log" >> .e2bignore

# 3. Use compression (already enabled by default)
# Verify in dry run output:
parallel-cc sandbox run --dry-run --repo .
# Should show: "Compressed: 1.2 MB (from 5.4 MB)"

# 4. Check network speed
speedtest-cli
```

#### Slow Download Times

**Symptoms:** Download taking >5 minutes after execution

**Solutions:**
```bash
# 1. Use selective download (default)
parallel-cc sandbox download --session-id <id> --selective

# 2. Only download specific files
cd parallel-e2b-<session-id>
parallel-cc sandbox download --session-id <id> \
  --filter "src/**/*.js,tests/**/*.js"

# 3. Skip large build artifacts
echo "dist/" >> .e2bignore
echo "build/" >> .e2bignore
```

### Debugging

#### Enable Verbose Logging

```bash
# Set log level to debug
export PARALLEL_CC_LOG_LEVEL=debug

# Run command with verbose output
parallel-cc sandbox run --repo . --prompt "..."

# Expected output includes:
# [DEBUG] Creating worktree: parallel-e2b-abc123
# [DEBUG] Registering E2B session in database
# [DEBUG] Connecting to E2B API
# [DEBUG] Sandbox created: sb_xyz789
# [DEBUG] Uploading files (45 files, 1.2 MB)
# [DEBUG] Upload progress: 25% (0.3 MB / 1.2 MB)
# ...
```

#### Inspect Sandbox State

```bash
# Get detailed sandbox information
parallel-cc sandbox health --session-id <id>

# Output includes:
# - Status (RUNNING/COMPLETED/FAILED)
# - Uptime
# - Resource usage (CPU, memory, disk)
# - Last activity timestamp
# - Error messages (if any)
```

#### Review SQLite Database

```bash
# Inspect session records
sqlite3 ~/.parallel-cc/coordinator.db \
  "SELECT * FROM sessions WHERE execution_mode = 'e2b' ORDER BY created_at DESC LIMIT 5;"

# View output logs
sqlite3 ~/.parallel-cc/coordinator.db \
  "SELECT output_log FROM sessions WHERE id = 'e2b-abc123';"
```

## Advanced Usage

### Custom Sandbox Configuration

```bash
# Future feature: Custom E2B sandbox configuration
parallel-cc sandbox run --repo . \
  --prompt "..." \
  --sandbox-config ./e2b-config.json

# e2b-config.json:
{
  "image": "anthropic-claude-code",
  "cpu": 2,
  "memory": 4096,
  "disk": 20480,
  "env": {
    "NODE_ENV": "development",
    "DEBUG": "app:*"
  }
}
```

### Checkpoint and Resume

```bash
# Future feature: Checkpoint long-running tasks
parallel-cc sandbox checkpoint --session-id <id>

# Resume from checkpoint
parallel-cc sandbox resume --checkpoint-id <checkpoint-id>
```

### Parallel Sandbox Execution

```bash
# Future feature: Run multiple sandboxes in parallel
parallel-cc sandbox run --repo ./backend --prompt "Backend tests" &
parallel-cc sandbox run --repo ./frontend --prompt "Frontend tests" &

# Monitor all
parallel-cc status --sandbox-only
```

### Private Repository Support

```bash
# Future feature: Inject GitHub PAT for private dependencies
parallel-cc sandbox run --repo . \
  --prompt "..." \
  --github-token "$GITHUB_PAT"

# Sandbox will have access to private repositories during npm install
```

### APM Integration

```bash
# Future feature: Deep integration with Autonomous Project Manager
parallel-cc sandbox run --repo . \
  --apm-plan .apm/Implementation_Plan.md \
  --apm-phase 2 \
  --apm-resume  # Resume from last completed phase
```

### Custom Post-Execution Hooks

```bash
# Future feature: Run commands after successful execution
parallel-cc sandbox run --repo . \
  --prompt "..." \
  --on-success "npm test && npm run build" \
  --on-failure "git reset --hard HEAD"
```

---

## Additional Resources

- **E2B Documentation**: https://e2b.dev/docs
- **parallel-cc ROADMAP**: ../ROADMAP.md
- **Architecture Guide**: ./ARCHITECTURE.md
- **Claude Code Documentation**: https://docs.anthropic.com/claude-code
- **Support**: https://github.com/frankbria/parallel-cc/issues

---

**Version:** 2.0.0
**Last Updated:** 2026-02-03
**Minimum parallel-cc Version:** v2.0.0

> **Note (v2.0):** CLI commands now use subcommand structure (e.g., `sandbox run` instead of `sandbox-run`). Old hyphenated commands still work but show deprecation warnings.
