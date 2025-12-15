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

# Helper function for colored output
print() {
    local type="$1"
    shift
    local message="$@"

    # Only try to use chalk-based printer if chalk is installed
    # Check for chalk package existence to avoid import errors
    if [ -d "$PROJECT_DIR/node_modules/chalk" ] && [ -f "$SCRIPT_DIR/print.mjs" ]; then
        node "$SCRIPT_DIR/print.mjs" "$type" "$message"
        return 0
    fi

    # Fallback to plain text with basic formatting
    case "$type" in
        title)
            echo ""
            echo "=============================="
            echo "  $message"
            echo "=============================="
            echo ""
            ;;
        error)
            echo "✗ $message"
            ;;
        warning)
            echo "⚠  $message"
            ;;
        info|check|success|step|install|build|verify|cleanup|folder)
            echo "$message"
            ;;
        *)
            echo "$message"
            ;;
    esac
}

# Cleanup function for rollback on failure
cleanup_on_error() {
    echo ""
    print error "Installation failed! Rolling back..."

    # Remove installed files
    for file in "${INSTALLED_FILES[@]}"; do
        if [ -f "$file" ]; then
            print step "Removing $file"
            rm -f "$file"
        fi
    done

    # Remove created directories (only if empty)
    for dir in "${CREATED_DIRS[@]}"; do
        if [ -d "$dir" ] && [ -z "$(ls -A "$dir")" ]; then
            print step "Removing empty directory $dir"
            rmdir "$dir"
        fi
    done

    print info "Rollback complete."
    exit 1
}

# Set trap for cleanup on error
trap cleanup_on_error ERR

# Parse command-line arguments
INSTALL_ALL=false
for arg in "$@"; do
    case "$arg" in
        --all)
            INSTALL_ALL=true
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --all        Install non-interactively with all features (global hooks + alias)"
            echo "  --help, -h   Show this help message"
            echo ""
            exit 0
            ;;
        *)
            print error "Unknown option: $arg"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

print title "Installing parallel-cc"

# Detect if this is an update
IS_UPDATE=false
if [ -f "$INSTALL_DIR/parallel-cc" ]; then
    print info "Existing installation detected - this will update parallel-cc"
    IS_UPDATE=true
    echo ""
fi

print verify "Checking dependencies..."
echo ""

# Check Node.js version
if ! command -v node &> /dev/null; then
    print error "Node.js is required but not installed."
    print step "Install from: https://nodejs.org/ (need version 20+)"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    print error "Node.js version 20+ required (found: $(node -v))"
    print step "Update from: https://nodejs.org/"
    exit 1
fi
print check "Node.js $(node -v)"

# Check npm
if ! command -v npm &> /dev/null; then
    print error "npm is required but not installed."
    exit 1
fi
print check "npm $(npm -v)"

# Check git
if ! command -v git &> /dev/null; then
    print error "git is required but not installed."
    exit 1
fi
print check "git $(git --version | cut -d' ' -f3)"

# Check for jq (required for wrapper script)
if ! command -v jq &> /dev/null; then
    print error "jq is required but not installed."
    print step "Install with: sudo apt install jq (Ubuntu) or brew install jq (macOS)"
    exit 1
fi
print check "jq $(jq --version)"

# Check for gtr (required for worktree management)
# Support both v1.x (standalone 'gtr') and v2.x ('git gtr')
if command -v gtr &> /dev/null; then
    print check "gtr installed (v1.x standalone)"
elif git gtr version &> /dev/null 2>&1; then
    print check "git gtr installed (v2.x subcommand)"
else
    print error "gtr (git-worktree-runner) is required but not installed."
    print step "Install from: https://github.com/coderabbitai/git-worktree-runner"
    exit 1
fi

# Check write permissions
if [ ! -w "$(dirname "$INSTALL_DIR")" ] && [ ! -w "$INSTALL_DIR" 2>/dev/null ]; then
    print error "Cannot write to $INSTALL_DIR"
    print step "Try: mkdir -p $INSTALL_DIR or run with different PARALLEL_CC_INSTALL_DIR"
    exit 1
