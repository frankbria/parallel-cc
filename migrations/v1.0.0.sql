-- ============================================================================
-- parallel-cc v1.0.0 Database Migration
--
-- This migration adds E2B Sandbox Integration support:
-- 1. Add execution_mode column to sessions (local | e2b)
-- 2. Add sandbox_id for tracking E2B sandbox instances
-- 3. Add prompt field for storing the user's task description
-- 4. Add status field for tracking sandbox execution state
-- 5. Add output_log for storing execution logs
--
-- Backward Compatibility:
-- - All new columns are nullable or have defaults
-- - Existing v0.5 sessions will work unchanged (execution_mode defaults to 'local')
-- - Migration is protected by version checks (enforced by migration runner)
--
-- Architecture Requirements Implemented:
-- - Enum validation with CHECK constraints
-- - Indexes optimized for E2B queries
-- - Maintains backward compatibility with v0.5 schema
-- ============================================================================

BEGIN TRANSACTION;

-- ============================================================================
-- Update Schema Version
-- ============================================================================

-- Update schema version in metadata
UPDATE schema_metadata
SET value = '1.0.0', updated_at = datetime('now')
WHERE key = 'version';

-- Insert if not exists (for fresh installs)
INSERT INTO schema_metadata (key, value) VALUES ('version', '1.0.0')
ON CONFLICT(key) DO UPDATE SET value = '1.0.0', updated_at = datetime('now');

-- ============================================================================
-- Alter Sessions Table for E2B Support (Copy-Recreate Pattern)
-- ============================================================================

-- IMPORTANT: Idempotency Strategy
-- --------------------------------
-- SQLite doesn't support ALTER TABLE ADD COLUMN IF NOT EXISTS, so this
-- migration uses a copy-recreate pattern for adding columns.
--
-- Idempotency is enforced by the migration runner (src/db.ts:runMigration):
--   1. Checks current schema_version before execution
--   2. Skips migration if already at target version (1.0.0)
--   3. Creates backup before migration
--   4. Verifies schema_version after execution
--
-- WARNING: Do NOT execute this SQL file directly (e.g., via sqlite3 cli).
--          Always use the migration runner: `parallel-cc migrate 1.0.0`
--          Direct execution will fail on second run due to table recreation.
--
-- If you need truly standalone idempotency, use column-existence checks
-- in the application layer before calling runMigration().

-- Step 0: Drop views that depend on sessions table (from v0.5.0)
-- These will be recreated after the sessions table is recreated
DROP VIEW IF EXISTS active_claims;
DROP VIEW IF EXISTS unresolved_conflicts;

-- Step 1: Create new table with E2B columns
CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  repo_path TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  worktree_name TEXT,
  is_main_repo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
  -- New E2B columns (v1.0.0)
  execution_mode TEXT DEFAULT 'local' CHECK(execution_mode IN ('local', 'e2b')),
  sandbox_id TEXT,
  prompt TEXT,
  status TEXT CHECK(status IS NULL OR status IN ('INITIALIZING', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMEOUT')),
  output_log TEXT
);

-- Step 2: Copy all existing data from old sessions table
-- Set execution_mode='local' for all existing sessions (backward compatibility)
INSERT INTO sessions_new (
  id, pid, repo_path, worktree_path, worktree_name,
  is_main_repo, created_at, last_heartbeat,
  execution_mode, sandbox_id, prompt, status, output_log
)
SELECT
  id, pid, repo_path, worktree_path, worktree_name,
  is_main_repo, created_at, last_heartbeat,
  'local', NULL, NULL, NULL, NULL
FROM sessions;

-- Step 3: Drop old table
DROP TABLE sessions;

-- Step 4: Rename new table to original name
ALTER TABLE sessions_new RENAME TO sessions;

-- ============================================================================
-- Create Indexes for Sessions Table
-- ============================================================================

-- Recreate original indexes from init() (lost when we dropped old sessions table)
CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo_path);
CREATE INDEX IF NOT EXISTS idx_sessions_pid ON sessions(pid);
CREATE INDEX IF NOT EXISTS idx_sessions_heartbeat ON sessions(last_heartbeat);

