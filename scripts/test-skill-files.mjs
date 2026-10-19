#!/usr/bin/env node
/**
 * Tests for lib/skill-files.ts: the argv that writes a skill file inside a container. The
 * content goes through stdin and the path is a positional argument, so neither is ever part
 * of a shell string. The argv is also run with a local `sh` against a temporary directory.
 *
 *   node scripts/test-skill-files.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { containerSkillWriteArgv, CONTAINER_NAME_RE } from '../lib/skill-files.ts';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); } catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}

const NASTY = [
  "/w/it's/SKILL.md",
  '/w/say "hi"/SKILL.md',
  '/w/$(touch pwned)/SKILL.md',
  '/w/`touch pwned`/SKILL.md',
  '/w/with space/SKILL.md',
  '/w/new\nline/SKILL.md',
  '/w/$HOME;rm -rf x/SKILL.md',
];

test('the script is fixed and the path is exactly one argv element', () => {
  const base = containerSkillWriteArgv('/a/SKILL.md');
  for (const p of NASTY) {
    const argv = containerSkillWriteArgv(p);
    assert.equal(argv.length, base.length);
    assert.deepEqual(argv.slice(0, -1), base.slice(0, -1), 'the script does not depend on the path');
    assert.equal(argv[argv.length - 1], p);
    assert.equal(argv.filter((a) => a.includes('pwned') || a.includes('rm -rf')).length, p.includes('pwned') || p.includes('rm -rf') ? 1 : 0);
  }
});

test('the content is not part of the argv (the function does not take it)', () => {
  assert.equal(containerSkillWriteArgv.length, 1);
  assert.ok(!containerSkillWriteArgv('/a/SKILL.md').join(' ').includes('$(id)'));
});

test('run with sh: the content lands byte for byte at the odd path, nothing else runs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-files-'));
  try {
    const content = "# s\n$(touch " + root + "/pwned)\n`touch " + root + "/pwned2`\n'q' \"d\" \\ NEXUS_EOF\nend";
    for (const rel of NASTY) {
      const p = path.join(root, rel);
      const r = spawnSync(containerSkillWriteArgv(p)[0], containerSkillWriteArgv(p).slice(1), { input: content, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.readFileSync(p, 'utf8'), content);
    }
    assert.ok(!fs.existsSync(path.join(root, 'pwned')) && !fs.existsSync(path.join(root, 'pwned2')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('container name rule', () => {
  for (const ok of ['openclaw-atlas', 'a', 'Agent_1.x']) assert.ok(CONTAINER_NAME_RE.test(ok), ok);
  for (const bad of ['', '-x', '.x', 'a b', 'a;b', 'a$(x)', 'a`b`', "a'b", 'a\nb', 'a/b']) assert.ok(!CONTAINER_NAME_RE.test(bad), bad);
});

console.log(`\n${passed} passed`);
