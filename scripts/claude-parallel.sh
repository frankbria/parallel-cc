#!/bin/bash
# claude-parallel - Wrapper that handles worktree coordination for parallel Claude Code sessions
#
# This script:
# 1. Detects if you're in a git repo
# 2. Registers with the parallel-cc coordinator
# 3. If parallel sessions exist, creates a worktree and cd's into it
# 4. Launches claude in the correct directory
#
# Usage: claude-parallel [claude args...]
# Recommended: alias claude='claude-parallel'

set -e

# Get repo path - if not in a git repo, just run claude normally
REPO_PATH=$(git rev-parse --show-toplevel 2>/dev/null || true)

if [ -z "$REPO_PATH" ]; then
    # Not in a git repo - just run claude normally
    exec claude "$@"
fi

# Check if parallel-cc is available
if ! command -v parallel-cc &> /dev/null; then
    echo "⚠️  parallel-cc not found - running claude without coordination" >&2
    exec claude "$@"
fi

# Register and get worktree path
RESULT=$(parallel-cc register --repo "$REPO_PATH" --pid $$ --json 2>/dev/null || echo '{}')

# Parse JSON results - ensure clean integers/strings
WORKTREE_PATH=$(echo "$RESULT" | jq -r '.worktreePath // empty' 2>/dev/null | tr -d '\n' || true)
IS_NEW=$(echo "$RESULT" | jq -r '.isNew // false' 2>/dev/null | tr -d '\n' || echo "false")
PARALLEL_COUNT=$(echo "$RESULT" | jq -r '.parallelSessions // 1' 2>/dev/null | tr -d '\n' || echo "1")

# Ensure PARALLEL_COUNT is a valid integer, default to 1
if ! [[ "$PARALLEL_COUNT" =~ ^[0-9]+$ ]]; then
    PARALLEL_COUNT=1
fi

# If we got a different worktree path, cd into it
if [ -n "$WORKTREE_PATH" ] && [ "$WORKTREE_PATH" != "$REPO_PATH" ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
    echo "📂 Parallel session detected - working in worktree" >&2
    echo "   Path: $WORKTREE_PATH" >&2
    echo "   Sessions: $PARALLEL_COUNT active" >&2
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
    cd "$WORKTREE_PATH"
elif [ "$PARALLEL_COUNT" -gt 1 ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
    echo "📂 Working in main repo (first session)" >&2
    echo "   Sessions: $PARALLEL_COUNT active" >&2
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
fi

# Set up cleanup trap to release session on exit
cleanup() {
    parallel-cc release --pid $$ 2>/dev/null || true
}
trap cleanup EXIT

# Launch claude in the (possibly new) directory
exec claude "$@"
