# Claude Execution Engine - Architectural Flow

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Claude Execution Engine                          │
│                         (executeClaudeInSandbox)                     │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  │
          ┌───────────────────────┼───────────────────────┐
          │                       │                       │
          ▼                       ▼                       ▼
    ┌──────────┐          ┌──────────────┐        ┌────────────┐
    │ Sandbox  │          │    Claude    │        │   Output   │
    │ Manager  │          │    Runner    │        │  Monitor   │
    └──────────┘          └──────────────┘        └────────────┘
          │                       │                       │
          │                       │                       │
          ▼                       ▼                       ▼
    ┌──────────┐          ┌──────────────┐        ┌────────────┐
    │ Health   │          │   Command    │        │  Streaming │
    │ Checks   │          │  Execution   │        │  Polling   │
    └──────────┘          └──────────────┘        └────────────┘
```

---

## Execution Flow Diagram

```
User CLI Command
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 0: Preparation                                        │
│ ─────────────────────                                       │
│ 1. SessionDB.createE2BSession() - Create database record    │
│ 2. SandboxManager.createSandbox() - Spin up E2B VM         │
│ 3. FileSync.createTarball() - Compress worktree            │
│ 4. FileSync.uploadToSandbox() - Upload workspace           │
└─────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: executeClaudeInSandbox()                          │
│ ──────────────────────────────────                          │
│                                                             │
│  Step 1/4: Verify Sandbox Health                           │
│  ─────────────────────────────                             │
│  • SandboxManager.monitorSandboxHealth(sandboxId)          │
│  • Check sandbox.isRunning()                               │
│  • Verify heartbeat response                               │
│  • Exit if unhealthy                                       │
│                                                             │
│  ✓ Sandbox healthy → Continue                              │
└─────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 2/4: Ensure Latest Claude Version                    │
│  ───────────────────────────────────                        │
│  • runClaudeUpdate(sandbox, logger)                        │
│  • Execute: claude update                                  │
│  • Timeout: 2 minutes                                      │
│  • Parse version from output                               │
│  • Non-fatal if fails (warn and continue)                  │
│                                                             │
│  ✓ Claude updated → Continue                               │
└─────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 3/4: Execute Claude with Prompt                      │
│  ─────────────────────────────                             │
│  • runClaudeWithPrompt(sandbox, prompt, logger, options)   │
│                                                             │
│  Sub-steps:                                                │
│  ├─ sanitizePrompt(prompt) - Prevent shell injection       │
│  ├─ createTempLogFile(sandbox) - /tmp/claude-output.log    │
│  ├─ StreamMonitor.startStreaming() - Begin polling         │
│  ├─ Execute: echo "$PROMPT" | claude -p --dangerously...   │
│  ├─ Monitor output in real-time (500ms poll)               │
│  └─ Wait for completion or timeout                         │
│                                                             │
│  ✓ Execution complete → Process results                    │
└─────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 4/4: Capture Output and Return Results               │
│  ────────────────────────────────────────                   │
│  • StreamMonitor.stopStreaming() - Final poll               │
│  • StreamMonitor.getBufferedOutput() - Last 50KB            │
│  • StreamMonitor.getFullOutput() - Complete log (optional)  │
│  • Determine state: completed/failed/timeout/killed         │
│  • Calculate execution time                                 │
│  • Return ClaudeExecutionResult                             │
│                                                             │
│  ✓ Results ready                                            │
└─────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 2: Post-Execution Cleanup                            │
│ ────────────────────────────                                │
│ 1. SessionDB.updateE2BSessionStatus() - Update status      │
│ 2. FileSync.downloadChangedFiles() - Get results           │
│ 3. SandboxManager.terminateSandbox() - Cleanup VM          │
│ 4. SessionDB.cleanupE2BSession() - Finalize record         │
└─────────────────────────────────────────────────────────────┘
       │
       ▼
    Results returned to user