fi

echo ""

print build "Building TypeScript..."
cd "$PROJECT_DIR"

# Install dependencies only if needed
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
    print step "Installing dependencies..."
    if ! npm install --silent > /tmp/parallel-cc-install.log 2>&1; then
        print error "npm install failed. Check /tmp/parallel-cc-install.log for details"
        cat /tmp/parallel-cc-install.log
        exit 1
    fi
    print check "Dependencies installed"
else
    print check "Dependencies already installed"
fi

# Build TypeScript only if needed or forced
NEEDS_BUILD=false
if [ ! -f "$PROJECT_DIR/dist/cli.js" ]; then
    NEEDS_BUILD=true
elif [ "$IS_UPDATE" = true ]; then
    # On update, always rebuild
    NEEDS_BUILD=true
elif [ "$PROJECT_DIR/src" -nt "$PROJECT_DIR/dist/cli.js" ]; then
    # Rebuild if source is newer than output
    NEEDS_BUILD=true
fi

if [ "$NEEDS_BUILD" = true ]; then
    print step "Compiling TypeScript..."
    if ! npm run build --silent > /tmp/parallel-cc-build.log 2>&1; then
        print error "Build failed. Check /tmp/parallel-cc-build.log for details"
        cat /tmp/parallel-cc-build.log
        exit 1
    fi
    print check "Build successful"
else
    print check "Build up to date"
fi

# Final verification that dist/cli.js exists
if [ ! -f "$PROJECT_DIR/dist/cli.js" ]; then
    print error "dist/cli.js not found - build may have failed"
    exit 1
fi
echo ""

print folder "Creating directories..."
if [ ! -d "$INSTALL_DIR" ]; then
    mkdir -p "$INSTALL_DIR"
    CREATED_DIRS+=("$INSTALL_DIR")
fi
print check "Install directory: $INSTALL_DIR"

# Create database directory
if [ ! -d "$DATA_DIR" ]; then
    mkdir -p "$DATA_DIR"
    CREATED_DIRS+=("$DATA_DIR")
fi
print check "Data directory: $DATA_DIR"
echo ""

# Create symlink for CLI with warning if exists
print install "Installing CLI..."
CLI_TARGET="$INSTALL_DIR/parallel-cc"
if [ -f "$CLI_TARGET" ] && [ ! -L "$CLI_TARGET" ] && [ ! "$IS_UPDATE" = true ]; then
    # Only backup non-symlink files on first install
    print warning "Warning: $CLI_TARGET exists and is not a symlink"
    print step "Backing up to ${CLI_TARGET}.backup"
    mv "$CLI_TARGET" "${CLI_TARGET}.backup"
fi
ln -sf "$PROJECT_DIR/dist/cli.js" "$CLI_TARGET"
chmod +x "$CLI_TARGET"
if [ ! "$IS_UPDATE" = true ]; then
    INSTALLED_FILES+=("$CLI_TARGET")
fi
print check "parallel-cc CLI installed"

# Install wrapper script
print install "Installing claude-parallel wrapper..."
WRAPPER_TARGET="$INSTALL_DIR/claude-parallel"
if [ ! -f "$SCRIPT_DIR/claude-parallel.sh" ]; then
    print error "claude-parallel.sh not found in $SCRIPT_DIR"
    exit 1
fi
# Only backup if not already installed and not an update
if [ -f "$WRAPPER_TARGET" ] && [ ! "$IS_UPDATE" = true ]; then
    # Check if it's already our file by comparing content
    if ! cmp -s "$SCRIPT_DIR/claude-parallel.sh" "$WRAPPER_TARGET"; then
        print warning "Warning: $WRAPPER_TARGET exists and differs"
        print step "Backing up to ${WRAPPER_TARGET}.backup"
        mv "$WRAPPER_TARGET" "${WRAPPER_TARGET}.backup"
    fi
fi
cp "$SCRIPT_DIR/claude-parallel.sh" "$WRAPPER_TARGET"
chmod +x "$WRAPPER_TARGET"
if [ ! "$IS_UPDATE" = true ]; then
    INSTALLED_FILES+=("$WRAPPER_TARGET")
