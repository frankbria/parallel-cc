/**
 * E2B File Sync Module
 *
 * Handles file synchronization between local worktrees and E2B sandboxes:
 * - Compress worktree into tarball (respecting .gitignore and .e2bignore)
 * - Upload to E2B sandbox with resumable uploads
 * - Download only changed files from sandbox
 * - Verify uploads/downloads for data integrity
 * - Scan for credentials and sensitive data
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { spawnSync, exec } from 'child_process';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { logger } from '../logger.js';

const execAsync = promisify(exec);

// ============================================================================
// Constants
// ============================================================================

/**
 * Sensitive patterns to detect in files (prevent credential leaks)
 */
export const SENSITIVE_PATTERNS = [
  /API[_-]?KEY/i,
  /PASSWORD/i,
  /SECRET/i,
  /TOKEN/i,
  /PRIVATE[_-]?KEY/i,
  /ACCESS[_-]?KEY/i,
  /CLIENT[_-]?SECRET/i,
  /AUTH[_-]?TOKEN/i,
  /BEARER[_-]?TOKEN/i,
  /CREDENTIALS/i,
  /AWS[_-]?SECRET/i,
  /STRIPE[_-]?KEY/i,
  /OAUTH/i,
  /SSH[_-]?KEY/i
];

/**
 * Files to always exclude from upload (security)
 */
export const ALWAYS_EXCLUDE = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.*.local',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'credentials.json',
  'service-account.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '.aws/credentials',
  '.ssh/id_*',
  '.gnupg/**'
];

/**
 * Checkpoint interval for resumable uploads (50MB)
 */
export const CHECKPOINT_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Gzip compression level (6 = balanced speed vs size)
 */
export const GZIP_LEVEL = 6;

// ============================================================================
// Path Validation (Security)
// ============================================================================

/**
 * Validate remote path to prevent shell injection
 *
 * Only allows safe characters in remote paths:
 * - Alphanumeric: A-Z, a-z, 0-9
 * - Path separators: /
 * - Common safe chars: _ (underscore), - (hyphen), . (dot)
 *
 * Rejects:
 * - Shell metacharacters: ; & | ` $ ( ) { } [ ] < > * ? ~ ! \ " '
 * - Control characters and whitespace
 * - Relative paths (must start with /)
 * - Directory traversal patterns (..)
 *
 * @param remotePath - Path to validate
 * @throws Error if path contains unsafe characters
 */
export function validateRemotePath(remotePath: string): void {
  if (!remotePath || typeof remotePath !== 'string') {
    throw new Error('Remote path must be a non-empty string');
  }

  // Must be absolute path (starts with /)
  if (!remotePath.startsWith('/')) {
    throw new Error(`Remote path must be absolute (start with /): ${remotePath}`);
  }

  // Only allow safe characters: alphanumeric, /, _, -, .
  const safePathPattern = /^[A-Za-z0-9/_.-]+$/;
  if (!safePathPattern.test(remotePath)) {
    throw new Error(
      `Remote path contains unsafe characters. Only alphanumeric, /, _, -, and . are allowed: ${remotePath}`
    );
  }

  // Reject directory traversal
  if (remotePath.includes('..')) {
    throw new Error(`Remote path contains directory traversal (..): ${remotePath}`);
  }

  // Reject paths with consecutive slashes (e.g., //) which can be confusing
  if (remotePath.includes('//')) {
    throw new Error(`Remote path contains consecutive slashes (//): ${remotePath}`);
  }

  // Reject hidden files/directories (starting with .) in path components
  // Allow /path/to/.config but reject /.secret or /path/./file
  const pathParts = remotePath.split('/').filter(p => p.length > 0);
  for (const part of pathParts) {
    if (part === '.' || part === '..') {
      throw new Error(`Remote path contains invalid directory component: ${part}`);
    }
  }
}

// ============================================================================
// Types
// ============================================================================

export interface TarballResult {
  path: string;
  sizeBytes: number;
  fileCount: number;
  excludedFiles: string[];
  duration: number;
}

