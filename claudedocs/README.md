# Claude Code Development Documentation

This directory contains documentation specific to Claude Code development sessions.

## Directory Structure

```
claudedocs/
├── archive/              # Archived session execution plans
│   ├── README.md         # Archive index and documentation
│   ├── 2025-12-09_v1.0_E2B_Integration.md
│   └── 2025-12-02_v0.5_Foundation.md
└── README.md            # This file
```

## Purpose

The `claudedocs/` directory serves as a workspace for:
- **Session execution plans** - Detailed implementation plans for major features
- **Development tracking** - Progress tracking during active development
- **Archived sessions** - Historical record of completed development phases

## Active Development

During active development, the current session's execution plan will be at:
- `claudedocs/SESSION.md` (moved to archive upon completion)

## Archived Documentation

Completed session plans are moved to `claudedocs/archive/` with descriptive filenames:
- Format: `YYYY-MM-DD_vX.Y_Feature_Name.md`
- See `archive/README.md` for detailed archive index

## Related Documentation

For production documentation, see:
- `/README.md` - User-facing project documentation
- `/CLAUDE.md` - Project overview for Claude Code (project configuration)
- `/ROADMAP.md` - Development roadmap and version history
- `/docs/` - Technical documentation and guides

## Workflow

1. **Planning Phase**: Create `SESSION.md` with execution plan
2. **Development Phase**: Update `SESSION.md` with progress
3. **Completion**: Move to `archive/YYYY-MM-DD_vX.Y_Feature.md`
4. **Update**: Add entry to `archive/README.md`
