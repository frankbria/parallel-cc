# Critical Fix Required for v1.0 Release

**Issue**: Missing timeout parameters on E2B SDK calls
**Severity**: CRITICAL
**Priority**: MUST FIX before merge to main
**Estimated Time**: 2-3 hours
**Tracking**: CODE_REVIEW_v1.0.md (Issue C1)

---

## Problem Summary

Multiple E2B SDK API calls lack timeout parameters, which could cause indefinite hangs:
- File upload/download operations
- Sandbox health checks
- Output monitoring polls
- Command executions

**Impact:**
- Operations hang indefinitely on network issues
- Sandbox costs accumulate during hangs ($0.10/hour)
- Resource exhaustion (max concurrent sandboxes blocked)
- Poor user experience (no feedback on hangs)

---

## Files Requiring Updates

### 1. `src/e2b/file-sync.ts`

**Lines to fix**: 234, 237, 296, 304, 352, 378

```typescript
// Line 234 - Add timeout to file write
await sandbox.files.write(
  remotePath + '/worktree.tar.gz',
  fileBuffer,
  { timeoutMs: 5 * 60 * 1000 } // 5 minute timeout for large files
);

// Line 237 - Add timeout to tar extraction
await sandbox.commands.run(
  `mkdir -p ${remotePath} && tar -xzf ${remotePath}/worktree.tar.gz -C ${remotePath}`,
  { timeoutMs: 5 * 60 * 1000 } // 5 minutes for extraction
);

// Lines 296, 304 - Add timeout to chunked uploads
await sandbox.files.write(chunkPath, chunk, { timeoutMs: 2 * 60 * 1000 });
await sandbox.commands.run(combineCommand, { timeoutMs: 5 * 60 * 1000 });

// Line 352 - Add timeout to git status
const gitStatusCmd = await sandbox.commands.run(
  'git status --porcelain',
  { cwd: remotePath, timeoutMs: 30000 } // 30 second timeout
);

// Line 378 - Add timeout to tarball download
const readResult = await sandbox.commands.run(
  `cat "${logPath}"`,
  { timeoutMs: 60000 } // 1 minute timeout
);
```

### 2. `src/e2b/sandbox-manager.ts`

**Lines to fix**: 197, 316, 422

```typescript
// Line 197 - Add timeout wrapper for isRunning()
let isRunning = false;
try {
  // E2B SDK's isRunning() doesn't accept timeout, so use Promise.race()
  isRunning = await Promise.race([
    sandbox.isRunning(),
    new Promise<boolean>((_, reject) =>
      setTimeout(() => reject(new Error('Health check timeout after 30s')), 30000)
    )
  ]);
} catch (error) {
  const errorMsg = error instanceof Error ? error.message : String(error);
  this.logger.warn(`Health check failed for sandbox ${sandboxId}: ${errorMsg}`);
  isRunning = false; // Assume not running on timeout
}

// Line 316 - Add timeout wrapper for kill()
try {
  await Promise.race([
    sandbox.kill(),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Kill timeout after 30s')), 30000)
    )
  ]);
} catch (error) {
  // Log but continue with cleanup
  this.logger.warn(`Kill operation timeout for ${sandboxId}, proceeding with cleanup`);
}

// Line 422 - Add error handling to setTimeout (already has timeout internally)
try {
  await Promise.race([
    sandbox.setTimeout(Math.min(timeoutMs, maxTimeoutMs)),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('setTimeout call timeout')), 10000)
    )
  ]);
  this.logger.info(`Extended timeout for sandbox ${sandboxId} by ${additionalMinutes} minutes`);
  return true;
} catch (error) {
  const errorMsg = error instanceof Error ? error.message : String(error);
  this.logger.error(`Failed to extend timeout for sandbox ${sandboxId}: ${errorMsg}`);
  return false;
}
```

### 3. `src/e2b/output-monitor.ts`

**Lines to fix**: 285, 292, 305

```typescript
// Lines 285, 292, 305 - Add timeout to all polling commands
// Line 285
const checkCmd = await sandbox.commands.run(
  `test -f "${this.logFilePath}" && echo "exists" || echo "missing"`,
  { timeoutMs: 10000 } // 10 second timeout for file checks
);

// Line 292
const sizeCmd = await sandbox.commands.run(
  `stat -c %s "${this.logFilePath}"`,
  { timeoutMs: 10000 } // 10 second timeout
);

// Line 298 - Add timeout to truncate command
await sandbox.commands.run(
  `tail -c ${MAX_LOG_SIZE_BYTES} "${this.logFilePath}" > "${this.logFilePath}.tmp" && mv "${this.logFilePath}.tmp" "${this.logFilePath}"`,
  { timeoutMs: 30000 } // 30 seconds for large file operations
);

// Line 305
const readCmd = await sandbox.commands.run(
  `tail -c +${this.state.bytesSeen + 1} "${this.logFilePath}"`,
  { timeoutMs: 30000 } // 30 seconds for reading logs
);
```

