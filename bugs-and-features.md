# Bugs and Features Tracker

## Bugs

### Critical / High Severity

#### BUG-001: `captureScreen` synthetic event never triggers React handler
- **File:** `apps/desktop/src/renderer/components/FloatingChat.tsx`
- **Severity:** High
- **Description:** The `captureScreen` function used `setInput(prompt)` followed by a `setTimeout` that dispatched a native `KeyboardEvent` on the input element. Native `dispatchEvent` does NOT trigger React's synthetic `onKeyDown` handler, so the Enter keypress was never detected by React. The "What's on my screen?" button effectively did nothing.
- **Fix:** Replaced the broken synthetic event approach with a direct task submission (mirrors `sendMessage` logic), so clicking the button now correctly starts a screen capture task.
- **Status:** FIXED

#### BUG-002: SettingsDialog state not reset on reopen
- **File:** `apps/desktop/src/renderer/components/layout/SettingsDialog.tsx`
- **Severity:** Medium
- **Description:** When the dialog was closed and reopened, `loadingKeys`, `loadingDebug`, `loadingModel` remained `false`, and `statusMessage`, `error`, `keyToDelete`, `modelStatusMessage` persisted from the previous open. Users saw stale success/error messages and old "Are you sure?" confirmations when reopening settings.
- **Fix:** Added state reset at the start of the `useEffect` that runs when `open` becomes true. All loading states, messages, and confirmation states are now cleared on each open.
- **Status:** FIXED

#### BUG-003: StreamingText animation stuttering
- **File:** `apps/desktop/src/renderer/components/ui/streaming-text.tsx`
- **Severity:** Medium
- **Description:** Two issues: (1) `displayedLength` was in the useEffect dependency array, causing the RAF animation loop to be torn down and recreated on every character update, producing visible stuttering. (2) `lastTimeRef` was never reset when streaming restarted, causing new text to flash instantly instead of animating character-by-character.
- **Fix:** Removed `displayedLength` from the useEffect dependency array and used a ref-based approach to track streaming state. Added `lastTimeRef.current = 0` reset when new text arrives. Moved `onComplete` and `setIsStreaming` calls outside the `setState` updater to fix the React anti-pattern (BUG-012).
- **Status:** FIXED

#### BUG-004: Duplicate message IDs from `Date.now()`
- **File:** `apps/desktop/src/renderer/components/FloatingChat.tsx`
- **Severity:** Medium
- **Description:** Message IDs like `` `user-${Date.now()}` `` had only millisecond precision. Two messages created within the same millisecond got identical IDs, used as React `key` props, causing rendering glitches.
- **Fix:** Added random suffix to all ID generation: `` `${Date.now()}-${Math.random().toString(36).substring(2, 7)}` `` for both message IDs and task IDs throughout the component.
- **Status:** FIXED

#### BUG-005: Dialog exit animations not working
- **File:** `apps/desktop/src/renderer/components/ui/dialog.tsx`
- **Severity:** Low
- **Description:** `AnimatePresence` was imported from framer-motion but never used. Radix Dialog's unmount bypassed framer-motion exit transitions, so the dialog disappeared instantly.
- **Fix:** Wrapped the dialog overlay and content with `<AnimatePresence>` so framer-motion's `exit` props are now respected.
- **Status:** FIXED

#### BUG-006: Race condition - cancel event flips `isLoading` during new task start
- **File:** `apps/desktop/src/renderer/components/FloatingChat.tsx`
- **Severity:** Medium
- **Description:** When sending a message while a previous task was running, `cancelTask` was awaited but the `onTaskUpdate` subscription was still active. The cancellation's 'complete'/'error' event flipped `isLoading` to `false` during the brief window before the new task started.
- **Fix:** Added `isCancellingRef` that is set to `true` before cancel and `false` after. The `onTaskUpdate` handler now ignores 'complete' and 'error' events while `isCancellingRef.current` is true.
- **Status:** FIXED

#### BUG-007: OpenCodeAdapter never flushes StreamParser on process exit
- **File:** `apps/desktop/src/main/opencode/adapter.ts`
- **Severity:** Medium
- **Description:** When the PTY process exited, `handleProcessExit` was called but `this.streamParser.flush()` was never invoked. The last line of output (potentially the `step_finish` message) could be lost if it didn't end with `\n`.
- **Fix:** Added `this.streamParser.flush()` call at the start of `handleProcessExit`, before the completion check.
- **Status:** FIXED

#### BUG-008: Permission API warning timer leak
- **File:** `apps/desktop/src/main/permission-api.ts`
- **Severity:** Medium
- **Description:** When a permission request was resolved by the user, `resolvePermission()` cleared `timeoutId` but had no reference to `warningId`. The orphaned warning timer could fire and send a spurious `permission:timeout-warning` to the renderer.
- **Fix:** Added `warningId` to the `PendingPermission` interface and stored it when creating the permission. `resolvePermission()` now clears both `timeoutId` and `warningId`.
- **Status:** FIXED

#### BUG-009: `after-pack.cjs` hardcoded `Accomplish.app` doesn't match productName
- **File:** `apps/desktop/scripts/after-pack.cjs` (line 126)
- **Severity:** High
- **Description:** The script hardcoded `Accomplish.app` as the macOS app bundle name, but `package.json` sets `productName: "Screen Agent"`, so electron-builder creates `Screen Agent.app`. Node.js binaries were placed in a non-existent `Accomplish.app` path.
- **Fix:** Replaced the hardcoded `'Accomplish.app'` with dynamic `packager.appInfo.productFilename` (which is already used correctly in `resignMacApp`).
- **Status:** FIXED

