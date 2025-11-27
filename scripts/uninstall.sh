#!/bin/bash
# Uninstallation script for parallel-cc

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Allow user to override installation paths
INSTALL_DIR="${PARALLEL_CC_INSTALL_DIR:-$HOME/.local/bin}"
DATA_DIR="${PARALLEL_CC_DATA_DIR:-$HOME/.parallel-cc}"

# Helper function for colored output
print() {
    # Try to use chalk-based printer if available, fallback to plain text
    if [ -f "$SCRIPT_DIR/print.mjs" ] && command -v node &> /dev/null; then
        node "$SCRIPT_DIR/print.mjs" "$@"
    else
        # Fallback to plain text
        shift
        echo "$@"
    fi
}

print title "Uninstalling parallel-cc"

# Check if installed
if [ ! -f "$INSTALL_DIR/parallel-cc" ]; then
    print error "parallel-cc does not appear to be installed in $INSTALL_DIR"
    print step "If installed elsewhere, set PARALLEL_CC_INSTALL_DIR environment variable"
    exit 1
fi

print info "This will remove:"
print step "$INSTALL_DIR/parallel-cc"
print step "$INSTALL_DIR/claude-parallel"
print step "$INSTALL_DIR/parallel-cc-heartbeat.sh"
echo ""
print warning "Database and session data will be preserved at: $DATA_DIR"
print step "To remove data, manually delete: $DATA_DIR"
echo ""

read -p "Continue with uninstall? [y/N] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print info "Uninstall cancelled."
    exit 0
fi

echo ""

# Offer to remove configurations before removing binaries
if [ -f "$INSTALL_DIR/parallel-cc" ]; then
    read -p "Remove hooks, alias, and MCP config from settings? [y/N] " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        print cleanup "Removing configurations..."
        "$INSTALL_DIR/parallel-cc" install --uninstall 2>/dev/null || print warning "Some configs may need manual removal"
        echo ""
    fi
fi

print cleanup "Removing files..."

# Remove CLI
if [ -f "$INSTALL_DIR/parallel-cc" ] || [ -L "$INSTALL_DIR/parallel-cc" ]; then
    rm -f "$INSTALL_DIR/parallel-cc"
    print check "Removed parallel-cc CLI"
fi

# Remove wrapper
if [ -f "$INSTALL_DIR/claude-parallel" ]; then
    rm -f "$INSTALL_DIR/claude-parallel"
    print check "Removed claude-parallel wrapper"
fi

# Remove heartbeat script
if [ -f "$INSTALL_DIR/parallel-cc-heartbeat.sh" ]; then
    rm -f "$INSTALL_DIR/parallel-cc-heartbeat.sh"
    print check "Removed heartbeat script"
fi

# Remove backup files if they exist
if ls "$INSTALL_DIR"/parallel-cc*.backup > /dev/null 2>&1; then
    rm -f "$INSTALL_DIR"/parallel-cc*.backup
    print check "Removed backup files"
fi
if ls "$INSTALL_DIR"/claude-parallel*.backup > /dev/null 2>&1; then
    rm -f "$INSTALL_DIR"/claude-parallel*.backup
fi

print title "Uninstall complete!"

print section "CLEANUP (OPTIONAL):"
echo ""
echo "To remove session data and database:"
print step "rm -rf $DATA_DIR"
echo ""
echo "To remove shell alias (if you added one):"
print step "Edit your shell profile and remove: alias claude='claude-parallel'"
echo ""
echo "To remove hooks and MCP config from Claude settings:"
print step "Edit ~/.claude/settings.json and remove:"
print step "  - PostToolUse hook (parallel-cc-heartbeat.sh)"
print step "  - mcpServers.parallel-cc entry"
echo ""
