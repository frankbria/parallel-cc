/**
 * Configuration management for parallel-cc
 *
 * Handles persistent user settings stored in ~/.parallel-cc/config.json
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join as pathJoin } from 'path';
import { homedir } from 'os';
import type { BudgetConfig } from './types.js';

/**
 * Default budget configuration values
 */
export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  monthlyLimit: undefined,
  perSessionDefault: undefined,
  warningThresholds: [0.5, 0.8],
  e2bHourlyRate: 0.10 // Default E2B pricing: $0.10/hour
};

/**
 * Default configuration structure
 */
interface Config {
  budget: BudgetConfig;
  [key: string]: unknown;
}

const DEFAULT_CONFIG: Config = {
  budget: DEFAULT_BUDGET_CONFIG
};

/**
 * Default config file path
 */
export const DEFAULT_CONFIG_PATH = pathJoin(homedir(), '.parallel-cc', 'config.json');

/**
 * ConfigManager - Manages persistent user configuration
 *
 * Features:
 * - JSON file storage with automatic directory creation
 * - Dot notation support for nested keys (e.g., "budget.monthlyLimit")
 * - Validation for budget-related settings
 * - Debounced writes to avoid excessive disk I/O during rapid changes
 */
export class ConfigManager {
  private configPath: string;
  private config: Config;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number = 100; // 100ms debounce window
  private pendingSave: boolean = false;

  /**
   * Create a new ConfigManager
   *
   * @param configPath - Path to config file (default: ~/.parallel-cc/config.json)
   */
  constructor(configPath: string = DEFAULT_CONFIG_PATH) {
    this.configPath = this.resolvePath(configPath);
    this.ensureDirectory();
    this.config = this.load();
  }

  /**
   * Resolve tilde in path to home directory
   */
  private resolvePath(path: string): string {
    if (path.startsWith('~')) {
      return path.replace('~', homedir());
    }
    return path;
  }

