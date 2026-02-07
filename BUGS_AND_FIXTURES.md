# Bugs and Fixtures

A prioritized list of bugs, issues, and improvements for the Openwork codebase.

**Progress: 8/20 resolved**

---

## Quick Reference

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| BUG-001 | Memory Leak - Message Batcher | Critical | ✅ Resolved |
| BUG-002 | Memory Leak - Pending Permissions | Critical | ✅ Resolved |
| BUG-003 | Silent Promise Rejections | Critical | ✅ Resolved |
| SEC-001 | API Key Prefix Exposure | High | ✅ Resolved |
| SEC-002 | Ollama Config Validation | Medium | Open |
| ERR-001 | Task Summary Error Handling | High | Open |
| ERR-002 | Permission Request Window Check | High | ✅ Resolved |
| ERR-003 | Playwright Installation Handling | High | Open |
| ERR-004 | Race Condition in forwardToRenderer | Medium | ✅ Resolved |
| TYPE-001 | API Response Type Validation | Medium | Open |
| TYPE-002 | Stream Parser Null Check | Medium | ✅ Resolved |
| CODE-001 | Split Large Handlers File | Medium | Open |
| CODE-002 | Refactor API Key Validation | Low | Open |
| PERF-001 | Buffer Truncation Warning | Medium | Open |
| PERF-002 | Task List O(n) Filtering | Low | Open |
| PERF-003 | Key Derivation Optimization | Low | Open |
| UX-001 | Permission Timeout Feedback | Medium | Open |
| UX-002 | Better API Key Error Messages | Low | Open |
| UX-003 | Queued Tasks Feedback | Low | Open |
| UX-004 | App Cleanup on Quit | Low | ✅ Resolved |

---

## Critical Priority

### BUG-001: Memory Leak - Message Batcher Map ✅ RESOLVED

**File:** `apps/desktop/src/main/ipc/handlers.ts:116-182`

**Problem:** The `messageBatchers` Map grows indefinitely because `flushAndCleanupBatcher()` is only called on success paths. Cancelled tasks left orphaned batchers in memory.

**Resolution:** Added `flushAndCleanupBatcher(taskId)` call at the start of the `task:cancel` handler to ensure batcher cleanup when tasks are cancelled.

---

### BUG-002: Memory Leak - Pending Permissions Map ✅ RESOLVED

**File:** `apps/desktop/src/main/permission-api.ts:152-170`

**Problem:** The `pendingPermissions` Map stores requests that timeout after 5 minutes. If clients crash or disconnect, entries remain until timeout expires.

**Resolution:**
1. Reduced timeout from 5 minutes to 2 minutes
2. Added `cleanupPendingPermissions()` function that rejects and clears all pending permissions
3. Added `closePermissionApiServer()` function called on app quit
4. Added logging for timeouts and cleanup events

---

### BUG-003: Silent Promise Rejections ✅ RESOLVED

**File:** `apps/desktop/src/main/ipc/handlers.ts:760,854`

**Problem:** Catch blocks like `.catch(() => ({}))` silently swallow errors, making debugging difficult.

**Resolution:** Added logging for caught errors with context before returning empty objects.

---

## High Priority

### SEC-001: API Key Prefix Exposure ✅ RESOLVED

**File:** `apps/desktop/src/main/ipc/handlers.ts:657-678`

**Problem:** API key prefixes (first 8 characters) were exposed in IPC responses.

**Resolution:** Replaced with masked placeholder `••••••••...` in all handlers.

---

### SEC-002: Ollama Config Validation

**File:** `apps/desktop/src/main/ipc/handlers.ts:962-998`
**Status:** Open

**Problem:** Ollama config validation is incomplete - doesn't check for empty strings, negative sizes, or invalid model names.

**How to Fix:**
1. Add check: `if (!modelId || modelId.trim() === '') throw error`
2. Add check: `if (size < 0 || size > 1e12) throw error` (1TB max)
3. Sanitize model names: `/^[a-zA-Z0-9_\-:./]+$/`
4. Return specific error messages for each validation failure

