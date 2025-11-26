#!/bin/bash
# Installation script for parallel-cc

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Allow user to override installation paths
INSTALL_DIR="${PARALLEL_CC_INSTALL_DIR:-$HOME/.local/bin}"
DATA_DIR="${PARALLEL_CC_DATA_DIR:-$HOME/.parallel-cc}"

# Track what we've installed for rollback
INSTALLED_FILES=()
CREATED_DIRS=()

# Cleanup function for rollback on failure
cleanup_on_error() {
    echo ""
    echo "❌ Installation failed! Rolling back..."

    # Remove installed files
    for file in "${INSTALLED_FILES[@]}"; do
        if [ -f "$file" ]; then
            echo "  Removing $file"
            rm -f "$file"
        fi
    done

    # Remove created directories (only if empty)
    for dir in "${CREATED_DIRS[@]}"; do
        if [ -d "$dir" ] && [ -z "$(ls -A "$dir")" ]; then
            echo "  Removing empty directory $dir"
            rmdir "$dir"
        fi
    done

    echo "Rollback complete."
    exit 1
}

# Set trap for cleanup on error
trap cleanup_on_error ERR

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Installing parallel-cc"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Detect if this is an update
IS_UPDATE=false
if [ -f "$INSTALL_DIR/parallel-cc" ]; then
    echo "ℹ️  Existing installation detected - this will update parallel-cc"
    IS_UPDATE=true
    echo ""
fi

echo "🔍 Checking dependencies..."
echo ""

# Check Node.js version
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is required but not installed."
    echo "   Install from: https://nodejs.org/ (need version 20+)"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "❌ Node.js version 20+ required (found: $(node -v))"
    echo "   Update from: https://nodejs.org/"
    exit 1
fi
echo "  ✓ Node.js $(node -v)"

# Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm is required but not installed."
    exit 1
fi
echo "  ✓ npm $(npm -v)"

# Check git
if ! command -v git &> /dev/null; then
    echo "❌ git is required but not installed."
    exit 1
fi
echo "  ✓ git $(git --version | cut -d' ' -f3)"

# Check for jq (required for wrapper script)
if ! command -v jq &> /dev/null; then
    echo "❌ jq is required but not installed."
    echo "   Install with: sudo apt install jq (Ubuntu) or brew install jq (macOS)"
    exit 1
fi
echo "  ✓ jq $(jq --version)"

# Check for gtr (required for worktree management)
if ! command -v gtr &> /dev/null; then
    echo "❌ gtr (git-worktree-runner) is required but not installed."
    echo "   Install from: https://github.com/coderabbitai/git-worktree-runner"
    exit 1
fi
echo "  ✓ gtr installed"

# Check write permissions
if [ ! -w "$(dirname "$INSTALL_DIR")" ] && [ ! -w "$INSTALL_DIR" 2>/dev/null ]; then
    echo "❌ Cannot write to $INSTALL_DIR"
    echo "   Try: mkdir -p $INSTALL_DIR or run with different PARALLEL_CC_INSTALL_DIR"
    exit 1
fi

echo ""

# Build the project
echo "📦 Building TypeScript..."
cd "$PROJECT_DIR"

# Install dependencies with progress feedback
echo "  Installing dependencies..."
if ! npm install --silent > /tmp/parallel-cc-install.log 2>&1; then
    echo "❌ npm install failed. Check /tmp/parallel-cc-install.log for details"
    cat /tmp/parallel-cc-install.log
    exit 1
fi

# Verify node_modules was created
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
    echo "❌ node_modules not created - npm install may have failed"
    exit 1
fi
echo "  ✓ Dependencies installed"

# Build TypeScript
echo "  Compiling TypeScript..."
if ! npm run build --silent > /tmp/parallel-cc-build.log 2>&1; then
    echo "❌ Build failed. Check /tmp/parallel-cc-build.log for details"
    cat /tmp/parallel-cc-build.log
    exit 1
fi

# Verify dist/cli.js was created
if [ ! -f "$PROJECT_DIR/dist/cli.js" ]; then
    echo "❌ dist/cli.js not created - build may have failed"
    exit 1
fi
echo "  ✓ Build successful"
echo ""

# Create installation directory
echo "📁 Creating directories..."
if [ ! -d "$INSTALL_DIR" ]; then
    mkdir -p "$INSTALL_DIR"
    CREATED_DIRS+=("$INSTALL_DIR")
fi
echo "  ✓ Install directory: $INSTALL_DIR"

# Create database directory
if [ ! -d "$DATA_DIR" ]; then
    mkdir -p "$DATA_DIR"
    CREATED_DIRS+=("$DATA_DIR")
fi
echo "  ✓ Data directory: $DATA_DIR"
echo ""

# Create symlink for CLI with warning if exists
echo "🔗 Installing CLI..."
CLI_TARGET="$INSTALL_DIR/parallel-cc"
if [ -f "$CLI_TARGET" ] && [ ! -L "$CLI_TARGET" ]; then
    echo "⚠️  Warning: $CLI_TARGET exists and is not a symlink"
    echo "   Backing up to ${CLI_TARGET}.backup"
    mv "$CLI_TARGET" "${CLI_TARGET}.backup"
