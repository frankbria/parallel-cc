/**
 * E2B Template Manager - Manages sandbox templates for common workflows
 *
 * Features:
 * - Load built-in templates from templates/ directory
 * - Load custom templates from ~/.parallel-cc/templates/
 * - CRUD operations for custom templates
 * - Template validation
 * - Project type detection for auto-suggesting templates
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import type {
  SandboxTemplate,
  TemplateListEntry,
  TemplateOperationResult,
  TemplateValidationResult,
  ProjectTypeDetection
} from '../types.js';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Reserved template names that cannot be used for custom templates
const RESERVED_NAMES = ['base', 'default', 'custom'];

// Template name validation regex: alphanumeric, hyphens, underscores, dots, 3-50 chars
const TEMPLATE_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,49}$/;

// Maximum length for setup commands
const MAX_COMMAND_LENGTH = 1000;

/**
 * Configuration for TemplateManager
 */
export interface TemplateManagerConfig {
  builtInDir?: string;
  customDir?: string;
}

/**
 * Default paths for template storage
 */
const getDefaultConfig = (): Required<TemplateManagerConfig> => {
  // Use project root's templates/ for built-in
  const projectRoot = path.resolve(__dirname, '..', '..');
  return {
    builtInDir: path.join(projectRoot, 'templates'),
    customDir: path.join(os.homedir(), '.parallel-cc', 'templates')
  };
};

/**
 * Validate template name format
 */
export function validateTemplateName(name: string): boolean {
  if (!name || typeof name !== 'string') {
    return false;
  }

  // Check for reserved names
  if (RESERVED_NAMES.includes(name.toLowerCase())) {
    return false;
  }

  // Check format
  return TEMPLATE_NAME_REGEX.test(name);
}

/**
 * Validate template definition
 */
