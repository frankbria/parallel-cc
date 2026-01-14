/**
 * Tests for E2B Template Manager
 *
 * Tests template management including:
 * - Loading built-in and custom templates
 * - CRUD operations on templates
 * - Template validation
 * - Template export/import
 * - Project type detection
 *
 * Following TDD - these tests are written before implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TemplateManager, validateTemplateName, validateTemplate } from '../../src/e2b/templates.js';
import type { SandboxTemplate, TemplateListEntry, TemplateValidationResult } from '../../src/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock fs module
vi.mock('fs/promises');

// Helper to create mock template
const createMockTemplate = (overrides: Partial<SandboxTemplate> = {}): SandboxTemplate => ({
  name: 'test-template',
  description: 'A test template',
  e2bTemplate: 'anthropic-claude-code',
  setupCommands: ['npm install'],
  environment: { NODE_ENV: 'development' },
  ...overrides
});

describe('TemplateManager', () => {
  let manager: TemplateManager;
  let tempDir: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    tempDir = path.join(os.tmpdir(), `parallel-cc-templates-test-${Date.now()}`);

    // Setup default mocks - these can be overridden in individual tests
    vi.mocked(fs.readdir).mockResolvedValue([]);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
    vi.mocked(fs.access).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    );

    manager = new TemplateManager({
      builtInDir: path.join(tempDir, 'templates'),
      customDir: path.join(tempDir, 'custom')
    });
  });

  afterEach(async () => {
    vi.resetAllMocks();
  });

  describe('constructor', () => {
    it('should create manager with default paths', () => {
      const defaultManager = new TemplateManager();
      expect(defaultManager).toBeInstanceOf(TemplateManager);
    });

    it('should create manager with custom paths', () => {
      const customManager = new TemplateManager({
        builtInDir: '/custom/builtin',
        customDir: '/custom/user'
      });
      expect(customManager).toBeInstanceOf(TemplateManager);
    });
  });

  describe('loadBuiltInTemplates', () => {
    it('should load templates from built-in directory', async () => {
      const template = createMockTemplate({ name: 'node-20-typescript' });

      vi.mocked(fs.readdir).mockResolvedValueOnce(['node-20-typescript.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(template));

      const templates = await manager.loadBuiltInTemplates();

      expect(templates).toHaveLength(1);
      expect(templates[0].name).toBe('node-20-typescript');
    });

    it('should return empty array when directory does not exist', async () => {
      vi.mocked(fs.readdir).mockRejectedValueOnce(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      const templates = await manager.loadBuiltInTemplates();

      expect(templates).toEqual([]);
    });

    it('should skip non-JSON files', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce(['template.json', 'readme.md', 'config.yaml'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify(createMockTemplate())
      );

      const templates = await manager.loadBuiltInTemplates();

      expect(templates).toHaveLength(1);
    });

    it('should handle invalid JSON gracefully', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce(['bad-template.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce('{ invalid json }');

      const templates = await manager.loadBuiltInTemplates();

      expect(templates).toEqual([]);
    });
  });

  describe('loadCustomTemplates', () => {
    it('should load templates from custom directory', async () => {
      const template = createMockTemplate({ name: 'my-custom-template' });

      vi.mocked(fs.readdir).mockResolvedValueOnce(['my-custom-template.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(template));

      const templates = await manager.loadCustomTemplates();

      expect(templates).toHaveLength(1);
      expect(templates[0].name).toBe('my-custom-template');
    });

    it('should return empty array when custom directory does not exist', async () => {
      vi.mocked(fs.readdir).mockRejectedValueOnce(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );

      const templates = await manager.loadCustomTemplates();

      expect(templates).toEqual([]);
    });
  });

  describe('listTemplates', () => {
    it('should list both built-in and custom templates', async () => {
      const builtIn = createMockTemplate({ name: 'node-typescript' });
      const custom = createMockTemplate({ name: 'my-custom' });

      // First call for built-in, second for custom
      vi.mocked(fs.readdir)
        .mockResolvedValueOnce(['node-typescript.json'] as any)
        .mockResolvedValueOnce(['my-custom.json'] as any);

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(builtIn))
        .mockResolvedValueOnce(JSON.stringify(custom));

      const list = await manager.listTemplates();

      expect(list).toHaveLength(2);
      expect(list.find(t => t.name === 'node-typescript')?.type).toBe('built-in');
      expect(list.find(t => t.name === 'my-custom')?.type).toBe('custom');
    });

    it('should return empty array when no templates exist', async () => {
      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const list = await manager.listTemplates();

      expect(list).toEqual([]);
    });
  });

  describe('getTemplate', () => {
    it('should return built-in template by name', async () => {
      const template = createMockTemplate({ name: 'node-20-typescript' });

      // getTemplate calls loadBuiltInTemplates first (if found, returns early)
      vi.mocked(fs.readdir).mockResolvedValueOnce(['node-20-typescript.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(template));

      const result = await manager.getTemplate('node-20-typescript');

      expect(result).not.toBeNull();
      expect(result?.name).toBe('node-20-typescript');
    });

    it('should return custom template by name', async () => {
      const template = createMockTemplate({ name: 'my-custom' });

      // getTemplate calls loadBuiltInTemplates first (empty), then loadCustomTemplates
      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([]) // built-in: empty
        .mockResolvedValueOnce(['my-custom.json'] as any); // custom: has template
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(template));

      const result = await manager.getTemplate('my-custom');

      expect(result).not.toBeNull();
      expect(result?.name).toBe('my-custom');
    });

    it('should return null for nonexistent template', async () => {
      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([]) // built-in: empty
        .mockResolvedValueOnce([]); // custom: empty

      const result = await manager.getTemplate('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('createTemplate', () => {
    it('should create new custom template', async () => {
      const template = createMockTemplate({ name: 'new-template' });

      // No existing templates
      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([])  // built-in check
        .mockResolvedValueOnce([]); // custom check

      const result = await manager.createTemplate(template);

      expect(result.success).toBe(true);
      expect(result.message).toContain('created');
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('should reject template with invalid name', async () => {
      const template = createMockTemplate({ name: 'invalid name!' });

      const result = await manager.createTemplate(template);

      expect(result.success).toBe(false);
      expect(result.error).toContain('name');
    });

    it('should reject template with reserved name', async () => {
      const template = createMockTemplate({ name: 'base' });

      const result = await manager.createTemplate(template);

      expect(result.success).toBe(false);
      expect(result.error).toContain('reserved');
    });

    it('should reject template that already exists', async () => {
      const template = createMockTemplate({ name: 'existing' });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce(['existing.json'] as any)
        .mockResolvedValueOnce([]);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(template));

      const result = await manager.createTemplate(template);

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('should add metadata timestamps on creation', async () => {
      const template = createMockTemplate({ name: 'timestamped' });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await manager.createTemplate(template);

      expect(result.success).toBe(true);
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('createdAt'),
        'utf-8'
      );
    });
  });

  describe('deleteTemplate', () => {
    it('should delete custom template', async () => {
      const template = createMockTemplate({ name: 'to-delete' });

      // deleteTemplate: isBuiltInTemplate (loads built-in), then loadCustomTemplates
      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([])  // isBuiltInTemplate: built-in empty
        .mockResolvedValueOnce(['to-delete.json'] as any); // loadCustomTemplates
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(template));

      const result = await manager.deleteTemplate('to-delete');

      expect(result.success).toBe(true);
      expect(fs.unlink).toHaveBeenCalled();
    });

    it('should reject deletion of built-in template', async () => {
      const template = createMockTemplate({ name: 'node-20-typescript' });

      // deleteTemplate: isBuiltInTemplate finds it as built-in
      vi.mocked(fs.readdir).mockResolvedValueOnce(['node-20-typescript.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(template));

      const result = await manager.deleteTemplate('node-20-typescript');

      expect(result.success).toBe(false);
      expect(result.error).toContain('built-in');
    });

    it('should return error for nonexistent template', async () => {
      // isBuiltInTemplate (empty), then loadCustomTemplates (empty)
      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([])  // isBuiltInTemplate
        .mockResolvedValueOnce([]); // loadCustomTemplates

      const result = await manager.deleteTemplate('nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('exportTemplate', () => {
    it('should export template as JSON string', async () => {
      const template = createMockTemplate({ name: 'to-export' });

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce(['to-export.json'] as any)
        .mockResolvedValueOnce([]);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(template));

      const result = await manager.exportTemplate('to-export');

      expect(result.success).toBe(true);
      expect(result.template).toBeDefined();
      const exported = JSON.parse(JSON.stringify(result.template));
      expect(exported.name).toBe('to-export');
    });

    it('should return error for nonexistent template', async () => {
      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await manager.exportTemplate('nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('importTemplate', () => {
    it('should import template from JSON', async () => {
      const template = createMockTemplate({ name: 'imported' });
      const json = JSON.stringify(template);

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await manager.importTemplate(json);

      expect(result.success).toBe(true);
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('should reject invalid JSON', async () => {
      const result = await manager.importTemplate('{ invalid json }');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid JSON');
    });

    it('should reject template with missing required fields', async () => {
      const incomplete = { name: 'incomplete' };
      const json = JSON.stringify(incomplete);

      const result = await manager.importTemplate(json);

      expect(result.success).toBe(false);
      expect(result.error).toContain('validation');
    });

    it('should prevent overwriting built-in templates', async () => {
      const template = createMockTemplate({ name: 'node-20-typescript' });
      const json = JSON.stringify(template);

      vi.mocked(fs.readdir)
        .mockResolvedValueOnce(['node-20-typescript.json'] as any)
        .mockResolvedValueOnce([]);
      vi.mocked(fs.readFile).mockResolvedValueOnce(
        JSON.stringify(createMockTemplate({ name: 'node-20-typescript' }))
      );

      const result = await manager.importTemplate(json);

      expect(result.success).toBe(false);
      expect(result.error).toContain('built-in');
    });
  });

  describe('isBuiltInTemplate', () => {
    it('should return true for built-in template', async () => {
      const template = createMockTemplate({ name: 'node-20-typescript' });

      // isBuiltInTemplate calls loadBuiltInTemplates
      vi.mocked(fs.readdir).mockResolvedValueOnce(['node-20-typescript.json'] as any);
      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(template));

      const isBuiltIn = await manager.isBuiltInTemplate('node-20-typescript');

      expect(isBuiltIn).toBe(true);
    });

    it('should return false for custom template', async () => {
      // isBuiltInTemplate checks built-in templates only
      vi.mocked(fs.readdir).mockResolvedValueOnce([]);

      const isBuiltIn = await manager.isBuiltInTemplate('my-custom');

      expect(isBuiltIn).toBe(false);
    });
  });
});

describe('validateTemplateName', () => {
  it('should accept valid alphanumeric names', () => {
    const validNames = ['node20', 'python312', 'mytemplate'];
    for (const name of validNames) {
      expect(validateTemplateName(name)).toBe(true);
    }
  });

  it('should accept names with hyphens, underscores, and dots', () => {
    const validNames = ['node-20-typescript', 'python_3_12', 'my-custom_template', 'python-3.12-fastapi'];
    for (const name of validNames) {
      expect(validateTemplateName(name)).toBe(true);
    }
  });

  it('should reject empty names', () => {
    expect(validateTemplateName('')).toBe(false);
  });

  it('should reject names shorter than 3 characters', () => {
    expect(validateTemplateName('ab')).toBe(false);
  });

  it('should reject names longer than 50 characters', () => {
    const longName = 'a'.repeat(51);
    expect(validateTemplateName(longName)).toBe(false);
  });

  it('should reject names with special characters', () => {
    const invalidNames = ['template!', 'my template', 'test@name', 'path/name'];
    for (const name of invalidNames) {
      expect(validateTemplateName(name)).toBe(false);
    }
  });

  it('should reject reserved names', () => {
    const reservedNames = ['base', 'default', 'custom'];
    for (const name of reservedNames) {
      expect(validateTemplateName(name)).toBe(false);
    }
  });
});

describe('validateTemplate', () => {
  it('should pass for valid template', () => {
    const template = createMockTemplate();
    const result = validateTemplate(template);

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should fail when name is missing', () => {
    const template = createMockTemplate();
    delete (template as any).name;

    const result = validateTemplate(template);

    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('name is required');
  });

  it('should fail when description is missing', () => {
    const template = createMockTemplate();
    delete (template as any).description;

    const result = validateTemplate(template);

    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('description is required');
  });

  it('should fail when e2bTemplate is missing', () => {
    const template = createMockTemplate();
    delete (template as any).e2bTemplate;

    const result = validateTemplate(template);

    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('e2bTemplate is required');
  });

  it('should fail when e2bTemplate is empty', () => {
    const template = createMockTemplate({ e2bTemplate: '' });

    const result = validateTemplate(template);

    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('e2bTemplate'))).toBe(true);
  });

  it('should fail when setupCommands is not an array', () => {
    const template = createMockTemplate();
    (template as any).setupCommands = 'npm install';

    const result = validateTemplate(template);

    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('setupCommands'))).toBe(true);
  });

  it('should fail when setupCommand exceeds max length', () => {
    const template = createMockTemplate({
      setupCommands: ['a'.repeat(1001)]
    });

    const result = validateTemplate(template);

    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('1000'))).toBe(true);
  });

  it('should fail when environment is not an object', () => {
    const template = createMockTemplate();
    (template as any).environment = 'NODE_ENV=development';

    const result = validateTemplate(template);

    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('environment'))).toBe(true);
  });

  it('should fail when environment values are not strings', () => {
    const template = createMockTemplate({
      environment: { PORT: 3000 } as any
    });

    const result = validateTemplate(template);

    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('environment'))).toBe(true);
  });

  it('should pass with optional fields omitted', () => {
    const template: SandboxTemplate = {
      name: 'minimal-template',
      description: 'A minimal template',
      e2bTemplate: 'base'
    };

    const result = validateTemplate(template);

    expect(result.isValid).toBe(true);
  });
});

describe('detectProjectType', () => {
  let manager: TemplateManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new TemplateManager();
  });

  it('should detect Node.js TypeScript project', async () => {
    vi.mocked(fs.access)
      .mockResolvedValueOnce(undefined) // package.json exists
      .mockResolvedValueOnce(undefined); // tsconfig.json exists

    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify({ dependencies: { typescript: '^5.0.0' } })
    );

    const result = await manager.detectProjectType('/path/to/repo');

    expect(result.detected).toBe(true);
    expect(result.suggestedTemplate).toBe('node-20-typescript');
  });

  it('should detect Python FastAPI project', async () => {
    vi.mocked(fs.access)
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })) // no package.json
      .mockResolvedValueOnce(undefined); // pyproject.toml exists

    vi.mocked(fs.readFile).mockResolvedValue('[project]\ndependencies = ["fastapi"]');

    const result = await manager.detectProjectType('/path/to/repo');

    expect(result.detected).toBe(true);
    expect(result.suggestedTemplate).toBe('python-3.12-fastapi');
  });

  it('should detect Next.js project', async () => {
    vi.mocked(fs.access).mockResolvedValue(undefined); // package.json exists
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify({ dependencies: { next: '^14.0.0' } })
    );

    const result = await manager.detectProjectType('/path/to/repo');

    expect(result.detected).toBe(true);
    expect(result.suggestedTemplate).toBe('full-stack-nextjs');
  });

  it('should return not detected for unknown project type', async () => {
    vi.mocked(fs.access).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    );

    const result = await manager.detectProjectType('/path/to/repo');

    expect(result.detected).toBe(false);
    expect(result.suggestedTemplate).toBeUndefined();
  });
});
