# Bugs and Fixtures

A prioritized list of bugs, issues, and improvements for the Openwork codebase.

**Progress: 11/20 resolved**

---

## Quick Reference

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| BUG-001 | Memory Leak - Message Batcher | Critical | ✅ Resolved |
| BUG-002 | Memory Leak - Pending Permissions | Critical | ✅ Resolved |
| BUG-003 | Silent Promise Rejections | Critical | ✅ Resolved |
| SEC-001 | API Key Prefix Exposure | High | ✅ Resolved |
| SEC-002 | Ollama Config Validation | Medium | ✅ Resolved |
| ERR-001 | Task Summary Error Handling | High | ✅ Resolved |
| ERR-002 | Permission Request Window Check | High | ✅ Resolved |
| ERR-003 | Playwright Installation Handling | High | ✅ Resolved |
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

### SEC-002: Ollama Config Validation ✅ RESOLVED

**File:** `apps/desktop/src/main/ipc/handlers.ts:962-998`

**Problem:** Ollama config validation is incomplete - doesn't check for empty strings, negative sizes, or invalid model names.

**Resolution:** Added comprehensive validation:
1. Empty string checks for model ID and display name
2. Size bounds validation (0 to 1TB max)
3. Model ID format validation (alphanumeric + common separators)
4. Display name length limit (256 chars)
5. Maximum models limit (100) to prevent DoS

---

### ERR-001: Task Summary Error Handling ✅ RESOLVED

**File:** `apps/desktop/src/main/ipc/handlers.ts:425-432`

**Problem:** Task summary generation is fire-and-forget. If `updateTaskSummary` fails, the error is caught but renderer still receives potentially inconsistent data.

**Resolution:** Wrapped `updateTaskSummary` in a separate try-catch block. If storage fails, the summary is not sent to renderer to avoid inconsistent state. Both storage errors and generation errors are logged with task context.

---

### ERR-002: Permission Request Window Check ✅ RESOLVED

**File:** `apps/desktop/src/main/permission-api.ts:150`

**Problem:** No check for window being destroyed before sending IPC.

**Resolution:** Added try-catch around `mainWindow.webContents.send()` with 503 error response if window is destroyed.

---

### ERR-003: Playwright Installation Handling ✅ RESOLVED

**File:** `apps/desktop/src/main/opencode/task-manager.ts:166-173`

**Problem:** Playwright installation failures are silently caught, causing confusing downstream failures when browser automation is needed.

**Resolution:**
1. Added `playwrightInstallSuccess` tracking variable
2. On installation failure, user is notified via `onProgress` with warning stage
3. Added verification check after installation attempt
4. Success/failure is logged for debugging

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
| 2026-02-07 | ERR-001 | Resolved - Added proper error handling for task summary |
| 2026-02-07 | ERR-003 | Resolved - Added user notification for Playwright install failures |
| 2026-02-07 | SEC-002 | Resolved - Added comprehensive Ollama config validation |
