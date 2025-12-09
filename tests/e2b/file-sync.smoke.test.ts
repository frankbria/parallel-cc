/**
 * Smoke tests for E2B File Sync Module
 *
 * These tests verify that all exported functions and constants are properly exported
 * and have the correct signatures. They DO NOT test full functionality (that's for
 * the vitest-expert agent).
 */

import { describe, it, expect } from 'vitest';
import * as FileSync from '../../src/e2b/file-sync.js';

describe('E2B File Sync - Exports', () => {
  it('should export all constants', () => {
    expect(FileSync.SENSITIVE_PATTERNS).toBeDefined();
    expect(Array.isArray(FileSync.SENSITIVE_PATTERNS)).toBe(true);
    expect(FileSync.SENSITIVE_PATTERNS.length).toBeGreaterThan(0);

    expect(FileSync.ALWAYS_EXCLUDE).toBeDefined();
    expect(Array.isArray(FileSync.ALWAYS_EXCLUDE)).toBe(true);
    expect(FileSync.ALWAYS_EXCLUDE.length).toBeGreaterThan(0);

    expect(FileSync.CHECKPOINT_SIZE_BYTES).toBeDefined();
    expect(typeof FileSync.CHECKPOINT_SIZE_BYTES).toBe('number');
    expect(FileSync.CHECKPOINT_SIZE_BYTES).toBe(50 * 1024 * 1024);

    expect(FileSync.GZIP_LEVEL).toBeDefined();
    expect(typeof FileSync.GZIP_LEVEL).toBe('number');
    expect(FileSync.GZIP_LEVEL).toBe(6);
  });

  it('should export core functions', () => {
    expect(typeof FileSync.createTarball).toBe('function');
    expect(typeof FileSync.uploadToSandbox).toBe('function');
    expect(typeof FileSync.downloadChangedFiles).toBe('function');
    expect(typeof FileSync.verifyUpload).toBe('function');
    expect(typeof FileSync.scanForCredentials).toBe('function');
  });

  it('should export helper functions', () => {
    expect(typeof FileSync.validatePath).toBe('function');
    expect(typeof FileSync.buildExclusionList).toBe('function');
    expect(typeof FileSync.countFilesInTarball).toBe('function');
    expect(typeof FileSync.parseGitStatus).toBe('function');
    expect(typeof FileSync.getTextFiles).toBe('function');
    expect(typeof FileSync.shouldSkipDirectory).toBe('function');
    expect(typeof FileSync.isTextFile).toBe('function');
    expect(typeof FileSync.formatBytes).toBe('function');
  });
});

describe('E2B File Sync - Constants Validation', () => {
  it('SENSITIVE_PATTERNS should detect common credential patterns', () => {
    const patterns = FileSync.SENSITIVE_PATTERNS;

    // Test API key patterns
    expect(patterns.some(p => p.test('API_KEY'))).toBe(true);
    expect(patterns.some(p => p.test('api-key'))).toBe(true);

    // Test password patterns
    expect(patterns.some(p => p.test('PASSWORD'))).toBe(true);
    expect(patterns.some(p => p.test('password'))).toBe(true);

    // Test secret patterns
    expect(patterns.some(p => p.test('SECRET'))).toBe(true);
    expect(patterns.some(p => p.test('secret'))).toBe(true);

    // Test token patterns
    expect(patterns.some(p => p.test('TOKEN'))).toBe(true);
    expect(patterns.some(p => p.test('AUTH_TOKEN'))).toBe(true);

    // Test AWS patterns
    expect(patterns.some(p => p.test('AWS_SECRET'))).toBe(true);
  });

  it('ALWAYS_EXCLUDE should include critical security files', () => {
    const excludes = FileSync.ALWAYS_EXCLUDE;

    expect(excludes).toContain('.env');
    expect(excludes).toContain('.env.local');
    expect(excludes).toContain('.env.production');
    expect(excludes.some(e => e.includes('.pem'))).toBe(true);
    expect(excludes.some(e => e.includes('.key'))).toBe(true);
    expect(excludes.some(e => e.includes('id_rsa'))).toBe(true);
  });
});