---

### ERR-001: Task Summary Error Handling

**File:** `apps/desktop/src/main/ipc/handlers.ts:425-432`
**Status:** Open

**Problem:** Task summary generation is fire-and-forget. If `updateTaskSummary` fails, the error is caught but renderer still receives potentially inconsistent data.

**How to Fix:**
1. Wrap `updateTaskSummary` in try-catch separately from `forwardToRenderer`
2. Only send to renderer if storage update succeeds
3. Add retry logic (1-2 retries with 500ms delay)
4. Log storage failures with task context

**Code Pattern:**
```typescript
generateTaskSummary(prompt)
  .then(async (summary) => {
    try {
      await updateTaskSummary(taskId, summary);
      forwardToRenderer('task:summary', { taskId, summary });
    } catch (storageError) {
      console.error('[IPC] Failed to store summary:', storageError);
      // Don't send to renderer if storage failed
    }
  })
  .catch((err) => console.warn('[IPC] Failed to generate summary:', err));
```

---

### ERR-002: Permission Request Window Check ✅ RESOLVED

**File:** `apps/desktop/src/main/permission-api.ts:150`

**Problem:** No check for window being destroyed before sending IPC.

**Resolution:** Added try-catch around `mainWindow.webContents.send()` with 503 error response if window is destroyed.

---

### ERR-003: Playwright Installation Handling

**File:** `apps/desktop/src/main/opencode/task-manager.ts:166-173`
**Status:** Open

**Problem:** Playwright installation failures are silently caught, causing confusing downstream failures when browser automation is needed.

**How to Fix:**
1. Track installation state in a variable: `playwrightInstalled: boolean`
2. If installation fails, set a flag and inform user via `onProgress`
3. Before tasks that need browser, check the flag
4. Add retry logic: Try installation up to 3 times with exponential backoff

**Code Pattern:**
```typescript
let playwrightInstalled = false;
try {
  await installPlaywrightChromium(onProgress);
  playwrightInstalled = true;
} catch (error) {
  console.error('[TaskManager] Playwright install failed:', error);
  onProgress?.({ stage: 'warning', message: 'Browser automation unavailable' });
}
```

---

### ERR-004: Race Condition in forwardToRenderer ✅ RESOLVED

**File:** `apps/desktop/src/main/ipc/handlers.ts:315-318`

**Problem:** Window could be destroyed between `isDestroyed()` check and `send()` call.

**Resolution:** Wrapped `sender.send()` in try-catch block with debug logging.

---

## Medium Priority

### TYPE-001: API Response Type Validation

**File:** `apps/desktop/src/main/ipc/handlers.ts:937`
**Status:** Open

**Problem:** External API responses are cast with `as` without runtime validation.

**How to Fix:**
1. Add Zod schema for Ollama API response
2. Validate response before using
3. Return fallback on validation failure
4. Log schema mismatches for debugging

**Code Pattern:**
```typescript
import { z } from 'zod';
const OllamaResponseSchema = z.object({
  models: z.array(z.object({
    name: z.string(),
    size: z.number()
  })).optional()
});
const result = OllamaResponseSchema.safeParse(await response.json());
if (!result.success) {
  console.warn('Unexpected Ollama response:', result.error);
  return { models: [] };
}
```

---

### TYPE-002: Stream Parser Null Check ✅ RESOLVED

**File:** `apps/desktop/src/main/opencode/adapter.ts:585`

**Problem:** Double type assertion without validation in switch default case.

**Resolution:** Added runtime type guard checking for `type` property before logging.

---

### CODE-001: Split Large Handlers File

**File:** `apps/desktop/src/main/ipc/handlers.ts` (1264 lines)
**Status:** Open

**Problem:** File is too large and hard to maintain.

**How to Fix:**
1. Create `handlers/` directory with separate files:
   - `task-handlers.ts` - task:start, session:resume, task:cancel, etc.
   - `settings-handlers.ts` - settings:*, api-key:*
   - `onboarding-handlers.ts` - onboarding:*
   - `ollama-handlers.ts` - ollama:*
