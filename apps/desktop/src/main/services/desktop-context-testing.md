# Desktop Context Testing Guide

## Overview

This document outlines testing strategies for the desktop context feature, which allows the agent to see and understand other apps' windows on macOS.

## Manual Testing

### Prerequisites

1. **macOS System**: This feature is macOS-only
2. **Permissions**: Grant Accessibility and Screen Recording permissions in System Settings
3. **Multiple Apps Open**: Have several apps open (browser, editor, chat, etc.)

### Test Cases

#### 1. Window Enumeration

**Test**: List all windows
```typescript
const windows = await accomplish.desktop?.listWindows();
console.log('Windows:', windows);
```

**Expected**:
- Returns array of `DesktopWindow` objects
- Includes windows from all apps (foreground and background)
- Includes windows that are covered/behind other windows
- Window metadata is accurate (app name, title, bounds, z-order)

**Verification**:
- Check that background windows appear in the list
- Verify window bounds match actual window positions
- Confirm z-order reflects window layering

#### 2. Accessibility Inspection

**Test**: Inspect a specific window's accessibility tree
```typescript
const windows = await accomplish.desktop?.listWindows();
const browserWindow = windows.find(w => w.appName === 'Safari' || w.appName === 'Google Chrome');
if (browserWindow) {
  const tree = await accomplish.desktop?.inspectWindow(browserWindow.id);
  console.log('Accessibility tree:', tree);
}
```

**Expected**:
- Returns `AccessibleNode` tree structure
- Contains UI elements (buttons, text fields, labels)
- Includes element roles, titles, values, frames
- Tree depth and node count are within limits

**Verification**:
- Verify tree structure matches actual UI
- Check that text content is readable
- Confirm element bounds are accurate
- Test with different apps (browser, editor, chat)

#### 3. Screenshot Capture

**Test**: Capture screenshots in different modes
```typescript
// Full screen
const screenShot = await accomplish.desktop?.capture({ mode: 'screen' });

// Specific window
const windowShot = await accomplish.desktop?.capture({ 
  mode: 'window', 
  windowId: browserWindow.id 
});

// Custom region
const regionShot = await accomplish.desktop?.capture({
  mode: 'region',
  rect: { x: 100, y: 100, width: 800, height: 600 }
});
```

**Expected**:
- Screenshots are saved to temp directory
- File paths are returned
- Image files are valid PNGs
- File sizes are reasonable (< 50MB)

**Verification**:
- Open screenshot files and verify content
- Check that window screenshots capture correct window
- Verify region screenshots match specified bounds

#### 4. Full Context Snapshot

**Test**: Get complete desktop context
```typescript
const context = await accomplish.desktop?.getContext({
  includeWindows: true,
  inspectWindowIds: [browserWindow.id, editorWindow.id],
  captureScreenshots: true,
  screenshotMode: 'screen',
  maxAccessibilityDepth: 10,
  maxAccessibilityNodes: 1000
});
```

**Expected**:
- Returns `DesktopContextSnapshot` with all requested data
- Windows list is complete
- Accessibility trees for specified windows
- Screenshots if requested

**Verification**:
- Verify all components are present
- Check data accuracy
- Confirm performance is acceptable

#### 5. Background Polling

**Test**: Enable background polling
```typescript
// Enable in settings
await accomplish.setAllowDesktopContext?.(true);
await accomplish.setDesktopContextBackgroundPolling?.(true);

// Listen for snapshots
// (Note: This would need to be implemented via IPC events)
```

**Expected**:
- Polling starts automatically when enabled
- Snapshots are generated at configured interval
- Polling stops when disabled
- Errors don't crash the service

**Verification**:
- Check that snapshots arrive periodically
- Verify polling stops when feature is disabled
- Test error handling (e.g., revoke permissions)

#### 6. Permissions Handling

**Test**: Permission denial scenarios
1. Disable Accessibility permission in System Settings
2. Disable Screen Recording permission
3. Try to use desktop context features

**Expected**:
- Clear error messages indicating missing permissions
- Features fail gracefully
- User guidance is provided

**Verification**:
- Error messages are user-friendly
- App doesn't crash
- Settings UI shows permission status

#### 7. Performance and Limits

**Test**: Stress testing
- List windows with many apps open (20+ windows)
- Inspect large accessibility trees (deep nesting)
- Capture screenshots of large displays

**Expected**:
- Operations complete within reasonable time (< 5s)
- Memory usage stays reasonable
- No crashes or hangs

**Verification**:
- Monitor CPU and memory usage
- Check operation timing
- Verify limits are enforced (depth, nodes, file size)

## Automated Testing

### Unit Tests

Test individual service methods:
- `DesktopContextService.listWindows()`
- `DesktopContextService.inspectWindow()`
- `DesktopContextService.captureScreenshot()`
- `DesktopContextService.getDesktopContext()`

### Integration Tests

Test IPC communication:
- IPC handlers respond correctly
- Preload API exposes methods
- Renderer can call desktop context methods

### E2E Tests

Test full flow:
1. Enable desktop context feature
2. Grant permissions (or mock)
3. Call desktop context methods
4. Verify responses

## Error Scenarios

Test these error cases:
1. Helper process crashes
2. Helper process not found
3. Invalid window IDs
4. Permission denied
5. Timeout scenarios
6. Invalid parameters

## Security and Privacy

Verify:
1. Only authorized operations are performed
2. Screenshots are stored securely (temp directory)
3. No sensitive data leaks in logs
4. Permissions are checked before operations
5. User can disable feature at any time

## Performance Benchmarks

Target metrics:
- Window enumeration: < 500ms
- Accessibility inspection: < 2s (for typical window)
- Screenshot capture: < 1s
- Full context snapshot: < 5s

## Known Limitations

1. **macOS Only**: Feature only works on macOS
2. **Permissions Required**: Requires Accessibility and Screen Recording permissions
3. **Helper Binary**: Requires native helper to be compiled and bundled
4. **Accessibility API**: Some apps may not expose full accessibility tree
5. **Window Matching**: Window ID matching may not be perfect for all apps

## Troubleshooting

### Helper Process Not Starting
- Check helper binary exists at expected path
- Verify helper has execute permissions
- Check console logs for errors

### Permission Errors
- Verify permissions in System Settings > Privacy & Security
- Try revoking and re-granting permissions
- Restart app after granting permissions

### Performance Issues
- Reduce polling interval
- Limit accessibility tree depth/nodes
- Disable screenshot capture in polling
- Check system resources
