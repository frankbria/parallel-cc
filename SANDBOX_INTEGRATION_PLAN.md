# Multi-Provider Sandbox Architecture - v1.5 Specification

> **Status:** 📋 **PLANNED** - This is the specification for v1.5 (next major release)
>
> **Current Release:** v1.0 implemented E2B-specific sandbox integration (see ROADMAP.md)
>
> **This Document:** Complete specification for provider-agnostic architecture planned for v1.5

---

## Executive Summary

This document outlines a **provider-agnostic sandboxing architecture** for parallel-cc that supports multiple isolation backends:

| Provider | Type | OS Support | Startup Time | Cost Model |
|----------|------|------------|--------------|------------|
| **Native** | Local OS-level | macOS, Linux | Instant | Free |
| **Docker** | Local container | macOS, Linux, Windows | ~2-5s | Free |
| **E2B** | Cloud VM | Any (remote) | ~150ms | Per-minute |
| **Daytona** | Cloud sandbox | Any (remote) | ~90ms | Per-minute |
| **Cloudflare** | Edge container | Any (remote) | ~100ms | Per-request |

The goal is to enable autonomous Claude Code execution in isolated environments while maintaining parallel-cc's worktree coordination system.

---

## Problem Statement

parallel-cc currently coordinates local Claude Code sessions using git worktrees. For autonomous, long-running tasks with `--dangerously-skip-permissions`, users need isolation guarantees that prevent:

1. **Filesystem damage** - Claude Code modifying critical system files
2. **Network exfiltration** - Malicious prompts leaking sensitive data
3. **Cross-session interference** - Parallel sessions affecting each other
4. **Host system compromise** - Privilege escalation or persistence

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    parallel-cc Sandbox Architecture                       │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  CLI Entry Points                                                        │
│  ────────────────                                                        │
│  parallel-cc sandbox-run --provider <native|docker|e2b|daytona|cloudflare>│
│       │                                                                  │
│       ├──► Provider-specific adapter (implements SandboxProvider)        │
│       │                                                                  │
│       └──► Common execution flow:                                        │
│             1. Create/acquire sandbox environment                        │
│             2. Sync worktree files to sandbox                           │
│             3. Execute Claude Code with task                            │
│             4. Stream output / monitor progress                         │
│             5. Sync results back to worktree                           │
│             6. Cleanup sandbox                                          │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Provider Adapters                                                       │
│  ─────────────────                                                       │
│                                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │   Native    │  │   Docker    │  │    E2B      │  │  Daytona    │     │
│  │  (srt CLI)  │  │ (container) │  │  (cloud)    │  │  (cloud)    │     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
│         │                │                │                │            │
│         ▼                ▼                ▼                ▼            │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │              SandboxProvider Interface                            │   │
│  │  - create(): Promise<SandboxInstance>                            │   │
│  │  - uploadFiles(files: FileList): Promise<void>                   │   │
│  │  - execute(command: string): AsyncGenerator<OutputChunk>         │   │
│  │  - downloadFiles(): Promise<FileList>                            │   │
│  │  - destroy(): Promise<void>                                      │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Configuration Model

### Environment Variables

All providers use a common set of environment variables with provider-specific prefixes:

