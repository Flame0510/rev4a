#!/usr/bin/env node
/**
 * Tests for lib/rev4a-skills.ts (ensureRev4aSkill) against temporary directories, and for the
 * shipped rev4a-mongodb skill file (frontmatter that makes it eligible, the env name OpenClaw
 * keeps). Never touches the real shared skills directory.
 *
 *   node scripts/test-rev4a-skills.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const hooks = `
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !/\\.\\w+$/.test(specifier)) {
    const p = new URL(specifier, context.parentURL).pathname + '.ts';
    if (existsSync(p)) return next(pathToFileURL(p).href, context);
  }
  return next(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(import.meta.dirname + '/'));
const { ensureRev4aSkill } = await import('../lib/rev4a-skills.ts');

let passed = 0;
const pending = [];
function test(name, fn) {
  const done = () => { passed++; console.log(`ok   ${name}`); };
  const fail = (e) => { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(done, fail)); else done();
  } catch (e) { fail(e); }
}

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-skills-'));
  const sourceRoot = path.join(root, 'pkg', 'rev4a-skills');
  const targetDir = path.join(root, 'shared-skills');
  fs.mkdirSync(path.join(sourceRoot, 'rev4a-demo'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'rev4a-demo', 'SKILL.md'), 'version one\n');
  return { root, dirs: { sourceRoot, targetDir }, target: path.join(targetDir, 'rev4a-demo', 'SKILL.md'), source: path.join(sourceRoot, 'rev4a-demo', 'SKILL.md') };
}

test('writes the skill when it is absent (creating the directories)', async () => {
  const s = sandbox();
  try {
    assert.equal(await ensureRev4aSkill('rev4a-demo', s.dirs), 'written');
    assert.equal(fs.readFileSync(s.target, 'utf8'), 'version one\n');
    assert.deepEqual(fs.readdirSync(path.dirname(s.target)), ['SKILL.md'], 'no temporary file left behind');
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('many deploys at once in one process: none fails, no temporary file left', async () => {
  const s = sandbox();
  try {
    fs.mkdirSync(path.dirname(s.target), { recursive: true });
    fs.writeFileSync(s.target, 'old text\n');
    const results = await Promise.allSettled(Array.from({ length: 50 }, () => ensureRev4aSkill('rev4a-demo', s.dirs)));
    assert.deepEqual(results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message), []);
    assert.equal(fs.readFileSync(s.target, 'utf8'), 'version one\n');
    assert.deepEqual(fs.readdirSync(path.dirname(s.target)), ['SKILL.md']);
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('rewrites when the content differs', async () => {
  const s = sandbox();
  try {
    await ensureRev4aSkill('rev4a-demo', s.dirs);
    fs.writeFileSync(s.source, 'version two\n');
    assert.equal(await ensureRev4aSkill('rev4a-demo', s.dirs), 'written');
    assert.equal(fs.readFileSync(s.target, 'utf8'), 'version two\n');
    fs.writeFileSync(s.target, 'edited by hand\n');
    assert.equal(await ensureRev4aSkill('rev4a-demo', s.dirs), 'written', 'a drifted copy is restored');
    assert.equal(fs.readFileSync(s.target, 'utf8'), 'version two\n');
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('does not write when the content is equal (mtime unchanged)', async () => {
  const s = sandbox();
  try {
    await ensureRev4aSkill('rev4a-demo', s.dirs);
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(s.target, old, old);
    const before = fs.statSync(s.target).mtimeMs;
    assert.equal(await ensureRev4aSkill('rev4a-demo', s.dirs), 'unchanged');
    assert.equal(fs.statSync(s.target).mtimeMs, before);
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('leaves a sibling skill (and a user skill with the same file name elsewhere) untouched', async () => {
  const s = sandbox();
  try {
    const sibling = path.join(s.dirs.targetDir, 'my-own-skill', 'SKILL.md');
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    fs.writeFileSync(sibling, 'mine\n');
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(sibling, old, old);
    const before = fs.statSync(sibling).mtimeMs;
    await ensureRev4aSkill('rev4a-demo', s.dirs);
    assert.equal(fs.readFileSync(sibling, 'utf8'), 'mine\n');
    assert.equal(fs.statSync(sibling).mtimeMs, before);
    assert.deepEqual(fs.readdirSync(s.dirs.targetDir).sort(), ['my-own-skill', 'rev4a-demo']);
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('a missing source or an unsafe name is an error and writes nothing', async () => {
  const s = sandbox();
  try {
    await assert.rejects(ensureRev4aSkill('rev4a-nothing', s.dirs), /missing from this Rev4a install/);
    for (const bad of ['../evil', 'rev4a-../x', 'mongodb', 'rev4a-', 'rev4a-A', '']) {
      await assert.rejects(ensureRev4aSkill(bad, s.dirs), /Invalid Rev4a skill name/, bad);
    }
    assert.ok(!fs.existsSync(s.dirs.targetDir));
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('an unwritable target is an error naming the directory', async () => {
  const s = sandbox();
  try {
    fs.writeFileSync(path.join(s.root, 'blocker'), 'a file, not a directory');
    await assert.rejects(ensureRev4aSkill('rev4a-demo', { ...s.dirs, targetDir: path.join(s.root, 'blocker') }), /Could not write the rev4a-demo skill/);
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('the shipped rev4a-mongodb skill deploys from the repo', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-skills-cwd-'));
  try {
    const targetDir = path.join(root, 'shared-skills');
    assert.equal(await ensureRev4aSkill('rev4a-mongodb', { sourceRoot: path.join(import.meta.dirname, '..', 'rev4a-skills'), targetDir }), 'written');
    assert.equal(fs.readFileSync(path.join(targetDir, 'rev4a-mongodb', 'SKILL.md'), 'utf8'),
      fs.readFileSync(path.join(import.meta.dirname, '..', 'rev4a-skills', 'rev4a-mongodb', 'SKILL.md'), 'utf8'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rev4a-mongodb SKILL.md: the frontmatter OpenClaw needs, and never the blocked env name', () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, '..', 'rev4a-skills', 'rev4a-mongodb', 'SKILL.md'), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'frontmatter');
  const get = (k) => new RegExp('^' + k + ': (.*)$', 'm').exec(m[1])?.[1];
  assert.equal(get('name'), 'rev4a-mongodb');
  assert.ok(get('description'));
  const meta = JSON.parse(get('metadata')).openclaw;
  assert.deepEqual(meta.requires, { bins: ['mongosh'], env: ['REV4A_MONGODB_URI'] });
  assert.equal(meta.primaryEnv, 'REV4A_MONGODB_URI');
  assert.ok(!/(^|[^_])MONGODB_URI/.test(text), 'OpenClaw drops MONGODB_URI from the exec tool');
  assert.ok(text.includes('"$REV4A_MONGODB_URI"'));
  assert.match(text, /not authorized/);
});

test('package.json ships rev4a-skills/', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('rev4a-skills/'));
});

test('bin/rev4a.js deploys every packaged skill at start, next to the rules', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'bin', 'rev4a.js'), 'utf8');
  assert.match(src, /ensureRev4aRules\(\);\s*ensureRev4aSkills\(\);/);
});

await Promise.all(pending);
console.log(`\n${passed} passed`);
