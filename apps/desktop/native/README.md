# Desktop Context Native Helper

This directory contains the macOS native helper for desktop context operations.

## Building the Helper

### Development (Swift Script)

The helper can be run directly as a Swift script:
```bash
swift apps/desktop/native/desktop-context-helper.swift
```

### Production (Compiled Binary)

For production builds, compile the Swift script to a binary:

```bash
# Compile to binary
swiftc -o desktop-context-helper desktop-context-helper.swift \
  -framework Foundation \
  -framework AppKit \
  -framework ApplicationServices \
  -framework CoreGraphics \
  -framework UniformTypeIdentifiers

# Make executable
chmod +x desktop-context-helper
```

The compiled binary should be placed in the app's resources directory for packaging.

## Integration with Electron Build

The helper binary should be included in the Electron build process:

1. Compile the helper during build
2. Copy to `resources/desktop-context-helper` in the packaged app
3. Ensure it has execute permissions

## Permissions

The helper requires:
- **Accessibility**: To inspect UI elements via AX APIs
- **Screen Recording**: To capture screenshots

These permissions are requested by macOS when the helper first runs.

## Testing

Test the helper directly:
```bash
echo '{"cmd":"list_windows","id":"test1"}' | swift desktop-context-helper.swift
```

Expected output:
```json
{"id":"test1","success":true,"data":{"windows":[...]}}
```
