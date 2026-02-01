# Bugs and Fixtures

This document lists all known bugs, issues, and ideas for small fixes in the Openwork codebase. Each item includes a description, affected files, and specifications for resolution.

---

## Table of Contents

1. [Critical Issues](#critical-issues)
2. [Security & Validation Issues](#security--validation-issues)
3. [Error Handling Gaps](#error-handling-gaps)
4. [Type Safety Issues](#type-safety-issues)
5. [Code Quality Issues](#code-quality-issues)
6. [Performance Issues](#performance-issues)
7. [UI/UX Improvements](#uiux-improvements)

---

## Critical Issues

### BUG-001: Memory Leak - Message Batcher Map Never Cleaned Up on Errors

**Severity:** Critical
**Status:** Open
**File:** `apps/desktop/src/main/ipc/handlers.ts` (lines 116-182)

**Description:**
The `messageBatchers` Map can grow indefinitely. While `flushAndCleanupBatcher()` is called on completion and permission requests, it is NOT called in all error paths. If a task fails before completion, the batcher remains in memory forever.

**Impact:**
Memory leak in long-running applications with many failed tasks. Over time, this could cause the app to consume excessive memory and become unresponsive.

**Root Cause:**
```typescript
// Batcher is created but only cleaned up on success paths
const messageBatchers = new Map<string, MessageBatcher>();
```

**Specification for Fix:**
1. Add cleanup logic in all error handlers for task execution
2. Implement a `finally` block that ensures batcher cleanup regardless of success/failure
3. Add a periodic cleanup mechanism for orphaned batchers (tasks older than X minutes)
4. Consider using WeakMap if task IDs could be garbage collected

**Acceptance Criteria:**
- [ ] Batcher is cleaned up when task fails with error
- [ ] Batcher is cleaned up when task is cancelled
- [ ] Add unit test to verify cleanup on error paths
- [ ] Monitor memory usage over time with failed tasks

---

### BUG-002: Memory Leak - Pending Permissions Accumulation

**Severity:** Critical
**Status:** Open
**File:** `apps/desktop/src/main/permission-api.ts` (lines 152-170)

**Description:**
The `pendingPermissions` Map stores requests that timeout after 5 minutes. However, if a client crashes without sending a response, the entry stays until timeout. With many permission requests, this could accumulate.

**Impact:**
Modest memory leak over time with hundreds of permission requests that never receive responses.

**Specification for Fix:**
1. Reduce timeout from 5 minutes to a more reasonable 2 minutes
2. Add cleanup on window destroy/close events
3. Implement periodic sweep of stale pending permissions
4. Add logging when permissions are cleaned up due to timeout

**Acceptance Criteria:**
- [ ] Pending permissions are cleaned up when window is destroyed
- [ ] Stale permissions are logged before cleanup
- [ ] Memory usage doesn't grow with repeated timeouts

---

### BUG-003: Unhandled Promise Rejections in Silent Catch

**Severity:** Critical
**Status:** Open
**File:** `apps/desktop/src/main/ipc/handlers.ts` (lines 760, 854)

**Description:**
```typescript
const errorData = await response.json().catch(() => ({}));
```
These catch blocks silently swallow errors and return empty objects, which could cause downstream type errors if the API returns invalid JSON.

**Impact:**
Debugging becomes difficult when API validation fails silently. Users may see generic errors without understanding the root cause.

**Specification for Fix:**
1. Log caught errors with appropriate context
2. Return typed error objects instead of empty objects
3. Add error state indicators for downstream consumers

**Acceptance Criteria:**
- [ ] All silently caught errors are logged
- [ ] Error objects have consistent shape
- [ ] Downstream code handles empty error data gracefully

---

## Security & Validation Issues

### SEC-001: API Key Exposure in Credential Listing

**Severity:** High
**Status:** Open
**File:** `apps/desktop/src/main/ipc/handlers.ts` (lines 657-678)

**Description:**
The `settings:api-keys` handler calls `listStoredCredentials()` which returns actual API key prefixes (first 8 characters). This exposes key format information.

**Code:**
```typescript
keyPrefix: credential.password && credential.password.length > 0
  ? `${credential.password.substring(0, 8)}...`
  : '';
```

**Impact:**
- First 8 characters could help identify key format/provider
- Could leak to logging services or error reporting
- Malware could use pattern to identify stored keys

**Specification for Fix:**
1. Remove actual key prefix from the response entirely
2. Replace with boolean `hasKey: true/false` indicator
3. Or use fixed placeholder like `••••••••` for UI display
4. Audit all places where credentials are serialized

**Acceptance Criteria:**
- [ ] No actual key characters are exposed in IPC responses
- [ ] UI still indicates whether a key is configured
- [ ] Logging doesn't contain key prefixes

---

### SEC-002: Incomplete Input Validation in Ollama Config

**Severity:** Medium
**Status:** Open
**File:** `apps/desktop/src/main/ipc/handlers.ts` (lines 962-998)

**Description:**
The Ollama config validation doesn't validate:
- Empty strings in model IDs or display names
- Negative size values
- Extremely large size values (potential DoS)
- Invalid characters in model names

**Specification for Fix:**
1. Add validation for non-empty model ID and display name
2. Validate size is positive number within reasonable bounds (e.g., 0 < size < 1TB)
3. Sanitize model names to alphanumeric + common separators
4. Add validation error messages for each case

**Acceptance Criteria:**
- [ ] Empty strings are rejected with clear error
- [ ] Negative/extreme sizes are rejected
- [ ] Model names are sanitized or validated
- [ ] Validation errors are user-friendly

---

## Error Handling Gaps

### ERR-001: Missing Error Handling in Task Summary Generation

**Severity:** High
**Status:** Open
**File:** `apps/desktop/src/main/ipc/handlers.ts` (lines 425-432)

**Description:**
Task summary generation is fire-and-forget. If `updateTaskSummary` fails, it silently swallows the error and still sends to renderer, potentially causing data inconsistency.

**Code:**
```typescript
generateTaskSummary(validatedConfig.prompt)
  .then((summary) => {
    updateTaskSummary(taskId, summary);
    forwardToRenderer('task:summary', { taskId, summary });
  })
  .catch((err) => {
    console.warn('[IPC] Failed to generate task summary:', err);
  });
```

**Specification for Fix:**
1. Separate the storage update from renderer notification
2. If storage update fails, don't send to renderer (or send with error flag)
3. Add retry logic for transient storage failures
4. Consider moving summary generation to background worker

**Acceptance Criteria:**
- [ ] Storage failures don't send inconsistent data to renderer
- [ ] Failed summary generations are logged with task context
- [ ] Consider retry mechanism for transient failures

---

### ERR-002: Missing Permission Request Cleanup on Window Destroy

**Severity:** High
**Status:** Open
**File:** `apps/desktop/src/main/permission-api.ts` (lines 150, 173)

**Description:**
When sending permission requests, there's no check for whether the window is destroyed:
```typescript
mainWindow.webContents.send('permission:request', permissionRequest);
```
If the window is destroyed between generating the request and sending it, this will throw an uncaught error.

**Specification for Fix:**
1. Add `isDestroyed()` check before sending IPC
2. Handle the case where window is destroyed mid-request
3. Add proper error handling wrapper for all renderer sends
4. Consider centralizing all renderer communication through a safe wrapper

**Acceptance Criteria:**
- [ ] Window destroy check before all IPC sends
- [ ] Graceful handling when window is destroyed
- [ ] No uncaught exceptions from destroyed window sends

---

### ERR-003: Unhandled Promise in Playwright Browser Installation

**Severity:** High
**Status:** Open
**File:** `apps/desktop/src/main/opencode/task-manager.ts` (lines 166-173)

**Description:**
```typescript
try {
  await installPlaywrightChromium((msg) => {
    onProgress?.({ stage: 'setup', message: msg });
  });
} catch (error) {
  console.error('[TaskManager] Failed to install Playwright:', error);
  // Don't throw - let agent handle the failure
}
```
Silent error handling means the task will proceed without Playwright installed, causing confusing downstream failures.

**Specification for Fix:**
1. Track Playwright installation state
2. If installation fails, inform the agent/user before task starts
3. Add retry logic for installation
4. Consider pre-flight check before tasks that need Playwright

**Acceptance Criteria:**
- [ ] Installation failures are reported to user
- [ ] Tasks that need Playwright fail fast with clear message
- [ ] Retry mechanism for transient installation failures

---

### ERR-004: Race Condition in Window Destroyed Check

**Severity:** Medium
**Status:** Open
**File:** `apps/desktop/src/main/ipc/handlers.ts` (lines 315-318)

**Description:**
```typescript
const forwardToRenderer = (channel: string, data: unknown) => {
  if (!window.isDestroyed() && !sender.isDestroyed()) {
    sender.send(channel, data);
  }
};
```
Between the `isDestroyed()` check and the `send()` call, the window could be destroyed, causing an exception.

**Specification for Fix:**
1. Wrap the send call in try-catch
2. Log when sends fail due to destroyed window
3. Consider using a queue-based approach for critical messages

**Acceptance Criteria:**
- [ ] No exceptions thrown when window destroyed during send
- [ ] Destroyed window sends are logged for debugging
- [ ] Critical messages don't get lost silently

---

## Type Safety Issues

### TYPE-001: Type Assertion Without Proper Validation

**Severity:** Medium
**Status:** Open
**File:** `apps/desktop/src/main/ipc/handlers.ts` (line 937)

**Description:**
```typescript
const data = await response.json() as { models?: Array<{ name: string; size: number }> };
```
This assumes the response structure without validation. If the API changes, this will cause runtime type errors.

**Specification for Fix:**
1. Add Zod schema validation for external API responses
2. Create type guards for runtime validation
3. Handle schema mismatches gracefully with fallbacks

**Acceptance Criteria:**
- [ ] All external API responses are validated at runtime
- [ ] Schema mismatches produce clear error messages
- [ ] Fallback behavior for unexpected responses

---

### TYPE-002: Missing Null Check in Stream Parser

**Severity:** Medium
**Status:** Open
**File:** `apps/desktop/src/main/opencode/adapter.ts` (line 585)

**Description:**
```typescript
const unknownMessage = message as unknown as { type: string };
```
Double type assertion without validation could allow invalid objects to pass through.

**Specification for Fix:**
1. Add runtime type guard before assertion
2. Validate message has required properties
3. Log and skip invalid messages instead of crashing

**Acceptance Criteria:**
- [ ] Invalid messages are detected and logged
- [ ] Stream processing continues after invalid messages
- [ ] No crashes from malformed messages

---

## Code Quality Issues

### CODE-001: Excessively Large IPC Handlers File

**Severity:** Medium
**Status:** Open
**File:** `apps/desktop/src/main/ipc/handlers.ts` (1264 lines)

**Description:**
The file is over 1200 lines, making it hard to test and maintain.

**Specification for Fix:**
1. Split into domain-specific handler modules:
   - `handlers/task.ts` - Task lifecycle handlers
   - `handlers/settings.ts` - Settings and API key handlers
   - `handlers/onboarding.ts` - Onboarding flow handlers
   - `handlers/ollama.ts` - Ollama-specific handlers
2. Create barrel export in `handlers/index.ts`
3. Add unit tests for each module

**Acceptance Criteria:**
- [ ] No single handler file exceeds 300 lines
- [ ] Clear separation of concerns
- [ ] Unit tests for each handler module
- [ ] No functionality regression

---

### CODE-002: Repeated Validation Code for API Keys

**Severity:** Low
**Status:** Open
**File:** `apps/desktop/src/main/ipc/handlers.ts` (lines 731-866)

**Description:**
API key validation code is duplicated for Anthropic, OpenAI, Google, and xAI providers. Should be refactored into a generic provider-agnostic function.

**Specification for Fix:**
1. Create provider configuration object with:
   - Validation endpoint
   - Request headers format
   - Response parsing logic
2. Create generic `validateApiKey(provider, key)` function
3. Add new providers by adding configuration, not code

**Acceptance Criteria:**
- [ ] Single validation function for all providers
- [ ] Easy to add new providers
- [ ] Reduced code duplication (DRY)
- [ ] Consistent error handling across providers

---

## Performance Issues

### PERF-001: Unbounded Buffer Truncation in Stream Parser

**Severity:** Medium
**Status:** Open
**File:** `apps/desktop/src/main/opencode/stream-parser.ts` (lines 21-31)

**Description:**
While there IS a 10MB limit, if a single message exceeds this, it will silently truncate and emit an error, potentially losing task data.

**Specification for Fix:**
1. Add warning when approaching buffer limit (e.g., 8MB)
2. Consider streaming large messages in chunks
3. Log truncation events with message context
4. Investigate why messages might be so large

**Acceptance Criteria:**
- [ ] Warning logged at 80% buffer capacity
- [ ] Truncation events are logged with context
- [ ] Consider chunked processing for large outputs

---

### PERF-002: O(n) Filtering on Every Task Update

**Severity:** Low
**Status:** Open
**File:** `apps/desktop/src/renderer/stores/taskStore.ts` (lines 110-116)

**Description:**
```typescript
set({
  currentTask: task,
  tasks: [task, ...currentTasks.filter((t) => t.id !== task.id)],
  isLoading: task.status === 'queued',
});
```
This filtering approach is O(n) and runs on every task start. With many tasks, this could impact performance.

**Specification for Fix:**
1. Use Map for O(1) task lookups
2. Or limit displayed tasks with pagination/virtualization
3. Consider memoization for task list operations

**Acceptance Criteria:**
- [ ] Task operations are O(1) or O(log n)
- [ ] Large task lists don't cause UI lag
- [ ] Consider virtualized list for task display

---

### PERF-003: Synchronous Encryption Key Derivation

**Severity:** Low
**Status:** Open
**File:** `apps/desktop/src/main/store/secureStorage.ts` (lines 68-94)

**Description:**
While there's caching (`if (_derivedKey)` check), the PBKDF2 derivation with 100,000 iterations could be called from many places, adding latency on first use.

**Specification for Fix:**
1. Ensure key derivation only happens once at startup
2. Add lazy initialization pattern
3. Consider async key derivation to not block main thread

**Acceptance Criteria:**
- [ ] Key derivation happens exactly once
- [ ] No blocking during app startup
- [ ] Key is ready before first use

---

## UI/UX Improvements

### UX-001: No Timeout Feedback for Permission Requests

**Severity:** Medium
**Status:** Open
**File:** `apps/desktop/src/main/permission-api.ts` (lines 152-170)

**Description:**
If a permission request times out, there's no UI feedback to the user or automatic retry mechanism. The user might not realize their permission response was lost.

**Specification for Fix:**
1. Show countdown timer for permission requests
2. Add visual indication when timeout is approaching
3. Allow user to extend timeout
4. Show notification when permission times out

**Acceptance Criteria:**
- [ ] User sees remaining time for permission
- [ ] Warning at 30 seconds remaining
- [ ] Clear notification on timeout
- [ ] Option to retry timed-out permission

---

### UX-002: Generic API Key Validation Error Messages

**Severity:** Low
**Status:** Open
**File:** `apps/desktop/src/renderer/components/layout/SettingsDialog.tsx` (lines 185-190)

**Description:**
Error messages for API key validation could be more specific about network vs authentication failures to help users debug issues.

**Specification for Fix:**
1. Distinguish between:
   - Network errors (can't reach API)
   - Authentication errors (invalid key)
   - Rate limiting (too many requests)
   - Account issues (billing, suspended)
2. Provide actionable guidance for each error type

**Acceptance Criteria:**
- [ ] Error messages indicate root cause
- [ ] Guidance provided for each error type
- [ ] Links to provider documentation where helpful

---

### UX-003: No Visual Feedback for Queued Tasks

**Severity:** Low
**Status:** Open
**File:** `apps/desktop/src/renderer/pages/Execution.tsx` (lines 229-235)

**Description:**
When a task is queued, users see "Queued" but don't know how many tasks are ahead or estimated wait time.

**Specification for Fix:**
1. Show queue position (e.g., "Queued #3")
2. Consider showing estimated start time
3. Allow users to reorder or cancel queued tasks

**Acceptance Criteria:**
- [ ] Queue position visible to user
- [ ] Option to cancel queued tasks
- [ ] Clear visual distinction between queued/running

---

### UX-004: Missing App Cleanup on Quit

**Severity:** Low
**Status:** Open
**File:** `apps/desktop/src/main/index.ts` (lines 192-197)

**Description:**
While `disposeTaskManager()` is called on quit, the permission API server is never explicitly closed, potentially leaving port 9226 in TIME_WAIT state.

**Specification for Fix:**
1. Add explicit cleanup for permission API server
2. Ensure all resources are released on quit
3. Add timeout for cleanup to prevent hanging

**Acceptance Criteria:**
- [ ] Permission API server closed on quit
- [ ] Port released immediately
- [ ] Graceful shutdown with timeout

---

## Summary

| Category | Count | Critical | High | Medium | Low |
|----------|-------|----------|------|--------|-----|
| Critical Issues | 3 | 3 | - | - | - |
| Security | 2 | - | 1 | 1 | - |
| Error Handling | 4 | - | 3 | 1 | - |
| Type Safety | 2 | - | - | 2 | - |
| Code Quality | 2 | - | - | 1 | 1 |
| Performance | 3 | - | - | 1 | 2 |
| UI/UX | 4 | - | - | 1 | 3 |
| **Total** | **20** | **3** | **4** | **7** | **6** |

---

## Priority Matrix

### Immediate (P0) - Fix ASAP
- BUG-001: Memory Leak - Message Batcher
- BUG-002: Memory Leak - Pending Permissions
- SEC-001: API Key Exposure

### High Priority (P1) - Next Sprint
- BUG-003: Silent Promise Rejections
- ERR-001: Task Summary Error Handling
- ERR-002: Window Destroy Permission Cleanup
- ERR-003: Playwright Installation Handling

### Medium Priority (P2) - Backlog
- SEC-002: Ollama Input Validation
- ERR-004: Race Condition Window Check
- TYPE-001: API Response Validation
- TYPE-002: Stream Parser Null Check
- CODE-001: Split Handlers File
- PERF-001: Buffer Truncation Warning
- UX-001: Permission Timeout Feedback

### Low Priority (P3) - Nice to Have
- CODE-002: API Key Validation Refactor
- PERF-002: Task List Performance
- PERF-003: Key Derivation Optimization
- UX-002: Better Error Messages
- UX-003: Queue Feedback
- UX-004: App Cleanup

---

## Contributing

When fixing an issue:
1. Reference the issue ID in your commit message (e.g., "fix(BUG-001): cleanup message batchers on error")
2. Update the status in this document to "In Progress" when starting
3. Add test coverage for the fix
4. Update status to "Resolved" with PR link when merged
