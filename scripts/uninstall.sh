#!/bin/bash
# Uninstallation script for parallel-cc

set -e

# Allow user to override installation paths
INSTALL_DIR="${PARALLEL_CC_INSTALL_DIR:-$HOME/.local/bin}"
DATA_DIR="${PARALLEL_CC_DATA_DIR:-$HOME/.parallel-cc}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Uninstalling parallel-cc"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if installed
if [ ! -f "$INSTALL_DIR/parallel-cc" ]; then
    echo "❌ parallel-cc does not appear to be installed in $INSTALL_DIR"
    echo "   If installed elsewhere, set PARALLEL_CC_INSTALL_DIR environment variable"
    exit 1
fi

# Confirm with user
echo "This will remove:"
echo "  - $INSTALL_DIR/parallel-cc"
echo "  - $INSTALL_DIR/claude-parallel"
echo "  - $INSTALL_DIR/parallel-cc-heartbeat.sh"
echo ""
echo "⚠️  Database and session data will be preserved at: $DATA_DIR"
echo "   To remove data, manually delete: $DATA_DIR"
echo ""

read -p "Continue with uninstall? [y/N] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Uninstall cancelled."
    exit 0
fi

echo ""
echo "🗑️  Removing files..."

# Remove CLI
if [ -f "$INSTALL_DIR/parallel-cc" ] || [ -L "$INSTALL_DIR/parallel-cc" ]; then
    rm -f "$INSTALL_DIR/parallel-cc"
    echo "  ✓ Removed parallel-cc CLI"
fi

# Remove wrapper
if [ -f "$INSTALL_DIR/claude-parallel" ]; then
    rm -f "$INSTALL_DIR/claude-parallel"
    echo "  ✓ Removed claude-parallel wrapper"
fi

# Remove heartbeat script
if [ -f "$INSTALL_DIR/parallel-cc-heartbeat.sh" ]; then
    rm -f "$INSTALL_DIR/parallel-cc-heartbeat.sh"
    echo "  ✓ Removed heartbeat script"
fi

# Remove backup files if they exist
if ls "$INSTALL_DIR"/parallel-cc*.backup > /dev/null 2>&1; then
    rm -f "$INSTALL_DIR"/parallel-cc*.backup
    echo "  ✓ Removed backup files"
fi
if ls "$INSTALL_DIR"/claude-parallel*.backup > /dev/null 2>&1; then
    rm -f "$INSTALL_DIR"/claude-parallel*.backup
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Uninstall complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "CLEANUP (OPTIONAL):"
echo ""
echo "To remove session data and database:"
echo "   rm -rf $DATA_DIR"
echo ""
echo "To remove shell alias (if you added one):"
echo "   Edit your shell profile and remove:"
echo "   alias claude='claude-parallel'"
echo ""
echo "To remove heartbeat hook (if you added one):"
echo "   Edit ~/.claude/settings.json and remove the PostToolUse hook"
echo ""