#### BUG-010: `config-generator.ts` PATH check uses incorrect substring match
- **File:** `apps/desktop/src/main/opencode/config-generator.ts`
- **Severity:** Low
- **Description:** `mcpPath.includes('/bin')` was a substring match. If PATH contained `/opt/homebrew/bin` but not `/bin` itself, the check passed and `/bin:/usr/bin` were not prepended.
- **Fix:** Replaced substring check with splitting PATH into entries and checking for exact `/bin` and `/usr/bin` entries individually.
- **Status:** FIXED

#### BUG-011: `handleProcessExit` doesn't emit completion for signal-killed processes
- **File:** `apps/desktop/src/main/opencode/adapter.ts` (lines 612-636)
- **Severity:** Medium
- **Description:** When `code` is `null` (process killed by signal / external kill), none of the branches match and no event is emitted. If killed externally (e.g., OOM killer), the task hangs forever in the UI.
- **Fix:** `handleProcessExit` now treats signal-only exits as error exits, emits a terminal error event, and flushes buffered parser output before finalization.
- **Status:** FIXED

#### BUG-012: `setState` and callback inside `setState` updater function
- **File:** `apps/desktop/src/renderer/components/ui/streaming-text.tsx`
- **Severity:** Medium
- **Description:** Inside the `setDisplayedLength` updater, `onComplete?.()` and `setIsStreaming(false)` were called. Calling state setters and callbacks inside a `setState` updater is a React anti-pattern.
- **Fix:** Addressed as part of BUG-003 fix. The `onComplete` callback and `setIsStreaming` are now called outside the state updater using a local `reachedEnd` flag.
- **Status:** FIXED

### Lower Severity

#### BUG-013: OpenAI API key prefix `sk-` also matches Anthropic keys
- **File:** `apps/desktop/src/renderer/components/layout/SettingsDialog.tsx` (lines 25-26)
- **Severity:** Medium
- **Description:** OpenAI's prefix is `sk-` but Anthropic keys start with `sk-ant-`. Pasting an Anthropic key with "OpenAI" selected passes the client-side validation.
- **Fix:** API-key save flow now performs provider-specific server validation (`validateApiKeyForProvider`) before persisting keys, preventing cross-provider key acceptance.
- **Status:** FIXED

#### BUG-014: Smart trigger subscription torn down on every state change
- **File:** `apps/desktop/src/renderer/components/FloatingChat.tsx` (lines 43-98)
- **Severity:** Medium
- **Description:** The `useEffect` for smart trigger has `isLoading`, `currentTaskId`, `sessionId` in deps. Every time these change, the subscription is torn down and recreated, creating a window where trigger events are missed.
- **Fix:** Switched to ref-backed state access (`isLoadingRef`, `currentTaskIdRef`, `sessionIdRef`) and stabilized the smart-trigger subscription effect dependencies.
- **Status:** FIXED

#### BUG-015: Command injection in action-executor skill
- **File:** `apps/desktop/skills/action-executor/src/index.ts` (lines 53-59, 108-113)
- **Severity:** Critical (Security)
- **Description:** Coordinates are interpolated directly into Python scripts and user text is interpolated into AppleScript without proper escaping. Single quotes in `typeText` can break the shell command.
- **Fix:** Reworked execution to use `execFile` argument arrays (`python3` and `osascript`) without shell interpolation; added `--` before user-supplied AppleScript args.
- **Status:** FIXED

#### BUG-016: Permission API CORS allows all origins
- **File:** `apps/desktop/src/main/permission-api.ts` (line 67)
- **Severity:** Medium (Security)
- **Description:** `Access-Control-Allow-Origin: *` means any browser tab can send requests to localhost:9226.
- **Fix:** Added allowlist-based CORS policy (`PERMISSION_API_ALLOWED_ORIGINS`) and reject non-allowlisted browser origins with `403`.
- **Status:** FIXED

#### BUG-017: Duplicate IPC handler registration risk
- **File:** `apps/desktop/src/main/ipc/handlers.ts` + `api-key-handlers.ts` + `settings-handlers.ts`
- **Severity:** Medium
- **Description:** Incomplete refactoring left duplicate handler registrations in separate files. Currently only `registerIPCHandlers()` is called, but calling the modular versions too would crash.
- **Status:** NOT FIXING (dead code, not actively causing issues)

#### BUG-018: Full API key exposed to renderer via `getApiKey()`
- **File:** `apps/desktop/src/preload/index.ts` (lines 63-65)
- **Severity:** High (Security)
- **Description:** `api-key:get` handler returns the full unmasked API key to the renderer.
- **Fix:** `api-key:get` now returns masked payload only (`{ exists, prefix }`), and preload typing enforces masked return shape.
- **Status:** FIXED

---

## Features / Improvements

### FEATURE-001: Desktop Control Reliability + Live Vision
- **Scope:** Fix reliability gaps for screenshot capture, mouse/keyboard actions, permission diagnostics, and repetitive fallback answers.
- **Spec/Plan:** `docs/plans/2026-02-13-desktop-control-reliability-plan.md`
- **Status:** PLANNED
