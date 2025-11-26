#!/bin/bash
# PostToolUse hook for Claude Code
# Updates heartbeat to indicate session is still active

# Only run if we're in a git repo
REPO_PATH=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_PATH" ]; then
    exit 0
fi

# Get Claude Code's PID
CLAUDE_PID=${PPID:-$$}

# Update heartbeat (silent - don't clutter Claude's output)
parallel-cc heartbeat --pid "$CLAUDE_PID" 2>/dev/null

exit 0