fi
print check "claude-parallel wrapper installed"

# Install heartbeat script (still useful for stale detection)
print install "Installing heartbeat hook..."
HEARTBEAT_TARGET="$INSTALL_DIR/parallel-cc-heartbeat.sh"
if [ ! -f "$SCRIPT_DIR/heartbeat.sh" ]; then
    print warning "Warning: heartbeat.sh not found - skipping"
else
    # Only backup if not already installed and not an update
    if [ -f "$HEARTBEAT_TARGET" ] && [ ! "$IS_UPDATE" = true ]; then
        # Check if it's already our file by comparing content
        if ! cmp -s "$SCRIPT_DIR/heartbeat.sh" "$HEARTBEAT_TARGET"; then
            print warning "Warning: $HEARTBEAT_TARGET exists and differs"
            print step "Backing up to ${HEARTBEAT_TARGET}.backup"
            mv "$HEARTBEAT_TARGET" "${HEARTBEAT_TARGET}.backup"
        fi
    fi
    cp "$SCRIPT_DIR/heartbeat.sh" "$HEARTBEAT_TARGET"
    chmod +x "$HEARTBEAT_TARGET"
    if [ ! "$IS_UPDATE" = true ]; then
        INSTALLED_FILES+=("$HEARTBEAT_TARGET")
    fi
    print check "heartbeat hook installed"
fi
echo ""

# Post-install verification
print verify "Verifying installation..."
if ! "$CLI_TARGET" doctor > /tmp/parallel-cc-doctor.log 2>&1; then
    print warning "Warning: post-install verification had issues"
    print step "Check /tmp/parallel-cc-doctor.log for details"
    cat /tmp/parallel-cc-doctor.log
else
    print check "Installation verified"
fi
echo ""

# Check if non-interactive mode with --all flag
if [ "$INSTALL_ALL" = true ]; then
    print step "Running non-interactive installation with --all flag..."
    echo ""

    if "$CLI_TARGET" install --all > /tmp/parallel-cc-install-all.log 2>&1; then
        print check "All features installed successfully"
        print step "  • Heartbeat hooks installed globally"
        print step "  • Shell alias configured"
        print step "  • MCP server configured"
        echo ""
        print warning "Restart your shell or source your shell profile to use the 'claude' alias"

        # Show installation status
        print step "Installation status:"
        "$CLI_TARGET" install --status
    else
        print error "Installation failed. Check /tmp/parallel-cc-install-all.log for details"
        cat /tmp/parallel-cc-install-all.log
        exit 1
    fi

    echo ""
    print title "Installation Complete!"
    print step "Run 'parallel-cc --help' to get started"
    print step "Or just run 'claude' (after restarting your shell)"
    echo ""
    exit 0
fi

# Interactive hook setup
install_hooks() {
    echo ""
    print step "The heartbeat hook improves session tracking by updating timestamps"
    print step "each time Claude Code uses a tool."
    echo ""

    # Check if running interactively
    if [ -t 0 ]; then
        read -p "Would you like to add the heartbeat hook for better session tracking? [y/N]: " hook_answer
        case "$hook_answer" in
            [Yy]|[Yy][Ee][Ss])
                echo ""
                read -p "Install globally (~/.claude/settings.json) or locally (current repo)? [global/local/skip]: " location_answer
                case "$location_answer" in
                    [Gg]|[Gg][Ll][Oo][Bb][Aa][Ll])
                        print step "Installing hooks globally..."
                        if "$CLI_TARGET" install --hooks --global > /tmp/parallel-cc-hooks.log 2>&1; then
                            print check "Heartbeat hook installed globally"
                            print step "Location: ~/.claude/settings.json"
                        else
                            print warning "Hook installation failed. Check /tmp/parallel-cc-hooks.log"
                            cat /tmp/parallel-cc-hooks.log
                        fi
                        ;;
                    [Ll]|[Ll][Oo][Cc][Aa][Ll])
                        print step "Installing hooks locally..."
                        echo ""
                        read -p "Add .claude/ to .gitignore? [y/N]: " gitignore_answer
                        GITIGNORE_FLAG=""
                        case "$gitignore_answer" in
                            [Yy]|[Yy][Ee][Ss])
                                GITIGNORE_FLAG="--gitignore"
                                ;;
                        esac
                        if "$CLI_TARGET" install --hooks --local $GITIGNORE_FLAG > /tmp/parallel-cc-hooks.log 2>&1; then
                            print check "Heartbeat hook installed locally"
                            print step "Location: ./.claude/settings.json"
                            if [ -n "$GITIGNORE_FLAG" ]; then
                                print step "Added .claude/ to .gitignore"
                            fi
                        else
                            print warning "Hook installation failed. Check /tmp/parallel-cc-hooks.log"
                            cat /tmp/parallel-cc-hooks.log
                        fi
                        ;;
                    *)
                        print step "Skipped hook installation."
                        print step "You can install later with: parallel-cc install --hooks"
                        ;;
                esac
                ;;
            *)
                print step "Skipped hook installation."
                print step "You can install later with: parallel-cc install --hooks"
                ;;
        esac
    else
        # Non-interactive mode - skip prompts
        print step "Non-interactive mode detected. Skipping hook setup."
        print step "To install hooks later, run: parallel-cc install --hooks"
    fi
    echo ""
}