```bash
# Global Settings
PARALLEL_CC_SANDBOX_PROVIDER=native|docker|e2b|daytona|cloudflare
PARALLEL_CC_SANDBOX_TIMEOUT=3600        # Max execution time (seconds)
PARALLEL_CC_SANDBOX_AUTO_CLEANUP=true   # Auto-destroy sandbox on completion

# Native Provider (Anthropic sandbox-runtime)
PARALLEL_CC_NATIVE_ALLOWED_DOMAINS=github.com,api.anthropic.com
PARALLEL_CC_NATIVE_ALLOW_WRITE_PATHS=.,.git
PARALLEL_CC_NATIVE_DENY_READ_PATHS=~/.ssh,~/.aws,~/.gnupg

# Docker Provider
PARALLEL_CC_DOCKER_IMAGE=anthropic/claude-code:latest
PARALLEL_CC_DOCKER_NETWORK=none|bridge|host
PARALLEL_CC_DOCKER_MEMORY_LIMIT=4g
PARALLEL_CC_DOCKER_CPU_LIMIT=2

# E2B Provider
E2B_API_KEY=<your-e2b-api-key>
PARALLEL_CC_E2B_TEMPLATE=anthropic-claude-code
PARALLEL_CC_E2B_TIMEOUT=3600

# Daytona Provider
DAYTONA_API_KEY=<your-daytona-api-key>
DAYTONA_API_URL=https://api.daytona.io
PARALLEL_CC_DAYTONA_TARGET=us|eu

# Cloudflare Provider
CLOUDFLARE_API_TOKEN=<your-cloudflare-token>
CLOUDFLARE_ACCOUNT_ID=<your-account-id>
PARALLEL_CC_CF_SANDBOX_TIMEOUT=300

# Claude Code (required for all providers)
ANTHROPIC_API_KEY=<your-anthropic-api-key>
```

### CLI Flags

```bash
parallel-cc sandbox-run [options] --prompt "task description"

Options:
  --provider <name>       Sandbox provider: native, docker, e2b, daytona, cloudflare
  --repo <path>           Repository path (default: current directory)
  --worktree <name>       Use existing worktree (optional)
  --timeout <seconds>     Maximum execution time (default: 3600)
  --upload-repo           Upload entire repo to cloud sandbox
  --prompt <text>         Task prompt for Claude Code
  --prompt-file <path>    Read prompt from file (e.g., PLAN.md)
  --dry-run               Test file sync without execution
  --stream                Stream output in real-time (default: true)
  --json                  Output results as JSON
  --no-cleanup            Keep sandbox alive after completion

Provider-specific flags:
  --docker-image <img>    Docker image to use
  --docker-network <net>  Docker network mode
  --e2b-template <name>   E2B sandbox template
  --daytona-target <id>   Daytona target region
  --native-config <path>  Path to srt config file
```

### Configuration File

Optional `~/.parallel-cc/sandbox.json` for persistent settings:

```json
{
  "defaultProvider": "native",
  "providers": {
    "native": {
      "allowedDomains": ["github.com", "api.anthropic.com", "registry.npmjs.org"],
      "filesystem": {
        "allowWrite": [".", ".git"],
        "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh"]
      }
    },
    "docker": {
      "image": "anthropic/claude-code:latest",
      "network": "none",
      "memoryLimit": "4g",
      "cpuLimit": 2
    },
    "e2b": {
      "template": "anthropic-claude-code",
      "defaultTimeout": 3600
    },
    "daytona": {
      "target": "us",
      "autoStopInterval": 1800,
      "autoArchiveInterval": 86400
    },
    "cloudflare": {
      "timeout": 300
    }
  },
  "uploadIgnorePatterns": [
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "__pycache__",
    "*.pyc",
    ".env*"
  ]
}
```

---

## Provider Implementations

### 1. Native Provider (Anthropic sandbox-runtime)

**Best for:** Quick local development, low-latency iteration, no external dependencies

**Implementation:**
```typescript
// src/sandbox/providers/native.ts
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';

export class NativeSandboxProvider implements SandboxProvider {
  async create(config: NativeConfig): Promise<SandboxInstance> {
    const srtConfig = {
      network: {
        allowedDomains: config.allowedDomains,
        allowLocalBinding: false
      },
      filesystem: {
        allowWrite: config.allowWritePaths,
        denyRead: config.denyReadPaths
      }
    };

    await SandboxManager.initialize(srtConfig);
    return new NativeSandboxInstance();
  }

  async execute(command: string): AsyncGenerator<OutputChunk> {
    const wrapped = await SandboxManager.wrapWithSandbox(command);
    // Execute and stream output...
  }
}
```

