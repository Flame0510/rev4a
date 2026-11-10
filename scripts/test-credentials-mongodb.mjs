#!/usr/bin/env node
/**
 * Tests for lib/credentials/mongodb.ts: the mongosh install check, parseSkillInfo, the order
 * of a MongoDB switch-on (version floor, mongosh, skill, store + skill entry, eligibility
 * check, rollback) with the exec primitives mocked, and the save-time check of the connection
 * string. No Docker, no network.
 *
 *   node scripts/test-credentials-mongodb.mjs
 */
import assert from 'node:assert/strict';
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
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(import.meta.dirname + '/'));
const m = await import('../lib/credentials/mongodb.ts');
const n = await import('../lib/credentials/native.ts');
const { validateSecret } = await import('../lib/credentials/providers.ts');

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

// A URI with the characters that break shells and String.replace.
const URI = 'mongodb+srv://reader:p%40ss$&w\'rd"@cluster0.example.mongodb.net/mydb?retryWrites=true&w=majority';

// ── constants ──────────────────────────────────────────────────────────────────────────

test('the pin and the argv arrays', () => {
  assert.equal(m.MONGOSH_VERSION, '2.13.0');
  assert.deepEqual(m.MONGOSH_INSTALL_ARGV, ['npm', 'install', '-g', '--prefix', '/root/.local', '--no-fund', '--no-audit', 'mongosh@2.13.0']);
  assert.deepEqual(m.SKILL_INFO_ARGV, ['openclaw', 'skills', 'info', 'rev4a-mongodb', '--json']);
  assert.equal(m.MONGOSH_INSTALL_TIMEOUT_MS, 300000);
  assert.ok(m.MONGOSH_CHECK_ARGV.join(' ').includes('/root/.local/bin/mongosh'));
  assert.ok(m.MONGOSH_CHECK_ARGV.join(' ').includes('/root/.local/lib/node_modules/mongosh/package.json'));
});

test('no Rev4a code names the env MONGODB_URI (OpenClaw drops it)', () => {
  for (const argv of [m.MONGOSH_CHECK_ARGV, m.MONGOSH_INSTALL_ARGV, m.SKILL_INFO_ARGV]) {
    assert.ok(!/(^|[^_])MONGODB_URI/.test(argv.join(' ')));
  }
});

test('parseMongoshVersion', () => {
  assert.equal(m.parseMongoshVersion('{"name":"mongosh","version":"2.13.0"}'), '2.13.0');
  assert.equal(m.parseMongoshVersion(''), '');
  assert.equal(m.parseMongoshVersion('not json'), '');
  assert.equal(m.parseMongoshVersion('{"version":2}'), '');
});

// ── parseSkillInfo ─────────────────────────────────────────────────────────────────────

test('parseSkillInfo: eligible', () => {
  assert.deepEqual(m.parseSkillInfo(JSON.stringify({ name: 'rev4a-mongodb', eligible: true, modelVisible: true, missing: { bins: [], env: [] } })),
    { eligible: true, missing: [], modelVisible: true });
});

test('parseSkillInfo: not eligible, with the missing bins and env', () => {
  const r = m.parseSkillInfo(JSON.stringify({ eligible: false, modelVisible: false, missing: { bins: ['mongosh'], env: ['REV4A_MONGODB_URI'], config: [] } }));
  assert.equal(r.eligible, false);
  assert.deepEqual(r.missing, ['mongosh', 'REV4A_MONGODB_URI']);
});

test('parseSkillInfo: garbage and wrong shapes give null', () => {
  for (const t of ['', 'nope', '{', '[]', '{"eligible":"yes"}', '{"name":"x"}', 'null', '42']) assert.equal(m.parseSkillInfo(t), null, t);
});

test('parseSkillInfo: JSON after a banner line, and pretty-printed', () => {
  const body = JSON.stringify({ eligible: true, missing: { bins: [], env: [] } }, null, 2);
  assert.equal(m.parseSkillInfo('openclaw 2026.9.9\nsome notice {braces}\n' + body + '\n').eligible, true);
  assert.equal(m.parseSkillInfo('banner: loaded\n' + body).eligible, true);
});

test('parseSkillInfo: a missing list given as an array is accepted', () => {
  assert.deepEqual(m.parseSkillInfo('{"eligible":false,"missing":["mongosh"]}').missing, ['mongosh']);
});

// ── the switch-on, with a mocked exec ──────────────────────────────────────────────────

const PKG = (v) => JSON.stringify({ name: 'mongosh', version: v });
const SKILL_OK = JSON.stringify({ eligible: true, modelVisible: true, missing: { bins: [], env: [] } });

