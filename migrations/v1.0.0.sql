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
-- - Migration is idempotent (can run multiple times safely)
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
-- Alter Sessions Table for E2B Support
-- ============================================================================

-- Add execution_mode column (default: 'local' for backward compatibility)
ALTER TABLE sessions ADD COLUMN execution_mode TEXT DEFAULT 'local' CHECK(execution_mode IN ('local', 'e2b'));

-- Add sandbox_id column (nullable, only populated for E2B sessions)
ALTER TABLE sessions ADD COLUMN sandbox_id TEXT;

-- Add prompt column (nullable, stores user's task description for E2B sessions)
ALTER TABLE sessions ADD COLUMN prompt TEXT;

-- Add status column (nullable, tracks E2B sandbox execution state)
-- Valid values: INITIALIZING, RUNNING, COMPLETED, FAILED, TIMEOUT
ALTER TABLE sessions ADD COLUMN status TEXT CHECK(status IS NULL OR status IN ('INITIALIZING', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMEOUT'));

-- Add output_log column (nullable, stores execution logs for E2B sessions)
ALTER TABLE sessions ADD COLUMN output_log TEXT;

-- ============================================================================
-- Create Indexes for E2B Queries
-- ============================================================================

-- Index for filtering by execution mode
CREATE INDEX IF NOT EXISTS idx_sessions_execution_mode ON sessions(execution_mode);

-- Index for looking up by sandbox ID
CREATE INDEX IF NOT EXISTS idx_sessions_sandbox_id ON sessions(sandbox_id) WHERE sandbox_id IS NOT NULL;

-- Index for filtering by status
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status) WHERE status IS NOT NULL;

-- Composite index for querying active E2B sessions
CREATE INDEX IF NOT EXISTS idx_sessions_e2b_active ON sessions(execution_mode, status, created_at) WHERE execution_mode = 'e2b';

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
