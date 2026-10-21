#!/usr/bin/env node
/**
 * Tests for lib/memory-context.ts (sizes, caps, truncation, limits from config or defaults, the cache).
 *
 *   node scripts/test-memory-context.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const m = await import('../lib/memory-context.ts');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}

const raw = (over = {}) => ({
  files: [
    { name: 'AGENTS.md', exists: true, chars: 5000 },
    { name: 'SOUL.md', exists: true, chars: 25000 },
    { name: 'USER.md', exists: true, chars: 100 },
    { name: 'MEMORY.md', exists: false, chars: null },
    { name: 'TOOLS.md', exists: true, chars: 999 },
    { name: 'HEARTBEAT.md', exists: false, chars: null },
  ],
  rules: { exists: true, chars: 900 },
  memory: [
    { name: 'old.md', size: 10, mtimeMs: 1000 },
    { name: 'new.md', size: 20, mtimeMs: 2000 },
  ],
  memoryTruncated: false,
  config: null,
  ...over,
});

test('limits fall back to the OpenClaw defaults', () => {
  const l = m.resolveLimits(null);
  assert.deepEqual(l, { perFile: { value: 20000, source: 'default' }, total: { value: 60000, source: 'default' } });
  assert.deepEqual(m.resolveLimits({ defaults: { perFile: null, total: undefined }, entries: {} }), l);
});

test('limits: defaults from the config, then the agent entry over them', () => {
  const cfg = { defaults: { perFile: 10000, total: 40000 }, entries: { main: { perFile: 5000 } } };
  const l = m.resolveLimits(cfg);
  assert.deepEqual(l.perFile, { value: 5000, source: 'config' });
  assert.deepEqual(l.total, { value: 40000, source: 'config' });
});

test('limits: the only entry applies; several entries without main do not', () => {
  assert.equal(m.resolveLimits({ defaults: {}, entries: { x: { total: 1234 } } }).total.value, 1234);
  const two = m.resolveLimits({ defaults: {}, entries: { a: { total: 1 }, b: { total: 2 } } });
  assert.deepEqual(two.total, { value: 60000, source: 'default' });
});

test('limits: junk values are ignored', () => {
  const l = m.resolveLimits({ defaults: { perFile: -5, total: 'big' }, entries: { main: { perFile: 0 } } });
  assert.equal(l.perFile.source, 'default');
  assert.equal(l.total.source, 'default');
});

test('injection: per-file cap truncates a long file only', () => {
  assert.deepEqual(m.computeInjection([5000, 25000, null], 20000, 60000), [
    { injected: 5000, truncated: false },
    { injected: 20000, truncated: true },
    { injected: 0, truncated: false },
  ]);
});

test('injection: the total cap cuts later files and a file at the cap is not truncated', () => {
  assert.deepEqual(m.computeInjection([20000, 20000, 20000, 20000, 10], 20000, 60000).map((x) => x.injected), [20000, 20000, 20000, 0, 0]);
  assert.equal(m.computeInjection([20000], 20000, 60000)[0].truncated, false);
  const r = m.computeInjection([30, 30], 100, 40);
  assert.deepEqual(r, [{ injected: 30, truncated: false }, { injected: 10, truncated: true }]);
});

test('injection: an empty file injects nothing and is not truncated', () => {
  assert.deepEqual(m.computeInjection([0], 10, 10), [{ injected: 0, truncated: false }]);
});

test('view: totals, order, missing files and notes', () => {
  const v = m.buildContextView(raw());
  assert.deepEqual(m.BOOTSTRAP_FILES.map((f) => f.name), ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'BOOTSTRAP.md', 'MEMORY.md']);
  assert.deepEqual(v.files.map((f) => f.name), m.BOOTSTRAP_FILES.map((f) => f.name));
  const soul = v.files.find((f) => f.name === 'SOUL.md');
  assert.equal(soul.injected, 20000);
  assert.equal(soul.truncated, true);
  assert.ok(!v.files.some((f) => f.name === 'TOOLS.md' || f.name === 'HEARTBEAT.md'));
  assert.deepEqual(v.other, [{ name: 'TOOLS.md', path: 'TOOLS.md', chars: 999 }]);
  assert.equal(v.totals.chars, 5000 + 25000 + 100);
  assert.equal(v.files.find((f) => f.name === 'MEMORY.md').optional, true);
  const missing = v.files.find((f) => f.name === 'IDENTITY.md');
  assert.deepEqual([missing.exists, missing.chars, missing.injected], [false, null, 0]);
  assert.match(v.files.find((f) => f.name === 'MEMORY.md').note, /sub-agent/);
  assert.equal(v.totals.injected, 5000 + 20000 + 100);
  assert.equal(v.totals.chars, 5000 + 25000 + 100);
  assert.equal(v.totals.cap, 60000);
  assert.equal(v.totals.truncatedFiles, 1);
  assert.deepEqual(v.rules, { path: '.rev4a/AGENTS.md', exists: true, size: 900, linked: false });
});

test('view: a linked file (chars null) is present but injects nothing', () => {
  const v = m.buildContextView(raw({ files: [{ name: 'USER.md', exists: true, chars: null }] }));
  const u = v.files.find((f) => f.name === 'USER.md');
  assert.deepEqual([u.exists, u.chars, u.injected, u.truncated], [true, null, 0, false]);
});

test('view: memory files keep their order and get a workspace path; the list is capped', () => {
  const v = m.buildContextView(raw({ memory: [{ name: 'a/b.md', size: 1, mtimeMs: 5 }] }));
  assert.equal(v.memory.files[0].path, 'memory/a/b.md');
  const many = Array.from({ length: 250 }, (_, i) => ({ name: `f${i}.md`, size: 1, mtimeMs: i }));
  const c = m.buildContextView(raw({ memory: many }));
  assert.equal(c.memory.files.length, 200);
  assert.equal(c.memory.truncated, true);
});

test('view: config limits change the verdict', () => {
  const v = m.buildContextView(raw({ config: { defaults: { perFile: 30000, total: 28000 }, entries: {} } }));
  assert.equal(v.totals.cap, 28000);
  assert.equal(v.files.find((f) => f.name === 'SOUL.md').injected, 23000);
  assert.equal(v.limits.perFile.source, 'config');
});

test('parse: takes the last line, rejects junk', () => {
  const out = JSON.stringify({ files: [], rules: { exists: false, chars: null }, memory: [], memoryTruncated: false, config: null });
  assert.deepEqual(m.parseContextOutput(`warning\n${out}\n`).files, []);
  assert.throws(() => m.parseContextOutput(''));
  assert.throws(() => m.parseContextOutput('{"files":1}'));
  assert.throws(() => m.parseContextOutput('not json'));
});

test('script: constant, argv-only, no host paths, no content output', () => {
  assert.deepEqual(m.CONTEXT_ARGV.slice(0, 2), ['node', '-e']);
  assert.equal(m.CONTEXT_ARGV[2], m.CONTEXT_SCRIPT);
  assert.ok(m.CONTEXT_SCRIPT.includes('/root/.openclaw/workspace'));
  assert.ok(!m.CONTEXT_SCRIPT.includes('/data/.openclaw'));
});

test('script: runs against a real tree and never prints file content', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rev4a-ctx-'));
  const ws = path.join(dir, 'workspace');
  mkdirSync(path.join(ws, 'memory', 'dreaming'), { recursive: true });
  mkdirSync(path.join(ws, '.rev4a'));
  writeFileSync(path.join(ws, 'AGENTS.md'), 'SECRET-é'.repeat(10));
  writeFileSync(path.join(ws, 'memory', 'a.md'), 'x');
  writeFileSync(path.join(ws, 'memory', 'dreaming', 'b.md'), 'yy');
  writeFileSync(path.join(ws, '.rev4a', 'AGENTS.md'), 'rules');
  symlinkSync('/etc/hosts', path.join(ws, 'USER.md'));
  symlinkSync('/etc', path.join(ws, 'memory', 'link'));
  const cfg = path.join(dir, 'openclaw.json');
  writeFileSync(cfg, JSON.stringify({ agents: { defaults: { bootstrapMaxChars: 50 }, entries: { main: { bootstrapTotalMaxChars: 70 } } } }));
  const script = m.CONTEXT_SCRIPT.replace(m.CONTEXT_WORKSPACE, ws).replace(m.CONTEXT_CONFIG_PATH, cfg);
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.ok(!out.includes('SECRET'));
  const v = m.buildContextView(m.parseContextOutput(out));
  const agents = v.files.find((f) => f.name === 'AGENTS.md');
  assert.deepEqual([agents.chars, agents.injected, agents.truncated], [80, 50, true]);
  const user = v.files.find((f) => f.name === 'USER.md');
  assert.deepEqual([user.exists, user.chars], [true, null]);
  assert.deepEqual(v.memory.files.map((f) => f.path).sort(), ['memory/a.md', 'memory/dreaming/b.md']);
  assert.deepEqual(v.limits, { perFile: { value: 50, source: 'config' }, total: { value: 70, source: 'config' } });
  assert.deepEqual(v.rules, { path: '.rev4a/AGENTS.md', exists: true, size: 5, linked: false });
});

test('limits: floor first, anything below 1 is ignored', () => {
  assert.deepEqual(m.resolveLimits({ defaults: { perFile: 0.5 }, entries: {} }).perFile, { value: 20000, source: 'default' });
  assert.deepEqual(m.resolveLimits({ defaults: { perFile: 7.9 }, entries: { main: { perFile: 0 } } }).perFile, { value: 7, source: 'config' });
  assert.equal(m.resolveLimits({ defaults: { total: -5, perFile: NaN }, entries: {} }).total.source, 'default');
});

test('injection: whitespace-only is blank, a linked file is unknown and counted apart', () => {
  const v = m.buildContextView(raw({ files: [
    { name: 'AGENTS.md', exists: true, chars: 40, blank: true },
    { name: 'USER.md', exists: true, chars: null, linked: true },
  ] }));
  const a = v.files.find((f) => f.name === 'AGENTS.md');
  assert.deepEqual([a.injected, a.truncated], [0, false]);
  assert.equal(v.files.find((f) => f.name === 'USER.md').linked, true);
  assert.equal(v.totals.linkedFiles, 1);
});

test('errors: a buffer overflow is not a timeout', () => {
  assert.match(m.contextError(new Error('stdout maxBuffer length exceeded'), 'Bob').error, /too much data/);
  assert.match(m.contextError(new Error('timed out'), 'Bob').error, /in time/);
});

test('script: symlinked memory/ and .rev4a are not followed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rev4a-ctx-'));
  const ws = path.join(dir, 'workspace');
  const outside = path.join(dir, 'outside');
  mkdirSync(ws); mkdirSync(outside);
  writeFileSync(path.join(outside, 'secret.txt'), 'x');
  writeFileSync(path.join(outside, 'AGENTS.md'), 'rules');
  symlinkSync(outside, path.join(ws, 'memory'));
  symlinkSync(outside, path.join(ws, '.rev4a'));
  writeFileSync(path.join(ws, 'SOUL.md'), '  \n\t ');
  const script = m.CONTEXT_SCRIPT.replace(m.CONTEXT_WORKSPACE, ws).replace(m.CONTEXT_CONFIG_PATH, path.join(dir, 'none.json'));
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.ok(!out.includes('secret.txt'));
  const v = m.buildContextView(m.parseContextOutput(out));
  assert.equal(v.memory.linked, true);
  assert.deepEqual(v.memory.files, []);
  assert.deepEqual(v.rules, { path: '.rev4a/AGENTS.md', exists: true, size: null, linked: true });
  assert.equal(v.files.find((f) => f.name === 'SOUL.md').injected, 0);
});

test('script: keeps the newest 200 whatever the folder order; flags depth and size cuts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rev4a-ctx-'));
  const ws = path.join(dir, 'workspace');
  mkdirSync(path.join(ws, 'memory', 'a', 'b', 'c', 'd'), { recursive: true });
  const now = Date.now() / 1000;
  for (let i = 0; i < 450; i++) {
    const p = path.join(ws, 'memory', 'f' + String(i).padStart(4, '0') + '.md');
    writeFileSync(p, 'x');
    utimesSync(p, now - (1000 - i), now - (1000 - i));
  }
  writeFileSync(path.join(ws, 'memory', 'a', 'b', 'c', 'd', 'deep.md'), 'x');
  const script = m.CONTEXT_SCRIPT.replace(m.CONTEXT_WORKSPACE, ws).replace(m.CONTEXT_CONFIG_PATH, path.join(dir, 'none.json'));
  const v = m.buildContextView(m.parseContextOutput(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })));
  assert.equal(v.memory.files.length, 200);
  assert.equal(v.memory.files[0].name, 'f0449.md');
  assert.equal(v.memory.files[199].name, 'f0250.md');
  assert.equal(v.memory.truncated, true);
  const small = mkdtempSync(path.join(tmpdir(), 'rev4a-ctx-'));
  mkdirSync(path.join(small, 'workspace', 'memory', 'a', 'b', 'c', 'd'), { recursive: true });
  const s2 = m.CONTEXT_SCRIPT.replace(m.CONTEXT_WORKSPACE, path.join(small, 'workspace')).replace(m.CONTEXT_CONFIG_PATH, path.join(small, 'none.json'));
  const v2 = m.buildContextView(m.parseContextOutput(execFileSync(process.execPath, ['-e', s2], { encoding: 'utf8' })));
  assert.equal(v2.memory.truncated, true);
});

test('urls', () => {
  assert.equal(m.workspaceFileUrl('agent_1', 'memory/a b.md'), '/workspace?agent=agent_1&file=memory%2Fa%20b.md');
  assert.equal(m.contextUrl('agent_1', true), '/api/memory-context?agent=agent_1&fresh=1');
});

test('errors map to 503 / 502', () => {
  assert.equal(m.contextError(new Error('Docker is not available'), 'x').status, 503);
  assert.match(m.contextError(new Error('container is not running'), 'Bob').error, /Bob is not running/);
  assert.equal(m.contextError(new Error('boom'), 'x').status, 502);
});

test('cache expires after the ttl and is replaced on set', () => {
  let t = 0;
  const c = new m.ContextCache(30_000, () => t);
  const view = m.buildContextView(raw());
  c.set('a', view);
  t = 29_999;
  assert.equal(c.get('a'), view);
  t = 30_000;
  assert.equal(c.get('a'), null);
});

console.log(`\n${passed} passed`);
