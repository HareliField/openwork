#!/usr/bin/env node

/**
 * CI guardrail: verify that post-pack Node.js placement matches runtime path assumptions.
 *
 * This script creates minimal fake Node.js payloads in resources/nodejs, runs after-pack
 * for representative targets, and verifies binaries end up where bundled-node.ts expects.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const afterPack = require('./after-pack.cjs').default;

const PROJECT_ROOT = path.resolve(__dirname, '..');
const NODEJS_RESOURCE_ROOT = path.join(PROJECT_ROOT, 'resources', 'nodejs');
const AFTER_PACK_SOURCE = fs.readFileSync(path.join(__dirname, 'after-pack.cjs'), 'utf8');
const NODE_VERSION_MATCH = AFTER_PACK_SOURCE.match(/const NODE_VERSION = '([^']+)'/);
const NODE_VERSION = NODE_VERSION_MATCH?.[1];
const PACKAGE_JSON = JSON.parse(
  fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')
);
const PRODUCT_FILENAME = PACKAGE_JSON.build?.productName;
const HAS_DESKTOP_CONTEXT_HELPER_RESOURCE = Array.isArray(PACKAGE_JSON.build?.extraResources)
  && PACKAGE_JSON.build.extraResources.some(
    (entry) =>
      entry
      && typeof entry === 'object'
      && entry.from === 'resources/desktop-context-helper'
      && entry.to === 'desktop-context-helper'
  );

if (!NODE_VERSION) {
  throw new Error('[packaged-path-check] Missing NODE_VERSION constant in after-pack.cjs');
}

if (!PRODUCT_FILENAME) {
  throw new Error(
    '[packaged-path-check] Missing build.productName in apps/desktop/package.json'
  );
}

if (!HAS_DESKTOP_CONTEXT_HELPER_RESOURCE) {
  throw new Error(
    '[packaged-path-check] Missing desktop-context helper extraResource mapping in apps/desktop/package.json'
  );
}

const ARCH_MAP = {
  x64: 1,
  arm64: 3,
};

const createdPaths = [];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeFile(filePath, contents = 'stub') {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, contents);
}

function platformSourceDir(platform, arch) {
  if (platform === 'win32') {
    return path.join(
      NODEJS_RESOURCE_ROOT,
      `${platform}-${arch}`,
      `node-v${NODE_VERSION}-win-${arch}`
    );
  }
  return path.join(
    NODEJS_RESOURCE_ROOT,
    `${platform}-${arch}`,
    `node-v${NODE_VERSION}-${platform}-${arch}`
  );
}

function ensureStubNodePayload(platform, arch) {
  const sourceDir = platformSourceDir(platform, arch);
  if (fs.existsSync(sourceDir)) {
    return;
  }

  const sourceRoot = path.dirname(sourceDir);
  const sourceRootExisted = fs.existsSync(sourceRoot);

  if (sourceRootExisted) {
    createdPaths.push(sourceDir);
  } else {
    createdPaths.push(sourceRoot);
  }

  ensureDir(sourceDir);

  if (platform === 'win32') {
    writeFile(path.join(sourceDir, 'node.exe'));
    writeFile(path.join(sourceDir, 'npm.cmd'));
    writeFile(path.join(sourceDir, 'npx.cmd'));
    return;
  }

  writeFile(path.join(sourceDir, 'bin', 'node'));
  writeFile(path.join(sourceDir, 'bin', 'npm'));
  writeFile(path.join(sourceDir, 'bin', 'npx'));
}

function assertExists(filePath, description) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${description} not found at: ${filePath}`);
  }
}

async function verifyLinuxLayout() {
  ensureStubNodePayload('linux', 'x64');
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-path-linux-'));

  await afterPack({
    arch: ARCH_MAP.x64,
    appOutDir,
    packager: {
      platform: { name: 'linux' },
      appInfo: { productFilename: PRODUCT_FILENAME },
    },
  });

  assertExists(
    path.join(appOutDir, 'resources', 'nodejs', 'x64', 'bin', 'node'),
    'Linux bundled node binary'
  );
  assertExists(
    path.join(appOutDir, 'resources', 'nodejs', 'x64', 'bin', 'npm'),
    'Linux bundled npm binary'
  );
  assertExists(
    path.join(appOutDir, 'resources', 'nodejs', 'x64', 'bin', 'npx'),
    'Linux bundled npx binary'
  );
}

async function verifyWindowsLayout() {
  ensureStubNodePayload('win32', 'x64');
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-path-win-'));

  await afterPack({
    arch: ARCH_MAP.x64,
    appOutDir,
    packager: {
      platform: { name: 'windows' },
      appInfo: { productFilename: PRODUCT_FILENAME },
    },
  });

  assertExists(
    path.join(appOutDir, 'resources', 'nodejs', 'x64', 'node.exe'),
    'Windows bundled node binary'
  );
  assertExists(
    path.join(appOutDir, 'resources', 'nodejs', 'x64', 'npm.cmd'),
    'Windows bundled npm binary'
  );
  assertExists(
    path.join(appOutDir, 'resources', 'nodejs', 'x64', 'npx.cmd'),
    'Windows bundled npx binary'
  );
}

async function verifyMacLayout() {
  ensureStubNodePayload('darwin', 'x64');
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-path-mac-'));

  await afterPack({
    arch: ARCH_MAP.x64,
    appOutDir,
    packager: {
      platform: { name: 'mac' },
      appInfo: { productFilename: PRODUCT_FILENAME },
    },
  });

  const macResourceRoot = path.join(
    appOutDir,
    `${PRODUCT_FILENAME}.app`,
    'Contents',
    'Resources',
    'nodejs',
    'x64'
  );

  assertExists(path.join(macResourceRoot, 'bin', 'node'), 'macOS bundled node binary');
  assertExists(path.join(macResourceRoot, 'bin', 'npm'), 'macOS bundled npm binary');
  assertExists(path.join(macResourceRoot, 'bin', 'npx'), 'macOS bundled npx binary');

  const hardcodedLegacyAppPath = path.join(
    appOutDir,
    'Accomplish.app',
    'Contents',
    'Resources',
    'nodejs',
    'x64',
    'bin',
    'node'
  );

  if (fs.existsSync(hardcodedLegacyAppPath)) {
    throw new Error(`Unexpected legacy app bundle path detected: ${hardcodedLegacyAppPath}`);
  }
}

function cleanupCreatedSources() {
  for (const createdPath of createdPaths) {
    if (fs.existsSync(createdPath)) {
      fs.rmSync(createdPath, { recursive: true, force: true });
    }
  }
}

async function main() {
  try {
    ensureDir(NODEJS_RESOURCE_ROOT);

    await verifyMacLayout();
    await verifyLinuxLayout();
    await verifyWindowsLayout();

    console.log('[packaged-path-check] All packaged path assumptions validated.');
  } finally {
    cleanupCreatedSources();
  }
}

main().catch((error) => {
  console.error('[packaged-path-check] Validation failed:', error);
  process.exit(1);
});
