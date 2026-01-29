-- ============================================================================
-- parallel-cc v1.1.0 Database Migration
--
-- This migration adds v1.1 features:
-- 1. Git configuration tracking (git_user, git_email, ssh_key_provided)
-- 2. Cost tracking improvements (budget_limit, cost_estimate, actual_cost)
-- 3. Template tracking (template_name)
-- 4. Budget tracking table for period-based budget management
--
-- Backward Compatibility:
-- - All new columns are nullable or have defaults
-- - Existing v1.0 sessions will work unchanged
-- - Migration is protected by version checks (enforced by migration runner)
--
-- Dependencies: Requires v1.0.0 migration to have been run first
-- ============================================================================

BEGIN TRANSACTION;

-- ============================================================================
-- Update Schema Version
-- ============================================================================

-- Update schema version in metadata
UPDATE schema_metadata
SET value = '1.1.0', updated_at = datetime('now')
WHERE key = 'version';

-- Insert if not exists (for fresh installs)
INSERT INTO schema_metadata (key, value) VALUES ('version', '1.1.0')
ON CONFLICT(key) DO UPDATE SET value = '1.1.0', updated_at = datetime('now');

-- ============================================================================
-- Alter Sessions Table for v1.1.0 Features (Copy-Recreate Pattern)
-- ============================================================================

-- IMPORTANT: Idempotency Strategy
-- --------------------------------
-- SQLite doesn't support ALTER TABLE ADD COLUMN IF NOT EXISTS, so this
-- migration uses a copy-recreate pattern for adding columns.
--
-- Idempotency is enforced by the migration runner (src/db.ts:runMigration):
--   1. Checks current schema_version before execution
--   2. Skips migration if already at target version (1.1.0)
--   3. Creates backup before migration
--   4. Verifies schema_version after execution
--
-- WARNING: Do NOT execute this SQL file directly (e.g., via sqlite3 cli).
--          Always use the migration runner: `parallel-cc migrate 1.1.0`
--          Direct execution will fail on second run due to table recreation.

-- Step 0: Drop views that depend on sessions table
DROP VIEW IF EXISTS active_claims;
DROP VIEW IF EXISTS unresolved_conflicts;
DROP VIEW IF EXISTS e2b_sessions;

-- Step 1: Create new table with all v1.0.0 columns plus new v1.1.0 columns
CREATE TABLE sessions_new (
  -- Original columns (v0.x)
  id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  repo_path TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  worktree_name TEXT,
  is_main_repo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
  -- E2B columns (v1.0.0)
  execution_mode TEXT DEFAULT 'local' CHECK(execution_mode IN ('local', 'e2b')),
  sandbox_id TEXT,
  prompt TEXT,
  status TEXT CHECK(status IS NULL OR status IN ('INITIALIZING', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMEOUT')),
  output_log TEXT,
  -- New v1.1.0 columns: Git configuration tracking
  git_user TEXT,
  git_email TEXT,
  ssh_key_provided INTEGER DEFAULT 0,
  -- New v1.1.0 columns: Cost tracking
  budget_limit REAL,
  cost_estimate REAL,
  actual_cost REAL,
  -- New v1.1.0 columns: Template tracking
  template_name TEXT
);

-- Step 2: Copy all existing data from old sessions table
-- Set v1.1.0 columns to defaults for existing sessions
INSERT INTO sessions_new (
  id, pid, repo_path, worktree_path, worktree_name,
  is_main_repo, created_at, last_heartbeat,
  execution_mode, sandbox_id, prompt, status, output_log,
  git_user, git_email, ssh_key_provided,
  budget_limit, cost_estimate, actual_cost,
  template_name
)
SELECT
  id, pid, repo_path, worktree_path, worktree_name,
  is_main_repo, created_at, last_heartbeat,
  execution_mode, sandbox_id, prompt, status, output_log,
  NULL, NULL, 0,
  NULL, NULL, NULL,
  NULL
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

-- E2B-specific indexes (from v1.0.0)
CREATE INDEX IF NOT EXISTS idx_sessions_execution_mode ON sessions(execution_mode);
CREATE INDEX IF NOT EXISTS idx_sessions_sandbox_id ON sessions(sandbox_id) WHERE sandbox_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status) WHERE status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_e2b_active ON sessions(execution_mode, status, created_at) WHERE execution_mode = 'e2b';

-- New v1.1.0 indexes
CREATE INDEX IF NOT EXISTS idx_sessions_template ON sessions(template_name) WHERE template_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_budget ON sessions(budget_limit) WHERE budget_limit IS NOT NULL;

-- ============================================================================
-- Recreate v0.5.0 and v1.0.0 Views
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

-- Recreate e2b_sessions view (from v1.0.0) with v1.1.0 columns
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
  s.git_user,
  s.git_email,
  s.ssh_key_provided,
  s.budget_limit,
  s.cost_estimate,
  s.actual_cost,
  s.template_name,
  CASE
    WHEN s.status IN ('COMPLETED', 'FAILED', 'TIMEOUT') THEN 1
    ELSE 0
  END AS is_terminated,
  CAST((julianday(COALESCE(s.last_heartbeat, s.created_at)) - julianday(s.created_at)) * 24 * 60 AS INTEGER) AS runtime_minutes
FROM sessions s
WHERE s.execution_mode = 'e2b'
ORDER BY s.created_at DESC;

-- ============================================================================
-- Create Budget Tracking Table (v1.1.0)
-- ============================================================================

CREATE TABLE IF NOT EXISTS budget_tracking (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL CHECK(period IN ('daily', 'weekly', 'monthly')),
  period_start TEXT NOT NULL,
  budget_limit REAL,
  spent REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Index for efficient period lookups
CREATE INDEX IF NOT EXISTS idx_budget_period ON budget_tracking(period, period_start);

-- ============================================================================
-- Migration Verification
-- ============================================================================

-- Verify new columns were added to sessions table
SELECT
  COUNT(*) as column_count
FROM pragma_table_info('sessions')
WHERE name IN ('git_user', 'git_email', 'ssh_key_provided', 'budget_limit', 'cost_estimate', 'actual_cost', 'template_name');

-- Verify budget_tracking table was created
SELECT name FROM sqlite_master
WHERE type='table' AND name = 'budget_tracking';

-- Verify budget_tracking index was created
SELECT name FROM sqlite_master
WHERE type='index' AND name = 'idx_budget_period';

-- Verify views were recreated
SELECT name FROM sqlite_master
WHERE type='view'
AND name IN ('active_claims', 'unresolved_conflicts', 'e2b_sessions');

COMMIT;