```

---

## Output Monitoring Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    StreamMonitor Lifecycle                   │
└─────────────────────────────────────────────────────────────┘

1. Initialize
   ──────────
   • new StreamMonitor(sandbox, logger, options)
   • Register event handlers: onChunk, onComplete, onError

2. Start Streaming
   ────────────────
   • startStreaming(remoteLogPath, localLogPath)
   • Create empty buffer (50KB max)
   • Initialize local log file (optional)
   • Start polling timer (500ms intervals)

3. Polling Loop (every 500ms)
   ──────────────────────────
   • Check if log file exists
   • Get current file size: stat -c %s <logFile>
   • If file grew:
     ├─ Read new bytes: tail -c +<offset> <logFile>
     ├─ Append to in-memory buffer (with truncation)
     ├─ Persist to local log file (if enabled)
     └─ Emit 'chunk' event with new content
   • If file size explosion (>100MB):
     └─ Truncate file: tail -c 100M <logFile>

4. Progress Callbacks
   ───────────────────
   • User-provided onProgress() called for each chunk
   • Real-time console output
   • Progress bars, status updates, etc.

5. Stop Streaming
   ───────────────
   • stopStreaming()
   • Clear polling timer
   • Final poll to capture remaining output
   • Emit 'complete' event

6. Retrieve Output
   ────────────────
   • getBufferedOutput() - Returns last 50KB
   • getFullOutput() - Reads entire local log file
```

---

## Error Handling Decision Tree

```
┌─────────────────────────────────────────────────────────────┐
│                      Error Scenarios                         │
└─────────────────────────────────────────────────────────────┘

Health Check Failed
│
├─ Sandbox not running?
│  └─ Return: { success: false, state: 'failed', error: '...' }
│
├─ Network error?
│  └─ Retry 3x → Still failing? → Terminate sandbox
│
└─ API quota exceeded?
   └─ Return clear error message with dashboard link

─────────────────────────────────────────────────────────────

Claude Update Failed
│
├─ Timeout (>2 minutes)?
│  └─ WARN: Continue anyway (non-fatal)
│
├─ Network error?
│  └─ WARN: Continue anyway (non-fatal)
│
└─ Permission error?
   └─ WARN: Continue anyway (non-fatal)

─────────────────────────────────────────────────────────────

Execution Failed
│
├─ Exit code 124 (timeout)?
│  └─ Return: { state: 'timeout', exitCode: 124 }
│
├─ Exit code != 0?
│  └─ Return: { state: 'failed', exitCode: <code>, output: '...' }
│
├─ Sandbox crashed?
│  └─ Health check detects → Terminate → Return: { state: 'killed' }
│
└─ Hard timeout reached (60 minutes)?
   └─ SandboxManager.enforceTimeout() → Terminate → Return: { state: 'timeout' }

─────────────────────────────────────────────────────────────

Output Capture Failed
│
├─ Buffer overflow?
│  └─ Truncate to last 50KB (keep most recent)
│
├─ File I/O error (local log)?
│  └─ WARN: Continue without local persistence
│
├─ Polling error?
│  └─ Emit 'error' event → Log → Continue polling
│
└─ Log file missing?
   └─ Wait for creation (Claude hasn't started writing yet)
```

---

## Integration Points

### SandboxManager Integration
```typescript
// Health monitoring
const health = await sandboxManager.monitorSandboxHealth(sandboxId);
if (!health.isHealthy) {
  // Terminate execution
}

// Timeout enforcement
const warning = await sandboxManager.enforceTimeout(sandboxId);
if (warning?.warningLevel === 'hard') {
  // Immediate termination
  await sandboxManager.terminateSandbox(sandboxId);
}

// Cost tracking
const cost = sandboxManager.getEstimatedCost(sandboxId);
logger.info(`Estimated cost: ${cost}`);
```

### SessionDB Integration
```typescript
// Create session record
const sessionId = await db.createE2BSession({
  id: 'session-' + Date.now(),
  sandbox_id: sandboxId,
  prompt: userPrompt,
  status: SandboxStatus.INITIALIZING,
  // ... other fields
});

// Update during execution
db.updateE2BSessionStatus(
  sandboxId,
  SandboxStatus.RUNNING,
  outputLog
);

// Finalize after completion
db.cleanupE2BSession(
  sandboxId,
  result.state === 'completed'
    ? SandboxStatus.COMPLETED
    : SandboxStatus.FAILED
);
```