/**
 * installed: what the check prints ('' = absent). After a successful install the check prints
 * the pinned version, unless installBroken. skillInfo: what 'skills info' prints (or an Error).
 */
function mockExec({ version = 'OpenClaw 2026.9.9 (abc)', installed = '', installFails = null, installBroken = false, skillInfo = SKILL_OK, failOn = () => false } = {}) {
  const calls = [];
  let current = installed;
  const label = (argv) => {
    if (argv[1] === '--version') return 'version';
    if (JSON.stringify(argv) === JSON.stringify(m.MONGOSH_CHECK_ARGV)) return 'check';
    if (argv[0] === 'npm') return 'install';
    if (argv[1] === 'skills') return 'skills-info';
    if (argv.includes('store') && argv.includes('set')) return 'store-set';
    if (argv.includes('store') && argv.includes('rm')) return 'store-rm';
    if (argv.includes('patch')) return 'config-patch';
    if (argv.some((a) => String(a).includes('secrets') ) || argv.includes('reload')) return 'reload';
    return argv.join(' ');
  };
  return {
    calls,
    labels: () => calls.map((c) => c.label),
    run: async (argv, env, opts) => {
      const l = label(argv); calls.push({ label: l, argv, opts, input: null });
      if (l === 'version') return version;
      if (l === 'check') return current ? PKG(current) : '';
      if (l === 'install') {
        if (installFails) throw new Error(installFails);
        if (!installBroken) current = m.MONGOSH_VERSION;
        return 'added 1 package';
      }
      if (l === 'skills-info') { if (skillInfo instanceof Error) throw skillInfo; return skillInfo; }
      if (failOn(l)) throw new Error(`exit 1 in ${l}`);
      return '';
    },
    runWithInput: async (argv, input, opts) => {
      const l = label(argv); calls.push({ label: l, argv, input, opts });
      if (failOn(l)) throw new Error(`refused ${l}: ${input}`);
      return '';
    },
  };
}

const deps = (skillCalls = []) => ({ ensureSkill: async (n) => { skillCalls.push(n); }, warn: () => {} });
const SECRET = { uri: URI };

test('first switch-on: floor, check, install, skill, store, patch, reload, skills info', async () => {
  const exec = mockExec();
  const skills = [];
  await m.enableMongodb(exec, SECRET, deps(skills));
  assert.deepEqual(exec.labels(), ['version', 'check', 'install', 'check', 'version', 'store-set', 'config-patch', 'reload', 'skills-info']);
  assert.deepEqual(skills, ['rev4a-mongodb']);
  assert.equal(exec.calls.find((c) => c.label === 'install').opts.timeoutMs, 300000);
  assert.equal(exec.calls.find((c) => c.label === 'skills-info').opts.timeoutMs, 60000);
});

test('the connection string reaches only stdin of the store write, never an argv', async () => {
  const exec = mockExec();
  await m.enableMongodb(exec, SECRET, deps());
  const set = exec.calls.find((c) => c.label === 'store-set');
  assert.equal(set.input, URI);
  assert.ok(set.argv.includes('REV4A_MONGODB_URI'));
  for (const c of exec.calls) assert.ok(!c.argv.join(' ').includes('reader'), c.label);
  const patch = JSON.parse(exec.calls.find((c) => c.label === 'config-patch').input);
  assert.deepEqual(patch.skills.entries['rev4a-mongodb'].apiKey, { source: 'store', provider: 'default', id: 'REV4A_MONGODB_URI' });
});

test('mongosh already at the pinned version: the install is skipped', async () => {
  const exec = mockExec({ installed: '2.13.0' });
  await m.enableMongodb(exec, SECRET, deps());
  assert.ok(!exec.labels().includes('install'));
  assert.deepEqual(exec.labels().slice(0, 3), ['version', 'check', 'version']);
});

test('mongosh at a different version (2.12.0): the pinned version is installed over it', async () => {
  const exec = mockExec({ installed: '2.12.0' });
  await m.enableMongodb(exec, SECRET, deps());
  assert.ok(exec.labels().includes('install'));
});

test('ensureMongosh: present / installed', async () => {
  assert.equal(await m.ensureMongosh(mockExec({ installed: '2.13.0' })), 'present');
  assert.equal(await m.ensureMongosh(mockExec()), 'installed');
});

test('a package.json without the launcher counts as absent (the check prints nothing)', async () => {
  // The check script prints the package.json only when /root/.local/bin/mongosh is executable.
  assert.match(m.MONGOSH_CHECK_ARGV[2], /^if \[ -x \/root\/\.local\/bin\/mongosh \]; then cat /);
  const exec = mockExec({ installed: '' });
  await m.ensureMongosh(exec);
  assert.ok(exec.labels().includes('install'));
});