**Platform Support:**

| Platform | Implementation | Dependencies |
|----------|----------------|--------------|
| macOS | `sandbox-exec` (Seatbelt) | `ripgrep` |
| Linux | `bubblewrap` | `bubblewrap`, `socat`, `ripgrep` |
| Windows | **Not supported** | — |

**Limitations:**
- No Windows support
- Linux requires literal paths (no globs)
- Cannot sandbox Docker-in-Docker scenarios
- Network filtering can be bypassed via domain fronting

---

### 2. Docker Provider

**Best for:** Cross-platform isolation, custom environments, Windows support via WSL

**Implementation:**
```typescript
// src/sandbox/providers/docker.ts
import Docker from 'dockerode';

export class DockerSandboxProvider implements SandboxProvider {
  private docker = new Docker();

  async create(config: DockerConfig): Promise<SandboxInstance> {
    const container = await this.docker.createContainer({
      Image: config.image,
      Cmd: ['/bin/bash'],
      Tty: true,
      HostConfig: {
        NetworkMode: config.network,
        Memory: config.memoryLimit,
        CpuQuota: config.cpuLimit * 100000,
        Binds: [`${config.worktreePath}:/workspace:rw`],
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['ALL']
      },
      WorkingDir: '/workspace',
      Env: [`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`]
    });

    await container.start();
    return new DockerSandboxInstance(container);
  }
}
```

**Platform Support:**

| Platform | Support Level | Notes |
|----------|---------------|-------|
| macOS | Full | Docker Desktop or Colima |
| Linux | Full | Native Docker engine |
| Windows | Via WSL2 | Docker Desktop with WSL2 backend |

**Recommended Images:**
- `anthropic/claude-code:latest` - Official Claude Code image
- `node:20-slim` + Claude Code install - Minimal footprint
- Custom Dockerfile with project-specific tooling

---

### 3. E2B Provider

**Best for:** Long-running autonomous tasks, pre-approved plans, maximum isolation

**Implementation:**
```typescript
// src/sandbox/providers/e2b.ts
import { Sandbox } from 'e2b';

export class E2BSandboxProvider implements SandboxProvider {
  async create(config: E2BConfig): Promise<SandboxInstance> {
    const sandbox = await Sandbox.create(config.template, {
      timeout: config.timeout * 1000,
      envs: {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!
      }
    });

    // Always update Claude Code to latest version
    await sandbox.commands.run('claude update');

    return new E2BSandboxInstance(sandbox);
  }

  async uploadFiles(sandbox: Sandbox, files: FileList): Promise<void> {
    // Create tarball, upload, extract
    const tarball = await createTarball(files);
    await sandbox.files.write('/tmp/repo.tar.gz', tarball);
    await sandbox.commands.run('tar -xzf /tmp/repo.tar.gz -C /workspace');
  }

  async *execute(sandbox: Sandbox, prompt: string): AsyncGenerator<OutputChunk> {
    const process = await sandbox.commands.run(
      `echo "${escapePrompt(prompt)}" | claude -p --dangerously-skip-permissions --output-format stream-json`,
      {
        onStdout: (data) => this.emit('stdout', data),
        onStderr: (data) => this.emit('stderr', data),
        timeout: this.config.timeout * 1000
      }
    );

    yield* this.parseStreamJson(process.stdout);
  }
}
```

**Pricing (as of 2025):**
- Hobby tier: 1 hour max session, limited concurrency
- Pro tier: 24 hour max session, higher concurrency
- Per-minute billing based on compute resources

---

### 4. Daytona Provider

**Best for:** Enterprise environments, compliance requirements (SOC2, HIPAA), desktop automation