### FileSync Integration
```typescript
// Before execution: Upload workspace
const tarball = await createTarball(worktreePath);
await uploadToSandbox(tarball.path, sandbox, '/workspace');

// After execution: Download results
await downloadChangedFiles(sandbox, '/workspace', worktreePath);
```

---

## Security Hardening

### Prompt Sanitization
```typescript
function sanitizePrompt(prompt: string): string {
  // 1. Validate input
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('Invalid prompt');
  }

  // 2. Length check (max 100KB)
  if (prompt.length > 100000) {
    throw new Error('Prompt too long');
  }

  // 3. Remove control characters (except \n, \t)
  const cleaned = prompt.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

  // 4. Escape shell metacharacters
  return cleaned.replace(/([;&|`$(){}[\]<>*?~!\\])/g, '\\$1');
}
```

### Path Validation
```typescript
function validateFilePath(path: string): boolean {
  // 1. Prevent directory traversal
  if (PATH_TRAVERSAL_PATTERN.test(path)) {
    throw new Error('Directory traversal detected');
  }

  // 2. Prevent absolute paths
  if (ABSOLUTE_PATH_PATTERN.test(path)) {
    throw new Error('Absolute paths not allowed');
  }

  // 3. Prevent null bytes
  if (path.includes('\0')) {
    throw new Error('Null byte detected');
  }

  return true;
}
```

---

## Performance Optimizations

### Memory Efficiency
- **Buffering**: Only keep last 50KB in memory
- **Chunked Reading**: 4KB chunks for file operations
- **Log Rotation**: Truncate logs >100MB automatically
- **Streaming**: Events instead of polling entire file

### Network Efficiency
- **Polling Interval**: 500ms (configurable)
- **Incremental Reads**: Only new bytes since last poll
- **Compression**: Gzip for tarball uploads
- **Resumable Uploads**: Checkpoint every 50MB

### Timeout Strategy
- **Soft Warnings**: 30min, 50min (non-blocking)
- **Hard Timeout**: 60min (immediate termination)
- **Cost Awareness**: Report estimated cost at warnings
- **Graceful Shutdown**: Cleanup resources on timeout

---

## Example Usage

### Basic Execution
```typescript
import { executeClaudeInSandbox } from './e2b/claude-runner.js';
import { SandboxManager } from './e2b/sandbox-manager.js';
import { logger } from './logger.js';

const sandboxManager = new SandboxManager(logger);
const { sandbox, sandboxId } = await sandboxManager.createSandbox('my-session');

const result = await executeClaudeInSandbox(
  sandbox,
  sandboxManager,
  'Create a REST API with Express.js',
  logger,
  {
    workingDir: '/workspace',
    timeout: 60,
    streamOutput: true,
    onProgress: (chunk) => console.log(chunk)
  }
);

console.log(`Execution ${result.state} in ${result.executionTime}ms`);
console.log(`Output: ${result.output}`);

await sandboxManager.terminateSandbox(sandboxId);
```

### With Local Log Persistence
```typescript
const result = await executeClaudeInSandbox(
  sandbox,
  sandboxManager,
  userPrompt,
  logger,
  {
    captureFullLog: true,
    localLogPath: `~/.parallel-cc/logs/${sandboxId}.log`
  }
);

// Read full log later
const fullLog = await fs.readFile(result.localLogPath, 'utf-8');
```

### Monitoring Long-Running Execution
```typescript
const monitor = await monitorExecution(sandboxManager, sandboxId, logger);
if (monitor.shouldTerminate) {
  logger.error(`Terminating: ${monitor.reason}`);
  await sandboxManager.terminateSandbox(sandboxId);
}
```

---

## Next Steps

**Phase 6**: CLI commands will expose this functionality via:
- `parallel-cc execute <prompt>` - Main entry point
- `parallel-cc sandbox-logs <id>` - View streaming logs
- `parallel-cc sandbox-status <id>` - Check execution state

**Phase 7**: E2E tests will validate:
- Full workflow from upload → execute → download
- Timeout enforcement in real scenarios
- Error recovery and retry logic
- Cost tracking accuracy