test('install failure: error names the last 3 lines, redacted; nothing else is written, no skill deployed', async () => {
  const exec = mockExec({ installFails: `docker exec c: exit 1 — line1\nnpm ERR! one\nnpm ERR! two with ${URI}\nnpm ERR! three` });
  const skills = [];
  await assert.rejects(m.enableMongodb(exec, SECRET, deps(skills)), (e) => {
    assert.match(e.message, /^Could not install mongosh: npm ERR! one \/ npm ERR! two with \*\*\* \/ npm ERR! three$/);
    assert.ok(!e.message.includes('line1'));
    assert.ok(!e.message.includes('reader'));
    return true;
  });
  assert.deepEqual(skills, []);
  for (const l of ['store-set', 'config-patch', 'reload', 'skills-info']) assert.ok(!exec.labels().includes(l), l);
});

test('an install that "finished" (timeout resolves) but left no mongosh is an error', async () => {
  const exec = mockExec({ installBroken: true });
  await assert.rejects(m.enableMongodb(exec, SECRET, deps()), /Could not install mongosh: the install did not finish/);
  assert.ok(!exec.labels().includes('store-set'));
});

test('agent on 2026.9.8: refused before anything else runs', async () => {
  const exec = mockExec({ version: 'OpenClaw 2026.9.8 (abc)' });
  await assert.rejects(m.enableMongodb(exec, SECRET, deps()), /needs OpenClaw 2026\.9\.9 or newer/);
  assert.deepEqual(exec.labels(), ['version']);
});

test('a skill deploy failure is a switch-on error and writes nothing', async () => {
  const exec = mockExec({ installed: '2.13.0' });
  await assert.rejects(m.enableMongodb(exec, SECRET, { ensureSkill: async () => { throw new Error('Could not write the rev4a-mongodb skill'); } }), /Could not write the rev4a-mongodb skill/);
  assert.ok(!exec.labels().includes('store-set'));
});

test('ineligible skill: the switch-on fails naming what is missing, and the entries are rolled back', async () => {
  const exec = mockExec({ installed: '2.13.0', skillInfo: JSON.stringify({ eligible: false, missing: { bins: ['mongosh'], env: ['REV4A_MONGODB_URI'] } }) });
  await assert.rejects(m.enableMongodb(exec, SECRET, deps()), (e) => {
    assert.equal(e.message, 'Switched on, but OpenClaw does not load the MongoDB skill: missing mongosh, REV4A_MONGODB_URI');
    return true;
  });
  const after = exec.labels().slice(exec.labels().indexOf('skills-info') + 1);
  assert.deepEqual(after, ['store-rm', 'config-patch', 'reload'], 'the switch-off steps ran');
  const rmPatch = JSON.parse(exec.calls.filter((c) => c.label === 'config-patch').pop().input);
  assert.deepEqual(rmPatch, { skills: { entries: { 'rev4a-mongodb': null } } });
  assert.ok(!exec.labels().slice(exec.labels().indexOf('skills-info')).includes('install'), 'mongosh is not uninstalled');
});

test('unreadable skill state (garbage, or the command failing): same failure and rollback', async () => {
  for (const skillInfo of ['not json at all', new Error('docker exec c: exit 1 — boom')]) {
    const exec = mockExec({ installed: '2.13.0', skillInfo });
    await assert.rejects(m.enableMongodb(exec, SECRET, deps()), /Switched on, but OpenClaw does not load the MongoDB skill: could not read the skill state/);
    assert.deepEqual(exec.labels().slice(-3), ['store-rm', 'config-patch', 'reload']);
  }
});

test('skills info timed out: the switch-on fails but nothing is rolled back (a working credential stays)', async () => {
  const exec = mockExec({ installed: '2.13.0', skillInfo: new Error(`docker exec c: timed out — ${URI}`) });
  await assert.rejects(m.enableMongodb(exec, SECRET, deps()), (e) => {
    assert.equal(e.message, 'Switched on, but checking that OpenClaw loads the MongoDB skill timed out: retry the switch-on');
    return true;
  });
  assert.equal(exec.labels().at(-1), 'skills-info');
  assert.ok(!exec.labels().includes('store-rm'));
});

test('an install that timed out says so', async () => {
  const exec = mockExec({ installFails: 'docker exec c: timed out — npm http fetch GET 200' });
  await assert.rejects(m.enableMongodb(exec, SECRET, deps()), /^Error: Could not install mongosh: timed out: /);
});