**Implementation:**
```typescript
// src/sandbox/providers/daytona.ts
import { Daytona, CreateSandboxParams } from '@daytonaio/sdk';

export class DaytonaSandboxProvider implements SandboxProvider {
  private daytona: Daytona;

  constructor(config: DaytonaConfig) {
    this.daytona = new Daytona({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      target: config.target
    });
  }

  async create(config: DaytonaConfig): Promise<SandboxInstance> {
    const sandbox = await this.daytona.create({
      language: 'javascript',
      autoStopInterval: config.autoStopInterval,
      autoArchiveInterval: config.autoArchiveInterval,
      envVars: {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!
      }
    });

    // Install Claude Code
    await sandbox.process.exec('npm install -g @anthropic-ai/claude-code');

    return new DaytonaSandboxInstance(sandbox);
  }

  async uploadFiles(sandbox: DaytonaSandbox, files: FileList): Promise<void> {
    for (const file of files) {
      await sandbox.files.upload(file.path, file.content);
    }
  }
}
```

**Unique Features:**
- Sub-90ms sandbox creation
- Git integration built-in
- Language Server Protocol support
- Desktop automation (Linux/Windows/macOS VMs)

---

### 5. Cloudflare Provider

**Best for:** Short tasks, global edge execution, pay-per-request pricing

**Implementation:**
```typescript
// src/sandbox/providers/cloudflare.ts
import { Sandbox } from '@cloudflare/sandbox';

export class CloudflareSandboxProvider implements SandboxProvider {
  async create(config: CloudflareConfig): Promise<SandboxInstance> {
    const sandbox = await Sandbox.create({
      accountId: config.accountId,
      apiToken: config.apiToken,
      timeout: config.timeout
    });

    return new CloudflareSandboxInstance(sandbox);
  }

  async execute(sandbox: Sandbox, command: string): AsyncGenerator<OutputChunk> {
    const result = await sandbox.exec(command, {
      streaming: true
    });

    yield* result.stdout;
  }
}
```

**Limitations:**
- Shorter timeout limits (experimental feature)
- Edge-optimized, not for heavy compute
- Workers platform restrictions apply

---

## Cross-Platform OS Considerations

### Platform Compatibility Matrix

| Feature | macOS | Linux | Windows |
|---------|-------|-------|---------|
| Native sandbox (srt) | Seatbelt | bubblewrap | Not supported |
| Docker sandbox | Docker Desktop | Native Docker | WSL2 + Docker Desktop |
| Cloud sandboxes | Full support | Full support | Full support |
| Git worktrees | Full support | Full support | Full support |
| File sync | rsync/tar | rsync/tar | tar (no rsync) |
| Path handling | POSIX | POSIX | Convert to POSIX |

### Platform-Specific Implementation Notes

#### macOS

```typescript
// Native sandbox uses Seatbelt profiles
const macOSConfig = {
  // Glob patterns supported
  filesystem: {
    allowWrite: ['**/*.ts', '**/*.js'],
    denyRead: ['~/.ssh/*', '~/.aws/*']
  }
};

// Docker requires Docker Desktop or Colima
// Path mounting works directly
```

#### Linux

```typescript
// Native sandbox uses bubblewrap
// Linux requires literal paths, no globs
const linuxConfig = {
  filesystem: {
    allowWrite: ['/home/user/project', '/home/user/project/.git'],
    denyRead: ['/home/user/.ssh', '/home/user/.aws']
  }
};

// Check for bubblewrap installation
const hasBwrap = await commandExists('bwrap');
if (!hasBwrap) {
  console.warn('Installing bubblewrap: apt-get install bubblewrap');
}
```

#### Windows

```typescript
// Native sandbox NOT supported on Windows
// Must use Docker (via WSL2) or cloud providers

if (process.platform === 'win32') {
  if (config.provider === 'native') {
    throw new Error('Native sandboxing not supported on Windows. Use --provider docker or a cloud provider.');
  }

  // Convert Windows paths to POSIX for Docker
  const worktreePath = windowsToWsl(config.worktreePath);
}
```