fi
ln -sf "$PROJECT_DIR/dist/cli.js" "$CLI_TARGET"
chmod +x "$CLI_TARGET"
INSTALLED_FILES+=("$CLI_TARGET")
echo "  ✓ parallel-cc CLI installed"

# Install wrapper script
echo "🔗 Installing claude-parallel wrapper..."
WRAPPER_TARGET="$INSTALL_DIR/claude-parallel"
if [ ! -f "$SCRIPT_DIR/claude-parallel.sh" ]; then
    echo "❌ claude-parallel.sh not found in $SCRIPT_DIR"
    exit 1
fi
if [ -f "$WRAPPER_TARGET" ] && [ ! "$IS_UPDATE" = true ]; then
    echo "⚠️  Warning: $WRAPPER_TARGET exists"
    echo "   Backing up to ${WRAPPER_TARGET}.backup"
    mv "$WRAPPER_TARGET" "${WRAPPER_TARGET}.backup"
fi
cp "$SCRIPT_DIR/claude-parallel.sh" "$WRAPPER_TARGET"
chmod +x "$WRAPPER_TARGET"
INSTALLED_FILES+=("$WRAPPER_TARGET")
echo "  ✓ claude-parallel wrapper installed"

# Install heartbeat script (still useful for stale detection)
echo "🔗 Installing heartbeat hook..."
HEARTBEAT_TARGET="$INSTALL_DIR/parallel-cc-heartbeat.sh"
if [ ! -f "$SCRIPT_DIR/heartbeat.sh" ]; then
    echo "⚠️  Warning: heartbeat.sh not found - skipping"
else
    if [ -f "$HEARTBEAT_TARGET" ] && [ ! "$IS_UPDATE" = true ]; then
        echo "⚠️  Warning: $HEARTBEAT_TARGET exists"
        echo "   Backing up to ${HEARTBEAT_TARGET}.backup"
        mv "$HEARTBEAT_TARGET" "${HEARTBEAT_TARGET}.backup"
    fi
    cp "$SCRIPT_DIR/heartbeat.sh" "$HEARTBEAT_TARGET"
    chmod +x "$HEARTBEAT_TARGET"
    INSTALLED_FILES+=("$HEARTBEAT_TARGET")
    echo "  ✓ heartbeat hook installed"
fi
echo ""

# Post-install verification
echo "🔍 Verifying installation..."
if ! "$CLI_TARGET" doctor > /tmp/parallel-cc-doctor.log 2>&1; then
    echo "⚠️  Warning: post-install verification had issues"
    echo "   Check /tmp/parallel-cc-doctor.log for details"
    cat /tmp/parallel-cc-doctor.log
else
    echo "  ✓ Installation verified"
fi
echo ""

# Detect shell and provide specific instructions
SHELL_NAME=$(basename "$SHELL")
SHELL_RC=""
case "$SHELL_NAME" in
    bash)
        SHELL_RC="~/.bashrc"
        ;;
    zsh)
        SHELL_RC="~/.zshrc"
        ;;
    fish)
        SHELL_RC="~/.config/fish/config.fish"
        ;;
    *)
        SHELL_RC="your shell profile"
        ;;
esac

# Check PATH
PATH_WARNING=""
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    PATH_WARNING="yes"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$IS_UPDATE" = true ]; then
    echo "  ✅ Update complete!"
else
    echo "  ✅ Installation complete!"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ -n "$PATH_WARNING" ]; then
    echo "⚠️  IMPORTANT: $INSTALL_DIR is not in your PATH"
    echo ""
    echo "Add this to your $SHELL_RC:"
    echo ""
    if [ "$INSTALL_DIR" = "$HOME/.local/bin" ]; then
        echo '   export PATH="$HOME/.local/bin:$PATH"'
    else
        echo "   export PATH=\"$INSTALL_DIR:\$PATH\""
    fi
    echo ""
    echo "Then reload your shell:"
    echo "   source $SHELL_RC"
    echo ""
fi

echo "SETUP OPTIONS:"
echo ""
echo "Option 1: Use 'claude-parallel' command directly"
echo "   Just run 'claude-parallel' instead of 'claude'"
echo ""
echo "Option 2: Make it automatic with an alias (RECOMMENDED)"
echo "   Add this to your $SHELL_RC:"
echo ""
echo "   alias claude='claude-parallel'"
echo ""
echo "Option 3: Add heartbeat hook for better stale detection"
echo "   Add to ~/.claude/settings.json:"
echo ""
cat << HOOKJSON
   {
     "hooks": {
       "PostToolUse": [
         {
           "matcher": "*",
           "hooks": [
             {
               "type": "command",
               "command": "$INSTALL_DIR/parallel-cc-heartbeat.sh"
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

# Disable error trap - we're done successfully
trap - ERR