# Offer to install hooks
install_hooks

# Interactive alias setup
install_alias() {
    # Check if running interactively
    if [ -t 0 ]; then
        echo ""
        print step "Setting up the 'claude' alias makes parallel-cc automatic:"
        print step "  Instead of: claude-parallel"
        print step "  Just run:   claude"
        echo ""

        read -p "Add 'claude=claude-parallel' alias to your shell profile? [y/N]: " alias_answer
        case "$alias_answer" in
            [Yy]|[Yy][Ee][Ss])
                print step "Installing alias..."
                if "$CLI_TARGET" install --alias > /tmp/parallel-cc-alias.log 2>&1; then
                    print check "Alias installed successfully"
                    # Extract the profile path from the output
                    PROFILE_PATH=$(grep -o "Path:.*" /tmp/parallel-cc-alias.log | cut -d' ' -f2 || echo "your shell profile")
                    print step "Location: $PROFILE_PATH"
                    print warning "Restart your shell or run: source $PROFILE_PATH"
                else
                    print warning "Alias installation failed. Check /tmp/parallel-cc-alias.log"
                    cat /tmp/parallel-cc-alias.log
                    print step "You can add the alias manually to your shell profile:"
                    print step "  alias claude='claude-parallel'"
                fi
                ;;
            *)
                print step "Skipped alias installation."
                print step "You can install later with: parallel-cc install --alias"
                ;;
        esac
    else
        # Non-interactive mode
        print step "Non-interactive mode. Skipping alias setup."
        print step "To install alias later, run: parallel-cc install --alias"
    fi
    echo ""
}

# Offer to install alias
install_alias

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

if [ "$IS_UPDATE" = true ]; then
    print title "Update complete!"
else
    print title "Installation complete!"
fi

if [ -n "$PATH_WARNING" ]; then
    print warning "IMPORTANT: $INSTALL_DIR is not in your PATH"
    echo ""
    print step "Add this to your $SHELL_RC:"
    echo ""
    if [ "$INSTALL_DIR" = "$HOME/.local/bin" ]; then
        echo '   export PATH="$HOME/.local/bin:$PATH"'
    else
        echo "   export PATH=\"$INSTALL_DIR:\$PATH\""
    fi
    echo ""
    print step "Then reload your shell:"
    echo "   source $SHELL_RC"
    echo ""
fi

echo "ADDITIONAL SETUP (if skipped above):"
echo ""
echo "   parallel-cc install --all          # Full setup: hooks + alias + MCP"
echo "   parallel-cc install --hooks        # Heartbeat hook for stale detection"
echo "   parallel-cc install --alias        # Shell alias (claude=claude-parallel)"
echo "   parallel-cc install --mcp          # MCP server for Claude Code integration"
echo "   parallel-cc install --status       # Check what's installed"
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