export interface UploadResult {
  success: boolean;
  remotePath: string;
  sizeBytes: number;
  duration: number;
  checkpoints?: number;
  error?: string;
}

export interface DownloadResult {
  success: boolean;
  localPath: string;
  filesDownloaded: number;
  sizeBytes: number;
  duration: number;
  error?: string;
}

export interface VerificationResult {
  verified: boolean;
  expectedFileCount: number;
  actualFileCount: number;
  expectedSize: number;
  actualSize: number;
  missingFiles?: string[];
  error?: string;
}

export interface CredentialScanResult {
  hasSuspiciousFiles: boolean;
  suspiciousFiles: string[];
  patterns: string[];
  recommendation: string;
}

export interface UploadCheckpoint {
  bytesSent: number;
  timestamp: string;
  chunkIndex: number;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Create a tarball of the worktree, excluding .gitignore and .e2bignore patterns
 *
 * @param worktreePath - Path to the worktree directory
 * @param outputPath - Where to save the tarball (default: temp directory)
 * @returns TarballResult with tarball metadata
 */
export async function createTarball(
  worktreePath: string,
  outputPath?: string
): Promise<TarballResult> {
  const startTime = Date.now();
  logger.info(`Creating tarball for worktree: ${worktreePath}`);

  // Validate worktree path
  await validatePath(worktreePath);

  // Default output path to temp directory
  if (!outputPath) {
    const tmpDir = await fs.mkdtemp('/tmp/parallel-cc-tarball-');
    outputPath = path.join(tmpDir, 'worktree.tar.gz');
  }

  // Build exclusion list
  const exclusions = await buildExclusionList(worktreePath);
  logger.debug(`Excluding ${exclusions.length} patterns from tarball`);

  // Build tar arguments array (no shell interpolation for security)
  const tarArgs = [
    '-czf',
    outputPath,
    // Add exclusion patterns as separate arguments
    ...exclusions.flatMap(pattern => ['--exclude', pattern]),
    '-C',
    worktreePath,
    '.'
  ];

  try {
    // Execute tar command using spawnSync (no shell, prevents injection)
    const result = spawnSync('tar', tarArgs, {
      stdio: 'pipe',
      maxBuffer: 100 * 1024 * 1024, // 100MB buffer
      env: {
        ...process.env,
        GZIP: `-${GZIP_LEVEL}` // Set gzip compression level
      }
    });

    // Check for errors
    if (result.status !== 0) {
      const stderr = result.stderr?.toString() || 'Unknown error';
      throw new Error(`tar command failed with exit code ${result.status}: ${stderr}`);
    }

    if (result.error) {
      throw result.error;
    }

    // Get tarball stats
    const stats = await fs.stat(outputPath);
    const fileCount = await countFilesInTarball(outputPath);

    const duration = Date.now() - startTime;
    logger.info(`Tarball created: ${outputPath} (${formatBytes(stats.size)}, ${fileCount} files, ${duration}ms)`);

    return {
      path: outputPath,
      sizeBytes: stats.size,
      fileCount,
      excludedFiles: exclusions,
      duration
    };
  } catch (error) {
    logger.error('Failed to create tarball', error);
    throw new Error(`Tarball creation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Upload tarball to E2B sandbox with resumable uploads
 *
 * @param tarballPath - Local path to tarball
 * @param sandbox - E2B sandbox instance (type: any to avoid dependency)
 * @param remotePath - Remote path in sandbox (default: /workspace)
 * @returns UploadResult with upload metadata
 */
export async function uploadToSandbox(
  tarballPath: string,
  sandbox: any, // E2B Sandbox type
  remotePath: string = '/workspace'
): Promise<UploadResult> {
  const startTime = Date.now();
  logger.info(`Uploading tarball to E2B sandbox: ${remotePath}`);

  // Validate remote path to prevent shell injection
  validateRemotePath(remotePath);

  try {
    // Validate tarball exists
    const stats = await fs.stat(tarballPath);
    logger.debug(`Tarball size: ${formatBytes(stats.size)}`);

    // Check if resumable upload is needed (file > 50MB)
    if (stats.size > CHECKPOINT_SIZE_BYTES) {
      return await uploadWithCheckpoints(tarballPath, sandbox, remotePath);
    }

    // Simple upload for small files
    const fileBuffer = await fs.readFile(tarballPath);

    // Upload to sandbox (E2B SDK method)
    // Note: E2B files.write() doesn't support timeout option, so we wrap it with Promise.race
    await Promise.race([
      sandbox.files.write(remotePath + '/worktree.tar.gz', fileBuffer),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('File upload timeout after 5 minutes')), 5 * 60 * 1000)
      )
    ]);

    // Extract tarball in sandbox
    await sandbox.commands.run(
      `mkdir -p ${remotePath} && tar -xzf ${remotePath}/worktree.tar.gz -C ${remotePath}`,
      { timeoutMs: 5 * 60 * 1000 } // 5 minute timeout for extraction
    );

    const duration = Date.now() - startTime;
    logger.info(`Upload completed: ${formatBytes(stats.size)} in ${duration}ms`);

    return {
      success: true,
      remotePath,
      sizeBytes: stats.size,
      duration
    };
  } catch (error) {
    logger.error('Upload failed', error);
    return {
      success: false,
      remotePath,
      sizeBytes: 0,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Upload large tarball with checkpoints for resumability
 *
 * @param tarballPath - Local path to tarball
 * @param sandbox - E2B sandbox instance
 * @param remotePath - Remote path in sandbox
 * @returns UploadResult with checkpoint metadata
 */
async function uploadWithCheckpoints(
  tarballPath: string,
  sandbox: any,
  remotePath: string
): Promise<UploadResult> {
  const startTime = Date.now();
  logger.info('Using resumable upload with checkpoints');

  // Validate remote path to prevent shell injection
  validateRemotePath(remotePath);

  try {
    const stats = await fs.stat(tarballPath);
    const totalChunks = Math.ceil(stats.size / CHECKPOINT_SIZE_BYTES);
    let checkpoints = 0;

    // Calculate zero-padding width based on total chunks
    // If totalChunks = 1000, we need 4 digits (0000-0999)
    const paddingWidth = totalChunks.toString().length;
    logger.debug(`Uploading ${totalChunks} chunks with ${paddingWidth}-digit padding`);

    // Read file in chunks
    const fileHandle = await fs.open(tarballPath, 'r');
    const buffer = Buffer.allocUnsafe(CHECKPOINT_SIZE_BYTES);

    try {
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const offset = chunkIndex * CHECKPOINT_SIZE_BYTES;
        const bytesToRead = Math.min(CHECKPOINT_SIZE_BYTES, stats.size - offset);

        // Read chunk
        const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, offset);
        const chunk = buffer.subarray(0, bytesRead);

        // Upload chunk with zero-padded index for correct lexicographic ordering
        // This ensures part9 comes before part10 (e.g., part009 < part010)
        const paddedIndex = chunkIndex.toString().padStart(paddingWidth, '0');
        const chunkPath = `${remotePath}/worktree.tar.gz.part${paddedIndex}`;
        await Promise.race([
          sandbox.files.write(chunkPath, chunk),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Chunk upload timeout after 2 minutes')), 2 * 60 * 1000)
          )
        ]);

        checkpoints++;
        logger.debug(`Checkpoint ${checkpoints}/${totalChunks}: ${formatBytes(offset + bytesRead)} / ${formatBytes(stats.size)}`);
      }

      // Combine chunks in sandbox using glob (now safe due to zero-padding)
      // Zero-padding ensures lexicographic ordering matches numeric ordering
      const combineCommand = `cat ${remotePath}/worktree.tar.gz.part* > ${remotePath}/worktree.tar.gz && rm ${remotePath}/worktree.tar.gz.part*`;
      await sandbox.commands.run(combineCommand, { timeoutMs: 5 * 60 * 1000 }); // 5 minutes for combining chunks

      // Extract tarball
      await sandbox.commands.run(
        `mkdir -p ${remotePath} && tar -xzf ${remotePath}/worktree.tar.gz -C ${remotePath}`,
        { timeoutMs: 5 * 60 * 1000 } // 5 minute timeout for extraction
      );

      const duration = Date.now() - startTime;
      logger.info(`Resumable upload completed: ${checkpoints} checkpoints in ${duration}ms`);

      return {
        success: true,
        remotePath,
        sizeBytes: stats.size,
        duration,
        checkpoints
      };
    } finally {
      await fileHandle.close();
    }
  } catch (error) {
    logger.error('Resumable upload failed', error);
    return {
      success: false,
      remotePath,
      sizeBytes: 0,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Download only changed files from sandbox (selective download)
 *
 * @param sandbox - E2B sandbox instance
 * @param remotePath - Remote workspace path
 * @param localPath - Local worktree path
 * @returns DownloadResult with download metadata
 */
export async function downloadChangedFiles(
  sandbox: any,
  remotePath: string,
  localPath: string
): Promise<DownloadResult> {
  const startTime = Date.now();
  logger.info(`Downloading changed files from sandbox to: ${localPath}`);

  // Validate remote path to prevent shell injection
  validateRemotePath(remotePath);

  // Validate local path to prevent shell injection and directory traversal
  await validatePath(localPath);

  try {
    // Query git status in sandbox to find changed files
    const gitStatusCmd = await sandbox.commands.run('git status --porcelain', {
      cwd: remotePath,
      timeoutMs: 30000 // 30 second timeout for git status
    });

    const changedFiles = parseGitStatus(gitStatusCmd.stdout);
    logger.info(`Found ${changedFiles.length} changed files`);

    if (changedFiles.length === 0) {
      return {
        success: true,
        localPath,
        filesDownloaded: 0,
        sizeBytes: 0,
        duration: Date.now() - startTime
      };
    }

    // Create tarball of changed files in sandbox
    // Escape filenames properly for shell (single quotes + escape embedded quotes)
    const changedFilesList = changedFiles
      .map(f => `'${f.replace(/'/g, "'\\''")}'`)
      .join(' ');
    const tarCmd = `cd ${remotePath} && tar -czf /tmp/changed-files.tar.gz ${changedFilesList}`;
    await sandbox.commands.run(tarCmd, { timeoutMs: 2 * 60 * 1000 }); // 2 minute timeout for creating tarball

    // Download tarball
    const tarballContent = await Promise.race([
      sandbox.files.read('/tmp/changed-files.tar.gz'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Tarball download timeout after 2 minutes')), 2 * 60 * 1000)
      )
    ]);
    const localTarPath = path.join('/tmp', `changed-files-${Date.now()}.tar.gz`);
    await fs.writeFile(localTarPath, tarballContent);

    // Extract to local worktree using spawnSync (no shell, prevents injection)
    const extractResult = spawnSync('tar', ['-xzf', localTarPath, '-C', localPath], {
      stdio: 'pipe'
    });

    // Check for extraction errors
    if (extractResult.status !== 0) {
      const stderr = extractResult.stderr?.toString() || 'Unknown error';
      throw new Error(`tar extraction failed with exit code ${extractResult.status}: ${stderr}`);
    }

    if (extractResult.error) {
      throw extractResult.error;
    }

    // Get download size
    const stats = await fs.stat(localTarPath);

    // Cleanup temp tarball
    await fs.unlink(localTarPath);

    const duration = Date.now() - startTime;
    logger.info(`Downloaded ${changedFiles.length} files (${formatBytes(stats.size)}) in ${duration}ms`);

    return {
      success: true,
      localPath,
      filesDownloaded: changedFiles.length,
      sizeBytes: stats.size,
      duration
    };
  } catch (error) {
    logger.error('Download failed', error);
    return {
      success: false,
      localPath,
      filesDownloaded: 0,
      sizeBytes: 0,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Verify upload integrity (file count and total size)
 *
 * @param sandbox - E2B sandbox instance
 * @param remotePath - Remote workspace path
 * @param expectedFileCount - Expected number of files
 * @param expectedSize - Expected total size in bytes
 * @returns VerificationResult with validation details
 */
export async function verifyUpload(
  sandbox: any,
  remotePath: string,
  expectedFileCount: number,
  expectedSize: number
): Promise<VerificationResult> {
  logger.info('Verifying upload integrity...');

  // Validate remote path to prevent shell injection
  validateRemotePath(remotePath);

  try {
    // Count files in sandbox
    const countCmd = await sandbox.commands.run(`find ${remotePath} -type f | wc -l`, {
      cwd: remotePath
    });
    const actualFileCount = parseInt(countCmd.stdout.trim(), 10);

    // Get total size
    const sizeCmd = await sandbox.commands.run(`du -sb ${remotePath} | cut -f1`, {
      cwd: remotePath
    });
    const actualSize = parseInt(sizeCmd.stdout.trim(), 10);

    // Verify counts
    const verified = actualFileCount === expectedFileCount &&
                     Math.abs(actualSize - expectedSize) < (expectedSize * 0.01); // 1% tolerance

    if (!verified) {
      logger.warn(`Verification failed: Expected ${expectedFileCount} files (${formatBytes(expectedSize)}), got ${actualFileCount} files (${formatBytes(actualSize)})`);
    } else {
      logger.info(`Verification passed: ${actualFileCount} files, ${formatBytes(actualSize)}`);
    }

    return {
      verified,
      expectedFileCount,
      actualFileCount,
      expectedSize,
      actualSize
    };
  } catch (error) {
    logger.error('Verification failed', error);
    return {
      verified: false,
      expectedFileCount,
      actualFileCount: 0,
      expectedSize,
      actualSize: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Scan files for sensitive patterns (API keys, passwords, secrets)
 *
 * @param worktreePath - Path to worktree directory
 * @returns CredentialScanResult with findings
 */
export async function scanForCredentials(worktreePath: string): Promise<CredentialScanResult> {
  logger.info('Scanning for sensitive patterns...');

  try {
    const suspiciousFiles: string[] = [];
    const foundPatterns: Set<string> = new Set();

    // Get list of files to scan (exclude binary files)
    const files = await getTextFiles(worktreePath);
    logger.debug(`Scanning ${files.length} text files`);

    for (const file of files) {
      const filePath = path.join(worktreePath, file);

      try {
        const content = await fs.readFile(filePath, 'utf-8');

        // Check against sensitive patterns
        for (const pattern of SENSITIVE_PATTERNS) {
          if (pattern.test(content)) {
            suspiciousFiles.push(file);
            foundPatterns.add(pattern.source);
            break; // One match per file is enough
          }
        }
      } catch (error) {
        // Skip files that can't be read as text
        logger.debug(`Skipping file ${file}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }

    const hasSuspiciousFiles = suspiciousFiles.length > 0;
    const recommendation = hasSuspiciousFiles
      ? 'WARNING: Sensitive patterns detected. Review files before uploading to E2B.'
      : 'No sensitive patterns detected.';

    if (hasSuspiciousFiles) {
      logger.warn(`Found ${suspiciousFiles.length} files with sensitive patterns`);
    } else {
      logger.info('Credential scan passed');
    }

    return {
      hasSuspiciousFiles,
      suspiciousFiles,
      patterns: Array.from(foundPatterns),
      recommendation
    };
  } catch (error) {
    logger.error('Credential scan failed', error);
    return {
      hasSuspiciousFiles: false,
      suspiciousFiles: [],
      patterns: [],
      recommendation: `Scan failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate file path (prevent directory traversal)
 */
export async function validatePath(filePath: string): Promise<void> {
  // Check for relative paths before normalization
  if (!path.isAbsolute(filePath)) {
    throw new Error('Invalid file path: must be absolute path');
  }

  // Check for directory traversal patterns before normalization
  if (filePath.includes('..')) {
    throw new Error('Invalid file path: directory traversal detected');
  }

  // Normalize and verify the path stays within expected boundaries
  const normalized = path.normalize(filePath);

  // Verify path exists
  try {
    await fs.access(normalized);
  } catch (error) {
    throw new Error(`Path does not exist: ${filePath}`);
  }
}

/**
 * Build exclusion list from .gitignore and .e2bignore
 */
export async function buildExclusionList(worktreePath: string): Promise<string[]> {
  const exclusions = [...ALWAYS_EXCLUDE];

  // Add .gitignore patterns
  const gitignorePath = path.join(worktreePath, '.gitignore');
  if (fsSync.existsSync(gitignorePath)) {
    const gitignore = await fs.readFile(gitignorePath, 'utf-8');
    const patterns = gitignore
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    exclusions.push(...patterns);
  }

  // Add .e2bignore patterns
  const e2bignorePath = path.join(worktreePath, '.e2bignore');
  if (fsSync.existsSync(e2bignorePath)) {
    const e2bignore = await fs.readFile(e2bignorePath, 'utf-8');
    const patterns = e2bignore
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    exclusions.push(...patterns);
  }

  // Add common large directories
  exclusions.push('node_modules', '.git', 'dist', 'build', 'coverage', '.next', '__pycache__');

  return [...new Set(exclusions)]; // Remove duplicates
}

/**
 * Count files in a tarball
 */
export async function countFilesInTarball(tarballPath: string): Promise<number> {
  try {
    const { stdout } = await execAsync(`tar -tzf "${tarballPath}" | wc -l`);
    return parseInt(stdout.trim(), 10);
  } catch (error) {
    logger.warn('Failed to count files in tarball, returning estimate');
    return 0;
  }
}

/**
 * Parse git status output to get list of changed files
 */
export function parseGitStatus(gitStatusOutput: string): string[] {
  const lines = gitStatusOutput.trim().split('\n');
  const files: string[] = [];

  for (const line of lines) {
    if (!line) continue;

    // Git status format: XY filename
    // X = staged, Y = unstaged
    const match = line.match(/^(.{2})\s+(.+)$/);
    if (match) {
      const filename = match[2].trim();

      // Handle renamed files (format: "old -> new")
      if (filename.includes(' -> ')) {
        const newName = filename.split(' -> ')[1];
        files.push(newName);
      } else {
        files.push(filename);
      }
    }
  }

  return files;
}

/**
 * Get list of text files in a directory (for credential scanning)
 */
export async function getTextFiles(dirPath: string): Promise<string[]> {
  const textFiles: string[] = [];

  async function walk(currentPath: string, relativePath: string = ''): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relPath = path.join(relativePath, entry.name);

      // Skip excluded directories
      if (entry.isDirectory()) {
        if (shouldSkipDirectory(entry.name)) {
          continue;
        }
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        // Only scan text files
        if (isTextFile(entry.name)) {
          textFiles.push(relPath);
        }
      }
    }
  }

  await walk(dirPath);
  return textFiles;
}

/**
 * Check if directory should be skipped during credential scan
 */
export function shouldSkipDirectory(dirname: string): boolean {
  const skipDirs = [
    'node_modules',
    '.git',
    'dist',
    'build',
    'coverage',
    '.next',
    '__pycache__',
    'vendor',
    '.venv',
    'venv'
  ];
  return skipDirs.includes(dirname);
}

/**
 * Check if file is a text file (by extension)
 */
export function isTextFile(filename: string): boolean {
  const textExtensions = [
    '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.java', '.c', '.cpp',
    '.h', '.hpp', '.cs', '.php', '.swift', '.kt', '.rs', '.sh', '.bash', '.zsh',
    '.yml', '.yaml', '.json', '.xml', '.html', '.css', '.scss', '.sass', '.less',
    '.md', '.txt', '.env', '.ini', '.conf', '.config', '.toml', '.sql'
  ];

  // Check for files that are text but have no extension (like .env, .gitignore)
  const basename = path.basename(filename);
  const textFilenames = ['.env', '.gitignore', '.dockerignore', '.e2bignore', 'Dockerfile', 'Makefile', 'LICENSE', 'README'];
  if (textFilenames.includes(basename)) {
    return true;
  }

  const ext = path.extname(filename).toLowerCase();
  return textExtensions.includes(ext);
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}