### 4. `src/e2b/output-monitor.ts` - Helper functions

**Lines to fix**: 368, 432

```typescript
// Line 368 - createTempLogFile
export async function createTempLogFile(sandbox: Sandbox): Promise<string> {
  const timestamp = Date.now();
  const logPath = `/tmp/claude-output-${timestamp}.log`;

  await sandbox.commands.run(
    `touch "${logPath}"`,
    { timeoutMs: 5000 } // 5 second timeout for file creation
  );

  return logPath;
}

// Line 432 - waitForLogStable
const sizeCmd = await sandbox.commands.run(
  `stat -c %s "${logPath}" 2>/dev/null || echo "0"`,
  { timeoutMs: 5000 } // 5 seconds
);
```

---

## Testing Strategy

### 1. Unit Tests

Add timeout tests to existing test suites:

```typescript
// tests/e2b/file-sync.smoke.test.ts
describe('Timeout Handling', () => {
  it('should timeout on slow file uploads', async () => {
    // Mock slow upload
    const slowSandbox = {
      files: {
        write: vi.fn().mockImplementation(() =>
          new Promise(resolve => setTimeout(resolve, 10 * 60 * 1000)) // 10 minutes
        )
      }
    };

    await expect(uploadToSandbox('/path/to/tarball', slowSandbox))
      .rejects.toThrow('timeout');
  });
});
```

### 2. Integration Tests

Add to `tests/e2b/integration.test.ts`:

```typescript
describe('Timeout Enforcement', () => {
  it('should handle network delays gracefully', async () => {
    // Test with simulated network delays
  });

  it('should not hang on unresponsive sandbox', async () => {
    // Test with unresponsive mock sandbox
  });
});
```

### 3. Manual Testing

Test scenarios:
1. **Slow network**: Use network throttling to simulate delays
2. **Large files**: Upload 500MB+ repositories
3. **Unresponsive sandbox**: Kill E2B sandbox mid-operation
4. **Concurrent operations**: Multiple sandboxes uploading simultaneously

---

## Verification Checklist

- [ ] All E2B SDK calls have timeout parameters or timeout wrappers
- [ ] Timeout values are appropriate for operation type:
  - [ ] File operations: 1-5 minutes
  - [ ] Health checks: 30 seconds
  - [ ] Command execution: 30 seconds - 5 minutes
  - [ ] File polls: 5-10 seconds
- [ ] Timeout errors are logged with context
- [ ] Timeout errors trigger appropriate cleanup
- [ ] Tests cover timeout scenarios
- [ ] Documentation updated with timeout behavior
- [ ] Manual testing completed for all scenarios

---

## Expected Outcomes

**Before Fix:**
```
❌ Operations hang indefinitely on network issues
❌ No feedback when sandbox becomes unresponsive
❌ Resource leaks when operations don't complete
❌ User confusion ("Why is it stuck?")
```

**After Fix:**
```
✅ Operations fail gracefully after timeout
✅ Clear error messages with timeout information
✅ Automatic cleanup triggered on timeout
✅ User receives actionable feedback
```

---

## Rollout Plan

### Step 1: Implement Fixes (2-3 hours)
- Update all 14 locations across 3 files
- Add timeout constants at top of each file

### Step 2: Test (1 hour)
- Run existing test suite (must maintain 100% pass rate)
- Add new timeout tests
- Manual testing with slow network

### Step 3: Code Review (30 minutes)
- Self-review all changes
- Verify all E2B calls now have timeouts
- Check error messages are clear

### Step 4: Commit & Push (15 minutes)
- Commit with message: "fix(e2b): add timeout parameters to all E2B SDK calls (C1)"
- Push to feature branch
- Update CODE_REVIEW_v1.0.md status

### Step 5: Final Validation (30 minutes)
- Run full test suite in CI
- Verify no regressions
- Check coverage remains >85%

**Total Time**: ~4 hours including testing

---

## Success Criteria

✅ All 14 E2B SDK calls have timeout protection
✅ Test suite passes at 100%
✅ Coverage remains ≥87.5%
✅ No regressions in existing functionality
✅ Error messages are clear and actionable
✅ Manual testing confirms graceful timeout handling

---

## Related Issues

- **M1**: Shell injection risk (can be fixed in parallel)
- **M2**: Rate limiting (separate issue, v1.0.1)
- **M3**: Audit logging (separate issue, v1.0.1)

---

## References

- Full review: `docs/CODE_REVIEW_v1.0.md`
- Security audit: `docs/SECURITY_AUDIT_v1.0.md`
- E2B SDK docs: https://e2b.dev/docs
- Test suite: `tests/e2b/`

---

**Status**: 🔴 BLOCKING MERGE
**Assignee**: Current developer
**Estimated Completion**: 2025-12-09 (today)
