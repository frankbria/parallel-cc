import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts'], // CLI is hard to unit test, covered by integration tests
      // Note: Global coverage thresholds will be enforced in v0.3
      // Currently only hooks-installer.ts has full test coverage
    },
    testTimeout: 10000,
    hookTimeout: 10000,
    // Use pool for better parallel execution
    pool: 'forks',
    // Reporters for CI and local dev
    reporters: ['verbose'],
  },
  resolve: {
    alias: {
      '@': '/src'
    }
  }
});
