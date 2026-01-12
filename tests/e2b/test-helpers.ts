/**
 * E2B Test Helpers
 *
 * Shared utilities for E2B integration tests including:
 * - API key detection and skip logic
 * - Clear messaging for skipped tests
 * - Environment validation
 */

import { beforeAll } from 'vitest';

/**
 * Check if E2B API key is available
 */
export const HAS_E2B_API_KEY = !!process.env.E2B_API_KEY;

/**
 * Check if E2B tests are explicitly required (fail if key missing)
 */
export const E2B_REQUIRED = process.env.E2B_REQUIRED === 'true';

/**
 * Whether to skip E2B tests that require API access
 */
export const skipE2B = !HAS_E2B_API_KEY;

/**
 * Log E2B test status at the start of a test suite
 * Call this in beforeAll() of E2B test files
 */
export function logE2BTestStatus(): void {
  if (E2B_REQUIRED && skipE2B) {
    throw new Error(
      'E2B_API_KEY required but not set.\n' +
      'Set the environment variable or run without E2B_REQUIRED=true'
    );
  }

  if (skipE2B) {
    console.log('\n' + '='.repeat(70));
    console.log('⚠️  E2B Integration Tests: SKIPPING (E2B_API_KEY not set)');
    console.log('');
    console.log('   To run E2B tests, set your API key:');
    console.log('   export E2B_API_KEY="your-key-here"');
    console.log('');
    console.log('   Or use the dedicated script:');
    console.log('   E2B_API_KEY="xxx" npm run test:e2b');
    console.log('='.repeat(70) + '\n');
  } else {
    console.log('\n' + '='.repeat(70));
    console.log('✓ E2B Integration Tests: RUNNING (E2B_API_KEY detected)');
    console.log('='.repeat(70) + '\n');
  }
}

/**
 * Setup hook for E2B test suites
 * Logs status and validates environment
 */
export function setupE2BTests(): void {
  beforeAll(() => {
    logE2BTestStatus();
  });
}

/**
 * Get a descriptive message for why E2B tests are skipped
 */
export function getSkipReason(): string {
  return 'E2B_API_KEY not set - skipping real API tests';
}