-- New E2B-specific indexes
-- Index for filtering by execution mode
CREATE INDEX IF NOT EXISTS idx_sessions_execution_mode ON sessions(execution_mode);

-- Index for looking up by sandbox ID
CREATE INDEX IF NOT EXISTS idx_sessions_sandbox_id ON sessions(sandbox_id) WHERE sandbox_id IS NOT NULL;

-- Index for filtering by status
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status) WHERE status IS NOT NULL;

-- Composite index for querying active E2B sessions
CREATE INDEX IF NOT EXISTS idx_sessions_e2b_active ON sessions(execution_mode, status, created_at) WHERE execution_mode = 'e2b';

-- ============================================================================
-- Recreate v0.5.0 Views (dropped earlier to allow sessions table modification)
-- ============================================================================

-- Recreate active_claims view (from v0.5.0)
CREATE VIEW IF NOT EXISTS active_claims AS
SELECT
  c.id,
  c.session_id,
  c.repo_path,
  c.file_path,
  c.claim_mode,
  c.claimed_at,
  c.expires_at,
  c.last_heartbeat,
  c.escalated_from,
  s.pid,
  s.worktree_name,
  CASE
    WHEN datetime(c.expires_at) < datetime('now') THEN 1
    WHEN datetime(c.last_heartbeat) < datetime('now', '-5 minutes') THEN 1
    ELSE 0
  END AS is_stale
FROM file_claims c
JOIN sessions s ON c.session_id = s.id
WHERE c.is_active = 1 AND c.deleted_at IS NULL;

-- Recreate unresolved_conflicts view (from v0.5.0)
CREATE VIEW IF NOT EXISTS unresolved_conflicts AS
SELECT
  cr.id,
  cr.session_id,
  cr.repo_path,
  cr.file_path,
  cr.conflict_type,
  cr.base_commit,
  cr.source_commit,
  cr.target_commit,
  cr.resolution_strategy,
  cr.confidence_score,
  cr.detected_at,
  afs.id AS suggestion_id,
  afs.confidence_score AS suggestion_confidence,
  afs.generated_at AS suggestion_generated_at,
  julianday('now') - julianday(cr.detected_at) AS age_days
FROM conflict_resolutions cr
LEFT JOIN auto_fix_suggestions afs ON cr.auto_fix_suggestion_id = afs.id
WHERE cr.resolved_at IS NULL AND cr.deleted_at IS NULL
ORDER BY cr.detected_at DESC;

-- ============================================================================
-- E2B Sessions View (Convenience for Queries)
-- ============================================================================

CREATE VIEW IF NOT EXISTS e2b_sessions AS
SELECT
  s.id,
  s.pid,
  s.repo_path,
  s.worktree_path,
  s.worktree_name,
  s.sandbox_id,
  s.prompt,
  s.status,
  s.output_log,
  s.created_at,
  s.last_heartbeat,
  CASE
    WHEN s.status IN ('COMPLETED', 'FAILED', 'TIMEOUT') THEN 1
    ELSE 0
  END AS is_terminated,
  CAST((julianday(COALESCE(s.last_heartbeat, s.created_at)) - julianday(s.created_at)) * 24 * 60 AS INTEGER) AS runtime_minutes
FROM sessions s
WHERE s.execution_mode = 'e2b'
ORDER BY s.created_at DESC;

-- ============================================================================
-- Migration Verification
-- ============================================================================

-- Verify columns were added
SELECT
  COUNT(*) as column_count
FROM pragma_table_info('sessions')
WHERE name IN ('execution_mode', 'sandbox_id', 'prompt', 'status', 'output_log');

-- Verify indexes were created
SELECT name FROM sqlite_master
WHERE type='index'
AND name IN ('idx_sessions_execution_mode', 'idx_sessions_sandbox_id', 'idx_sessions_status', 'idx_sessions_e2b_active');

-- Verify view was created
SELECT name FROM sqlite_master
WHERE type='view'
AND name = 'e2b_sessions';

COMMIT;