  /**
   * Ensure config directory exists
   */
  private ensureDirectory(): void {
    const dir = dirname(this.configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Load config from file
   */
  private load(): Config {
    if (!existsSync(this.configPath)) {
      // Create default config
      this.save(structuredClone(DEFAULT_CONFIG));
      return structuredClone(DEFAULT_CONFIG);
    }

    try {
      const content = readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(content);

      // Merge with defaults to ensure all required fields exist
      // Use structuredClone to prevent shared references (e.g., warningThresholds array)
      return {
        ...structuredClone(DEFAULT_CONFIG),
        ...parsed,
        budget: {
          ...structuredClone(DEFAULT_BUDGET_CONFIG),
          ...parsed.budget
        }
      };
    } catch (err) {
      // Invalid JSON - backup corrupted file and return defaults
      const backupPath = `${this.configPath}.corrupted.${Date.now()}`;
      try {
        copyFileSync(this.configPath, backupPath);
        console.error(`Warning: Config file had invalid JSON. Backed up to: ${backupPath}`);
      } catch {
        // Backup failed - just warn
        console.error(`Warning: Config file has invalid JSON and could not be backed up: ${(err as Error).message}`);
      }
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  /**
   * Save config to file (debounced to avoid excessive I/O)
   *
   * Multiple rapid calls will be batched into a single write.
   * Use flushSync() to force immediate write when needed.
   */
  private save(config?: Config): void {
    const toSave = config ?? this.config;
    this.config = toSave;
    this.pendingSave = true;

    // Clear existing timer if any
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    // Schedule debounced write
    this.saveTimer = setTimeout(() => {
      this.flushSync();
    }, this.debounceMs);
  }

  /**
   * Immediately flush pending config changes to disk (synchronous)
   *
   * Call this when you need to ensure config is persisted immediately,
   * such as before process exit.
   */
  flushSync(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.pendingSave) {
      try {
        writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
      } catch (err) {
        // Ignore ENOENT if directory was removed (e.g., test cleanup race conditions)
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }
      this.pendingSave = false;
    }
  }

  /**
   * Cancel any pending writes (for cleanup/testing)
   */
  cancelPendingWrites(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.pendingSave = false;
  }

  /**
   * Get a config value by key (supports dot notation)
   *
   * @param key - Config key (e.g., "budget.monthlyLimit")
   * @returns Config value or undefined if not found
   */
  get(key: string): unknown {
    const parts = key.split('.');
    let current: unknown = this.config;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      if (typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  /**
   * Validate that a key part is safe (prevents prototype pollution)
   */
  private validateKeyPart(part: string): void {
    // Prevent prototype pollution attacks
    const dangerousKeys = ['__proto__', 'constructor', 'prototype'];
    if (dangerousKeys.includes(part)) {
      throw new Error(`Invalid config key: "${part}" is a reserved property`);
    }

    // Prevent keys starting with underscore (internal properties)
    if (part.startsWith('_')) {
      throw new Error(`Invalid config key: keys starting with underscore are reserved`);
    }

    // Validate key format (alphanumeric, hyphens, underscores only for middle parts)
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(part)) {
      throw new Error(`Invalid config key format: "${part}" must start with a letter and contain only alphanumeric characters, hyphens, or underscores`);
    }
  }

  /**
   * Set a config value by key (supports dot notation)
   *
   * @param key - Config key (e.g., "budget.monthlyLimit")
   * @param value - Value to set
   * @throws Error if key is invalid or reserved
   */
  set(key: string, value: unknown): void {
    const parts = key.split('.');

    // Validate all key parts
    for (const part of parts) {
      this.validateKeyPart(part);
    }

    let current: Record<string, unknown> = this.config;

    // Navigate/create path to parent
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (current[part] === undefined || current[part] === null || typeof current[part] !== 'object') {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    // Set the value
    const lastPart = parts[parts.length - 1];
    current[lastPart] = value;

    this.save();
  }

  /**
   * Delete a config key (supports dot notation)
   *
   * @param key - Config key to delete
   * @throws Error if key is invalid or reserved
   */
  delete(key: string): void {
    const parts = key.split('.');

    // Validate all key parts
    for (const part of parts) {
      this.validateKeyPart(part);
    }

    let current: Record<string, unknown> = this.config;

    // Navigate to parent
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (current[part] === undefined || typeof current[part] !== 'object') {
        return; // Path doesn't exist, nothing to delete
      }
      current = current[part] as Record<string, unknown>;
    }

    // Delete the key
    const lastPart = parts[parts.length - 1];
    delete current[lastPart];

    this.save();
  }

  /**
   * Get entire config object (returns a copy)
   *
   * @returns Copy of entire config
   */
  getAll(): Config {
    return structuredClone(this.config);
  }

  /**
   * Get budget configuration
   *
   * @returns Budget config
   */
  getBudgetConfig(): BudgetConfig {
    return structuredClone(this.config.budget);
  }

  /**
   * Set budget configuration (partial update)
   *
   * @param config - Partial budget config to merge
   * @throws Error if validation fails
   */
  setBudgetConfig(config: Partial<BudgetConfig>): void {
    // Validate budget limits
    if (config.monthlyLimit !== undefined && config.monthlyLimit !== null) {
      if (config.monthlyLimit < 0) {
        throw new Error('Budget limit must be a positive number');
      }
    }

    if (config.perSessionDefault !== undefined && config.perSessionDefault !== null) {
      if (config.perSessionDefault < 0) {
        throw new Error('Per-session budget must be a positive number');
      }
    }

    // Validate warning thresholds
    if (config.warningThresholds !== undefined) {
      for (const threshold of config.warningThresholds) {
        if (threshold < 0 || threshold > 1) {
          throw new Error('Warning thresholds must be between 0 and 1');
        }
      }
    }

    // Validate e2bHourlyRate
    if (config.e2bHourlyRate !== undefined && config.e2bHourlyRate !== null) {
      if (config.e2bHourlyRate < 0) {
        throw new Error('E2B hourly rate must be a non-negative number');
      }
    }

    // Merge config
    this.config.budget = {
      ...this.config.budget,
      ...config
    };

    this.save();
  }
}