describe('E2B File Sync - Helper Functions', () => {
  describe('formatBytes', () => {
    it('should format bytes correctly', () => {
      expect(FileSync.formatBytes(0)).toBe('0 B');
      expect(FileSync.formatBytes(1024)).toBe('1.00 KB');
      expect(FileSync.formatBytes(1024 * 1024)).toBe('1.00 MB');
      expect(FileSync.formatBytes(50 * 1024 * 1024)).toBe('50.00 MB');
      expect(FileSync.formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
    });
  });

  describe('parseGitStatus', () => {
    it('should parse git status output', () => {
      const output = `
M  file1.txt
A  file2.txt
D  file3.txt
`;
      const files = FileSync.parseGitStatus(output);
      expect(files).toContain('file1.txt');
      expect(files).toContain('file2.txt');
      expect(files).toContain('file3.txt');
    });

    it('should handle renamed files', () => {
      const output = 'R  old-name.txt -> new-name.txt';
      const files = FileSync.parseGitStatus(output);
      expect(files).toContain('new-name.txt');
      expect(files).not.toContain('old-name.txt');
    });

    it('should handle empty output', () => {
      const files = FileSync.parseGitStatus('');
      expect(files).toEqual([]);
    });
  });

  describe('shouldSkipDirectory', () => {
    it('should skip common excluded directories', () => {
      expect(FileSync.shouldSkipDirectory('node_modules')).toBe(true);
      expect(FileSync.shouldSkipDirectory('.git')).toBe(true);
      expect(FileSync.shouldSkipDirectory('dist')).toBe(true);
      expect(FileSync.shouldSkipDirectory('build')).toBe(true);
      expect(FileSync.shouldSkipDirectory('coverage')).toBe(true);
      expect(FileSync.shouldSkipDirectory('.next')).toBe(true);
      expect(FileSync.shouldSkipDirectory('__pycache__')).toBe(true);
      expect(FileSync.shouldSkipDirectory('vendor')).toBe(true);
      expect(FileSync.shouldSkipDirectory('.venv')).toBe(true);
      expect(FileSync.shouldSkipDirectory('venv')).toBe(true);
    });

    it('should not skip normal directories', () => {
      expect(FileSync.shouldSkipDirectory('src')).toBe(false);
      expect(FileSync.shouldSkipDirectory('tests')).toBe(false);
      expect(FileSync.shouldSkipDirectory('lib')).toBe(false);
    });
  });

  describe('isTextFile', () => {
    it('should identify text files by extension', () => {
      // JavaScript/TypeScript
      expect(FileSync.isTextFile('file.js')).toBe(true);
      expect(FileSync.isTextFile('file.ts')).toBe(true);
      expect(FileSync.isTextFile('file.jsx')).toBe(true);
      expect(FileSync.isTextFile('file.tsx')).toBe(true);

      // Other languages
      expect(FileSync.isTextFile('file.py')).toBe(true);
      expect(FileSync.isTextFile('file.go')).toBe(true);
      expect(FileSync.isTextFile('file.rs')).toBe(true);
      expect(FileSync.isTextFile('file.java')).toBe(true);

      // Config files
      expect(FileSync.isTextFile('.env')).toBe(true);
      expect(FileSync.isTextFile('config.yml')).toBe(true);
      expect(FileSync.isTextFile('config.yaml')).toBe(true);
      expect(FileSync.isTextFile('package.json')).toBe(true);

      // Documentation
      expect(FileSync.isTextFile('README.md')).toBe(true);
      expect(FileSync.isTextFile('notes.txt')).toBe(true);
    });

    it('should reject binary files', () => {
      expect(FileSync.isTextFile('image.png')).toBe(false);
      expect(FileSync.isTextFile('video.mp4')).toBe(false);
      expect(FileSync.isTextFile('archive.zip')).toBe(false);
      expect(FileSync.isTextFile('library.so')).toBe(false);
    });

    it('should be case insensitive', () => {
      expect(FileSync.isTextFile('FILE.JS')).toBe(true);
      expect(FileSync.isTextFile('FILE.PY')).toBe(true);
      expect(FileSync.isTextFile('README.MD')).toBe(true);
    });
  });
});

describe('E2B File Sync - validatePath', () => {
  it('should reject paths with directory traversal', async () => {
    await expect(FileSync.validatePath('/tmp/../etc/passwd')).rejects.toThrow(
      'directory traversal detected'
    );
  });

  it('should reject relative paths', async () => {
    await expect(FileSync.validatePath('relative/path')).rejects.toThrow(
      'must be absolute path'
    );
  });

  it('should reject non-existent paths', async () => {
    await expect(
      FileSync.validatePath('/tmp/this-path-definitely-does-not-exist-12345')
    ).rejects.toThrow('Path does not exist');
  });

  it('should accept valid absolute paths', async () => {
    // /tmp should exist on all Unix systems
    await expect(FileSync.validatePath('/tmp')).resolves.not.toThrow();
  });
});