### Dependency Detection

```typescript
// src/sandbox/platform.ts
export async function detectPlatformCapabilities(): Promise<PlatformCaps> {
  const platform = process.platform;

  return {
    platform,
    nativeSupported: platform !== 'win32',
    dockerAvailable: await commandExists('docker'),
    wslAvailable: platform === 'win32' && await checkWslInstalled(),
    bubblewrapAvailable: platform === 'linux' && await commandExists('bwrap'),
    ripgrepAvailable: await commandExists('rg'),

    recommendedProvider: detectRecommendedProvider()
  };
}

function detectRecommendedProvider(): string {
  if (process.platform === 'win32') {
    return 'docker';
  }
  if (process.env.E2B_API_KEY) {
    return 'e2b';
  }
  if (process.env.DAYTONA_API_KEY) {
    return 'daytona';
  }
  return 'native';
}
```

---

## Database Schema Changes

```sql
-- Extend sessions table for sandbox tracking
ALTER TABLE sessions ADD COLUMN sandbox_provider TEXT;
-- Values: 'local' | 'native' | 'docker' | 'e2b' | 'daytona' | 'cloudflare'

ALTER TABLE sessions ADD COLUMN sandbox_id TEXT;
-- Provider-specific sandbox identifier

ALTER TABLE sessions ADD COLUMN sandbox_status TEXT DEFAULT 'pending';
-- Values: 'pending' | 'creating' | 'running' | 'completed' | 'failed' | 'timeout'

ALTER TABLE sessions ADD COLUMN prompt TEXT;
-- Task prompt for autonomous execution

ALTER TABLE sessions ADD COLUMN output_log_path TEXT;
-- Path to streaming output log file

ALTER TABLE sessions ADD COLUMN started_at TEXT;
-- When sandbox execution began

ALTER TABLE sessions ADD COLUMN completed_at TEXT;
-- When sandbox execution finished

-- Index for sandbox queries
CREATE INDEX idx_sessions_sandbox ON sessions(sandbox_provider, sandbox_status);
```

---

## New Source Files

```
src/
├── sandbox/
│   ├── index.ts              # Sandbox module exports
│   ├── types.ts              # SandboxProvider interface, configs
│   ├── factory.ts            # Provider factory (create by name)
│   ├── file-sync.ts          # Upload/download utilities
│   ├── output-monitor.ts     # Real-time output streaming
│   ├── platform.ts           # OS detection and capabilities
│   └── providers/
│       ├── native.ts         # Anthropic sandbox-runtime
│       ├── docker.ts         # Docker container provider
│       ├── e2b.ts            # E2B cloud sandbox
│       ├── daytona.ts        # Daytona cloud sandbox
│       └── cloudflare.ts     # Cloudflare Workers sandbox

tests/
├── sandbox/
│   ├── factory.test.ts       # Provider factory tests
│   ├── file-sync.test.ts     # File sync tests
│   ├── platform.test.ts      # Platform detection tests
│   └── providers/
│       ├── native.test.ts    # Native provider tests
│       ├── docker.test.ts    # Docker provider tests
│       └── e2b.test.ts       # E2B provider tests
```

---

## CLI Commands

### New Commands

```bash
# Execute task in sandbox
parallel-cc sandbox-run --provider native --prompt "Implement auth system"
parallel-cc sandbox-run --provider e2b --prompt-file PLAN.md --timeout 3600
parallel-cc sandbox-run --provider docker --docker-image node:20

# Check sandbox status
parallel-cc sandbox-status [--session-id <id>]
parallel-cc sandbox-logs --session-id <id> [--follow]

# Download results from running sandbox
parallel-cc sandbox-download --session-id <id> --output ./results

# Terminate sandbox
parallel-cc sandbox-kill --session-id <id>

# Platform diagnostics
parallel-cc doctor --sandbox
# Output:
# Platform: linux
# Native sandbox: ✓ bubblewrap available
# Docker: ✓ Docker 24.0.5
# E2B: ✓ API key configured
# Daytona: ✗ API key not set
```

