/**
 * Database validation helpers for parallel-cc v0.5
 *
 * Implements security validation for file paths and other inputs
 * to prevent path traversal attacks and ensure data integrity.
 */

import { normalize, isAbsolute, join } from 'path';

/**
 * Validate a file path to prevent path traversal attacks
 *
 * Security Requirements:
 * - File path must be relative (not absolute)
 * - File path cannot contain '..' segments
 * - Normalized path must remain within repo boundary
 *
 * @param repoPath - Absolute path to the repository
 * @param filePath - Relative file path to validate
 * @throws Error if path is invalid or unsafe
 */
export function validateFilePath(repoPath: string, filePath: string): void {
  // Check if repo path is absolute
  if (!isAbsolute(repoPath)) {
    throw new Error('Repository path must be absolute');
  }

  // Normalize the file path to resolve any '..' or '.' segments
  const normalized = normalize(filePath);

  // Check for absolute paths
  if (isAbsolute(normalized)) {
    throw new Error('File path must be relative to repository root');
  }

  // Check for parent directory traversal
  if (normalized.includes('..')) {
    throw new Error('File path cannot contain ".." segments');
  }

  // Check that the normalized path starts with a valid character
  if (normalized.startsWith('/') || normalized.startsWith('\\')) {
    throw new Error('File path cannot start with path separator');
  }

  // Construct full path and verify it's within repo
  const fullPath = join(repoPath, normalized);
  if (!fullPath.startsWith(repoPath)) {
    throw new Error('File path escapes repository boundary');
  }
}

/**
 * Validate claim mode enum value
 *
 * @param mode - Claim mode to validate
 * @throws Error if mode is invalid
 */
export function validateClaimMode(mode: string): void {
  const validModes = ['EXCLUSIVE', 'SHARED', 'INTENT'];
  if (!validModes.includes(mode)) {
    throw new Error(`Invalid claim mode: ${mode}. Must be one of: ${validModes.join(', ')}`);
  }
}

/**
 * Validate conflict type enum value
 *
 * @param type - Conflict type to validate
 * @throws Error if type is invalid
 */
export function validateConflictType(type: string): void {
  const validTypes = ['STRUCTURAL', 'SEMANTIC', 'CONCURRENT_EDIT', 'TRIVIAL', 'UNKNOWN'];
  if (!validTypes.includes(type)) {
    throw new Error(`Invalid conflict type: ${type}. Must be one of: ${validTypes.join(', ')}`);
  }
}

/**
 * Validate resolution strategy enum value
 *
 * @param strategy - Resolution strategy to validate
 * @throws Error if strategy is invalid
 */
export function validateResolutionStrategy(strategy: string): void {
  const validStrategies = ['AUTO_FIX', 'MANUAL', 'HYBRID', 'ABANDONED'];
  if (!validStrategies.includes(strategy)) {
    throw new Error(`Invalid resolution strategy: ${strategy}. Must be one of: ${validStrategies.join(', ')}`);
  }
}

/**
 * Validate confidence score (0.0 to 1.0)
 *
 * @param score - Confidence score to validate
 * @throws Error if score is out of range
 */
export function validateConfidenceScore(score: number): void {
  if (score < 0 || score > 1) {
    throw new Error(`Confidence score must be between 0 and 1, got: ${score}`);
  }
  if (isNaN(score) || !isFinite(score)) {
    throw new Error(`Confidence score must be a valid number, got: ${score}`);
  }
}

/**
 * Validate TTL (time-to-live) in hours
 *
 * @param ttlHours - TTL in hours to validate
 * @throws Error if TTL is invalid
 */
export function validateTTL(ttlHours: number): void {
  if (ttlHours <= 0) {
    throw new Error(`TTL must be positive, got: ${ttlHours}`);
  }
  if (!isFinite(ttlHours)) {
    throw new Error(`TTL must be a finite number, got: ${ttlHours}`);
  }
  if (ttlHours > 8760) { // 1 year
    throw new Error(`TTL cannot exceed 1 year (8760 hours), got: ${ttlHours}`);
  }
}

/**
 * Sanitize metadata JSON for storage
 *
 * @param metadata - Metadata object to sanitize
 * @returns Sanitized JSON string or null
 */
export function sanitizeMetadata(metadata: unknown): string | null {
  if (metadata === null || metadata === undefined) {
    return null;
  }

  try {
    const json = JSON.stringify(metadata);
    // Verify it can be parsed back (validates JSON structure)
    JSON.parse(json);
    return json;
  } catch (error) {
    throw new Error(`Invalid metadata: must be valid JSON serializable object`);
  }
}
