/**
 * SSH Key Injector for E2B Sandboxes
 *
 * Enables private repository access by securely injecting SSH keys into E2B sandboxes.
 *
 * Security Features:
 * - Key validation (existence, permissions, format)
 * - Security warnings before transmission
 * - Proper permissions (700 for .ssh, 600 for keys)
 * - Known hosts configuration for common git providers
 * - Cleanup after execution
 *
 * Usage:
 * 1. validateSSHKeyPath() - Validate key before use
 * 2. getSecurityWarning() - Display warning to user
 * 3. injectSSHKey() - Inject key into sandbox
 * 4. cleanupSSHKey() - Remove key after execution
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { Sandbox } from 'e2b';
import type { Logger } from '../logger.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Result of SSH key validation
 */
export interface SSHValidationResult {
  /** Whether the key is valid for use */
  valid: boolean;
  /** Detected key type (rsa, ed25519, ecdsa, dsa, openssh) */
  keyType?: string;
  /** Whether file permissions are secure */
  permissionsOk: boolean;
  /** Warning about permissions or key format */
  permissionsWarning?: string;
  /** Error message if validation failed */
  error?: string;
}

/**
 * Result of SSH key injection
 */
export interface SSHInjectionResult {
  /** Whether injection succeeded */
  success: boolean;
  /** Key fingerprint (partially redacted for logging) */
  keyFingerprint?: string;
  /** Detected key type */
  keyType?: string;
  /** Error message if injection failed */
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Valid SSH private key header patterns
 */
const SSH_KEY_PATTERNS = {
  RSA: /-----BEGIN RSA PRIVATE KEY-----/,
  DSA: /-----BEGIN DSA PRIVATE KEY-----/,
  ECDSA: /-----BEGIN EC PRIVATE KEY-----/,
  OPENSSH: /-----BEGIN OPENSSH PRIVATE KEY-----/,
  GENERIC: /-----BEGIN PRIVATE KEY-----/
};

/**
 * Public key pattern (to reject if user provides public key by mistake)
 */
const PUBLIC_KEY_PATTERN = /^ssh-(rsa|ed25519|ecdsa|dsa)\s+[A-Za-z0-9+/]+/;

/**
 * Common git hosting providers for known_hosts
 */
const GIT_PROVIDERS = [
  'github.com',
  'gitlab.com',
  'bitbucket.org'
];

/**
 * Maximum key path length (security measure)
 */
const MAX_PATH_LENGTH = 512;

/**
 * Dangerous shell characters to reject in paths
 */
const DANGEROUS_PATH_CHARS = /[;&|`$(){}[\]<>*?~!\\"']/;

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate SSH key file path
 *
 * Checks:
 * - File exists and is readable
 * - File is a regular file (not directory)
 * - Permissions are secure (warns if too permissive)
 * - Content is valid SSH private key format
 * - Not a public key (common mistake)
 *
 * @param keyPath - Path to SSH private key file
 * @returns Validation result with key type and any warnings
 */
export async function validateSSHKeyPath(keyPath: string): Promise<SSHValidationResult> {
  // Validate path length
  if (keyPath.length > MAX_PATH_LENGTH) {
    return {
      valid: false,
      permissionsOk: false,
      error: `Key path too long (max ${MAX_PATH_LENGTH} characters)`
    };
  }

  // Check for dangerous shell characters
  if (DANGEROUS_PATH_CHARS.test(keyPath)) {
    return {
      valid: false,
      permissionsOk: false,
      error: 'Key path contains invalid characters'
    };
  }

  // Check file exists
  if (!fsSync.existsSync(keyPath)) {
    return {
      valid: false,
      permissionsOk: false,
      error: `SSH key file not found: ${keyPath}`
    };
  }

  // Check file is readable
  try {
    await fs.access(keyPath, fsSync.constants.R_OK);
  } catch (error) {
    return {
      valid: false,
      permissionsOk: false,
      error: `Cannot read SSH key file (permission denied): ${keyPath}`
    };
  }

  // Check it's a file (not directory)
  let stat;
  try {
    stat = await fs.stat(keyPath);
  } catch (error) {
    return {
      valid: false,
      permissionsOk: false,
      error: `Cannot stat SSH key file: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (!stat.isFile()) {
    return {
      valid: false,
      permissionsOk: false,
      error: `Path is not a file: ${keyPath}`
    };
  }

  // Check permissions (should be 600 or 400)
  const mode = stat.mode & 0o777; // Get permission bits only
  const isGroupReadable = (mode & 0o070) !== 0;
  const isOtherReadable = (mode & 0o007) !== 0;
  const permissionsOk = !isGroupReadable && !isOtherReadable;

  let permissionsWarning: string | undefined;
  if (!permissionsOk) {
    const octalMode = mode.toString(8).padStart(3, '0');
    permissionsWarning = `Key file has overly permissive permissions (${octalMode}). Recommended: 600 or 400`;
  }

  // Read and validate content
  let keyContent: string;
  try {
    keyContent = await fs.readFile(keyPath, 'utf-8');
  } catch (error) {
    return {
      valid: false,
      permissionsOk,
      permissionsWarning,
      error: `Cannot read SSH key file: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  // Check for empty file
  if (!keyContent.trim()) {
    return {
      valid: false,
      permissionsOk,
      permissionsWarning,
      error: 'Invalid SSH key format: file is empty'
    };
  }

  // Check if it's a public key (common mistake)
  if (PUBLIC_KEY_PATTERN.test(keyContent.trim())) {
    return {
      valid: false,
      permissionsOk,
      permissionsWarning,
      error: 'This appears to be a public key (.pub). Please provide the private key file instead.'
    };
  }

  // Detect key type from content
  const keyType = detectKeyType(keyContent, path.basename(keyPath));

  if (keyType === 'unknown') {
    return {
      valid: false,
      keyType,
      permissionsOk,
      permissionsWarning,
      error: 'Invalid SSH key format: file does not contain a valid SSH private key'
    };
  }

  // Check for encrypted key (passphrase-protected)
  if (keyContent.includes('ENCRYPTED') || keyContent.includes('Proc-Type: 4,ENCRYPTED')) {
    if (!permissionsWarning) {
      permissionsWarning = 'Key is passphrase-protected. Passphrase will not be prompted in sandbox (non-interactive).';
    } else {
      permissionsWarning += ' Also: key is passphrase-protected (non-interactive mode).';
    }
  }

  return {
    valid: true,
    keyType,
    permissionsOk,
    permissionsWarning
  };
}

/**
 * Detect SSH key type from content and filename
 *
 * @param content - Key file content
 * @param filename - Key filename (for OpenSSH format detection)
 * @returns Key type string
 */
export function detectKeyType(content: string, filename: string): string {
  // Check content-based patterns first
  if (SSH_KEY_PATTERNS.RSA.test(content)) {
    return 'rsa';
  }
  if (SSH_KEY_PATTERNS.DSA.test(content)) {
    return 'dsa';
  }
  if (SSH_KEY_PATTERNS.ECDSA.test(content)) {
    return 'ecdsa';
  }
  if (SSH_KEY_PATTERNS.GENERIC.test(content)) {
    // Generic PKCS#8 format - try to detect from filename
    return detectKeyTypeFromFilename(filename) || 'generic';
  }
  if (SSH_KEY_PATTERNS.OPENSSH.test(content)) {
    // OpenSSH format can contain any key type - detect from filename
    return detectKeyTypeFromFilename(filename) || 'openssh';
  }

  return 'unknown';
}

/**
 * Detect key type from filename
 */
function detectKeyTypeFromFilename(filename: string): string | null {
  const lower = filename.toLowerCase();
  if (lower.includes('ed25519')) return 'ed25519';
  if (lower.includes('ecdsa')) return 'ecdsa';
  if (lower.includes('rsa')) return 'rsa';
  if (lower.includes('dsa')) return 'dsa';
  return null;
}

// ============================================================================
// Security Warning
// ============================================================================

/**
 * Get security warning message for SSH key injection
 *
 * @param keyPath - Path to SSH key file
 * @returns Warning message to display to user
 */
export function getSecurityWarning(keyPath: string): string {
  const filename = path.basename(keyPath);

  return `
⚠️  SSH KEY SECURITY WARNING

You are about to transmit your SSH private key (${filename}) to an E2B sandbox.

Security implications:
• The key will be transmitted over an encrypted network connection
• The key will be stored temporarily in the sandbox filesystem
• The key will be accessible to processes running in the sandbox
• The key will be cleaned up after execution completes

Recommendations:
• Use a dedicated deploy key with minimal permissions (read-only when possible)
• Rotate keys regularly
• Monitor key usage in your git provider's dashboard
• Consider using repository-specific deploy keys

The key will be used for:
• Cloning private repositories (GitHub, GitLab, Bitbucket)
• Pushing changes (if the key has write access)

Proceed only if you understand and accept these security implications.
`.trim();
}

// ============================================================================
// Injection Functions
// ============================================================================

/**
 * Inject SSH key into E2B sandbox
 *
 * Creates ~/.ssh directory with proper permissions, writes the key,
 * configures known_hosts for common git providers, and creates SSH config.
 *
 * @param sandbox - E2B Sandbox instance
 * @param keyPath - Path to local SSH private key
 * @param logger - Logger instance
 * @returns Injection result with fingerprint
 */
export async function injectSSHKey(
  sandbox: Sandbox,
  keyPath: string,
  logger: Logger
): Promise<SSHInjectionResult> {
  try {
    // Read key content
    const keyContent = await fs.readFile(keyPath, 'utf-8');
    const keyFilename = path.basename(keyPath);
    const keyType = detectKeyType(keyContent, keyFilename);

    logger.debug(`Injecting SSH key: ${keyFilename} (type: ${keyType})`);

    // Step 1: Create .ssh directory with correct permissions
    const mkdirResult = await sandbox.commands.run(
      'mkdir -p ~/.ssh && chmod 700 ~/.ssh',
      { timeoutMs: 10000 }
    );

    if (mkdirResult.exitCode !== 0) {
      logger.error(`Failed to create .ssh directory: ${mkdirResult.stderr}`);
      return {
        success: false,
        error: `Failed to create .ssh directory: ${mkdirResult.stderr}`
      };
    }

    // Step 2: Write SSH key with proper permissions
    const remoteKeyPath = `~/.ssh/${keyFilename}`;

    try {
      // Write key content
      await sandbox.files.write(`/root/.ssh/${keyFilename}`, keyContent);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to write SSH key: ${errorMsg}`);
      return {
        success: false,
        error: `Failed to write SSH key: ${errorMsg}`
      };
    }

    // Set correct permissions (600)
    const chmodResult = await sandbox.commands.run(
      `chmod 600 ~/.ssh/${keyFilename}`,
      { timeoutMs: 5000 }
    );

    if (chmodResult.exitCode !== 0) {
      logger.warn(`Failed to set key permissions: ${chmodResult.stderr}`);
    }

    // Step 3: Configure known_hosts for common git providers
    for (const provider of GIT_PROVIDERS) {
      const keyscanResult = await sandbox.commands.run(
        `ssh-keyscan -H ${provider} >> ~/.ssh/known_hosts 2>/dev/null || true`,
        { timeoutMs: 30000 }
      );

      if (keyscanResult.exitCode !== 0) {
        logger.warn(`Failed to add ${provider} to known_hosts`);
      }
    }

    // Step 4: Create SSH config with StrictHostKeyChecking
    const sshConfig = `Host *
  StrictHostKeyChecking accept-new
  UserKnownHostsFile ~/.ssh/known_hosts
  IdentityFile ~/.ssh/${keyFilename}
`;

    try {
      await sandbox.files.write('/root/.ssh/config', sshConfig);
    } catch (error) {
      logger.warn(`Failed to create SSH config: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Set config permissions
    await sandbox.commands.run('chmod 600 ~/.ssh/config', { timeoutMs: 5000 });

    // Step 5: Get key fingerprint for logging
    let fingerprint = 'unknown';
    try {
      const fingerprintBuffer = execSync(`ssh-keygen -lf "${keyPath}" 2>/dev/null`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore']
      });
      // Extract just the fingerprint hash (e.g., SHA256:abcdef...)
      const match = fingerprintBuffer.match(/SHA256:([A-Za-z0-9+/=]+)/);
      if (match) {
        fingerprint = match[1].substring(0, 8) + '...';
      }
    } catch {
      // Fingerprint extraction failed - not critical
    }

    logger.info(`SSH key injected successfully (fingerprint: ${fingerprint})`);

    return {
      success: true,
      keyFingerprint: fingerprint,
      keyType
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(`SSH key injection failed: ${errorMsg}`);
    return {
      success: false,
      error: errorMsg
    };
  }
}

// ============================================================================
// Cleanup Functions
// ============================================================================

/**
 * Clean up SSH key from sandbox
 *
 * Removes all SSH-related files created during injection:
 * - Private key file
 * - known_hosts
 * - SSH config
 *
 * @param sandbox - E2B Sandbox instance
 * @param logger - Logger instance
 */
export async function cleanupSSHKey(
  sandbox: Sandbox,
  logger: Logger
): Promise<void> {
  logger.debug('Cleaning up SSH key from sandbox...');

  const cleanupCommands = [
    'rm -f ~/.ssh/id_* ~/.ssh/known_hosts ~/.ssh/config'
  ];

  for (const cmd of cleanupCommands) {
    try {
      await sandbox.commands.run(cmd, { timeoutMs: 10000 });
    } catch (error) {
      logger.warn(`SSH key cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  logger.info('SSH key cleanup completed');
}
