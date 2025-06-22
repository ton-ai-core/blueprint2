#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable @ton-ai-core/suggest-members/suggest-imports */
/* eslint-disable @typescript-eslint/no-require-imports */

const fs   = require('fs');
const path = require('path');

// Project root - current working directory
const PROJECT_ROOT = process.cwd();

// Directory with generated TS files
const BUILD_DIR = path.join(PROJECT_ROOT, 'build');

if (!fs.existsSync(BUILD_DIR) || !fs.statSync(BUILD_DIR).isDirectory()) {
  console.error(`❌ Build directory not found: ${BUILD_DIR}`);
  process.exit(1);
}

/**
 * Processes a single .ts file: if it doesn't have c8 directives,
 * inserts them around all code BEFORE the first export class line.
 */
function processFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // if directives already exist - skip
  if (content.includes('/* c8 ignore file */') || content.includes('/* c8 ignore start */')) {
    return;
  }

  const idx = content.indexOf('export class');
  if (idx === -1) {
    // no class - skip
    return;
  }

  const before = content.slice(0, idx);
  const after  = content.slice(idx);

  const patched =
    '/* c8 ignore start */\n' +
    before +
    '\n/* c8 ignore end */\n\n' +
    after;

  fs.writeFileSync(filePath, patched, 'utf8');
  console.log(`✅ Patched: ${path.relative(PROJECT_ROOT, filePath)}`);
}

/**
 * Recursively traverses a folder, processing all .ts files.
 */
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walk(full);
    } else if (stat.isFile() && full.endsWith('.ts')) {
      processFile(full);
    }
  }
}

// Start execution
walk(BUILD_DIR);
console.log('🎉 insert-c8-ignore done.');