2. Create `handlers/index.ts` barrel export
3. Each file should be under 300 lines
4. Update main `handlers.ts` to import and register all

---

### PERF-001: Buffer Truncation Warning

**File:** `apps/desktop/src/main/opencode/stream-parser.ts:21-31`
**Status:** Open

**Problem:** 10MB buffer silently truncates large messages without warning.

**How to Fix:**
1. Add warning at 80% capacity (8MB): Log "Buffer approaching limit"
2. Log truncation events with message preview
3. Consider chunked processing for very large outputs
4. Track truncation count for diagnostics

---

### UX-001: Permission Timeout Feedback

**File:** `apps/desktop/src/main/permission-api.ts:152-170`
**Status:** Open

**Problem:** Users don't see countdown or warning when permission requests are about to timeout.

**How to Fix:**
1. Include `expiresAt` timestamp in permission request
2. Frontend shows countdown timer
3. Show warning toast at 30 seconds remaining
4. Allow "Extend timeout" button

---

## Low Priority

### CODE-002: Refactor API Key Validation

**File:** `apps/desktop/src/main/ipc/handlers.ts:731-866`
**Status:** Open

**Problem:** API key validation code is duplicated for each provider.

**How to Fix:**
1. Create provider config object with endpoint, headers, body format
2. Single `validateApiKey(provider, key)` function
3. Add new providers via config, not code

---

### PERF-002: Task List O(n) Filtering

**File:** `apps/desktop/src/renderer/stores/taskStore.ts:110-116`
**Status:** Open

**Problem:** Task list filtering is O(n) on every update.

**How to Fix:**
1. Use Map for O(1) lookups by task ID
2. Limit displayed tasks with pagination
3. Consider virtualized list for many tasks

---

### PERF-003: Key Derivation Optimization

**File:** `apps/desktop/src/main/store/secureStorage.ts:68-94`
**Status:** Open

**Problem:** PBKDF2 with 100k iterations could block if called unexpectedly.

**How to Fix:**
1. Ensure `_derivedKey` cache is always used after first call
2. Consider deriving key at startup in background
3. Add async wrapper for the derivation

---

### UX-002: Better API Key Error Messages

**File:** `apps/desktop/src/renderer/components/layout/SettingsDialog.tsx:185-190`
**Status:** Open

**Problem:** Error messages don't distinguish between network/auth/rate-limit errors.

**How to Fix:**
1. Parse error response codes
2. Show specific messages: "Network error", "Invalid key", "Rate limited"
3. Link to provider docs for common issues

---

### UX-003: Queued Tasks Feedback

**File:** `apps/desktop/src/renderer/pages/Execution.tsx:229-235`
**Status:** Open

**Problem:** Users only see "Queued" without position or wait estimate.

**How to Fix:**
1. Show queue position: "Queued #3"
2. Allow cancel/reorder of queued tasks
3. Show when task was queued

---

### UX-004: App Cleanup on Quit ✅ RESOLVED

**File:** `apps/desktop/src/main/index.ts:192-197`

**Problem:** Permission API server not explicitly closed on quit.

**Resolution:**
1. Added `closePermissionApiServer()` call in `before-quit` event handler
2. Server closes gracefully with 2-second timeout
3. Force closes if graceful close hangs

---

## Changelog

| Date | Issue | Action |
|------|-------|--------|
| 2026-02-07 | BUG-001 | Resolved - Added batcher cleanup on task cancel |
| 2026-02-07 | BUG-002 | Resolved - Added permission cleanup on quit, reduced timeout |
| 2026-02-07 | BUG-003 | Resolved - Added logging for silent catches |
| 2026-02-07 | SEC-001 | Resolved - Masked API key prefixes |
| 2026-02-07 | ERR-002 | Resolved - Added window destroy check |
| 2026-02-07 | ERR-004 | Resolved - Added try-catch for race condition |
| 2026-02-07 | TYPE-002 | Resolved - Added type guard for messages |
| 2026-02-07 | UX-004 | Resolved - Added permission server cleanup on quit |