### Updated Commands

```bash
# Status now shows sandbox info
parallel-cc status
# Active Sessions: 2
#   ● Session abc123 (local)
#     Path: /home/user/project
#   ● Session def456 (e2b, running)
#     Prompt: "Implement auth system"
#     Duration: 12m / 60m timeout

# Install now includes sandbox configuration
parallel-cc install --all
# Installs: hooks + alias + MCP + sandbox config
```

---

## Execution Flow

### Local Sandbox (Native/Docker)

```
┌─────────────────────────────────────────────────────────────────┐
│              Local Sandbox Execution Flow                        │
├─────────────────────────────────────────────────────────────────┤
│ 1. User: parallel-cc sandbox-run --provider native --prompt ... │
│ 2. Coordinator: Create worktree via gtr (if needed)            │
│ 3. Coordinator: Register session in SQLite with sandbox_provider│
│ 4. Platform: Verify native/docker prerequisites                 │
│ 5. Provider: Initialize sandbox with security config            │
│ 6. Execute: Run Claude Code with --dangerously-skip-permissions │
│ 7. Monitor: Stream output to terminal and log file              │
│ 8. Cleanup: Reset sandbox, update session status                │
│ 9. Done: Files already in worktree, no sync needed              │
└─────────────────────────────────────────────────────────────────┘
```

### Cloud Sandbox (E2B/Daytona/Cloudflare)