test('a rollback that also fails says so, without the secret', async () => {
  // store-rm only runs in the rollback.
  const exec = mockExec({ installed: '2.13.0', skillInfo: '{"eligible":false,"missing":{"bins":["mongosh"]}}', failOn: (l) => l === 'store-rm' });
  await assert.rejects(m.enableMongodb(exec, SECRET, deps()), (e) => {
    assert.match(e.message, /missing mongosh\. Undoing it also failed: remove REV4A_MONGODB_URI/);
    assert.ok(!e.message.includes('reader'));
    return true;
  });
});

test('eligible but not shown to the model: still on, with a warning', async () => {
  const warnings = [];
  const exec = mockExec({ installed: '2.13.0', skillInfo: JSON.stringify({ eligible: true, modelVisible: false, missing: {} }) });
  await m.enableMongodb(exec, SECRET, { ensureSkill: async () => {}, warn: (w) => warnings.push(w) });
  assert.equal(warnings.length, 1);
  assert.ok(!exec.labels().includes('store-rm'));
});

test('a re-apply (same path) with mongosh on the volume skips the install and re-checks the skill', async () => {
  const exec = mockExec({ installed: '2.13.0' });
  await m.enableMongodb(exec, SECRET, deps());
  assert.ok(exec.labels().includes('skills-info'));
  assert.ok(!exec.labels().includes('install'));
});

test('MongoDB enable and rollback patches/reloads get the longer deadline', async () => {
  const raw = mockExec({ installed: '2.13.0', skillInfo: '{"eligible":false}' });
  const exec = raw;
  await assert.rejects(m.enableMongodb(exec, SECRET, deps()), /not eligible/);
  const reloads = raw.calls.filter((c) => ['config-patch', 'reload'].includes(c.label));
  assert.equal(reloads.length, 4, 'enable and rollback each patch and reload');
  for (const c of reloads) assert.equal(c.opts.timeoutMs, 150000, c.label);
  for (const c of raw.calls.filter((c) => ['version', 'check', 'store-set', 'store-rm'].includes(c.label))) {
    assert.equal(c.opts?.timeoutMs ?? n.NATIVE_TIMEOUT_MS, 30000, c.label);
  }
});

test('MongoDB install retains five minutes and later rollback retains full reload deadlines', async () => {
  let elapsedMs = 0;
  const raw = mockExec({ skillInfo: '{"eligible":false}' });
  const exec = {
    run: async (argv, env, opts) => {
      if (argv[0] === 'npm') {
        assert.equal(opts.timeoutMs, 300000);
        elapsedMs += 300000;
      }
      return raw.run(argv, env, opts);
    },
    runWithInput: (...args) => raw.runWithInput(...args),
  };
  await assert.rejects(m.enableMongodb(exec, SECRET, deps()), /not eligible/);
  assert.equal(elapsedMs, 300000);
  for (const c of raw.calls.filter((c) => ['config-patch', 'reload'].includes(c.label))) {
    assert.equal(c.opts.timeoutMs, 150000, c.label);
  }
});

// ── save-time validation ───────────────────────────────────────────────────────────────

test('validateSecret: only mongodb:// and mongodb+srv:// are accepted (trimmed)', () => {
  assert.equal(validateSecret('mongodb', { uri: URI }), null);
  assert.equal(validateSecret('mongodb', { uri: '  mongodb://localhost:27017/db \n' }), null);
  for (const bad of ['', '   ', 'postgres://x', 'http://example.com', 'mongodb:/x', 'Mongo://x', 'xmongodb://x']) {
    assert.match(validateSecret('mongodb', { uri: bad }) ?? '', /mongodb:\/\/ or mongodb\+srv:\/\/|is required/, bad);
  }
  assert.equal(validateSecret('mongodb', {}), 'Connection string is required');
});

test('validateSecret: a non-string value is a 400 message, never a throw', () => {
  for (const bad of [42, {}, [], true, null]) {
    assert.match(validateSecret('mongodb', { uri: bad }) ?? '', /must start with mongodb:\/\//, String(bad));
  }
  assert.equal(validateSecret('mongodb', { uri: null }, true), null);
  assert.ok(validateSecret('mongodb', { uri: 42 }, true));
  assert.ok(validateSecret('mongodb', null));
});

test('validateSecret: an edit with a blank field keeps the stored value; other providers are unchecked', () => {
  assert.equal(validateSecret('mongodb', { uri: '' }, true), null);
  assert.equal(validateSecret('mongodb', {}, true), null);
  assert.ok(validateSecret('mongodb', { uri: 'nope' }, true));
  assert.equal(validateSecret('notion', { token: 'x' }), null);
  assert.equal(validateSecret('notion', {}), null);
});

await Promise.all(pending);
console.log(`\n${passed} passed`);
