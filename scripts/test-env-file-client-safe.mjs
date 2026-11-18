#!/usr/bin/env node
/**
 * lib/env-file.js is bundled into the browser (the Config page imports RUNTIME_ONLY_ENV_KEYS). A Node-only
 * require at its top crashed the Config page in production (2026-11-18, "This page couldn't load").
 * It must stay free of Node built-ins; server-only helpers live elsewhere (lib/file-lock.js).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'lib/env-file.js'), 'utf8');
const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
assert.deepEqual(requires, [], `lib/env-file.js must not require anything (browser bundle): ${requires.join(', ')}`);
assert.doesNotMatch(source, /\bimport\s.+from\s/, 'no ES imports either');

// Every client component that imports env-file still gets only pure helpers.
const clientFiles = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'api') walk(rel); }
    else if (/\.tsx$/.test(entry.name)) {
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      if (/^['"]use client['"]/m.test(text) && /from ['"]@\/lib\/(file-lock|caddy|env-edit)['"]/.test(text)) clientFiles.push(rel);
    }
  }
};
walk('app');
assert.deepEqual(clientFiles, [], `client components must not import server-only modules: ${clientFiles.join(', ')}`);
console.log('lib/env-file.js is browser-safe; no client component imports server-only env/lock modules');
