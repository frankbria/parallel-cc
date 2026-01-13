/**
 * Tests for SSH Key Injector Module
 *
 * Tests SSH key injection for E2B sandboxes with private repository access:
 * - Key validation (existence, permissions, format)
 * - Security warning display
 * - Key injection with proper permissions
 * - Known hosts configuration
 * - Cleanup after execution
 *
 * All file system and E2B operations are mocked - no real file operations occur.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Sandbox } from 'e2b';

// Types for our module (will be implemented)
interface SSHInjectionResult {
  success: boolean;
  keyFingerprint?: string;
  keyType?: string;
  error?: string;
}

interface SSHValidationResult {
  valid: boolean;
  keyType?: string;
  permissionsOk: boolean;
  permissionsWarning?: string;
  error?: string;
}

// Mock fs module
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
  access: vi.fn()
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  constants: { R_OK: 4 }
}));

// Mock child_process for ssh-keygen
vi.mock('child_process', () => ({
  execSync: vi.fn()
}));

// Mock logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
};

describe('SSH Key Injector', () => {
  let mockSandbox: any;

  beforeEach(() => {
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validateSSHKeyPath', () => {
    it('should validate an existing valid SSH key file', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      // Mock file exists and is readable
      vi.mocked(fsSync.existsSync).mockReturnValue(true);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.stat).mockResolvedValue({
        mode: 0o100600, // -rw------- (owner read/write only)
        isFile: () => true
      } as any);
      vi.mocked(fs.readFile).mockResolvedValue(
        '-----BEGIN OPENSSH PRIVATE KEY-----\nbase64content\n-----END OPENSSH PRIVATE KEY-----'
      );

      const { validateSSHKeyPath } = await import('../../src/e2b/ssh-key-injector.js');
      const result = await validateSSHKeyPath('/home/user/.ssh/id_ed25519');

      expect(result.valid).toBe(true);
      expect(result.permissionsOk).toBe(true);
    });

    it('should reject non-existent key file', async () => {
      const fsSync = await import('fs');
      vi.mocked(fsSync.existsSync).mockReturnValue(false);

      const { validateSSHKeyPath } = await import('../../src/e2b/ssh-key-injector.js');
      const result = await validateSSHKeyPath('/home/user/.ssh/nonexistent');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should reject unreadable key file', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      vi.mocked(fsSync.existsSync).mockReturnValue(true);
      vi.mocked(fs.access).mockRejectedValue(new Error('EACCES: permission denied'));

      const { validateSSHKeyPath } = await import('../../src/e2b/ssh-key-injector.js');
      const result = await validateSSHKeyPath('/home/user/.ssh/id_rsa');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('permission');
    });

    it('should warn about overly permissive permissions (644)', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      vi.mocked(fsSync.existsSync).mockReturnValue(true);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.stat).mockResolvedValue({
        mode: 0o100644, // -rw-r--r-- (world readable - dangerous!)
        isFile: () => true
      } as any);
      vi.mocked(fs.readFile).mockResolvedValue(
        '-----BEGIN OPENSSH PRIVATE KEY-----\ncontent\n-----END OPENSSH PRIVATE KEY-----'
      );

      const { validateSSHKeyPath } = await import('../../src/e2b/ssh-key-injector.js');
      const result = await validateSSHKeyPath('/home/user/.ssh/id_ed25519');

      expect(result.valid).toBe(true); // Still valid but with warning
      expect(result.permissionsOk).toBe(false);
      expect(result.permissionsWarning).toContain('permissive');
    });

    it('should accept valid permissions (400 - read-only)', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      vi.mocked(fsSync.existsSync).mockReturnValue(true);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.stat).mockResolvedValue({
        mode: 0o100400, // -r-------- (owner read only)
        isFile: () => true
      } as any);
      vi.mocked(fs.readFile).mockResolvedValue(
        '-----BEGIN RSA PRIVATE KEY-----\ncontent\n-----END RSA PRIVATE KEY-----'
      );

      const { validateSSHKeyPath } = await import('../../src/e2b/ssh-key-injector.js');
      const result = await validateSSHKeyPath('/home/user/.ssh/id_rsa');

      expect(result.valid).toBe(true);
      expect(result.permissionsOk).toBe(true);
    });

    it('should reject invalid SSH key format', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      vi.mocked(fsSync.existsSync).mockReturnValue(true);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.stat).mockResolvedValue({
        mode: 0o100600,
        isFile: () => true
      } as any);
      vi.mocked(fs.readFile).mockResolvedValue('not a valid ssh key');

      const { validateSSHKeyPath } = await import('../../src/e2b/ssh-key-injector.js');
      const result = await validateSSHKeyPath('/home/user/.ssh/id_rsa');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid SSH key format');
    });

    it('should reject directory instead of file', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      vi.mocked(fsSync.existsSync).mockReturnValue(true);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.stat).mockResolvedValue({
        mode: 0o40755,
        isFile: () => false,
        isDirectory: () => true
      } as any);

      const { validateSSHKeyPath } = await import('../../src/e2b/ssh-key-injector.js');
      const result = await validateSSHKeyPath('/home/user/.ssh');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('not a file');
    });

    it('should detect RSA key type', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      vi.mocked(fsSync.existsSync).mockReturnValue(true);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.stat).mockResolvedValue({
        mode: 0o100600,
        isFile: () => true
      } as any);
      vi.mocked(fs.readFile).mockResolvedValue(
        '-----BEGIN RSA PRIVATE KEY-----\ncontent\n-----END RSA PRIVATE KEY-----'
      );

      const { validateSSHKeyPath } = await import('../../src/e2b/ssh-key-injector.js');
      const result = await validateSSHKeyPath('/home/user/.ssh/id_rsa');

      expect(result.valid).toBe(true);
      expect(result.keyType).toBe('rsa');
    });

    it('should detect Ed25519 key type', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      vi.mocked(fsSync.existsSync).mockReturnValue(true);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.stat).mockResolvedValue({
        mode: 0o100600,
        isFile: () => true
      } as any);
      vi.mocked(fs.readFile).mockResolvedValue(
        '-----BEGIN OPENSSH PRIVATE KEY-----\ncontent\n-----END OPENSSH PRIVATE KEY-----'
      );

      const { validateSSHKeyPath } = await import('../../src/e2b/ssh-key-injector.js');
      const result = await validateSSHKeyPath('/home/user/.ssh/id_ed25519');

      expect(result.valid).toBe(true);
      // OPENSSH format can be any type, but we can detect from filename
      expect(result.keyType).toMatch(/ed25519|openssh/);
    });

    it('should detect ECDSA key type', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      vi.mocked(fsSync.existsSync).mockReturnValue(true);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.stat).mockResolvedValue({
        mode: 0o100600,
        isFile: () => true
      } as any);
      vi.mocked(fs.readFile).mockResolvedValue(
        '-----BEGIN EC PRIVATE KEY-----\ncontent\n-----END EC PRIVATE KEY-----'
      );

      const { validateSSHKeyPath } = await import('../../src/e2b/ssh-key-injector.js');
      const result = await validateSSHKeyPath('/home/user/.ssh/id_ecdsa');

      expect(result.valid).toBe(true);
      expect(result.keyType).toBe('ecdsa');
    });

    it('should detect DSA key type', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      vi.mocked(fsSync.existsSync).mockReturnValue(true);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.stat).mockResolvedValue({
        mode: 0o100600,
        isFile: () => true
      } as any);
      vi.mocked(fs.readFile).mockResolvedValue(
        '-----BEGIN DSA PRIVATE KEY-----\ncontent\n-----END DSA PRIVATE KEY-----'
      );

      const { validateSSHKeyPath } = await import('../../src/e2b/ssh-key-injector.js');
      const result = await validateSSHKeyPath('/home/user/.ssh/id_dsa');

      expect(result.valid).toBe(true);
      expect(result.keyType).toBe('dsa');
    });
  });

  describe('injectSSHKey', () => {
    beforeEach(async () => {
      const fs = await import('fs/promises');
      vi.mocked(fs.readFile).mockResolvedValue(
        '-----BEGIN OPENSSH PRIVATE KEY-----\nbase64content\n-----END OPENSSH PRIVATE KEY-----'
      );
    });

    it('should create .ssh directory with correct permissions', async () => {
      const { injectSSHKey } = await import('../../src/e2b/ssh-key-injector.js');

      await injectSSHKey(mockSandbox, '/home/user/.ssh/id_ed25519', mockLogger as any);

      // Check that mkdir -p ~/.ssh was called
      expect(mockSandbox.commands.run).toHaveBeenCalledWith(
        expect.stringMatching(/mkdir -p.*\.ssh.*chmod 700/),
        expect.any(Object)
      );
    });

    it('should write SSH key with 600 permissions', async () => {
      const { injectSSHKey } = await import('../../src/e2b/ssh-key-injector.js');

      await injectSSHKey(mockSandbox, '/home/user/.ssh/id_ed25519', mockLogger as any);

      // Check that key was written
      expect(mockSandbox.files.write).toHaveBeenCalled();

      // Check chmod 600 was called
      expect(mockSandbox.commands.run).toHaveBeenCalledWith(
        expect.stringMatching(/chmod 600.*id_/),
        expect.any(Object)
      );
    });

    it('should configure known_hosts for common git providers', async () => {
      const { injectSSHKey } = await import('../../src/e2b/ssh-key-injector.js');

      await injectSSHKey(mockSandbox, '/home/user/.ssh/id_ed25519', mockLogger as any);

      // Check ssh-keyscan calls for GitHub, GitLab, Bitbucket
      expect(mockSandbox.commands.run).toHaveBeenCalledWith(
        expect.stringMatching(/ssh-keyscan.*github\.com/),
        expect.any(Object)
      );
      expect(mockSandbox.commands.run).toHaveBeenCalledWith(
        expect.stringMatching(/ssh-keyscan.*gitlab\.com/),
        expect.any(Object)
      );
      expect(mockSandbox.commands.run).toHaveBeenCalledWith(
        expect.stringMatching(/ssh-keyscan.*bitbucket\.org/),
        expect.any(Object)
      );
    });

    it('should create SSH config with StrictHostKeyChecking', async () => {
      const { injectSSHKey } = await import('../../src/e2b/ssh-key-injector.js');

      await injectSSHKey(mockSandbox, '/home/user/.ssh/id_ed25519', mockLogger as any);

      // Check SSH config was written
      expect(mockSandbox.files.write).toHaveBeenCalledWith(
        expect.stringMatching(/\.ssh\/config/),
        expect.stringMatching(/StrictHostKeyChecking/)
      );
    });

    it('should return success with key fingerprint', async () => {
      const { injectSSHKey } = await import('../../src/e2b/ssh-key-injector.js');

      const result = await injectSSHKey(mockSandbox, '/home/user/.ssh/id_ed25519', mockLogger as any);

      expect(result.success).toBe(true);
      // Fingerprint may be 'unknown' if ssh-keygen is not available in test env
      expect(result.keyFingerprint).toBeDefined();
      expect(typeof result.keyFingerprint).toBe('string');
    });

    it('should handle sandbox file write errors', async () => {
      mockSandbox.files.write.mockRejectedValueOnce(new Error('Write failed'));

      const { injectSSHKey } = await import('../../src/e2b/ssh-key-injector.js');

      const result = await injectSSHKey(mockSandbox, '/home/user/.ssh/id_ed25519', mockLogger as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Write failed');
    });

    it('should handle sandbox command errors gracefully', async () => {
      // First command (mkdir) fails
      mockSandbox.commands.run.mockResolvedValueOnce({
        stdout: '',
        stderr: 'Permission denied',
        exitCode: 1
      });

      const { injectSSHKey } = await import('../../src/e2b/ssh-key-injector.js');

      const result = await injectSSHKey(mockSandbox, '/home/user/.ssh/id_ed25519', mockLogger as any);

      // mkdir is critical - should fail if it fails
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to create .ssh directory');
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should preserve key filename for different key types', async () => {
      const { injectSSHKey } = await import('../../src/e2b/ssh-key-injector.js');

      // Test with RSA key
      await injectSSHKey(mockSandbox, '/home/user/.ssh/id_rsa', mockLogger as any);

      expect(mockSandbox.files.write).toHaveBeenCalledWith(
        expect.stringMatching(/id_rsa$/),
        expect.any(String)
      );
    });

    it('should log injection success (redacted)', async () => {
      const { injectSSHKey } = await import('../../src/e2b/ssh-key-injector.js');

      await injectSSHKey(mockSandbox, '/home/user/.ssh/id_ed25519', mockLogger as any);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringMatching(/SSH key injected/)
      );
    });
  });

  describe('cleanupSSHKey', () => {
    it('should remove SSH key files using id_* pattern when no keyFilename provided', async () => {
      const { cleanupSSHKey } = await import('../../src/e2b/ssh-key-injector.js');

      await cleanupSSHKey(mockSandbox, mockLogger as any);

      expect(mockSandbox.commands.run).toHaveBeenCalledWith(
        expect.stringMatching(/rm.*id_\*/),
        expect.any(Object)
      );
    });

    it('should remove specific key file when keyFilename is provided', async () => {
      const { cleanupSSHKey } = await import('../../src/e2b/ssh-key-injector.js');

      await cleanupSSHKey(mockSandbox, mockLogger as any, 'my_deploy_key');

      expect(mockSandbox.commands.run).toHaveBeenCalledWith(
        expect.stringMatching(/rm.*~\/\.ssh\/my_deploy_key/),
        expect.any(Object)
      );
      // Should NOT use id_* pattern when specific filename provided
      expect(mockSandbox.commands.run).not.toHaveBeenCalledWith(
        expect.stringMatching(/id_\*/),
        expect.any(Object)
      );
    });

    it('should remove known_hosts file', async () => {
      const { cleanupSSHKey } = await import('../../src/e2b/ssh-key-injector.js');

      await cleanupSSHKey(mockSandbox, mockLogger as any);

      expect(mockSandbox.commands.run).toHaveBeenCalledWith(
        expect.stringMatching(/rm.*known_hosts/),
        expect.any(Object)
      );
    });

    it('should remove SSH config file', async () => {
      const { cleanupSSHKey } = await import('../../src/e2b/ssh-key-injector.js');

      await cleanupSSHKey(mockSandbox, mockLogger as any);

      expect(mockSandbox.commands.run).toHaveBeenCalledWith(
        expect.stringMatching(/rm.*config/),
        expect.any(Object)
      );
    });

    it('should log cleanup completion', async () => {
      const { cleanupSSHKey } = await import('../../src/e2b/ssh-key-injector.js');

      await cleanupSSHKey(mockSandbox, mockLogger as any);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringMatching(/SSH key.*clean/i)
      );
    });

    it('should handle errors gracefully (log warning but do not throw)', async () => {
      mockSandbox.commands.run.mockRejectedValueOnce(new Error('Cleanup failed'));

      const { cleanupSSHKey } = await import('../../src/e2b/ssh-key-injector.js');

      // Should not throw
      await expect(cleanupSSHKey(mockSandbox, mockLogger as any)).resolves.not.toThrow();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/cleanup.*failed/i)
      );
    });

    it('should handle missing files gracefully', async () => {
      mockSandbox.commands.run.mockResolvedValueOnce({
        stdout: '',
        stderr: 'No such file or directory',
        exitCode: 1
      });

      const { cleanupSSHKey } = await import('../../src/e2b/ssh-key-injector.js');

      // Should not throw even if files don't exist
      await expect(cleanupSSHKey(mockSandbox, mockLogger as any)).resolves.not.toThrow();
    });
  });

  describe('getSecurityWarning', () => {
    it('should return security warning message', async () => {
      const { getSecurityWarning } = await import('../../src/e2b/ssh-key-injector.js');

      const warning = getSecurityWarning('/home/user/.ssh/id_ed25519');

      expect(warning).toContain('SSH');
      expect(warning).toContain('sandbox');
      expect(warning).toContain('transmitted');
    });

    it('should include key path in warning', async () => {
      const { getSecurityWarning } = await import('../../src/e2b/ssh-key-injector.js');

      const warning = getSecurityWarning('/home/user/.ssh/id_ed25519');

      expect(warning).toContain('id_ed25519');
    });

    it('should list security implications', async () => {
      const { getSecurityWarning } = await import('../../src/e2b/ssh-key-injector.js');

      const warning = getSecurityWarning('/home/user/.ssh/id_ed25519');

      // Should mention key will be in sandbox
      expect(warning).toMatch(/sandbox|E2B/i);
      // Should mention network transmission
      expect(warning).toMatch(/network|transmit/i);
    });
  });

  describe('SSH key type detection', () => {
    it('should detect RSA key from content', async () => {
      const { detectKeyType } = await import('../../src/e2b/ssh-key-injector.js');

      const keyContent = '-----BEGIN RSA PRIVATE KEY-----\ncontent\n-----END RSA PRIVATE KEY-----';
      const keyType = detectKeyType(keyContent, 'id_rsa');

      expect(keyType).toBe('rsa');
    });

    it('should detect ECDSA key from content', async () => {
      const { detectKeyType } = await import('../../src/e2b/ssh-key-injector.js');

      const keyContent = '-----BEGIN EC PRIVATE KEY-----\ncontent\n-----END EC PRIVATE KEY-----';
      const keyType = detectKeyType(keyContent, 'id_ecdsa');

      expect(keyType).toBe('ecdsa');
    });

    it('should detect DSA key from content', async () => {
      const { detectKeyType } = await import('../../src/e2b/ssh-key-injector.js');

      const keyContent = '-----BEGIN DSA PRIVATE KEY-----\ncontent\n-----END DSA PRIVATE KEY-----';
      const keyType = detectKeyType(keyContent, 'id_dsa');

      expect(keyType).toBe('dsa');
    });

    it('should detect OpenSSH format and fall back to filename', async () => {
      const { detectKeyType } = await import('../../src/e2b/ssh-key-injector.js');

      const keyContent = '-----BEGIN OPENSSH PRIVATE KEY-----\ncontent\n-----END OPENSSH PRIVATE KEY-----';

      expect(detectKeyType(keyContent, 'id_ed25519')).toBe('ed25519');
      expect(detectKeyType(keyContent, 'id_rsa')).toBe('rsa');
      expect(detectKeyType(keyContent, 'id_ecdsa')).toBe('ecdsa');
    });

    it('should return unknown for unrecognized format', async () => {
      const { detectKeyType } = await import('../../src/e2b/ssh-key-injector.js');

      const keyContent = '-----BEGIN UNKNOWN PRIVATE KEY-----\ncontent\n-----END UNKNOWN PRIVATE KEY-----';
      const keyType = detectKeyType(keyContent, 'custom_key');

      expect(keyType).toBe('unknown');
    });
  });

  describe('Integration scenarios', () => {
    it('should support full injection workflow: validate -> inject -> use -> cleanup', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      // Setup validation mocks
      vi.mocked(fsSync.existsSync).mockReturnValue(true);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.stat).mockResolvedValue({
        mode: 0o100600,
        isFile: () => true
      } as any);
      vi.mocked(fs.readFile).mockResolvedValue(
        '-----BEGIN OPENSSH PRIVATE KEY-----\nbase64content\n-----END OPENSSH PRIVATE KEY-----'
      );

      // Import all functions
      const { validateSSHKeyPath, injectSSHKey, cleanupSSHKey } = await import('../../src/e2b/ssh-key-injector.js');

      // Step 1: Validate
      const validation = await validateSSHKeyPath('/home/user/.ssh/id_ed25519');
      expect(validation.valid).toBe(true);

      // Step 2: Inject
      const injection = await injectSSHKey(mockSandbox, '/home/user/.ssh/id_ed25519', mockLogger as any);
      expect(injection.success).toBe(true);

      // Step 3: Simulate git clone (mock sandbox command)
      mockSandbox.commands.run.mockResolvedValueOnce({
        stdout: 'Cloning into private-repo...',
        stderr: '',
        exitCode: 0
      });

      const cloneResult = await mockSandbox.commands.run('git clone git@github.com:user/private-repo.git');
      expect(cloneResult.exitCode).toBe(0);

      // Step 4: Cleanup
      await cleanupSSHKey(mockSandbox, mockLogger as any);

      // Verify cleanup was called with rm commands
      expect(mockSandbox.commands.run).toHaveBeenCalledWith(
        expect.stringMatching(/rm/),
        expect.any(Object)
      );
    });

    it('should handle key injection failure gracefully', async () => {
      const fs = await import('fs/promises');
      vi.mocked(fs.readFile).mockResolvedValue(
        '-----BEGIN OPENSSH PRIVATE KEY-----\nbase64content\n-----END OPENSSH PRIVATE KEY-----'
      );

      // Make sandbox directory creation fail
      mockSandbox.commands.run.mockResolvedValueOnce({
        stdout: '',
        stderr: 'Permission denied',
        exitCode: 1
      });

      const { injectSSHKey } = await import('../../src/e2b/ssh-key-injector.js');

      const result = await injectSSHKey(mockSandbox, '/home/user/.ssh/id_ed25519', mockLogger as any);

      // Should fail gracefully
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should cleanup even when sandbox is unhealthy', async () => {
      // Make all commands fail
      mockSandbox.commands.run.mockRejectedValue(new Error('Sandbox disconnected'));

      const { cleanupSSHKey } = await import('../../src/e2b/ssh-key-injector.js');

      // Should not throw
      await expect(cleanupSSHKey(mockSandbox, mockLogger as any)).resolves.not.toThrow();

      // Should log warning
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('Edge cases', () => {
    it('should handle keys with passphrase (detect encrypted key)', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      vi.mocked(fsSync.existsSync).mockReturnValue(true);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.stat).mockResolvedValue({
        mode: 0o100600,
        isFile: () => true
      } as any);
      // Encrypted key has ENCRYPTED in header
      vi.mocked(fs.readFile).mockResolvedValue(
        '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,abcdef\n\ncontent\n-----END RSA PRIVATE KEY-----'
      );

      const { validateSSHKeyPath } = await import('../../src/e2b/ssh-key-injector.js');
      const result = await validateSSHKeyPath('/home/user/.ssh/id_rsa');

      expect(result.valid).toBe(true);
      // Should warn that passphrase-protected keys won't work non-interactively
      expect(result.permissionsWarning).toMatch(/passphrase|encrypted/i);
    });

    it('should handle very long key paths', async () => {
      const fsSync = await import('fs');
      vi.mocked(fsSync.existsSync).mockReturnValue(false);

      const longPath = '/home/user/' + 'a'.repeat(1000) + '/.ssh/id_ed25519';

      const { validateSSHKeyPath } = await import('../../src/e2b/ssh-key-injector.js');
      const result = await validateSSHKeyPath(longPath);

      expect(result.valid).toBe(false);
    });

    it('should handle paths with special characters', async () => {
      const fsSync = await import('fs');
      vi.mocked(fsSync.existsSync).mockReturnValue(false);

      const { validateSSHKeyPath } = await import('../../src/e2b/ssh-key-injector.js');

      // Paths with spaces
      const result1 = await validateSSHKeyPath('/home/user name/.ssh/id_ed25519');
      expect(result1.error).toContain('not found');

      // Paths with shell metacharacters should be handled safely
      const result2 = await validateSSHKeyPath('/home/user/.ssh/id_ed25519; rm -rf /');
      expect(result2.valid).toBe(false);
    });

    it('should handle empty key file', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      vi.mocked(fsSync.existsSync).mockReturnValue(true);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.stat).mockResolvedValue({
        mode: 0o100600,
        isFile: () => true
      } as any);
      vi.mocked(fs.readFile).mockResolvedValue('');

      const { validateSSHKeyPath } = await import('../../src/e2b/ssh-key-injector.js');
      const result = await validateSSHKeyPath('/home/user/.ssh/id_ed25519');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid SSH key format');
    });

    it('should handle public key instead of private key', async () => {
      const fs = await import('fs/promises');
      const fsSync = await import('fs');

      vi.mocked(fsSync.existsSync).mockReturnValue(true);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.stat).mockResolvedValue({
        mode: 0o100644,
        isFile: () => true
      } as any);
      vi.mocked(fs.readFile).mockResolvedValue(
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample user@host'
      );

      const { validateSSHKeyPath } = await import('../../src/e2b/ssh-key-injector.js');
      const result = await validateSSHKeyPath('/home/user/.ssh/id_ed25519.pub');

      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/public key|private key/i);
    });
  });
});
