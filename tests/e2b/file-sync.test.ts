/**
 * Tests for E2B File Sync Module
 *
 * Tests file synchronization between local worktrees and E2B sandboxes:
 * - Tarball creation with .gitignore and .e2bignore filtering
 * - Upload with resumable chunks for large files
 * - Download only changed files from sandbox
 * - Credential scanning with sensitive pattern detection
 * - File path validation and security checks
 *
 * All file system and E2B operations are mocked - no real file operations occur.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTarball,
  uploadToSandbox,
  downloadChangedFiles,
  verifyUpload,
  scanForCredentials,
  SENSITIVE_PATTERNS,
  ALWAYS_EXCLUDE,
  CHECKPOINT_SIZE_BYTES,
  GZIP_LEVEL
} from '../../src/e2b/file-sync.js';
import type {
  TarballResult,
  UploadResult,
  DownloadResult,
  VerificationResult,
  CredentialScanResult
} from '../../src/e2b/file-sync.js';

// Mock fs module with named exports
vi.mock('fs/promises', () => ({
  mkdtemp: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  readdir: vi.fn(),
  open: vi.fn()
}));

// Mock fs (sync)
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  createReadStream: vi.fn(),
  createWriteStream: vi.fn()
}));

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  exec: vi.fn()
}));

// Mock logger
vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}));

describe('E2B File Sync', () => {
  let mockSandbox: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create mock sandbox with E2B-like API
    mockSandbox = {
      files: {
        write: vi.fn().mockResolvedValue(undefined),
        read: vi.fn().mockResolvedValue(Buffer.from(''))
      },
      commands: {
        run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
      }
    };
  });

  describe('Constants', () => {
    it('should export SENSITIVE_PATTERNS array', () => {
      expect(SENSITIVE_PATTERNS).toBeInstanceOf(Array);
      expect(SENSITIVE_PATTERNS.length).toBeGreaterThan(0);
    });

    it('should include common credential patterns', () => {
      const patterns = SENSITIVE_PATTERNS.map(p => p.source.toLowerCase());
      expect(patterns.some(p => p.includes('api'))).toBe(true);
      expect(patterns.some(p => p.includes('password'))).toBe(true);
      expect(patterns.some(p => p.includes('secret'))).toBe(true);
      expect(patterns.some(p => p.includes('token'))).toBe(true);
    });

    it('should export ALWAYS_EXCLUDE array', () => {
      expect(ALWAYS_EXCLUDE).toBeInstanceOf(Array);
      expect(ALWAYS_EXCLUDE.length).toBeGreaterThan(0);
    });

    it('should include sensitive file patterns in ALWAYS_EXCLUDE', () => {
      expect(ALWAYS_EXCLUDE).toContain('.env');
      expect(ALWAYS_EXCLUDE.some(p => p.includes('.pem'))).toBe(true);
      expect(ALWAYS_EXCLUDE.some(p => p.includes('credentials'))).toBe(true);
    });

    it('should define CHECKPOINT_SIZE_BYTES for resumable uploads', () => {
      expect(CHECKPOINT_SIZE_BYTES).toBe(50 * 1024 * 1024); // 50MB
    });

    it('should define GZIP_LEVEL for compression', () => {
      expect(GZIP_LEVEL).toBe(6);
    });
  });

  describe('createTarball', () => {
    beforeEach(async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');
      const childProcess = await import('child_process');

      // Mock fs operations
      vi.mocked(fs.mkdtemp).mockResolvedValue('/tmp/parallel-cc-tarball-abc123');
      vi.mocked(fs.stat).mockResolvedValue({
        size: 1024 * 1024, // 1MB
        isFile: () => true,
        isDirectory: () => false
      } as any);
      vi.mocked(fsSync.existsSync).mockReturnValue(false); // No .gitignore/.e2bignore

      // Mock execSync for tar command
      vi.mocked(childProcess.execSync).mockReturnValue(Buffer.from(''));
    });

    it('should create tarball from worktree path', async () => {
      const { execSync } = await import('child_process');

      const result = await createTarball('/test/worktree');

      expect(result).toMatchObject({
        path: expect.stringContaining('tar.gz'),
        sizeBytes: expect.any(Number),
        fileCount: expect.any(Number),
        excludedFiles: expect.any(Array),
        duration: expect.any(Number)
      });
      expect(execSync).toHaveBeenCalled();
    });

    it('should use custom output path when provided', async () => {
      const customPath = '/tmp/custom-tarball.tar.gz';

      const result = await createTarball('/test/worktree', customPath);

      expect(result.path).toBe(customPath);
    });

    it('should exclude .gitignore patterns', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      vi.mocked(fsSync.existsSync).mockImplementation((path) => {
        return path.toString().includes('.gitignore');
      });
      vi.mocked(fs.readFile).mockResolvedValue('node_modules\n*.log\n');

      const result = await createTarball('/test/worktree');

      expect(result.excludedFiles).toContain('node_modules');
      expect(result.excludedFiles).toContain('*.log');
    });

    it('should exclude .e2bignore patterns', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      vi.mocked(fsSync.existsSync).mockImplementation((path) => {
        return path.toString().includes('.e2bignore');
      });
      vi.mocked(fs.readFile).mockResolvedValue('secrets/\n.env*\n');

      const result = await createTarball('/test/worktree');

      expect(result.excludedFiles).toContain('secrets/');
      expect(result.excludedFiles).toContain('.env*');
    });

    it('should always exclude sensitive files', async () => {
      const result = await createTarball('/test/worktree');

      expect(result.excludedFiles).toContain('.env');
      expect(result.excludedFiles.some(p => p.includes('.pem'))).toBe(true);
    });

    it('should validate worktree path', async () => {
      await expect(createTarball('/test/../../../etc/passwd')).rejects.toThrow(
        /directory traversal/
      );
    });

    it('should reject relative paths', async () => {
      await expect(createTarball('relative/path')).rejects.toThrow(/absolute path/);
    });

    it('should handle tar command errors', async () => {
      const { execSync } = await import('child_process');
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('tar: command failed');
      });

      await expect(createTarball('/test/worktree')).rejects.toThrow(/Tarball creation failed/);
    });

    it('should set gzip compression level', async () => {
      const { execSync } = await import('child_process');

      await createTarball('/test/worktree');

      const calls = vi.mocked(execSync).mock.calls;
      expect(calls[0][1]?.env).toHaveProperty('GZIP', `-${GZIP_LEVEL}`);
    });

    it('should skip comments in .gitignore', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      vi.mocked(fsSync.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue('# Comment\nnode_modules\n# Another comment\n');

      const result = await createTarball('/test/worktree');

      expect(result.excludedFiles).toContain('node_modules');
      expect(result.excludedFiles).not.toContain('# Comment');
    });

    it('should skip empty lines in .gitignore', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      vi.mocked(fsSync.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue('\n\nnode_modules\n\n');

      const result = await createTarball('/test/worktree');

      expect(result.excludedFiles).toContain('node_modules');
      expect(result.excludedFiles.filter(p => p === '').length).toBe(0);
    });

    it('should deduplicate exclusion patterns', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      vi.mocked(fsSync.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue('node_modules\nnode_modules\n');

      const result = await createTarball('/test/worktree');

      const nodeModulesCount = result.excludedFiles.filter(p => p === 'node_modules').length;
      expect(nodeModulesCount).toBe(1);
    });

    it('should handle unicode in file patterns', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      vi.mocked(fsSync.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue('中文目录/\némoji-🚀.log\n');

      const result = await createTarball('/test/worktree');

      expect(result.excludedFiles).toContain('中文目录/');
      expect(result.excludedFiles).toContain('emoji-🚀.log');
    });

    it('should include duration in result', async () => {
      const result = await createTarball('/test/worktree');

      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(typeof result.duration).toBe('number');
    });
  });

  describe('uploadToSandbox', () => {
    beforeEach(async () => {
      const fs = await import('fs/promises');

      vi.mocked(fs.stat).mockResolvedValue({
        size: 1024 * 1024, // 1MB (small file)
        isFile: () => true
      } as any);
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('tarball-content'));
    });

    it('should upload small tarball without checkpoints', async () => {
      const result = await uploadToSandbox(
        '/tmp/test.tar.gz',
        mockSandbox,
        '/workspace'
      );

      expect(result.success).toBe(true);
      expect(result.remotePath).toBe('/workspace');
      expect(mockSandbox.files.write).toHaveBeenCalledWith(
        '/workspace/worktree.tar.gz',
        expect.any(Buffer)
      );
      expect(mockSandbox.commands.run).toHaveBeenCalledWith(
        expect.stringContaining('tar -xzf')
      );
    });

    it('should use default remote path', async () => {
      const result = await uploadToSandbox('/tmp/test.tar.gz', mockSandbox);

      expect(result.remotePath).toBe('/workspace');
    });

    it('should handle upload errors gracefully', async () => {
      mockSandbox.files.write.mockRejectedValueOnce(new Error('Network error'));

      const result = await uploadToSandbox('/tmp/test.tar.gz', mockSandbox);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });

    it('should return upload metadata on success', async () => {
      const result = await uploadToSandbox('/tmp/test.tar.gz', mockSandbox);

      expect(result).toMatchObject({
        success: true,
        remotePath: '/workspace',
        sizeBytes: expect.any(Number),
        duration: expect.any(Number)
      });
    });

    it('should handle missing tarball file', async () => {
      const fs = await import('fs/promises');
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT: file not found'));

      const result = await uploadToSandbox('/tmp/missing.tar.gz', mockSandbox);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ENOENT');
    });

    it('should extract tarball in sandbox after upload', async () => {
      await uploadToSandbox('/tmp/test.tar.gz', mockSandbox, '/custom');

      expect(mockSandbox.commands.run).toHaveBeenCalledWith(
        expect.stringMatching(/tar -xzf.*\/custom/)
      );
    });

    it('should use resumable upload for large files', async () => {
      const fs = await import('fs/promises');

      // Mock large file (60MB > CHECKPOINT_SIZE_BYTES)
      vi.mocked(fs.stat).mockResolvedValue({
        size: 60 * 1024 * 1024,
        isFile: () => true
      } as any);

      const mockFileHandle = {
        read: vi.fn().mockResolvedValue({
          bytesRead: CHECKPOINT_SIZE_BYTES,
          buffer: Buffer.alloc(CHECKPOINT_SIZE_BYTES)
        }),
        close: vi.fn().mockResolvedValue(undefined)
      };
      vi.mocked(fs.open).mockResolvedValue(mockFileHandle as any);

      const result = await uploadToSandbox('/tmp/large.tar.gz', mockSandbox);

      expect(result.checkpoints).toBeGreaterThan(0);
      expect(mockFileHandle.read).toHaveBeenCalled();
    });

    it('should combine chunks after resumable upload', async () => {
      const fs = await import('fs/promises');

      vi.mocked(fs.stat).mockResolvedValue({
        size: 60 * 1024 * 1024,
        isFile: () => true
      } as any);

      const mockFileHandle = {
        read: vi.fn().mockResolvedValue({
          bytesRead: CHECKPOINT_SIZE_BYTES,
          buffer: Buffer.alloc(CHECKPOINT_SIZE_BYTES)
        }),
        close: vi.fn()
      };
      vi.mocked(fs.open).mockResolvedValue(mockFileHandle as any);

      await uploadToSandbox('/tmp/large.tar.gz', mockSandbox);

      // Should combine chunks
      const combineCalls = mockSandbox.commands.run.mock.calls.filter((call: any) =>
        call[0].includes('cat') && call[0].includes('part')
      );
      expect(combineCalls.length).toBeGreaterThan(0);
    });

    it('should cleanup chunk files after combining', async () => {
      const fs = await import('fs/promises');

      vi.mocked(fs.stat).mockResolvedValue({
        size: 60 * 1024 * 1024,
        isFile: () => true
      } as any);

      const mockFileHandle = {
        read: vi.fn().mockResolvedValue({
          bytesRead: CHECKPOINT_SIZE_BYTES,
          buffer: Buffer.alloc(CHECKPOINT_SIZE_BYTES)
        }),
        close: vi.fn()
      };
      vi.mocked(fs.open).mockResolvedValue(mockFileHandle as any);

      await uploadToSandbox('/tmp/large.tar.gz', mockSandbox);

      // Should remove chunk files
      const removeCalls = mockSandbox.commands.run.mock.calls.filter((call: any) =>
        call[0].includes('rm') && call[0].includes('part')
      );
      expect(removeCalls.length).toBeGreaterThan(0);
    });

    it('should handle resumable upload errors', async () => {
      const fs = await import('fs/promises');

      vi.mocked(fs.stat).mockResolvedValue({
        size: 60 * 1024 * 1024,
        isFile: () => true
      } as any);

      const mockFileHandle = {
        read: vi.fn().mockRejectedValue(new Error('Read error')),
        close: vi.fn()
      };
      vi.mocked(fs.open).mockResolvedValue(mockFileHandle as any);

      const result = await uploadToSandbox('/tmp/large.tar.gz', mockSandbox);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Read error');
    });

    it('should close file handle even on error', async () => {
      const fs = await import('fs/promises');

      vi.mocked(fs.stat).mockResolvedValue({
        size: 60 * 1024 * 1024,
        isFile: () => true
      } as any);

      const mockFileHandle = {
        read: vi.fn().mockRejectedValue(new Error('Read error')),
        close: vi.fn()
      };
      vi.mocked(fs.open).mockResolvedValue(mockFileHandle as any);

      await uploadToSandbox('/tmp/large.tar.gz', mockSandbox);

      expect(mockFileHandle.close).toHaveBeenCalled();
    });

    it('should include duration in result', async () => {
      const result = await uploadToSandbox('/tmp/test.tar.gz', mockSandbox);

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('downloadChangedFiles', () => {
    beforeEach(async () => {
      const fs = await import('fs/promises');
      const childProcess = await import('child_process');

      mockSandbox.commands.run.mockResolvedValue({
        stdout: ' M src/file1.ts\n M src/file2.ts\n',
        stderr: '',
        exitCode: 0
      });
      mockSandbox.files.read.mockResolvedValue(Buffer.from('tarball-content'));

      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.stat).mockResolvedValue({ size: 1024 } as any);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      vi.mocked(childProcess.execSync).mockReturnValue(Buffer.from(''));
    });

    it('should download only changed files', async () => {
      const result = await downloadChangedFiles(
        mockSandbox,
        '/workspace',
        '/local/worktree'
      );

      expect(result.success).toBe(true);
      expect(result.filesDownloaded).toBe(2);
      expect(mockSandbox.commands.run).toHaveBeenCalledWith(
        'git status --porcelain',
        expect.any(Object)
      );
    });

    it('should handle no changed files', async () => {
      mockSandbox.commands.run.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0
      });

      const result = await downloadChangedFiles(mockSandbox, '/workspace', '/local');

      expect(result.success).toBe(true);
      expect(result.filesDownloaded).toBe(0);
    });

    it('should create tarball of changed files in sandbox', async () => {
      await downloadChangedFiles(mockSandbox, '/workspace', '/local');

      const tarCalls = mockSandbox.commands.run.mock.calls.filter((call: any) =>
        call[0].includes('tar -czf')
      );
      expect(tarCalls.length).toBeGreaterThan(0);
    });

    it('should download tarball from sandbox', async () => {
      await downloadChangedFiles(mockSandbox, '/workspace', '/local');

      expect(mockSandbox.files.read).toHaveBeenCalledWith('/tmp/changed-files.tar.gz');
    });

    it('should extract tarball to local worktree', async () => {
      const { execSync } = await import('child_process');

      await downloadChangedFiles(mockSandbox, '/workspace', '/local');

      expect(execSync).toHaveBeenCalledWith(
        expect.stringMatching(/tar -xzf/),
        expect.any(Object)
      );
    });

    it('should cleanup temporary tarball', async () => {
      const fs = await import('fs/promises');

      await downloadChangedFiles(mockSandbox, '/workspace', '/local');

      expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('changed-files'));
    });

    it('should handle download errors', async () => {
      mockSandbox.files.read.mockRejectedValueOnce(new Error('Network error'));

      const result = await downloadChangedFiles(mockSandbox, '/workspace', '/local');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });

    it('should parse git status correctly', async () => {
      mockSandbox.commands.run.mockResolvedValueOnce({
        stdout: ' M file1.ts\nA  file2.ts\nD  file3.ts\n',
        stderr: '',
        exitCode: 0
      });

      const result = await downloadChangedFiles(mockSandbox, '/workspace', '/local');

      expect(result.filesDownloaded).toBe(3);
    });

    it('should handle renamed files in git status', async () => {
      mockSandbox.commands.run.mockResolvedValueOnce({
        stdout: 'R  old.ts -> new.ts\n',
        stderr: '',
        exitCode: 0
      });

      const result = await downloadChangedFiles(mockSandbox, '/workspace', '/local');

      expect(result.filesDownloaded).toBe(1);
    });

    it('should include duration in result', async () => {
      const result = await downloadChangedFiles(mockSandbox, '/workspace', '/local');

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should return download size', async () => {
      const result = await downloadChangedFiles(mockSandbox, '/workspace', '/local');

      expect(result.sizeBytes).toBeGreaterThan(0);
    });
  });

  describe('verifyUpload', () => {
    beforeEach(() => {
      mockSandbox.commands.run
        .mockResolvedValueOnce({ stdout: '100\n', stderr: '', exitCode: 0 }) // file count
        .mockResolvedValueOnce({ stdout: '1048576\n', stderr: '', exitCode: 0 }); // size
    });

    it('should verify upload with correct file count and size', async () => {
      const result = await verifyUpload(
        mockSandbox,
        '/workspace',
        100,
        1048576
      );

      expect(result.verified).toBe(true);
      expect(result.actualFileCount).toBe(100);
      expect(result.actualSize).toBe(1048576);
    });

    it('should fail verification on file count mismatch', async () => {
      const result = await verifyUpload(
        mockSandbox,
        '/workspace',
        50, // Expected 50
        1048576
      );

      expect(result.verified).toBe(false);
      expect(result.expectedFileCount).toBe(50);
      expect(result.actualFileCount).toBe(100);
    });

    it('should allow 1% size tolerance', async () => {
      // Actual: 1048576, Expected: 1038576 (0.95% difference)
      const result = await verifyUpload(
        mockSandbox,
        '/workspace',
        100,
        1038576
      );

      expect(result.verified).toBe(true);
    });

    it('should fail verification on large size mismatch', async () => {
      // More than 1% difference
      const result = await verifyUpload(
        mockSandbox,
        '/workspace',
        100,
        500000 // 50% of actual
      );

      expect(result.verified).toBe(false);
    });

    it('should execute file count command', async () => {
      await verifyUpload(mockSandbox, '/workspace', 100, 1048576);

      expect(mockSandbox.commands.run).toHaveBeenCalledWith(
        expect.stringMatching(/find.*wc -l/),
        expect.any(Object)
      );
    });

    it('should execute size command', async () => {
      await verifyUpload(mockSandbox, '/workspace', 100, 1048576);

      expect(mockSandbox.commands.run).toHaveBeenCalledWith(
        expect.stringMatching(/du -sb/),
        expect.any(Object)
      );
    });

    it('should handle verification errors', async () => {
      mockSandbox.commands.run.mockRejectedValueOnce(new Error('Command failed'));

      const result = await verifyUpload(mockSandbox, '/workspace', 100, 1048576);

      expect(result.verified).toBe(false);
      expect(result.error).toContain('Command failed');
    });

    it('should return expected values in result', async () => {
      const result = await verifyUpload(mockSandbox, '/workspace', 100, 1048576);

      expect(result.expectedFileCount).toBe(100);
      expect(result.expectedSize).toBe(1048576);
    });

    it('should handle invalid command output', async () => {
      mockSandbox.commands.run
        .mockResolvedValueOnce({ stdout: 'invalid\n', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: '1048576\n', stderr: '', exitCode: 0 });

      const result = await verifyUpload(mockSandbox, '/workspace', 100, 1048576);

      expect(result.verified).toBe(false);
    });
  });

  describe('scanForCredentials', () => {
    beforeEach(async () => {
      const fs = await import('fs/promises');

      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'file1.ts', isDirectory: () => false, isFile: () => true },
        { name: 'file2.js', isDirectory: () => false, isFile: () => true }
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValue('clean file content');
    });

    it('should scan files for sensitive patterns', async () => {
      const result = await scanForCredentials('/test/worktree');

      expect(result).toMatchObject({
        hasSuspiciousFiles: expect.any(Boolean),
        suspiciousFiles: expect.any(Array),
        patterns: expect.any(Array),
        recommendation: expect.any(String)
      });
    });

    it('should detect API_KEY pattern', async () => {
      const fs = await import('fs/promises');
      vi.mocked(fs.readFile).mockResolvedValueOnce('const API_KEY = "secret123"');

      const result = await scanForCredentials('/test/worktree');

      expect(result.hasSuspiciousFiles).toBe(true);
      expect(result.suspiciousFiles.length).toBeGreaterThan(0);
    });

    it('should detect PASSWORD pattern', async () => {
      const fs = await import('fs/promises');
      vi.mocked(fs.readFile).mockResolvedValueOnce('const PASSWORD = "hunter2"');

      const result = await scanForCredentials('/test/worktree');

      expect(result.hasSuspiciousFiles).toBe(true);
    });

    it('should detect SECRET pattern', async () => {
      const fs = await import('fs/promises');
      vi.mocked(fs.readFile).mockResolvedValueOnce('const CLIENT_SECRET = "abc123"');

      const result = await scanForCredentials('/test/worktree');

      expect(result.hasSuspiciousFiles).toBe(true);
    });

    it('should detect TOKEN pattern', async () => {
      const fs = await import('fs/promises');
      vi.mocked(fs.readFile).mockResolvedValueOnce('const AUTH_TOKEN = "xyz789"');

      const result = await scanForCredentials('/test/worktree');

      expect(result.hasSuspiciousFiles).toBe(true);
    });

    it('should detect PRIVATE_KEY pattern', async () => {
      const fs = await import('fs/promises');
      vi.mocked(fs.readFile).mockResolvedValueOnce('-----BEGIN PRIVATE KEY-----');

      const result = await scanForCredentials('/test/worktree');

      expect(result.hasSuspiciousFiles).toBe(true);
    });

    it('should be case insensitive', async () => {
      const fs = await import('fs/promises');
      vi.mocked(fs.readFile).mockResolvedValueOnce('const api_key = "secret"');

      const result = await scanForCredentials('/test/worktree');

      expect(result.hasSuspiciousFiles).toBe(true);
    });

    it('should return clean result for safe files', async () => {
      const fs = await import('fs/promises');
      vi.mocked(fs.readFile).mockResolvedValue('function hello() { return "world"; }');

      const result = await scanForCredentials('/test/worktree');

      expect(result.hasSuspiciousFiles).toBe(false);
      expect(result.suspiciousFiles).toEqual([]);
      expect(result.recommendation).toContain('No sensitive patterns');
    });

    it('should provide warning recommendation when suspicious files found', async () => {
      const fs = await import('fs/promises');
      vi.mocked(fs.readFile).mockResolvedValueOnce('const API_KEY = "secret"');

      const result = await scanForCredentials('/test/worktree');

      expect(result.recommendation).toContain('WARNING');
    });

    it('should skip node_modules directory', async () => {
      const fs = await import('fs/promises');

      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'node_modules', isDirectory: () => true, isFile: () => false },
        { name: 'file.ts', isDirectory: () => false, isFile: () => true }
      ] as any);

      await scanForCredentials('/test/worktree');

      // Should only read file.ts, not descend into node_modules
      expect(fs.readFile).toHaveBeenCalledTimes(1);
    });

    it('should skip .git directory', async () => {
      const fs = await import('fs/promises');

      vi.mocked(fs.readdir).mockResolvedValue([
        { name: '.git', isDirectory: () => true, isFile: () => false },
        { name: 'file.ts', isDirectory: () => false, isFile: () => true }
      ] as any);

      await scanForCredentials('/test/worktree');

      expect(fs.readFile).toHaveBeenCalledTimes(1);
    });

    it('should skip binary files by extension', async () => {
      const fs = await import('fs/promises');

      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'image.png', isDirectory: () => false, isFile: () => true },
        { name: 'file.ts', isDirectory: () => false, isFile: () => true }
      ] as any);

      await scanForCredentials('/test/worktree');

      // Should only scan text file
      expect(fs.readFile).toHaveBeenCalledTimes(1);
    });

    it('should scan common text file extensions', async () => {
      const fs = await import('fs/promises');

      const textFiles = [
        'file.js',
        'file.ts',
        'file.py',
        'file.go',
        'file.java',
        'file.yml',
        'file.json',
        'file.md'
      ];

      vi.mocked(fs.readdir).mockResolvedValue(
        textFiles.map(name => ({
          name,
          isDirectory: () => false,
          isFile: () => true
        })) as any
      );

      await scanForCredentials('/test/worktree');

      expect(fs.readFile).toHaveBeenCalledTimes(textFiles.length);
    });

    it('should handle file read errors gracefully', async () => {
      const fs = await import('fs/promises');
      vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('Permission denied'));

      const result = await scanForCredentials('/test/worktree');

      // Should complete scan despite error
      expect(result).toBeDefined();
    });

    it('should include matched pattern sources', async () => {
      const fs = await import('fs/promises');
      vi.mocked(fs.readFile).mockResolvedValueOnce('const API_KEY = "test"');

      const result = await scanForCredentials('/test/worktree');

      expect(result.patterns.length).toBeGreaterThan(0);
    });

    it('should deduplicate pattern matches per file', async () => {
      const fs = await import('fs/promises');
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        'const API_KEY = "test1"; const API_KEY_2 = "test2"'
      );

      const result = await scanForCredentials('/test/worktree');

      // Should only report file once
      expect(result.suspiciousFiles.length).toBe(1);
    });

    it('should handle unicode in file content', async () => {
      const fs = await import('fs/promises');
      vi.mocked(fs.readFile).mockResolvedValue('const msg = "你好世界 🚀"');

      const result = await scanForCredentials('/test/worktree');

      expect(result).toBeDefined();
    });
  });

  describe('SENSITIVE_PATTERNS validation', () => {
    it('should match API_KEY variations', () => {
      const testStrings = [
        'API_KEY',
        'api-key',
        'ApiKey',
        'API KEY'
      ];

      const pattern = SENSITIVE_PATTERNS.find(p => p.source.includes('API'));
      expect(pattern).toBeDefined();

      for (const str of testStrings) {
        expect(pattern!.test(str)).toBe(true);
      }
    });

    it('should match PASSWORD variations', () => {
      const testStrings = [
        'PASSWORD',
        'password',
        'Password',
        'pass_word'
      ];

      const pattern = SENSITIVE_PATTERNS.find(p => p.source.includes('PASSWORD'));
      expect(pattern).toBeDefined();

      for (const str of testStrings) {
        expect(pattern!.test(str)).toBe(true);
      }
    });

    it('should match TOKEN variations', () => {
      const testStrings = [
        'TOKEN',
        'token',
        'auth_token',
        'bearer-token'
      ];

      const pattern = SENSITIVE_PATTERNS.find(p => p.source.includes('TOKEN'));
      expect(pattern).toBeDefined();

      for (const str of testStrings) {
        expect(pattern!.test(str)).toBe(true);
      }
    });

    it('should match AWS patterns', () => {
      const pattern = SENSITIVE_PATTERNS.find(p => p.source.includes('AWS'));
      expect(pattern).toBeDefined();

      expect(pattern!.test('AWS_SECRET')).toBe(true);
      expect(pattern!.test('aws-secret')).toBe(true);
    });

    it('should match STRIPE patterns', () => {
      const pattern = SENSITIVE_PATTERNS.find(p => p.source.includes('STRIPE'));
      expect(pattern).toBeDefined();

      expect(pattern!.test('STRIPE_KEY')).toBe(true);
      expect(pattern!.test('stripe-key')).toBe(true);
    });
  });

  describe('ALWAYS_EXCLUDE validation', () => {
    it('should include .env files', () => {
      expect(ALWAYS_EXCLUDE).toContain('.env');
      expect(ALWAYS_EXCLUDE).toContain('.env.local');
      expect(ALWAYS_EXCLUDE).toContain('.env.production');
    });

    it('should include certificate files', () => {
      expect(ALWAYS_EXCLUDE.some(p => p.includes('.pem'))).toBe(true);
      expect(ALWAYS_EXCLUDE.some(p => p.includes('.p12'))).toBe(true);
    });

    it('should include SSH keys', () => {
      expect(ALWAYS_EXCLUDE).toContain('id_rsa');
      expect(ALWAYS_EXCLUDE).toContain('id_dsa');
      expect(ALWAYS_EXCLUDE).toContain('id_ecdsa');
    });

    it('should include credential files', () => {
      expect(ALWAYS_EXCLUDE).toContain('credentials.json');
      expect(ALWAYS_EXCLUDE.some(p => p.includes('.aws/credentials'))).toBe(true);
    });
  });

  describe('edge cases and error handling', () => {
    it('should handle empty worktree', async () => {
      const fs = await import('fs/promises');
      vi.mocked(fs.readdir).mockResolvedValue([]);

      const result = await scanForCredentials('/test/empty');

      expect(result.hasSuspiciousFiles).toBe(false);
      expect(result.suspiciousFiles).toEqual([]);
    });

    it('should handle very large files', async () => {
      const fs = await import('fs/promises');

      // Mock 100MB file
      vi.mocked(fs.stat).mockResolvedValue({
        size: 100 * 1024 * 1024,
        isFile: () => true
      } as any);

      const result = await createTarball('/test/worktree');

      expect(result).toBeDefined();
    });

    it('should handle files with no extension', async () => {
      const fs = await import('fs/promises');

      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'Dockerfile', isDirectory: () => false, isFile: () => true },
        { name: 'Makefile', isDirectory: () => false, isFile: () => true }
      ] as any);

      const result = await scanForCredentials('/test/worktree');

      expect(result).toBeDefined();
    });

    it('should handle deeply nested directories', async () => {
      const fs = await import('fs/promises');

      vi.mocked(fs.readdir).mockResolvedValue([
        { name: 'deep', isDirectory: () => true, isFile: () => false }
      ] as any);

      const result = await scanForCredentials('/test/worktree');

      expect(result).toBeDefined();
    });

    it('should handle symlinks gracefully', async () => {
      const fs = await import('fs/promises');

      vi.mocked(fs.readdir).mockResolvedValue([
        {
          name: 'symlink',
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => true
        }
      ] as any);

      const result = await scanForCredentials('/test/worktree');

      expect(result).toBeDefined();
    });

    it('should handle concurrent uploads', async () => {
      const promises = [
        uploadToSandbox('/tmp/test1.tar.gz', mockSandbox, '/workspace1'),
        uploadToSandbox('/tmp/test2.tar.gz', mockSandbox, '/workspace2'),
        uploadToSandbox('/tmp/test3.tar.gz', mockSandbox, '/workspace3')
      ];

      const results = await Promise.all(promises);

      expect(results).toHaveLength(3);
      expect(results.every(r => r.success)).toBe(true);
    });

    it('should handle sandbox connection timeout', async () => {
      mockSandbox.files.write.mockImplementation(() => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Timeout')), 100);
        });
      });

      const result = await uploadToSandbox('/tmp/test.tar.gz', mockSandbox);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Timeout');
    });
  });
});
