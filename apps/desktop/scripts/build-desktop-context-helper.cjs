#!/usr/bin/env node

/**
 * Build the native desktop-context helper binary for packaged macOS builds.
 *
 * Output: apps/desktop/resources/desktop-context-helper
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SOURCE_FILE = path.join(PROJECT_ROOT, 'native', 'desktop-context-helper.swift');
const OUTPUT_FILE = path.join(PROJECT_ROOT, 'resources', 'desktop-context-helper');

function ensureParentDir(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function compileWith(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

function main() {
  if (!fs.existsSync(SOURCE_FILE)) {
    throw new Error(`[desktop-context-helper-build] Source not found: ${SOURCE_FILE}`);
  }

  if (process.platform !== 'darwin') {
    console.log('[desktop-context-helper-build] Non-macOS platform detected, skipping native helper compilation.');
    return;
  }

  ensureParentDir(OUTPUT_FILE);

  const compileArgs = [
    'swiftc',
    '-o',
    OUTPUT_FILE,
    SOURCE_FILE,
    '-framework',
    'Foundation',
    '-framework',
    'AppKit',
    '-framework',
    'ApplicationServices',
    '-framework',
    'CoreGraphics',
    '-framework',
    'ImageIO',
    '-framework',
    'UniformTypeIdentifiers',
  ];

  try {
    compileWith('xcrun', compileArgs);
  } catch (error) {
    console.warn('[desktop-context-helper-build] xcrun swiftc failed, retrying with swiftc directly.');
    compileWith('swiftc', compileArgs.slice(1));
  }

  fs.chmodSync(OUTPUT_FILE, 0o755);
  console.log(`[desktop-context-helper-build] Compiled helper: ${OUTPUT_FILE}`);
}

main();