```
┌─────────────────────────────────────────────────────────────────┐
│              Cloud Sandbox Execution Flow                        │
├─────────────────────────────────────────────────────────────────┤
│ 1. User: parallel-cc sandbox-run --provider e2b --prompt ...    │
│ 2. Coordinator: Create worktree via gtr (if needed)             │
│ 3. Coordinator: Register session in SQLite with sandbox_provider│
│ 4. Provider: Create cloud sandbox (150ms - 2s)                  │
│ 5. FileSync: Upload worktree files (exclude .git, node_modules) │
│ 6. Provider: Run `claude update` to ensure latest version       │
│ 7. Execute: Run Claude Code with --dangerously-skip-permissions │
│ 8. Monitor: Stream output via WebSocket/callbacks               │
│ 9. FileSync: Download changed files back to worktree            │
│ 10. Git: Commit changes with "[Sandbox] Task completed" message │
│ 11. Cleanup: Terminate sandbox, update session status           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Risks and Potential Issues

### Provider-Specific Risks

#### Native Sandbox (sandbox-runtime)

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Windows not supported** | High | Fallback to Docker; clear error message |
| **Network bypass via domain fronting** | Medium | Document limitation; use stricter allowlists |
| **Unix socket access can bypass sandbox** | Medium | Disable `allowUnixSockets` by default |
| **Linux glob patterns not supported** | Low | Auto-expand globs to literal paths |
| **Requires root for bubblewrap on some distros** | Medium | Check permissions; suggest alternatives |

#### Docker Sandbox

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Docker not installed** | High | Check on startup; provide install instructions |
| **Windows path conversion issues** | Medium | Convert paths via WSL; test thoroughly |
| **Container escape vulnerabilities** | Low | Use `--security-opt no-new-privileges`, drop capabilities |
| **Resource exhaustion** | Medium | Set memory/CPU limits; monitor usage |
| **Slow volume mounts on macOS** | Low | Use named volumes for large codebases |

#### E2B Cloud

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Cost overruns** | High | Enforce timeouts; warn at 30m/50m; cost estimates |
| **API key exposure** | High | Never log API keys; use env vars only |
| **Large repo upload fails** | Medium | Compress; use .gitignore; size limits (500MB) |
| **Template version outdated** | Medium | Always run `claude update` first |
| **Network failures mid-execution** | Medium | Retry logic; checkpoint partial results |
| **E2B service outage** | Low | Graceful fallback to local; clear error messages |

#### Daytona Cloud

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Alpha SDK instability** | Medium | Pin SDK version; extensive testing |
| **API rate limits** | Low | Implement backoff; cache sandbox instances |
| **Regional availability** | Low | Allow target selection; fallback regions |
| **Auto-archive loses state** | Medium | Configure appropriate intervals; warn users |

#### Cloudflare Sandbox

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Experimental feature** | High | Mark as beta; warn about changes |
| **Short timeout limits** | High | Only recommend for short tasks |
| **Workers platform restrictions** | Medium | Document limitations; test edge cases |
| **No persistent filesystem** | Medium | Upload/download every execution |

### Cross-Platform Risks

| Risk | OS | Severity | Mitigation |
|------|-----|----------|------------|
| **Native sandbox unsupported** | Windows | High | Auto-select Docker; clear messaging |
| **bubblewrap not installed** | Linux | Medium | Auto-detect; installation guide |
| **Docker Desktop licensing** | All | Low | Suggest alternatives (Colima, Podman) |
| **WSL2 not enabled** | Windows | Medium | Detection; setup guide |
| **Path separator issues** | Windows | Medium | Normalize all paths to POSIX |
| **File permission mismatches** | macOS/Linux | Low | Preserve permissions during sync |

### Security Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Prompt injection attacks** | High | Sandbox isolation prevents host damage |
| **API key theft from sandbox** | Medium | Keys passed via env vars, not files |
| **Data exfiltration via allowed domains** | Medium | Minimal allowlist; document risks |
| **Secrets in codebase uploaded to cloud** | High | Exclude .env files; warn on upload |
| **Sandbox escape (theoretical)** | Low | Use hardened containers; stay updated |

### Operational Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Conflicting worktree changes** | Medium | Merge conflicts handled at review time |
| **Orphaned cloud sandboxes** | Medium | Aggressive timeout; cleanup on crash |
| **Inconsistent Claude Code versions** | Medium | Always update before execution |
| **Output buffer overflow** | Low | Truncate logs; archive large outputs |
| **Session tracking out of sync** | Low | Health checks; auto-recovery |

---

## Implementation Phases

### Phase 1: Foundation (Week 1-2)

**Goal:** Provider interface and native sandbox implementation

- [ ] Define `SandboxProvider` interface and types
- [ ] Implement platform detection (`platform.ts`)
- [ ] Implement native provider using `@anthropic-ai/sandbox-runtime`
- [ ] Add `sandbox-run` CLI command (native only)
- [ ] Add database schema changes
- [ ] Unit tests for platform detection and native provider
- [ ] Update `doctor` command with sandbox diagnostics

**Deliverable:** `parallel-cc sandbox-run --provider native` working on macOS/Linux

### Phase 2: Docker Provider (Week 3)

**Goal:** Cross-platform support via Docker

- [ ] Implement Docker provider using `dockerode`
- [ ] Handle Windows path conversion
- [ ] Add Docker network and resource configuration
- [ ] Test on macOS, Linux, Windows (WSL2)
- [ ] Unit tests for Docker provider
- [ ] Integration tests with real containers

**Deliverable:** `parallel-cc sandbox-run --provider docker` working on all platforms

### Phase 3: Cloud Providers (Week 4-5)

**Goal:** E2B and Daytona cloud sandbox integration

- [ ] Implement E2B provider using `e2b` SDK
- [ ] Implement Daytona provider using `@daytonaio/sdk`
- [ ] Build file sync utilities (upload/download)
- [ ] Add streaming output support
- [ ] Implement cost tracking and warnings
- [ ] Unit tests for cloud providers
- [ ] Integration tests with real cloud sandboxes

**Deliverable:** Cloud providers working with file sync

### Phase 4: Polish & Documentation (Week 6)

**Goal:** Production-ready release

- [ ] Add `sandbox-status`, `sandbox-logs`, `sandbox-kill` commands
- [ ] Implement `--dry-run` mode
- [ ] Add Cloudflare provider (experimental)
- [ ] Update MCP server with sandbox tools
- [ ] Write user documentation
- [ ] Create example workflows
- [ ] Performance testing and optimization
- [ ] >85% test coverage

**Deliverable:** v1.0.0 release with full sandbox support

---

## Validation Experiments

Before full implementation, validate these critical assumptions:

### 1. Native Sandbox Performance

**Test:** Measure overhead of `srt` wrapper on typical Claude Code operations

```bash
# Baseline (no sandbox)
time claude -p "Hello" --dangerously-skip-permissions

