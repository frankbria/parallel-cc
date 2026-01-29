/**
 * Tests for ConfigManager class
 *
 * TDD: These tests define the expected behavior of the ConfigManager
 * before implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigManager, DEFAULT_BUDGET_CONFIG } from '../src/config.js';
import type { BudgetConfig } from '../src/types.js';

// Test fixtures directory - unique per process to avoid conflicts
const TEST_DIR = path.join(os.tmpdir(), 'parallel-cc-config-test-' + process.pid);
const TEST_CONFIG_PATH = path.join(TEST_DIR, '.parallel-cc', 'config.json');

describe('ConfigManager', () => {
  let configManager: ConfigManager;

  beforeEach(() => {
    // Create test directory
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    // Cancel any pending debounced writes to avoid race conditions with directory cleanup
    if (configManager) {
      configManager.cancelPendingWrites();
    }
    // Clean up test directory
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ==========================================================================
  // Constructor and Initialization Tests
  // ==========================================================================

  describe('constructor', () => {
    it('should create config file directory if it does not exist', () => {
      const configPath = path.join(TEST_DIR, 'nested', 'deep', 'config.json');
      configManager = new ConfigManager(configPath);

      expect(fs.existsSync(path.dirname(configPath))).toBe(true);
    });

    it('should load existing config file', () => {
      // Create a config file first
      const configDir = path.dirname(TEST_CONFIG_PATH);
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
        budget: {
          monthlyLimit: 10.00,
          perSessionDefault: 1.00
        }
      }));

      configManager = new ConfigManager(TEST_CONFIG_PATH);

      expect(configManager.get('budget.monthlyLimit')).toBe(10.00);
      expect(configManager.get('budget.perSessionDefault')).toBe(1.00);
    });

    it('should create default config if file does not exist', () => {
      configManager = new ConfigManager(TEST_CONFIG_PATH);

      expect(configManager.getAll()).toEqual({
        budget: DEFAULT_BUDGET_CONFIG
      });
    });

    it('should handle invalid JSON gracefully', () => {
      // Create an invalid JSON file
      const configDir = path.dirname(TEST_CONFIG_PATH);
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(TEST_CONFIG_PATH, 'not valid json {{{');

      // Should not throw, should use defaults
      configManager = new ConfigManager(TEST_CONFIG_PATH);

      expect(configManager.getAll()).toEqual({
        budget: DEFAULT_BUDGET_CONFIG
      });
    });
  });

  // ==========================================================================
  // get() Tests
  // ==========================================================================

  describe('get', () => {
    beforeEach(() => {
      configManager = new ConfigManager(TEST_CONFIG_PATH);
    });

    it('should get top-level config value', () => {
      configManager.set('testKey', 'testValue');

      expect(configManager.get('testKey')).toBe('testValue');
    });

    it('should get nested config value with dot notation', () => {
      const value = configManager.get('budget.warningThresholds');

      expect(value).toEqual(DEFAULT_BUDGET_CONFIG.warningThresholds);
    });

    it('should return undefined for non-existent key', () => {
      expect(configManager.get('nonexistent')).toBeUndefined();
      expect(configManager.get('budget.nonexistent')).toBeUndefined();
      expect(configManager.get('a.b.c.d')).toBeUndefined();
    });

    it('should return entire nested object when accessing parent key', () => {
      const budget = configManager.get('budget');

      expect(budget).toEqual(DEFAULT_BUDGET_CONFIG);
    });
  });

  // ==========================================================================
  // set() Tests
  // ==========================================================================

  describe('set', () => {
    beforeEach(() => {
      configManager = new ConfigManager(TEST_CONFIG_PATH);
    });

    it('should set top-level config value', () => {
      configManager.set('newKey', 'newValue');

      expect(configManager.get('newKey')).toBe('newValue');
    });

    it('should set nested config value with dot notation', () => {
      configManager.set('budget.monthlyLimit', 25.00);

      expect(configManager.get('budget.monthlyLimit')).toBe(25.00);
    });

    it('should create intermediate objects for deep paths', () => {
      configManager.set('deep.nested.value', 42);

      expect(configManager.get('deep.nested.value')).toBe(42);
      expect(configManager.get('deep.nested')).toEqual({ value: 42 });
    });

    it('should persist changes to file', () => {
      configManager.set('budget.monthlyLimit', 50.00);
      // Flush debounced writes to ensure file is updated
      configManager.flushSync();

      // Read directly from file
      const fileContent = JSON.parse(fs.readFileSync(TEST_CONFIG_PATH, 'utf-8'));

      expect(fileContent.budget.monthlyLimit).toBe(50.00);
    });

    it('should overwrite existing values', () => {
      configManager.set('budget.monthlyLimit', 10.00);
      configManager.set('budget.monthlyLimit', 20.00);

      expect(configManager.get('budget.monthlyLimit')).toBe(20.00);
    });

    it('should handle null values', () => {
      configManager.set('budget.monthlyLimit', null);

      expect(configManager.get('budget.monthlyLimit')).toBeNull();
    });

    it('should handle array values', () => {
      configManager.set('budget.warningThresholds', [0.3, 0.6, 0.9]);

      expect(configManager.get('budget.warningThresholds')).toEqual([0.3, 0.6, 0.9]);
    });
  });

  // ==========================================================================
  // getAll() Tests
  // ==========================================================================

  describe('getAll', () => {
    it('should return entire config object', () => {
      configManager = new ConfigManager(TEST_CONFIG_PATH);
      configManager.set('budget.monthlyLimit', 15.00);
      configManager.set('customKey', 'customValue');

      const config = configManager.getAll();

      expect(config).toHaveProperty('budget');
      expect(config).toHaveProperty('customKey');
      expect(config.budget.monthlyLimit).toBe(15.00);
      expect(config.customKey).toBe('customValue');
    });

    it('should return a copy, not a reference', () => {
      configManager = new ConfigManager(TEST_CONFIG_PATH);
      const config1 = configManager.getAll();

      // Mutate the returned object
      config1.budget.monthlyLimit = 999.99;

      // Original should be unchanged
      expect(configManager.get('budget.monthlyLimit')).not.toBe(999.99);
    });
  });

  // ==========================================================================
  // getBudgetConfig() Tests
  // ==========================================================================

  describe('getBudgetConfig', () => {
    beforeEach(() => {
      configManager = new ConfigManager(TEST_CONFIG_PATH);
    });

    it('should return default budget config', () => {
      const budgetConfig = configManager.getBudgetConfig();

      expect(budgetConfig).toEqual(DEFAULT_BUDGET_CONFIG);
    });

    it('should return updated budget config after set', () => {
      configManager.set('budget.monthlyLimit', 100.00);
      configManager.set('budget.perSessionDefault', 5.00);

      const budgetConfig = configManager.getBudgetConfig();

      expect(budgetConfig.monthlyLimit).toBe(100.00);
      expect(budgetConfig.perSessionDefault).toBe(5.00);
    });

    it('should include warning thresholds', () => {
      const budgetConfig = configManager.getBudgetConfig();

      expect(budgetConfig.warningThresholds).toEqual([0.5, 0.8]);
    });
  });

  // ==========================================================================
  // setBudgetConfig() Tests
  // ==========================================================================

  describe('setBudgetConfig', () => {
    beforeEach(() => {
      configManager = new ConfigManager(TEST_CONFIG_PATH);
    });

    it('should update budget config partially', () => {
      configManager.setBudgetConfig({ monthlyLimit: 50.00 });

      const budgetConfig = configManager.getBudgetConfig();

      expect(budgetConfig.monthlyLimit).toBe(50.00);
      expect(budgetConfig.perSessionDefault).toEqual(DEFAULT_BUDGET_CONFIG.perSessionDefault);
      expect(budgetConfig.warningThresholds).toEqual(DEFAULT_BUDGET_CONFIG.warningThresholds);
    });

    it('should update multiple budget config fields', () => {
      configManager.setBudgetConfig({
        monthlyLimit: 75.00,
        perSessionDefault: 2.50,
        warningThresholds: [0.25, 0.5, 0.75]
      });

      const budgetConfig = configManager.getBudgetConfig();

      expect(budgetConfig.monthlyLimit).toBe(75.00);
      expect(budgetConfig.perSessionDefault).toBe(2.50);
      expect(budgetConfig.warningThresholds).toEqual([0.25, 0.5, 0.75]);
    });

    it('should persist budget config to file', () => {
      configManager.setBudgetConfig({ monthlyLimit: 30.00 });
      // Flush debounced writes to ensure file is updated
      configManager.flushSync();

      // Read directly from file
      const fileContent = JSON.parse(fs.readFileSync(TEST_CONFIG_PATH, 'utf-8'));

      expect(fileContent.budget.monthlyLimit).toBe(30.00);
    });

    it('should clear budget config values with undefined', () => {
      configManager.setBudgetConfig({ monthlyLimit: 100.00 });
      configManager.setBudgetConfig({ monthlyLimit: undefined });

      const budgetConfig = configManager.getBudgetConfig();

      expect(budgetConfig.monthlyLimit).toBeUndefined();
    });
  });

  // ==========================================================================
  // delete() Tests
  // ==========================================================================

  describe('delete', () => {
    beforeEach(() => {
      configManager = new ConfigManager(TEST_CONFIG_PATH);
    });

    it('should delete a config key', () => {
      configManager.set('toDelete', 'value');

      expect(configManager.get('toDelete')).toBe('value');

      configManager.delete('toDelete');

      expect(configManager.get('toDelete')).toBeUndefined();
    });

    it('should delete nested config key', () => {
      configManager.set('budget.monthlyLimit', 100.00);

      configManager.delete('budget.monthlyLimit');

      expect(configManager.get('budget.monthlyLimit')).toBeUndefined();
      // Parent should still exist
      expect(configManager.get('budget')).toBeDefined();
    });

    it('should handle deleting non-existent key gracefully', () => {
      // Should not throw
      expect(() => configManager.delete('nonexistent')).not.toThrow();
      expect(() => configManager.delete('a.b.c')).not.toThrow();
    });

    it('should persist deletion to file', () => {
      configManager.set('deleteMe', 'value');
      configManager.delete('deleteMe');
      // Flush debounced writes to ensure file is updated
      configManager.flushSync();

      // Read directly from file
      const fileContent = JSON.parse(fs.readFileSync(TEST_CONFIG_PATH, 'utf-8'));

      expect(fileContent.deleteMe).toBeUndefined();
    });
  });

  // ==========================================================================
  // Validation Tests
  // ==========================================================================

  describe('validation', () => {
    beforeEach(() => {
      configManager = new ConfigManager(TEST_CONFIG_PATH);
    });

    it('should reject negative budget limits', () => {
      expect(() => configManager.setBudgetConfig({ monthlyLimit: -10.00 }))
        .toThrow('Budget limit must be a positive number');
    });

    it('should reject negative per-session defaults', () => {
      expect(() => configManager.setBudgetConfig({ perSessionDefault: -5.00 }))
        .toThrow('Per-session budget must be a positive number');
    });

    it('should reject invalid warning thresholds', () => {
      expect(() => configManager.setBudgetConfig({ warningThresholds: [-0.1, 0.5] }))
        .toThrow('Warning thresholds must be between 0 and 1');

      expect(() => configManager.setBudgetConfig({ warningThresholds: [0.5, 1.5] }))
        .toThrow('Warning thresholds must be between 0 and 1');
    });

    it('should accept valid budget config', () => {
      expect(() => configManager.setBudgetConfig({
        monthlyLimit: 100.00,
        perSessionDefault: 5.00,
        warningThresholds: [0.25, 0.5, 0.75]
      })).not.toThrow();
    });

    it('should accept zero as valid budget limit', () => {
      // Zero means "no limit" or "disabled"
      expect(() => configManager.setBudgetConfig({ monthlyLimit: 0 })).not.toThrow();
    });
  });

  // ==========================================================================
  // Persistence and Concurrency Tests
  // ==========================================================================

  describe('persistence', () => {
    it('should preserve config across instances', () => {
      const configManager1 = new ConfigManager(TEST_CONFIG_PATH);
      configManager1.set('persistent', 'value');
      // Flush to ensure file is written before creating second instance
      configManager1.flushSync();

      const configManager2 = new ConfigManager(TEST_CONFIG_PATH);

      expect(configManager2.get('persistent')).toBe('value');

      // Clean up both instances
      configManager1.cancelPendingWrites();
      configManager2.cancelPendingWrites();
    });

    it('should write valid JSON', () => {
      configManager = new ConfigManager(TEST_CONFIG_PATH);
      configManager.set('complex', {
        nested: { deep: { value: 'test' } },
        array: [1, 2, 3]
      });
      // Flush to ensure file is written
      configManager.flushSync();

      // Should not throw when parsing
      const content = fs.readFileSync(TEST_CONFIG_PATH, 'utf-8');
      expect(() => JSON.parse(content)).not.toThrow();
    });

    it('should format JSON with indentation for readability', () => {
      configManager = new ConfigManager(TEST_CONFIG_PATH);
      configManager.set('test', 'value');
      // Flush to ensure file is written
      configManager.flushSync();

      const content = fs.readFileSync(TEST_CONFIG_PATH, 'utf-8');

      // Should contain newlines (formatted)
      expect(content).toContain('\n');
    });
  });

  // ==========================================================================
  // Default Config Tests
  // ==========================================================================

  describe('DEFAULT_BUDGET_CONFIG', () => {
    it('should have expected default values', () => {
      expect(DEFAULT_BUDGET_CONFIG).toEqual({
        monthlyLimit: undefined,
        perSessionDefault: undefined,
        warningThresholds: [0.5, 0.8],
        e2bHourlyRate: 0.10
      });
    });
  });
});
