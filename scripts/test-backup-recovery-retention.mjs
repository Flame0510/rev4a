#!/usr/bin/env node
/** Automatic pruning cannot silently delete a restore's recovery copy. Disposable local files only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-recovery-retention-'));
let protectedFiles = []; let unreadable = false;
const forbidden = () => { throw new Error('Unexpected Docker call'); };
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const module = { exports: {} };
  cache.set(file, module.exports);
  const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const resolve = (name) => {
    if (name === '@/lib/rev4a-paths') return { BACKUPS_DIR: dir };
    if (name === '@/lib/agent-restore-state') return { retainedRestoreRecoveryFiles: () => { if (unreadable) throw new Error('unavailable'); return protectedFiles; } };
    if (name === '@/lib/docker-socket') return { dockerFetch: forbidden };
    if (name === '@/lib/agent-images') return { runDocker: forbidden };
    if (name === '@/lib/backups-migration') return { recordedMigrationState: () => ({ status: 'done', volumeRemoved: true }) };
    if (name.startsWith('@/')) return load(name.slice(2) + '.ts');
    return require(name);
  };
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { console, process })(resolve, module, module.exports);
  cache.set(file, module.exports);
  return module.exports;
}
const { pruneBackups } = load('lib/backups-volume.ts');
let passed = 0;
try {
  const names = [1, 2, 3, 4].map((day) => `agent-agent_fixture-cold-2026-11-0${day}_120000001.tar.gz`);
  names.forEach((name, index) => { const file = path.join(dir, name); fs.writeFileSync(file, name); fs.utimesSync(file, index + 1, index + 1); });
  protectedFiles = [names[0]];
  const removed = await pruneBackups('agent_fixture', 'cold', 1, dir);
  assert.deepEqual([...removed].sort(), names.slice(1, 3).sort());
  assert.equal(fs.existsSync(path.join(dir, names[0])), true);
  assert.equal(fs.existsSync(path.join(dir, names[3])), true);
  passed++; console.log('ok   a retained restore recovery file survives automatic cold-backup retention');
  unreadable = true;
  assert.equal((await pruneBackups('agent_fixture', 'cold', 0, dir)).length, 0);
  assert.equal(fs.readdirSync(dir).length, 2);
  passed++; console.log('ok   unreadable restore history prevents automatic archive deletion');
  unreadable = false; protectedFiles = [];
  await pruneBackups('agent_fixture', 'cold', 1, dir);
  assert.equal(fs.existsSync(path.join(dir, names[0])), false);
  passed++; console.log('ok   a recovery file becomes eligible only after its history reference is removed');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`\n${passed} passed`);
