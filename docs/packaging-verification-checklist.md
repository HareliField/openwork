# Desktop Packaging Verification Checklist

Use this checklist before merging packaging/runtime changes in:
- `apps/desktop/scripts/**`
- `apps/desktop/run_*.sh`
- `apps/desktop/src/main/utils/**`

This validates:
- packaged binary placement (Node.js + OpenCode CLI + skills),
- runtime PATH/bootstrap behavior,
- packaged-app fallbacks.

## 1. Preflight

Run from repository root:

```bash
pnpm install
pnpm -F @accomplish/desktop download:nodejs
```

Confirm Node archives were extracted:

```bash
ls -la apps/desktop/resources/nodejs
find apps/desktop/resources/nodejs -maxdepth 2 -type d -name "node-v20.18.1-*"
```

Expected:
- `apps/desktop/resources/nodejs/darwin-x64/node-v20.18.1-darwin-x64`
- `apps/desktop/resources/nodejs/darwin-arm64/node-v20.18.1-darwin-arm64`

## 2. Build Artifacts

Run from repository root:

```bash
pnpm -F @accomplish/desktop clean
pnpm -F @accomplish/desktop build:unpack
```

Optional distributables (run from `apps/desktop`):

```bash
pnpm build
node scripts/package.cjs --mac --publish never
node scripts/package.cjs --win --publish never
node scripts/package.cjs --linux --publish never
```

Expected:
- artifacts written under `apps/desktop/release/`
- artifact names follow `${productName}-${version}-${os}-${arch}.${ext}`

## 3. Post-Pack File Placement

### macOS

```bash
APP_PATH="$(find apps/desktop/release -maxdepth 3 -type d -name '*.app' | head -n 1)"
echo "$APP_PATH"
ls -la "$APP_PATH/Contents/Resources/nodejs"
find "$APP_PATH/Contents/Resources/nodejs" -maxdepth 3 -type f \( -name node -o -name npm -o -name npx \)
test -f "$APP_PATH/Contents/Resources/app.asar.unpacked/node_modules/opencode-ai/bin/opencode"
test -d "$APP_PATH/Contents/Resources/skills"
```

Expected:
- `nodejs/<arch>/bin/node`, `nodejs/<arch>/bin/npm`, `nodejs/<arch>/bin/npx` exist.
- `app.asar.unpacked/node_modules/opencode-ai/bin/opencode` exists.
- `Contents/Resources/skills` exists.

For universal mac builds, both `nodejs/x64` and `nodejs/arm64` must exist.

### Windows

Verify inside unpacked app directory (`release/win-*`):
- `resources/nodejs/<arch>/node.exe`
- `resources/nodejs/<arch>/npm.cmd`
- `resources/nodejs/<arch>/npx.cmd`
- `resources/app.asar.unpacked/node_modules/opencode-ai/bin/opencode`
- `resources/skills/**`

### Linux

Verify inside unpacked app directory (`release/linux-*`):
- `resources/nodejs/<arch>/bin/node`
- `resources/nodejs/<arch>/bin/npm`
- `resources/nodejs/<arch>/bin/npx`
- `resources/app.asar.unpacked/node_modules/opencode-ai/bin/opencode`
- `resources/skills/**`

### Size/Exclusions

Confirm Node headers are excluded by `after-pack`:

```bash
find apps/desktop/release -type d -path '*nodejs*include*'
```

Expected: no `include` directory in packaged Node tree.

## 4. Runtime Bootstrap Verification

Launch packaged app (macOS examples):

```bash
./apps/desktop/run_prod.sh
# or
./apps/desktop/run_staging.sh
```

Trigger one task, then confirm logs include:
- `[OpenCode CLI] Added bundled Node.js to PATH:`
- `[OpenCode CLI] Extended PATH for packaged app` (macOS packaged runs)
- `[Bundled Node] Configuration:`

Confirm logs do not include fallback warnings:
- `[Bundled Node] WARNING: Bundled Node.js not found, falling back to system node`
- `[Bundled Node] WARNING: Bundled npm not found, falling back to system npm`
- `[Bundled Node] WARNING: Bundled npx not found, falling back to system npx`

## 5. Automated Regression Checks

Run targeted integration tests:

```bash
pnpm -F @accomplish/desktop test:integration -- __tests__/integration/main/utils/bundled-node.integration.test.ts
pnpm -F @accomplish/desktop test:integration -- __tests__/integration/main/utils/system-path.integration.test.ts
pnpm -F @accomplish/desktop test:integration -- __tests__/integration/main/opencode/cli-path.integration.test.ts
```

Expected: all tests pass.

## 6. Sign-Off Template

Use this in PR descriptions:

```md
## Packaging Verification
- [ ] Preflight binaries downloaded (`download:nodejs`)
- [ ] Build/unpack successful
- [ ] Node binaries placed correctly for target OS/arch
- [ ] OpenCode CLI present in `app.asar.unpacked`
- [ ] Skills copied into `resources/skills`
- [ ] No bundled-node fallback warnings at runtime
- [ ] Integration checks pass
```