export function validateTemplate(template: Partial<SandboxTemplate>): TemplateValidationResult {
  const errors: string[] = [];

  // Required fields
  if (!template.name || typeof template.name !== 'string') {
    errors.push('name is required');
  } else if (!validateTemplateName(template.name)) {
    errors.push('name must be 3-50 alphanumeric characters, hyphens, or underscores');
  }

  if (!template.description || typeof template.description !== 'string') {
    errors.push('description is required');
  }

  if (!template.e2bTemplate || typeof template.e2bTemplate !== 'string') {
    errors.push('e2bTemplate is required');
  } else if (template.e2bTemplate.trim() === '') {
    errors.push('e2bTemplate cannot be empty');
  }

  // Optional fields validation
  if (template.setupCommands !== undefined) {
    if (!Array.isArray(template.setupCommands)) {
      errors.push('setupCommands must be an array');
    } else {
      for (let i = 0; i < template.setupCommands.length; i++) {
        const cmd = template.setupCommands[i];
        if (typeof cmd !== 'string') {
          errors.push(`setupCommands[${i}] must be a string`);
        } else if (cmd.length > MAX_COMMAND_LENGTH) {
          errors.push(`setupCommands[${i}] exceeds maximum length of ${MAX_COMMAND_LENGTH} characters`);
        }
      }
    }
  }

  if (template.environment !== undefined) {
    if (typeof template.environment !== 'object' || template.environment === null || Array.isArray(template.environment)) {
      errors.push('environment must be an object');
    } else {
      for (const [key, value] of Object.entries(template.environment)) {
        if (typeof value !== 'string') {
          errors.push(`environment["${key}"] must be a string`);
        }
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Template Manager for E2B sandbox templates
 */
export class TemplateManager {
  private config: Required<TemplateManagerConfig>;

  constructor(config: TemplateManagerConfig = {}) {
    this.config = { ...getDefaultConfig(), ...config };
  }

  /**
   * Load templates from built-in directory
   */
  async loadBuiltInTemplates(): Promise<SandboxTemplate[]> {
    return this.loadTemplatesFromDir(this.config.builtInDir);
  }

  /**
   * Load templates from custom directory
   */
  async loadCustomTemplates(): Promise<SandboxTemplate[]> {
    return this.loadTemplatesFromDir(this.config.customDir);
  }

  /**
   * Load templates from a directory
   */
  private async loadTemplatesFromDir(dir: string): Promise<SandboxTemplate[]> {
    const templates: SandboxTemplate[] = [];

    try {
      const files = await fs.readdir(dir);

      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue;
        }

        try {
          const content = await fs.readFile(path.join(dir, file), 'utf-8');
          const template = JSON.parse(content) as SandboxTemplate;

          // Validate template before adding
          const validation = validateTemplate(template);
          if (validation.isValid) {
            templates.push(template);
          }
        } catch {
          // Skip invalid JSON files
          continue;
        }
      }
    } catch (error: any) {
      // Directory doesn't exist or can't be read
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    return templates;
  }

  /**
   * List all available templates (built-in and custom)
   */
  async listTemplates(): Promise<TemplateListEntry[]> {
    const entries: TemplateListEntry[] = [];

    // Load built-in templates
    const builtIn = await this.loadBuiltInTemplates();
    for (const template of builtIn) {
      entries.push({
        name: template.name,
        description: template.description,
        type: 'built-in',
        e2bTemplate: template.e2bTemplate
      });
    }

    // Load custom templates
    const custom = await this.loadCustomTemplates();
    for (const template of custom) {
      entries.push({
        name: template.name,
        description: template.description,
        type: 'custom',
        e2bTemplate: template.e2bTemplate
      });
    }

    return entries;
  }

  /**
   * Get a specific template by name
   */
  async getTemplate(name: string): Promise<SandboxTemplate | null> {
    // First check built-in templates
    const builtIn = await this.loadBuiltInTemplates();
    const builtInMatch = builtIn.find(t => t.name === name);
    if (builtInMatch) {
      return builtInMatch;
    }

    // Then check custom templates
    const custom = await this.loadCustomTemplates();
    const customMatch = custom.find(t => t.name === name);
    if (customMatch) {
      return customMatch;
    }

    return null;
  }

  /**
   * Check if a template is built-in
   */
  async isBuiltInTemplate(name: string): Promise<boolean> {
    const builtIn = await this.loadBuiltInTemplates();
    return builtIn.some(t => t.name === name);
  }

  /**
   * Create a new custom template
   */
  async createTemplate(template: SandboxTemplate): Promise<TemplateOperationResult> {
    // Validate template name
    if (!validateTemplateName(template.name)) {
      if (RESERVED_NAMES.includes(template.name?.toLowerCase())) {
        return {
          success: false,
          message: 'Template creation failed',
          error: `"${template.name}" is a reserved name`
        };
      }
      return {
        success: false,
        message: 'Template creation failed',
        error: 'Invalid template name: must be 3-50 alphanumeric characters, hyphens, or underscores'
      };
    }

    // Validate template structure
    const validation = validateTemplate(template);
    if (!validation.isValid) {
      return {
        success: false,
        message: 'Template validation failed',
        error: validation.errors.join(', ')
      };
    }

    // Check if template already exists
    const existing = await this.getTemplate(template.name);
    if (existing) {
      return {
        success: false,
        message: 'Template creation failed',
        error: `Template "${template.name}" already exists`
      };
    }

    // Add timestamps
    const templateWithMetadata: SandboxTemplate = {
      ...template,
      metadata: {
        ...template.metadata,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    };

    // Ensure custom directory exists
    await fs.mkdir(this.config.customDir, { recursive: true });

    // Write template file
    const filePath = path.join(this.config.customDir, `${template.name}.json`);
    await fs.writeFile(filePath, JSON.stringify(templateWithMetadata, null, 2), 'utf-8');

    return {
      success: true,
      message: `Template "${template.name}" created successfully`,
      template: templateWithMetadata
    };
  }

  /**
   * Delete a custom template
   */
  async deleteTemplate(name: string): Promise<TemplateOperationResult> {
    // Check if template exists and is not built-in
    const isBuiltIn = await this.isBuiltInTemplate(name);
    if (isBuiltIn) {
      return {
        success: false,
        message: 'Template deletion failed',
        error: `Cannot delete built-in template "${name}"`
      };
    }

    // Check if template exists as custom
    const custom = await this.loadCustomTemplates();
    const exists = custom.some(t => t.name === name);
    if (!exists) {
      return {
        success: false,
        message: 'Template deletion failed',
        error: `Template "${name}" not found`
      };
    }

    // Delete template file
    const filePath = path.join(this.config.customDir, `${name}.json`);
    await fs.unlink(filePath);

    return {
      success: true,
      message: `Template "${name}" deleted successfully`
    };
  }

  /**
   * Export a template as JSON
   */
  async exportTemplate(name: string): Promise<TemplateOperationResult> {
    const template = await this.getTemplate(name);
    if (!template) {
      return {
        success: false,
        message: 'Template export failed',
        error: `Template "${name}" not found`
      };
    }

    return {
      success: true,
      message: `Template "${name}" exported successfully`,
      template
    };
  }

  /**
   * Import a template from JSON string
   */
  async importTemplate(json: string): Promise<TemplateOperationResult> {
    // Parse JSON
    let template: SandboxTemplate;
    try {
      template = JSON.parse(json);
    } catch {
      return {
        success: false,
        message: 'Template import failed',
        error: 'Invalid JSON format'
      };
    }

    // Validate template structure
    const validation = validateTemplate(template);
    if (!validation.isValid) {
      return {
        success: false,
        message: 'Template import failed',
        error: `Template validation failed: ${validation.errors.join(', ')}`
      };
    }

    // Check if it would overwrite a built-in template
    const isBuiltIn = await this.isBuiltInTemplate(template.name);
    if (isBuiltIn) {
      return {
        success: false,
        message: 'Template import failed',
        error: `Cannot overwrite built-in template "${template.name}"`
      };
    }

    // Create the template
    return this.createTemplate(template);
  }

  /**
   * Detect project type and suggest a template
   */
  async detectProjectType(repoPath: string): Promise<ProjectTypeDetection> {
    const detectedFiles: string[] = [];

    // Check for package.json (Node.js projects)
    try {
      await fs.access(path.join(repoPath, 'package.json'));
      detectedFiles.push('package.json');

      // Read package.json to check for specific frameworks
      const packageJson = JSON.parse(
        await fs.readFile(path.join(repoPath, 'package.json'), 'utf-8')
      );

      const deps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies
      };

      // Check for Next.js
      if (deps.next) {
        return {
          detected: true,
          suggestedTemplate: 'full-stack-nextjs',
          reason: 'Next.js project detected',
          detectedFiles
        };
      }

      // Check for TypeScript
      try {
        await fs.access(path.join(repoPath, 'tsconfig.json'));
        detectedFiles.push('tsconfig.json');
        return {
          detected: true,
          suggestedTemplate: 'node-20-typescript',
          reason: 'Node.js TypeScript project detected',
          detectedFiles
        };
      } catch {
        // No tsconfig.json, continue checking
      }

      // Generic Node.js project
      return {
        detected: true,
        suggestedTemplate: 'node-20-typescript',
        reason: 'Node.js project detected',
        detectedFiles
      };
    } catch {
      // No package.json, continue checking
    }

    // Check for Python projects
    try {
      await fs.access(path.join(repoPath, 'pyproject.toml'));
      detectedFiles.push('pyproject.toml');

      // Read pyproject.toml to check for FastAPI
      const content = await fs.readFile(
        path.join(repoPath, 'pyproject.toml'),
        'utf-8'
      );

      if (content.includes('fastapi')) {
        return {
          detected: true,
          suggestedTemplate: 'python-3.12-fastapi',
          reason: 'Python FastAPI project detected',
          detectedFiles
        };
      }

      // Generic Python project
      return {
        detected: true,
        suggestedTemplate: 'python-3.12-fastapi',
        reason: 'Python project detected',
        detectedFiles
      };
    } catch {
      // No pyproject.toml, continue checking
    }

    // Check for requirements.txt
    try {
      await fs.access(path.join(repoPath, 'requirements.txt'));
      detectedFiles.push('requirements.txt');

      const content = await fs.readFile(
        path.join(repoPath, 'requirements.txt'),
        'utf-8'
      );

      if (content.includes('fastapi')) {
        return {
          detected: true,
          suggestedTemplate: 'python-3.12-fastapi',
          reason: 'Python FastAPI project detected',
          detectedFiles
        };
      }

      return {
        detected: true,
        suggestedTemplate: 'python-3.12-fastapi',
        reason: 'Python project detected',
        detectedFiles
      };
    } catch {
      // No requirements.txt
    }

    // No known project type detected
    return {
      detected: false,
      reason: 'No recognizable project type detected'
    };
  }
}