# With srt
time srt "claude -p 'Hello' --dangerously-skip-permissions"
```

**Success criteria:** <100ms overhead per command

### 2. Docker Volume Performance on macOS

**Test:** Large codebase file operations in mounted volume

```bash
# Time a typical operation
docker run -v $(pwd):/workspace node:20 npm install
```

**Success criteria:** <2x slowdown vs native

### 3. Cloud Upload/Download Speed

**Test:** Upload 50MB/200MB/500MB repos to E2B

```typescript
const start = Date.now();
await sandbox.files.write('/tmp/repo.tar.gz', tarball);
const uploadTime = Date.now() - start;
```

**Success criteria:** <60s for 200MB

### 4. Claude Code Plan Execution

**Test:** Verify Claude Code can execute multi-step plans autonomously

```bash
echo "Execute the plan in PLAN.md" | claude -p --dangerously-skip-permissions
```

**Success criteria:** Claude reads plan, executes steps, commits results

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Sandbox creation time (native) | <100ms |
| Sandbox creation time (Docker) | <5s |
| Sandbox creation time (cloud) | <2s |
| File sync (100MB repo) | <30s upload, <15s download |
| Output streaming latency | <500ms |
| Test coverage | >85% |
| Platform support | macOS, Linux, Windows (Docker) |
| Provider support | 5 providers |

---

## Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/sandbox-runtime": "^0.1.0",
    "dockerode": "^4.0.0",
    "e2b": "^1.0.0",
    "@daytonaio/sdk": "^0.1.0",
    "@cloudflare/sandbox": "^0.6.0"
  },
  "devDependencies": {
    "@types/dockerode": "^3.3.0"
  }
}
```

---

## Appendix: Provider Comparison

| Feature | Native | Docker | E2B | Daytona | Cloudflare |
|---------|--------|--------|-----|---------|------------|
| **Startup time** | Instant | 2-5s | 150ms | 90ms | 100ms |
| **Windows support** | No | WSL2 | Yes | Yes | Yes |
| **Isolation level** | OS sandbox | Container | VM | Container | Isolate |
| **Network control** | Domain allowlist | Network modes | Full | Full | Workers limits |
| **Filesystem access** | Local paths | Mounted volumes | Upload/download | Upload/download | Upload/download |
| **Max timeout** | Unlimited | Unlimited | 24h (Pro) | Configurable | 5min (experimental) |
| **Cost** | Free | Free | Per-minute | Per-minute | Per-request |
| **Best for** | Quick iteration | Cross-platform | Long autonomous | Enterprise | Short tasks |

---

## References

- [Claude Code Sandboxing Documentation](https://code.claude.com/docs/en/sandboxing)
- [Anthropic Sandbox Runtime (GitHub)](https://github.com/anthropic-experimental/sandbox-runtime)
- [E2B Documentation](https://e2b.dev/docs)
- [Daytona Documentation](https://www.daytona.io/docs/en/)
- [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/)
- [Docker Sandboxes for Claude Code](https://docs.docker.com/ai/sandboxes/claude-code/)
