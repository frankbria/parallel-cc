-- ============================================================================
-- parallel-cc v0.5.0 Database Migration
--
-- This migration adds:
-- 1. schema_metadata - Version tracking and distributed lock support
-- 2. file_claims - File access locks across sessions
-- 3. conflict_resolutions - Conflict resolution history
-- 4. auto_fix_suggestions - AI-generated conflict solutions
--
-- Architecture Review Requirements Implemented:
-- - Distributed lock support in schema_metadata (last_claim_cleanup, last_session_cleanup)
-- - Indexes optimized for stale claim queries
-- - Soft delete fields for audit trail (deleted_at, deleted_reason)
-- - CHECK constraints for enum validation
-- - Proper foreign keys with CASCADE/SET NULL
-- ============================================================================

BEGIN TRANSACTION;

-- ============================================================================
-- Schema Metadata Table (Version Tracking & Distributed Locks)
-- ============================================================================

CREATE TABLE IF NOT EXISTS schema_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Insert initial schema version
INSERT INTO schema_metadata (key, value) VALUES ('version', '0.5.0')
ON CONFLICT(key) DO UPDATE SET value = '0.5.0', updated_at = datetime('now');

-- Distributed lock timestamps for cleanup operations
INSERT INTO schema_metadata (key, value) VALUES ('last_claim_cleanup', datetime('now'))
ON CONFLICT(key) DO NOTHING;

INSERT INTO schema_metadata (key, value) VALUES ('last_session_cleanup', datetime('now'))
ON CONFLICT(key) DO NOTHING;

-- ============================================================================
-- File Claims Table (File Access Locks)
-- ============================================================================

CREATE TABLE IF NOT EXISTS file_claims (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  claim_mode TEXT NOT NULL CHECK (claim_mode IN ('EXCLUSIVE', 'SHARED', 'INTENT')),
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
  escalated_from TEXT CHECK (escalated_from IS NULL OR escalated_from IN ('EXCLUSIVE', 'SHARED', 'INTENT')),
  metadata TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  released_at TEXT,
  deleted_at TEXT,
  deleted_reason TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Indexes for file claims (optimized for stale claim queries)
CREATE INDEX IF NOT EXISTS idx_file_claims_session ON file_claims(session_id);
CREATE INDEX IF NOT EXISTS idx_file_claims_repo_file ON file_claims(repo_path, file_path);
CREATE INDEX IF NOT EXISTS idx_file_claims_active ON file_claims(is_active) WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_file_claims_expires ON file_claims(expires_at) WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_file_claims_stale ON file_claims(last_heartbeat, is_active) WHERE is_active = 1;

-- Composite index for conflict detection queries
CREATE INDEX IF NOT EXISTS idx_file_claims_conflict_check ON file_claims(repo_path, file_path, is_active, claim_mode) WHERE is_active = 1;

-- ============================================================================
-- Conflict Resolutions Table (Conflict History)
-- ============================================================================

CREATE TABLE IF NOT EXISTS conflict_resolutions (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  repo_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  conflict_type TEXT NOT NULL CHECK (conflict_type IN ('STRUCTURAL', 'SEMANTIC', 'CONCURRENT_EDIT', 'TRIVIAL', 'UNKNOWN')),
  base_commit TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  target_commit TEXT NOT NULL,
  resolution_strategy TEXT NOT NULL CHECK (resolution_strategy IN ('AUTO_FIX', 'MANUAL', 'HYBRID', 'ABANDONED')),
  confidence_score REAL CHECK (confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)),
  conflict_markers TEXT NOT NULL,
  resolved_content TEXT,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  auto_fix_suggestion_id TEXT,
  metadata TEXT,
  deleted_at TEXT,
  deleted_reason TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (auto_fix_suggestion_id) REFERENCES auto_fix_suggestions(id) ON DELETE SET NULL
);

-- Indexes for conflict resolutions
CREATE INDEX IF NOT EXISTS idx_conflict_resolutions_session ON conflict_resolutions(session_id);
CREATE INDEX IF NOT EXISTS idx_conflict_resolutions_repo_file ON conflict_resolutions(repo_path, file_path);
CREATE INDEX IF NOT EXISTS idx_conflict_resolutions_type ON conflict_resolutions(conflict_type);
CREATE INDEX IF NOT EXISTS idx_conflict_resolutions_strategy ON conflict_resolutions(resolution_strategy);
CREATE INDEX IF NOT EXISTS idx_conflict_resolutions_detected ON conflict_resolutions(detected_at);
CREATE INDEX IF NOT EXISTS idx_conflict_resolutions_unresolved ON conflict_resolutions(resolved_at) WHERE resolved_at IS NULL;

-- ============================================================================
-- Auto-Fix Suggestions Table (AI-Generated Solutions)
-- ============================================================================

CREATE TABLE IF NOT EXISTS auto_fix_suggestions (
  id TEXT PRIMARY KEY,
  conflict_resolution_id TEXT,
  repo_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  conflict_type TEXT NOT NULL CHECK (conflict_type IN ('STRUCTURAL', 'SEMANTIC', 'CONCURRENT_EDIT', 'TRIVIAL', 'UNKNOWN')),
  suggested_resolution TEXT NOT NULL,
  confidence_score REAL NOT NULL CHECK (confidence_score >= 0 AND confidence_score <= 1),
  explanation TEXT NOT NULL,
  strategy_used TEXT NOT NULL,
  base_content TEXT NOT NULL,
  source_content TEXT NOT NULL,
  target_content TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT,
  was_auto_applied INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  deleted_at TEXT,
  deleted_reason TEXT,
  FOREIGN KEY (conflict_resolution_id) REFERENCES conflict_resolutions(id) ON DELETE SET NULL
);

-- Indexes for auto-fix suggestions
CREATE INDEX IF NOT EXISTS idx_auto_fix_suggestions_resolution ON auto_fix_suggestions(conflict_resolution_id);
CREATE INDEX IF NOT EXISTS idx_auto_fix_suggestions_repo_file ON auto_fix_suggestions(repo_path, file_path);
CREATE INDEX IF NOT EXISTS idx_auto_fix_suggestions_type ON auto_fix_suggestions(conflict_type);
CREATE INDEX IF NOT EXISTS idx_auto_fix_suggestions_confidence ON auto_fix_suggestions(confidence_score);
CREATE INDEX IF NOT EXISTS idx_auto_fix_suggestions_unapplied ON auto_fix_suggestions(applied_at) WHERE applied_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_auto_fix_suggestions_generated ON auto_fix_suggestions(generated_at);

-- ============================================================================
-- Active Claims View (Convenience for Queries)
-- ============================================================================

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

-- ============================================================================
-- Unresolved Conflicts View (Convenience for Queries)
-- ============================================================================

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
-- Migration Verification
-- ============================================================================

-- Verify all tables were created
SELECT name FROM sqlite_master
WHERE type='table'
AND name IN ('schema_metadata', 'file_claims', 'conflict_resolutions', 'auto_fix_suggestions');

-- Verify all views were created
SELECT name FROM sqlite_master
WHERE type='view'
AND name IN ('active_claims', 'unresolved_conflicts');

COMMIT;
