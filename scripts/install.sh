#!/bin/bash
# Installation script for parallel-cc

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Installing parallel-cc"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check for jq (required for wrapper script)
if ! command -v jq &> /dev/null; then
    echo "⚠️  jq is required but not installed."
    echo "   Install with: sudo apt install jq (Ubuntu) or brew install jq (macOS)"
    exit 1
fi

# Build the project
echo "📦 Building TypeScript..."
cd "$PROJECT_DIR"
npm install
npm run build

# Create bin directory
mkdir -p ~/.local/bin

# Create symlink for CLI
echo "🔗 Creating CLI symlink..."
ln -sf "$PROJECT_DIR/dist/cli.js" ~/.local/bin/parallel-cc
chmod +x ~/.local/bin/parallel-cc

# Install wrapper script
echo "🔗 Installing claude-parallel wrapper..."
cp "$SCRIPT_DIR/claude-parallel.sh" ~/.local/bin/claude-parallel
chmod +x ~/.local/bin/claude-parallel

# Install heartbeat script (still useful for stale detection)
echo "🔗 Installing heartbeat hook..."
cp "$SCRIPT_DIR/heartbeat.sh" ~/.local/bin/parallel-cc-heartbeat.sh
chmod +x ~/.local/bin/parallel-cc-heartbeat.sh

# Create database directory
echo "📁 Creating database directory..."
mkdir -p ~/.parallel-cc

# Check if gtr is installed
if ! command -v gtr &> /dev/null; then
    echo ""
    echo "⚠️  gtr (git-worktree-runner) is not installed."
    echo "   This is REQUIRED for parallel-cc to work."
    echo "   Install from: https://github.com/coderabbitai/git-worktree-runner"
    echo ""
fi

# Check PATH
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    echo ""
    echo "⚠️  ~/.local/bin is not in your PATH"
    echo "   Add this to your shell profile (~/.bashrc or ~/.zshrc):"
    echo ""
    echo '   export PATH="$HOME/.local/bin:$PATH"'
    echo ""
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Installation complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "SETUP OPTIONS:"
echo ""
echo "Option 1: Use 'claude-parallel' command directly"
echo "   Just run 'claude-parallel' instead of 'claude'"
echo ""
echo "Option 2: Make it automatic with an alias (RECOMMENDED)"
echo "   Add this to your ~/.bashrc or ~/.zshrc:"
echo ""
echo "   alias claude='claude-parallel'"
echo ""
echo "Option 3: Add heartbeat hook for better stale detection"
echo "   Add to ~/.claude/settings.json:"
echo ""
cat << 'HOOKJSON'
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
HOOKJSON
echo ""
echo "VERIFY INSTALLATION:"
echo "   parallel-cc doctor"
echo ""
echo "USAGE:"
echo "   Open multiple terminals in the same repo"
echo "   Run 'claude-parallel' (or 'claude' if aliased) in each"
echo "   The coordinator automatically creates worktrees as needed!"
echo ""
