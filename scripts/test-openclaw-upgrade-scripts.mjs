#!/usr/bin/env node
/**
 * Tests for the rev4a-openclaw-upgrade skill scripts (skills/rev4a-openclaw-upgrade/scripts):
 * the pure helpers every report depends on (JSON in noisy output, shapes, redaction, flags,
 * versions, the schema lookup), compare.mjs and triage.mjs on fixture directories, the refusals
 * of snapshot.mjs that need no Docker, neutralize-backup.mjs on a fixture archive, and the
 * evidence of references/deps.json against the Rev4a code. No Docker or external network;
 * cleanup uses a loopback-only fixture API.
 *
 *   node scripts/test-openclaw-upgrade-scripts.mjs
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  UsageError, apiProblem, checkFields, compareTriage, compareVersions, diffShapes, firstJson, flattenSchema, jsonProblem, parseArgs,
  githubReleaseBodies, githubReleaseChangelog, parseMemUsage, redact, run, seededAgentCronResult, schemaLookup, shapeMap, shapeOf, stripStamps, doctorBoxes, cronJobs, assertTestAgent, versionIn, versionParts,
  snapshotSettleSample, databaseVersionsProblem, listeningPorts,
  observationWindowProblem,
  seedSkillExpected,
  usageCacheProblem,
} from '../skills/rev4a-openclaw-upgrade/scripts/lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = path.join(ROOT, 'skills', 'rev4a-openclaw-upgrade', 'scripts');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rev4a-upgrade-test-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); } catch (e) { console.error(`FAIL ${name}\n${e?.stack || e}`); process.exit(1); }
}
const node = (script, args, env = {}) => spawnSync(process.execPath, ['--no-warnings', path.join(S, script), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

await test('listening ports: Docker\'s embedded DNS (127.0.0.11) is ignored, real listeners are kept', () => {
  const proc = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0B00007F:9A9D 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1771676',
    '   1: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1771700',
    '   2: 0100007F:4A4B 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1771701',
    '   3: 00000000:0BB9 0100007F:1F90 01 00000000:00000000 00:00000000 00000000     0        0 1771702',
  ].join('\n');
  assert.deepEqual(listeningPorts(proc), [3000, 19019]);
});
await test('snapshot settle: failed CPU reads and restarted containers cannot look idle', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const old = { running: true, startedAt: '2026-11-06T11:00:00Z' };
  const gateway = { rc: 0, stdout: '{"status":"started"}' };
  const valid = { rc: 0, stdout: '0.00%\n' };
  assert.equal(snapshotSettleSample(old, gateway, valid, now).cpu, 0);
  for (const stats of [{rc:1,stdout:''},{rc:0,stdout:'garbage'},{...valid,timedOut:true}]) assert.equal(snapshotSettleSample(old,gateway,stats,now).cpu,null);
  assert.equal(snapshotSettleSample({...old,startedAt:'2026-11-06T11:59:58Z'},gateway,valid,now).uptimeS,2);
  assert.equal(snapshotSettleSample({...old,running:false},gateway,valid,now).uptimeS,null);
  assert.equal(snapshotSettleSample(old,{...gateway,rc:1},valid,now).startupz,null);
});

await test('snapshot database versions: nested read errors cannot count as successful evidence', () => {
  assert.equal(databaseVersionsProblem({'state/openclaw.sqlite':{user_version:27,tables:['sessions']}}),null);
  assert.match(databaseVersionsProblem({'state/openclaw.sqlite':{error:'database is locked'}}),/unreadable database/);
  assert.match(databaseVersionsProblem({'agent.sqlite':{tables:[]}}),/agent.sqlite/);
  assert.match(databaseVersionsProblem([]),/invalid/);
});
await test('operation observations: sleep gaps and late final replies stop before automatic continuation', () => {
  const start = Date.parse('2026-11-06T13:11:34Z');
  assert.match(observationWindowProblem({nowMs:start+815000,lastObservedAtMs:start+810000,phaseStartedAtMs:start}),/window exceeded/);
  const beforeSleep = Date.parse('2026-11-06T13:29:25Z');
  assert.match(observationWindowProblem({nowMs:Date.parse('2026-11-06T14:01:30Z'),lastObservedAtMs:beforeSleep,phaseStartedAtMs:beforeSleep,phaseLimitMs:1800000}),/observation gap/);
  assert.equal(observationWindowProblem({nowMs:start+300000,lastObservedAtMs:start+295000,phaseStartedAtMs:start}),null);
});
await test('fresh unseeded skill absence is optional, but a lost claimed seed and unknown listing are not', () => {
  const seeded={container:'agent_a',steps:{'workspace skill':{status:'ok'}}};
  assert.equal(seedSkillExpected(undefined,'agent_fresh',{skills:[]}),false);
  assert.equal(seedSkillExpected(seeded,'agent_fresh',{skills:[]}),false);
  assert.equal(seedSkillExpected(seeded,'agent_a',{skills:[]}),true);
  assert.equal(seedSkillExpected(undefined,'agent_fresh',{skills:[{name:'rev4a-upgrade-seed'}]}),true);
  assert.equal(seedSkillExpected(undefined,'agent_fresh',undefined),true);
});
await test('usage cache warming cannot certify zero historical usage as a stable baseline', () => {
  assert.match(usageCacheProblem({totals:{totalCost:0},cacheStatus:{status:'refreshing',cachedFiles:0,pendingFiles:40,staleFiles:40}}),/not fresh/);
  assert.equal(usageCacheProblem({totals:{totalCost:0},cacheStatus:{status:'fresh',pendingFiles:0,staleFiles:0}}),null);
  assert.match(usageCacheProblem({cacheStatus:{status:'fresh',pendingFiles:1,staleFiles:0}}),/pending=1/);
  assert.equal(usageCacheProblem({totals:{totalCost:1}}),null);
});

await test('seed cleanup keeps the original seed evidence and records its own result', async () => {
  const work = path.join(TMP, 'seed-cleanup');
  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const original = JSON.stringify({ container: 'agent_fixture', mode: 'seed', steps: { 'workspace skill': { status: 'ok' } } });
  fs.writeFileSync(path.join(work, 'seed.json'), original);
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
if(process.argv[2]==='inspect') console.log(JSON.stringify([{Name:'/agent_fixture',Config:{Env:['AGENT_NAME=oc-eval-fixture'],Labels:{AGENT_ID:'agent_fixture'}},State:{Running:true}}]));
else console.log('{"jobs":[]}');
`, { mode: 0o755 });
  const requests = [];
  const server = http.createServer((req, res) => { requests.push(req.method+' '+req.url); res.setHeader('Content-Type','application/json'); res.end('{"success":true}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(S,'seed.mjs'),'--container','agent_fixture','--cleanup','--work',work,'--base-url',`http://127.0.0.1:${server.address().port}`], {
        env: { ...process.env, PATH: bin+path.delimiter+process.env.PATH, REV4A_JWT_SECRET:'unit-test-signing-secret-only' }, stdio:'ignore', // secret-ok: loopback fixture signing value
      });
      child.on('error',reject); child.on('exit',resolve);
    });
    assert.equal(code,0);
    assert.equal(fs.readFileSync(path.join(work,'seed.json'),'utf8'),original);
    assert.equal(JSON.parse(fs.readFileSync(path.join(work,'seed-cleanup.json'))).mode,'cleanup');
    assert.deepEqual(requests,['DELETE /api/agents/agent_fixture/channels/telegram']);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

await test('seed agent cron: failed turns with session ids and stale prior successes never pass', () => {
  const old = {runId:'old',sessionId:'s1',action:'finished',status:'ok',runAtMs:1};
  const failed = {runId:'new',sessionId:'s2',action:'finished',status:'error',completionStatus:'failed',error:'Insufficient Balance'};
  assert.deepEqual(seededAgentCronResult([failed,old],[old]), {status:'fail',detail:'Insufficient Balance'});
  assert.equal(seededAgentCronResult([old],[old]).status, 'pending');
  assert.equal(seededAgentCronResult([{...old,runId:'new',status:'ok'}],[old]).status, 'ok');
  assert.equal(seededAgentCronResult([{...failed,error:undefined,status:'ok'}],[old]).status, 'fail');
  assert.equal(seededAgentCronResult([{...old,runId:'new',status:undefined}],[old]).status, 'fail');
  assert.equal(seededAgentCronResult([{...old,runId:'new',action:'started'}],[old]).status, 'pending');
});

await test('run: a silent command timeout retains a diagnostic instead of an empty error', () => {
  const result = run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 });
  assert.equal(result.rc, -1);
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /timed out after 200 ms/);
  assert.match(result.out, /timed out after 200 ms/);
  const ordinaryFailure = run(process.execPath, ['-e', 'process.exit(1)']);
  assert.equal(ordinaryFailure.rc, 1);
  assert.equal(ordinaryFailure.stderr, '');
});

await test('GitHub notes: old gh API pagination preserves hotfix bodies and rejects failed or malformed reads', () => {
  const dir = path.join(TMP, 'gh-api');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'gh'), `#!${process.execPath}
if (process.argv[2] !== 'api') process.exit(9);
if (process.env.FAKE_GH_MODE === 'failure') { console.error('network unavailable'); process.exit(1); }
if (process.env.FAKE_GH_MODE === 'malformed') { console.log('{"message":"not a list"}'); process.exit(0); }
if (process.argv[3].includes('/contents/')) {
  if (!process.argv[3].endsWith('?ref=v2026.10.10')) process.exit(8);
  console.log(JSON.stringify({encoding:'base64',content:Buffer.from('## 2026.10.10\\nBreaking: retired jobs.').toString('base64')}));
  process.exit(0);
}
const page = Number(process.argv[3].match(/page=(\\d+)$/)[1]);
console.log(JSON.stringify(page < 3 ? Array.from({length:100}, (_,i) => ({tag_name:'v2026.10.'+(i+11),body:'body '+i})) : [{tag_name:'v2026.10.10-1',body:'hotfix body'},{tag_name:'v2026.10.10',body:null}]));
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  const oldMode = process.env.FAKE_GH_MODE;
  try {
    process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
    delete process.env.FAKE_GH_MODE;
    const releases = githubReleaseBodies();
    assert.equal(releases.length, 202);
    assert.deepEqual(releases[200], {tag:'v2026.10.10-1',body:'hotfix body'});
    assert.equal(releases[201].body, '');
    assert.equal(githubReleaseChangelog('v2026.10.10', 'ordinary body'), null);
    assert.throws(() => githubReleaseChangelog('v2026.10.10', ''), /empty body.*unverified/);
    const wrapper = '<!-- openclaw-release-publication:docs-v1 -->\nhttps://raw.githubusercontent.com/openclaw/openclaw/main/CHANGELOG/2026.10.10.md';
    assert.match(githubReleaseChangelog('v2026.10.10', wrapper), /Breaking: retired jobs/);
    assert.throws(() => githubReleaseChangelog('v2026.10.10', '<!-- openclaw-release-publication:docs-v1 -->'), /recognized changelog/);
    process.env.FAKE_GH_MODE = 'failure';
    assert.throws(githubReleaseBodies, /network unavailable/);
    assert.throws(() => githubReleaseChangelog('v2026.10.10', wrapper), /network unavailable/);
    process.env.FAKE_GH_MODE = 'malformed';
    assert.throws(githubReleaseBodies, /unexpected release list/);
  } finally {
    process.env.PATH = oldPath;
    if (oldMode === undefined) delete process.env.FAKE_GH_MODE; else process.env.FAKE_GH_MODE = oldMode;
  }
});

// ── parseArgs ──────────────────────────────────────────────────
await test('parseArgs: a value flag without a value, or an unknown flag, is a usage error', () => {
  const spec = { out: 'string', force: 'boolean' };
  assert.throws(() => parseArgs(['--out'], spec), UsageError);
  assert.throws(() => parseArgs(['--out', '--force'], spec), UsageError);
  assert.throws(() => parseArgs(['--nope'], spec), UsageError);
  assert.throws(() => parseArgs(['--force=1'], spec), UsageError);
  assert.deepEqual(parseArgs(['a', '--out=x.md', '--force', 'b'], spec), { _: ['a', 'b'], out: 'x.md', force: true });
});

// ── firstJson ──────────────────────────────────────────────────
await test('firstJson: a log line with JSON after the real value does not win (A3)', () => {
  assert.deepEqual(firstJson('{"jobs":[1]}\n[gateway] worker startup state: {"workerCount":8}'), { jobs: [1] });
  assert.deepEqual(firstJson('{\n  "ok": true,\n  "jobs": []\n}\nhint: run {openclaw doctor}'), { ok: true, jobs: [] });
  assert.deepEqual(firstJson('[]\n(node:7) state {"warn":1}'), []);
  assert.deepEqual(firstJson('banner [x]\n{"a":"a } inside ] a string"}\n'), { a: 'a } inside ] a string' });
  assert.deepEqual(firstJson('Config warnings: {}\n{"plugins":[{"id":"x"}]}'), { plugins: [{ id: 'x' }] });
  assert.equal(firstJson('no json here'), undefined);
  assert.equal(firstJson(''), undefined);
});
await test('firstJson: linear on unparsable input', () => {
  const t = Date.now();
  firstJson('{'.repeat(210_000));
  firstJson('['.repeat(100_000) + ']'.repeat(100_000));
  assert.ok(Date.now() - t < 2000, `took ${Date.now() - t} ms`);
});
await test('jsonProblem: ok:false or a top-level error is a failure even with exit 0', () => {
  assert.match(jsonProblem({ ok: false, error: { message: 'Control UI dashboard is unavailable' } }), /ok:false.*unavailable/);
  assert.match(jsonProblem({ error: 'Unauthorized' }), /Unauthorized/);
  assert.equal(jsonProblem({ ok: true, error: null }), null);
  assert.equal(jsonProblem([{ error: 'x' }]), null);
});

// ── Shapes ─────────────────────────────────────────────────────
await test('shapeOf: container names, account ids, emails and dates are data keys (A8)', () => {
  const lines = shapeOf({ agent_c298a411: { telegram: 1 }, 'openai:user@x.io': {}, '2026-11-04': 1, 'telegram:default': 2, plain: true });
  assert.ok(lines.includes('$.<key>.telegram: number'));
  assert.ok(!lines.some((l) => /agent_c298a411|openai:|2026-11-04|telegram:default/.test(l)));
  assert.ok(lines.includes('$.plain: boolean'));
  assert.deepEqual(shapeOf({ a: [1, null] }), ['$.a: array', '$.a[]: null|number', '$: object']);
});
await test('diffShapes: null merges, an empty array is not a removal, retyped is not also widened (A8)', () => {
  const a = shapeMap({ paired: [{ deviceId: 'd', role: 'op' }], ip: 'x', n: 1, o: { p: 1 } });
  const b = shapeMap({ paired: [], ip: null, n: 'one', o: 'gone' });
  const d = diffShapes(a, b);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.widened, []);
  assert.deepEqual(d.retyped.map((r) => r.path).sort(), ['$.n', '$.o']);
  assert.ok(d.notComparable.some((x) => x.path === '$.paired[].deviceId'));
  assert.ok(d.notComparable.some((x) => x.path === '$.ip'));
  const d2 = diffShapes(shapeMap({ x: { gone: { deep: 1 } }, keep: 1 }), shapeMap({ x: { other: 1 }, keep: 1 }));
  assert.deepEqual(d2.removed.map((r) => [r.path, r.paths]), [['$.x.gone', 2]]);
  assert.deepEqual(d2.added.map((r) => r.path), ['$.x.other']);
});
await test('checkFields: lost, not comparable, absent, optional and failed items are told apart', () => {
  const fields = [
    { id: 'J7', item: 'dev', paths: ['$.paired[].deviceId', '$.missing'] },
    { id: 'J9', item: 'plug', optional: true, paths: ['$.x'] },
    { id: 'J8', item: 'dash', paths: ['$.ok'] },
  ];
  const A = new Map([['dev', shapeMap({ paired: [{ deviceId: 1 }], missing: 1 })], ['plug', shapeMap({})]]);
  const B = new Map([['dev', shapeMap({ paired: [] })], ['plug', shapeMap({})]]);
  const r = Object.fromEntries(checkFields(fields, B, A).map((f) => [f.path, f.status]));
  assert.deepEqual(r, { '$.paired[].deviceId': 'not-comparable', '$.missing': 'lost', '$.x': 'optional-absent', '$.ok': 'no-item' });
});
await test('agent cron usage fields read the seeded agent-run item, not the command cron', () => {
  const deps=JSON.parse(fs.readFileSync(path.join(S,'../references/deps.json'),'utf8'));
  const fields=deps.fields.filter(f=>f.id==='J5'&&f.needsSeed==='agent-cron');
  const shapes=new Map([
    ['cli.cron-runs',shapeMap({entries:[{action:'finished',status:'ok'}]})],
    ['cli.cron-runs-agent',shapeMap({entries:[{sessionId:'s',sessionKey:'agent:main:cron:s',usage:{input_tokens:10,output_tokens:2},model:'m',provider:'p'}]})],
  ]);
  assert.equal(fields.length,1);
  assert.ok(checkFields(fields,shapes,shapes).every(f=>f.status==='present'));
});

// ── Small helpers ──────────────────────────────────────────────
await test('redact: env-style names, Bearer headers and key formats are masked; ids Rev4a reads back are not', () => {
  const t = redact('{"TRELLO_API_KEY":"0123456789","declarationKey":"heartbeat:main","sessionKey":"agent:main:main"}\n'
    + 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstu\n"Authorization":"Bearer sk-or-v1-abcdefghijklmnop"\nx ghp_abcdefghijklmnopqrstuvwxyz0123\n' // secret-ok: deliberately fake redaction fixtures
    + '{"botToken":"123456789:AAFakeTokenForRev4aUpgradeSeedOnly_x"}');
  assert.ok(!/0123456789"|sk-abc|sk-or-v1|ghp_|AAFake/.test(t), t);
  assert.match(t, /"declarationKey":"heartbeat:main"/);
  assert.match(t, /"sessionKey":"agent:main:main"/);
  const navigationError = 'page.goto: net::ERR_CONNECTION_RESET at http://localhost:4500/#token=fixture-local-gateway-123456789\n'
    + '  navigating to "http://localhost:4500/#token=fixture-local-gateway-123456789"';
  assert.ok(!redact(navigationError).includes('fixture-local-gateway-123456789'));
});
await test('compareVersions: a -N hotfix is a fourth part (issue 33)', () => {
  assert.ok(compareVersions('2026.10.10-1', '2026.10.10') > 0);
  assert.ok(compareVersions('2026.10.14-1', '2026.10.14') > 0);
  assert.ok(compareVersions('v2026.10.9', '2026.10.10') < 0);
  assert.equal(compareVersions('2026.10.10', 'v2026.10.10'), 0);
});
await test('versionParts parses a whole version only; versionIn finds one inside a text', () => {
  assert.deepEqual(versionParts('2026.10.10-1'), [2026, 10, 10, 1]);
  for (const bad of ['x2026.10.10', '2026.10.100', '2026.10.10-beta', 'OpenClaw 2026.10.10', '']) assert.equal(versionParts(bad), null, bad);
  assert.equal(versionIn('OpenClaw 2026.10.10 (1391f7c)'), '2026.10.10');
  assert.equal(versionIn('OpenClaw 2026.10.10-2'), '2026.10.10-2');
  assert.equal(versionIn('no version'), null);
});
await test('parseMemUsage, stripStamps, doctorBoxes, cronJobs', () => {
  assert.deepEqual(parseMemUsage('1.871GiB / 3GiB'), { usedMb: 1916, limitMb: 3072 });
  assert.deepEqual(parseMemUsage('512MiB / 2GiB'), { usedMb: 512, limitMb: 2048 });
  assert.equal(stripStamps('2026-11-04T19:53:19.011Z 2026-11-04T20:53:57.428+01:00 [gateway] x'), '[gateway] x');
  const box = doctorBoxes(['a', '◇  Doctor changes ───╮', '│  Removed X  │', '╰───╯', 'b']);
  assert.deepEqual(box.slice(0, 4), ['◇  Doctor changes ───╮', '│  Removed X  │', '╰───╯', '']);
  assert.deepEqual(cronJobs([{ id: 1 }]), [{ id: 1 }]);
  assert.deepEqual(cronJobs({ jobs: [{ id: 2 }] }), [{ id: 2 }]);
  assert.deepEqual(cronJobs(undefined), []);
});
await test('assertTestAgent: only oc-eval agents, unless the caller owns it', () => {
  assert.doesNotThrow(() => assertTestAgent({ name: 'agent_1', displayName: 'oc-eval-candidate' }, {}));
  assert.doesNotThrow(() => assertTestAgent({ name: 'agent_1', displayName: 'oc-eval' }, {}));
  assert.throws(() => assertTestAgent({ name: 'agent_1', displayName: 'support-bot' }, {}), UsageError);
  assert.throws(() => assertTestAgent({ name: 'agent_1', displayName: 'oc-evaluation' }, {}), UsageError);
  const err = console.error; console.error = () => {};
  try { assert.doesNotThrow(() => assertTestAgent({ name: 'agent_1', displayName: 'mine' }, { 'i-own-this-agent': true })); } finally { console.error = err; }
});

// ── Schema ─────────────────────────────────────────────────────
const schemaA = {
  type: 'object', additionalProperties: false, properties: {
    hooks: { type: 'object', properties: { internal: { type: 'object', properties: { entries: { type: 'object', additionalProperties: { type: 'object', properties: { enabled: { type: 'boolean' } }, additionalProperties: {} } } } } } },
    mode: { type: 'string', enum: ['a', 'b'], default: 'a' },
    old: { type: 'object', properties: { key: { type: 'string' } } },
    queue: { type: 'object', properties: { telegram: { type: 'string' }, discord: { type: 'string' }, irc: { type: 'string' }, slack: { type: 'string' } } },
    ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, { type: 'string' }])),
  },
};
const schemaB = JSON.parse(JSON.stringify(schemaA));
delete schemaB.properties.old;
schemaB.properties.mode = { type: 'string', enum: ['a'], default: 'a' };
schemaB.properties.queue = { type: 'object', additionalProperties: { type: 'string' } };
await test('schemaLookup: an open object accepts the paths below it, unchecked (A10)', () => {
  const m = flattenSchema(schemaA);
  assert.equal(schemaLookup(m, 'hooks.internal.entries.bootstrap-extra-files.enabled').status, 'map');
  const open = schemaLookup(m, 'hooks.internal.entries.bootstrap-extra-files.paths[]');
  assert.equal(open.status, 'open');
  assert.equal(open.at, 'hooks.internal.entries.<key>');
  assert.equal(schemaLookup(m, 'nothing.here').status, 'missing');
  assert.equal(schemaLookup(m, 'mode').status, 'named');
});
await test('schema-diff.mjs offline: removed, options lost, per-channel keys grouped, config leaves', () => {
  const fa = path.join(TMP, 'sa.json'); const fb = path.join(TMP, 'sb.json'); const cfg = path.join(TMP, 'cfg.json');
  fs.writeFileSync(fa, JSON.stringify(schemaA)); fs.writeFileSync(fb, JSON.stringify(schemaB));
  fs.writeFileSync(cfg, JSON.stringify({ old: { key: 'x' }, hooks: { internal: { entries: { 'bootstrap-extra-files': { enabled: true, paths: ['.rev4a/*.md'] } } } }, k1: '<redacted>' }));
  const r = node('schema-diff.mjs', ['--from-schema', fa, '--to-schema', fb, '--config', cfg, '--out', path.join(TMP, 'sd', 'schema-diff.md')]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(fs.readFileSync(path.join(TMP, 'sd', 'schema-diff.json'), 'utf8'));
  assert.deepEqual(j.removed, ['old']);
  assert.deepEqual(j.changed.map((c) => [c.path, c.optionsLost]), [['mode', ['"b"']]]);
  assert.deepEqual(j.viaMap, [{ parent: 'queue', keys: ['discord', 'irc', 'slack', 'telegram'] }]);
  assert.deepEqual(j.config.unknownInTo, ['old.key']);
  assert.deepEqual(j.config.unchecked, ['hooks.internal.entries.bootstrap-extra-files.paths[]']);
  assert.deepEqual(j.config.redacted, ['k1']);
  assert.equal(j.config.validate.ran, false);
});

// ── Refusals that need no Docker ───────────────────────────────
await test('scripts refuse an output inside a git tree, a non-empty snapshot dir, and a missing value', () => {
  const inRepo = node('schema-diff.mjs', ['--from-schema', path.join(TMP, 'sa.json'), '--to-schema', path.join(TMP, 'sb.json'), '--out', path.join(ROOT, 'schema-diff.md')]);
  assert.equal(inRepo.status, 1);
  assert.match(inRepo.stderr, /inside the git tree/);
  assert.ok(!fs.existsSync(path.join(ROOT, 'schema-diff.md')));
  const busy = path.join(TMP, 'busy'); fs.mkdirSync(busy); fs.writeFileSync(path.join(busy, 'x.raw'), 'old');
  const bin = path.join(TMP, 'no-docker'); fs.mkdirSync(bin);
  const touched = path.join(bin, 'called');
  fs.writeFileSync(path.join(bin, 'docker'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(touched)}, 'called'); process.exit(1);\n`, {mode:0o755});
  const r = node('snapshot.mjs', ['--container', 'agent_x', '--label', 'after', '--out', busy, '--work', path.join(TMP, 'w')], {PATH:`${bin}${path.delimiter}${process.env.PATH}`});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not empty/);
  assert.ok(!fs.existsSync(touched), 'a non-empty destination is refused before any Docker call');
  const forced = node('snapshot.mjs', ['--container','agent_x','--label','after','--out',busy,'--force','--work',path.join(TMP,'w')], {PATH:`${bin}${path.delimiter}${process.env.PATH}`});
  assert.equal(forced.status,2);
  assert.equal(fs.readFileSync(path.join(busy,'x.raw'),'utf8'),'old','failed inspection must preserve previous evidence even with --force');
  assert.equal(node('snapshot.mjs', ['--container', 'agent_x', '--label']).status, 1);
  assert.equal(node('release-diff.mjs', ['--from', '2026.9.9', '--to', 'x']).status, 1);
});

// ── compare.mjs on fixtures ────────────────────────────────────
function snapshot(dir, { ok = true, items }) {
  fs.mkdirSync(dir, { recursive: true });
  const index = { formatVersion: 2, container: 'agent_aaaaaaaa', label: path.basename(dir), takenAt: '2026-11-04T10:00:00.000Z', complete: true, ok, problems: [], items: [] };
  for (const [name, value, extra = {}] of items) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    fs.writeFileSync(path.join(dir, `${name}.raw`), text);
    const json = typeof value !== 'string';
    index.items.push({ name, ok: extra.ok ?? true, rc: extra.rc ?? 0, json, empty: json && Object.keys(value).length === 0, ...extra });
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  return dir;
}
const baseItems = (devices, cron) => [
  ['runtime.version', 'OpenClaw 2026.10.10'],
  ['cli.cron-list', { jobs: cron }],
  ['cli.devices-list', { pending: [], paired: devices }],
  ['cli.dashboard', { ok: false, error: { message: 'request timed out' } }, { ok: false, problem: 'ok:false (request timed out)' }],
  ['api.update', { update: { status: 'done' } }],
];
await test('compare.mjs refuses a failed snapshot, then reports what failed on both sides (A1)', () => {
  const a = snapshot(path.join(TMP, 'c1', 'a'), { ok: false, items: baseItems([], []) });
  const b = snapshot(path.join(TMP, 'c1', 'b'), { items: baseItems([], []) });
  const out = path.join(TMP, 'c1', 'compare.md');
  assert.equal(node('compare.mjs', [a, b, '--out', out]).status, 2);
  const r = node('compare.mjs', [a, b, '--out', out, '--allow-incomplete']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(fs.readFileSync(out.replace(/md$/, 'json'), 'utf8'));
  assert.deepEqual(j.itemsFailingBoth.map((x) => x.name), ['cli.dashboard']);
  assert.ok(j.triage.some((t) => t.level === 'unverified' && /cli\.dashboard/.test(t.text)));
  assert.match(fs.readFileSync(out, 'utf8'), /Failing in both snapshots/);
});
await test('compare.mjs reads only the items in index.json, never stale files (A2)', () => {
  const a = snapshot(path.join(TMP, 'c2', 'a'), { items: [...baseItems([], []), ['cli.cron-runs', { entries: [{ sessionId: 's' }] }]] });
  const b = snapshot(path.join(TMP, 'c2', 'b'), { items: baseItems([], []) });
  fs.writeFileSync(path.join(b, 'cli.cron-runs.raw'), JSON.stringify({ entries: [{ sessionId: 's' }] }));
  fs.writeFileSync(path.join(b, 'cli.cron-runs.shape'), '$.entries[].sessionId: string\n');
  const out = path.join(TMP, 'c2', 'compare.md');
  assert.equal(node('compare.mjs', [a, b, '--out', out]).status, 0);
  const j = JSON.parse(fs.readFileSync(out.replace(/md$/, 'json'), 'utf8'));
  assert.deepEqual(j.onlyIn.a, ['cli.cron-runs']);
});
await test('compare.mjs: an empty device list is "not comparable", a gone OpenClaw-owned job is named (A8)', () => {
  const owned = { id: 'r', name: 'skill-collection-review-main', declarationKey: 'skill-collection-review:main' };
  const a = snapshot(path.join(TMP, 'c3', 'a'), { items: baseItems([{ deviceId: 'd', role: 'operator', platform: 'web' }], [{ id: '1', name: 'rev4a-upgrade-seed' }, owned]) });
  const b = snapshot(path.join(TMP, 'c3', 'b'), { items: baseItems([], [{ id: '1', name: 'rev4a-upgrade-seed' }]) });
  const out = path.join(TMP, 'c3', 'compare.md');
  const result = node('compare.mjs', [a, b, '--out', out]);
  assert.equal(result.status, 0, result.stderr);
  const j = JSON.parse(fs.readFileSync(out.replace(/md$/, 'json'), 'utf8'));
  assert.deepEqual(j.shape['cli.devices-list']?.removed ?? [], []);
  assert.equal(j.fields.lost.filter((f) => f.item === 'cli.devices-list').length, 0);
  assert.deepEqual(j.cron.owned.gone, ['skill-collection-review-main [skill-collection-review:]']);
  assert.deepEqual(j.cron.user.gone, []);
});
await test('compare.mjs: a field Rev4a parses that disappears is a blocker candidate with its inventory id', () => {
  const a = snapshot(path.join(TMP, 'c4', 'a'), { items: [...baseItems([], []), ['cli.plugins-list', { plugins: [{ id: 'x', channelIds: ['t'] }] }]] });
  const b = snapshot(path.join(TMP, 'c4', 'b'), { items: [...baseItems([], []), ['cli.plugins-list', { plugins: [{ id: 'x', channels: ['t'] }] }]] });
  const out = path.join(TMP, 'c4', 'compare.md');
  assert.equal(node('compare.mjs', [a, b, '--out', out]).status, 0);
  const j = JSON.parse(fs.readFileSync(out.replace(/md$/, 'json'), 'utf8'));
  assert.ok(j.fields.lost.some((f) => f.id === 'J9' && f.path === '$.plugins[].channelIds'));
  assert.ok(j.triage.some((t) => t.level === 'blocker-candidate' && /J9/.test(t.text)));
});

// ── triage.mjs on fixture JSON ─────────────────────────────────
const GO_HISTORY = '# History\n\n## 2026.9.9 → 2026.10.10 (OC-10)\n\n**Verdict:** go\n';
function triageWork(name, { rd = {}, sd = {}, deps = {}, cmp, manual, history = GO_HISTORY } = {}) {
  const w = path.join(TMP, 'tr', name);
  fs.mkdirSync(w, { recursive: true });
  const cleanRd = {
    from: '2026.10.10', to: '2026.10.14', distTags: { latest: '2026.10.14' }, engines: { from: '>=24', to: '>=24' }, floors: { from: 'none', to: 'none' },
    schemaVersions: [{ name: 'OPENCLAW_AGENT_SCHEMA_VERSION', from: [27], to: [27], changed: false }], bundledSkills: { removed: [] }, bundledPlugins: { removed: [] },
    codex: { from: { version: '2026.10.10', peer: '>=2026.10.10', codex: '0.164.0' }, to: { version: '2026.10.14', peer: '>=2026.10.10', codex: '0.164.0' }, changed: false },
    cliRev4a: [], paramFields: { gone: [], changed: [] }, internals: [{ name: 'f', found: true, exported: true, deprecated: null, deprecationNew: false }],
    constants: { new: [], changed: [], gone: [] }, behaviour: [], notes: { fetched: true, bodies: ['v2026.10.14'], hits: [] },
  };
  const cleanDeps = { configKeys: [{ id: 'KW1', path: 'a', result: 'ok' }], cli: [{ command: 'openclaw cron list', docs: { result: 'ok' } }], legacy: [], internals: [] };
  if (rd !== null) fs.writeFileSync(path.join(w, 'release-diff.json'), JSON.stringify({ ...cleanRd, ...rd }));
  fs.writeFileSync(path.join(w, 'schema-diff.json'), JSON.stringify({ removed: [], changed: [], ...sd }));
  if (deps !== null) fs.writeFileSync(path.join(w, 'rev4a-deps.json'), JSON.stringify({ ...cleanDeps, ...deps }));
  if (cmp) fs.writeFileSync(path.join(w, 'compare.json'), JSON.stringify(cmp));
  if (manual) fs.writeFileSync(path.join(w, 'manual.json'), JSON.stringify(manual));
  fs.writeFileSync(path.join(w, 'versions.json'), JSON.stringify({ supported: [{ version: '2026.10.10', imageRevision: 'abc1234' }] }));
  fs.writeFileSync(path.join(w, 'history.md'), history);
  const r = node('triage.mjs', ['--work', w, '--versions-file', path.join(w, 'versions.json'), '--history-file', path.join(w, 'history.md')]);
  const j = fs.existsSync(path.join(w, 'triage.json')) ? JSON.parse(fs.readFileSync(path.join(w, 'triage.json'), 'utf8')) : null;
  return { r, j };
}
const cleanCompare = {
  a: { trust: [], version: 'OpenClaw 2026.10.10 (abc1234)' }, b: { trust: [], version: 'OpenClaw 2026.10.14 (def5678)' }, warnings: [], update: { status: 'done' }, itemsChanged: [], itemsFailingBoth: [], fields: { lost: [] }, shape: {},
  cron: { user: { gone: [] }, owned: { gone: [] } }, tables: { gone: [] }, plugins: { gone: [] }, dbVersions: [{ file: 'state/openclaw.sqlite', a: 22, b: 22 }],
  memory: { a: { usedMb: 1200, restarts: 0 }, b: { usedMb: 1250, restarts: 0, oomKilled: false } }, logs: { newNotable: [] },
};
await test('triage: a clean static set allows the minor track so far, with the live triggers open', () => {
  const { r, j } = triageWork('static-clean');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(j.verdict, 'minor-so-far');
  assert.deepEqual(j.open, ['T12', 'T13', 'T14', 'T15']);
});
await test('triage: every trigger answered and clean → minor; a memory jump → full (T14)', () => {
  const sd = { config: { unknownInTo: [], validate: { ran: true, rc: 0, judgedIssues: 0 } } };
  const ok = triageWork('live-clean', { sd, cmp: cleanCompare, manual: { startupMs: { from: 40000, to: 42000 }, dmesgOom: false } });
  assert.equal(ok.r.status, 0, ok.r.stdout + ok.r.stderr);
  assert.equal(ok.j.verdict, 'minor');
  const mem = triageWork('live-mem', { sd, cmp: { ...cleanCompare, memory: { a: { usedMb: 1000, restarts: 0 }, b: { usedMb: 1500, restarts: 0 } } }, manual: { startupMs: { from: 40000, to: 42000 }, dmesgOom: false } });
  assert.equal(mem.r.status, 3);
  assert.deepEqual(mem.j.escalate, ['T14']);
});
await test('triage: historical 2 GiB escalation stays explicit after the UI constant is removed', () => {
  const sd = { config: { unknownInTo: [], validate: { ran: true, rc: 0, judgedIssues: 0 } } };
  for (const [usedMb, escalates] of [[1433, false], [1434, true]]) {
    const { j } = triageWork('historical-memory-' + usedMb, { sd,
      cmp: { ...cleanCompare, memory: { a: { usedMb }, b: { usedMb, oomKilled: false } } },
      manual: { startupMs: { from: 40000, to: 42000 }, dmesgOom: false } });
    assert.equal(j.escalate.includes('T14'), escalates);
    if (escalates) assert.match(JSON.stringify(j), /historical warning baseline 2048 MB/);
    assert.doesNotMatch(JSON.stringify(j), /COMFORTABLE_MB/);
  }
});
await test('triage: a removed schema path, a new RETIRED_ constant or unread notes escalate (exit 3)', () => {
  const { r, j } = triageWork('static-bad', { sd: { removed: ['skills.workshop.approvalPolicy'] }, rd: { constants: { new: [{ name: 'RETIRED_X' }], changed: [], gone: [] }, notes: { fetched: false, reason: 'not fetched: --offline' } } });
  assert.equal(r.status, 3);
  assert.deepEqual(j.escalate, ['T2', 'T6', 'T10']);
});
await test('triage T15: a fast idle create cannot hide slow measured startup under load', () => {
  const sd = { config: { unknownInTo: [], validate: { ran: true, rc: 0, judgedIssues: 0 } } };
  const manual = { startupMs: { from: 17208, to: 12879 }, startupUnderLoadMs: { from: 139144, to: 175712 }, dmesgOom: false };
  const slow = triageWork('startup-load', { sd, cmp: cleanCompare, manual });
  assert.equal(slow.r.status, 3);
  assert.deepEqual(slow.j.escalate, ['T15']);
  assert.match(slow.j.rows.find(r=>r.id==='T15').proof.join(' '), /under load: 139144 → 175712/);
  const incomplete = triageWork('startup-load-incomplete', { sd, cmp: cleanCompare, manual: { ...manual, startupUnderLoadMs: { from: 139144 } } });
  assert.equal(incomplete.j.rows.find(r=>r.id==='T15').result, 'unverified');
});
await test('triage: a new release line escalates (P2); a missing static input is exit 2', () => {
  assert.deepEqual(triageWork('line', { rd: { to: '2026.11.2', distTags: { latest: '2026.11.2' } } }).j.escalate, ['P2', 'P3']);
  assert.equal(triageWork('missing', { deps: null }).r.status, 2);
});

// ── triage T13: compare.json's blocker candidates (one source: lib.mjs compareTriage) ──
const liveSd = { config: { unknownInTo: [], validate: { ran: true, rc: 0, judgedIssues: 0 } } };
const liveManual = { startupMs: { from: 40000, to: 42000 }, dmesgOom: false };
const blockerKinds = [
  ['an item that now fails', { itemsChanged: [{ name: 'cli.devices-list', a: 'ok', b: 'rc 1' }] }, /cli\.devices-list now fails/],
  ['a parsed field lost', { fields: { lost: [{ id: 'J9', item: 'cli.plugins-list', path: '$.plugins[].channelIds' }] } }, /J9/],
  ['an inventory path retyped', { shape: { 'cli.cron-list': { removed: [], retyped: [{ path: '$.jobs[].enabled', from: ['boolean'], to: ['string'], inventory: ['C2'] }], widened: [], added: [] } } }, /C2.*retyped/],
  ['a user cron job gone', { cron: { user: { gone: ['rev4a-upgrade-seed'] }, owned: { gone: [] } } }, /User cron jobs gone/],
  ['a database gone', { dbVersions: [{ file: 'state/openclaw.sqlite', a: 22, b: null, gone: true }] }, /database state\/openclaw\.sqlite gone/],
  ['a restart', { memory: { a: { usedMb: 1200, restarts: 0 }, b: { usedMb: 1250, restarts: 1, oomKilled: false } } }, /Restarts 0 → 1/],
  ['a workspace skill gone', { workspaceSkills: { gone: ['rev4a-upgrade-seed'] } }, /Workspace skills gone/],
  ['a past day\'s cost changed', { costsChanged: [{ date: '2026-11-01', a: 1, b: 0 }] }, /Cost of days before the update/],
  ['a port outside the published block', { listeners: { outsideBlockB: [18789] } }, /Listening outside 3000-3009: 18789/],
  ['memory at 90 % of the limit', { memory: { a: { usedMb: 1200, restarts: 0 }, b: { usedMb: 1250, limitMb: 1300, pct: 96, restarts: 0, oomKilled: false } } }, /Memory in B at 96%/],
  ['a Rev4a API answer with an error in B', { api: [{ item: 'api.model', a: '{"reachable":true}', b: '{"reachable":false,"error":"x"}' }] }, /api\.model answers differently in B/],
];
for (const [kind, extra, re] of blockerKinds) {
  await test(`triage T13: ${kind} in compare.json escalates (B1)`, () => {
    assert.ok(compareTriage({ ...cleanCompare, ...extra }).some((x) => x.level === 'blocker-candidate'), 'compareTriage marks it a blocker candidate');
    const { r, j } = triageWork(`t13-${kind.replace(/\W+/g, '-')}`, { sd: liveSd, cmp: { ...cleanCompare, ...extra }, manual: liveManual });
    assert.equal(r.status, 3, r.stdout + r.stderr);
    const t13 = j.rows.find((x) => x.id === 'T13');
    assert.equal(t13.result, 'full');
    assert.ok(t13.proof.some((p) => re.test(p)), t13.proof.join(' / '));
  });
}
await test('triage T13: failing in both, not exercised and absent fields are `unverified`, not ok (B1)', () => {
  const extra = { itemsFailingBoth: [{ name: 'cli.dashboard', a: 'x', b: 'x' }], notExercised: [{ name: 'api.model' }], fields: { lost: [], absent: [{ id: 'M1' }] } };
  const { r, j } = triageWork('t13-unverified', { sd: liveSd, cmp: { ...cleanCompare, ...extra }, manual: liveManual });
  assert.equal(r.status, 3);
  const t13 = j.rows.find((x) => x.id === 'T13');
  assert.equal(t13.result, 'unverified');
  for (const re of [/unverified: cli\.dashboard failed in both/, /unverified: 1 item\(s\) empty.*api\.model/, /unverified: 1 field\(s\).*M1/]) assert.ok(t13.proof.some((p) => re.test(p)), `${re} in ${t13.proof.join(' / ')}`);
});
await test('compare.mjs: an api.* answer that turns unreachable in B is a blocker candidate, and T13 escalates on it (B1)', () => {
  assert.equal(apiProblem({ primary: 'm', reachable: false }), 'reachable: false');
  assert.equal(apiProblem({ agent: { error: 'boom' } }), 'error boom');
  assert.equal(apiProblem({ primary: 'm', reachable: true, resolvable: true }), null);
  const items = (reachable) => [...baseItems([], []), ['api.model', { primary: 'rev4a/m', fallbacks: [], resolvable: true, reachable, ...(reachable ? {} : { error: 'provider unreachable' }) }]];
  const a = snapshot(path.join(TMP, 'c5', 'a'), { items: items(true) });
  const b = snapshot(path.join(TMP, 'c5', 'b'), { items: items(false) });
  const out = path.join(TMP, 'c5', 'compare.md');
  assert.equal(node('compare.mjs', [a, b, '--out', out]).status, 0);
  const j = JSON.parse(fs.readFileSync(out.replace(/md$/, 'json'), 'utf8'));
  assert.equal(j.api.find((x) => x.item === 'api.model').bProblem, 'error provider unreachable');
  assert.ok(j.triage.some((x) => x.level === 'blocker-candidate' && /api\.model/.test(x.text)));
  // compare.json's own list and the one triage.mjs rebuilds are the same.
  assert.deepEqual(compareTriage(j), j.triage);
  const cmp = { ...j, a: { ...j.a, version: 'OpenClaw 2026.10.10' }, b: { ...j.b, version: 'OpenClaw 2026.10.14' } };
  const t = triageWork('t13-api', { sd: liveSd, cmp, manual: liveManual });
  assert.equal(t.r.status, 3);
  assert.ok(t.j.rows.find((x) => x.id === 'T13').proof.some((p) => /api\.model answers differently in B: error provider unreachable/.test(p)));
});

// ── triage: the inputs belong to this FROM → TO (S2) ──────────
await test('triage: an image tag or a compare.json for other versions is exit 2; a schema file name is a warning (S2)', () => {
  const wrongTag = triageWork('s2-tag', { sd: { from: 'openclaw-agent-base:2026.10.9', to: 'openclaw-agent-base:2026.10.14' } });
  assert.equal(wrongTag.r.status, 2, wrongTag.r.stdout + wrongTag.r.stderr);
  assert.match(wrongTag.r.stderr, /schema-diff\.json from is openclaw-agent-base:2026\.10\.9, not an image tagged :2026\.10\.10/);
  assert.equal(triageWork('s2-deps', { deps: { to: 'openclaw-agent-base:2026.10.10' } }).r.status, 2);
  const pinned = triageWork('s2-pin', { sd: { from: 'openclaw-agent-base:2026.10.10', to: 'ghcr.io/x/openclaw-agent-base:2026.10.14-abc1234' }, deps: { to: 'openclaw-agent-base:2026.10.14' } });
  assert.equal(pinned.r.status, 0, pinned.r.stdout + pinned.r.stderr);
  const staleB = triageWork('s2-cmp-b', { sd: liveSd, cmp: { ...cleanCompare, b: { trust: [], version: 'OpenClaw 2026.10.10' } }, manual: liveManual });
  assert.equal(staleB.r.status, 2);
  assert.match(staleB.r.stderr, /snapshot B runs OpenClaw 2026\.10\.10, not 2026\.10\.14/);
  assert.equal(triageWork('s2-cmp-none', { sd: liveSd, cmp: { ...cleanCompare, b: { trust: [] } }, manual: liveManual }).r.status, 2);
  assert.equal(triageWork('s2-cmp-a-newer', { sd: liveSd, cmp: { ...cleanCompare, a: { trust: [], version: 'OpenClaw 2026.10.12' } }, manual: liveManual }).r.status, 2);
  const older = triageWork('s2-cmp-a-older', { sd: liveSd, cmp: { ...cleanCompare, a: { trust: [], version: 'OpenClaw 2026.9.9' } }, manual: liveManual });
  assert.equal(older.r.status, 0, older.r.stdout + older.r.stderr);
  assert.ok(older.j.warnings.some((w) => /older than FROM/.test(w)));
  const named = triageWork('s2-file', { sd: { from: 'schema-old.json', to: 'schema-2026.10.14.json' } });
  assert.equal(named.r.status, 0);
  assert.ok(named.j.warnings.some((w) => /schema-old\.json: its name does not hold 2026\.10\.10/.test(w)), named.j.warnings.join(' / '));
});

// ── triage: P3 needs a full evaluation that ended in go (S5) ──
await test('triage P3: a minor entry, or a full one without "**Verdict:** go", does not open the minor track (S5)', () => {
  const p3 = (name, history) => triageWork(name, { history }).j.rows.find((x) => x.id === 'P3');
  assert.equal(p3('p3-minor', '## 2026.10.10 → 2026.10.12 (minor, OC-11, 2026-11-10)\n\n**Verdict:** go\n').result, 'full');
  assert.equal(p3('p3-no-verdict', '## 2026.9.9 → 2026.10.10 (OC-10, 2026-11-04)\n\n**Verdict:** pending\n\n## Traps\n\n**Verdict:** go\n').result, 'full');
  assert.equal(p3('p3-other-line', '## 2026.8.1 → 2026.9.9 (X, 2026-01-01)\n\n**Verdict:** go\n').result, 'full');
  assert.equal(p3('p3-go', '## 2026.9.9 → 2026.10.10 (OC-10, 2026-11-04)\n\nFound…\n\n**Verdict:** go\n').result, 'ok');
});

// ── triage: ids, P4 and T8 (S6, nits) ─────────────────────────
await test('triage T4: a hook, skill or plugin id Rev4a names that TO lacks escalates (S6)', () => {
  const { r, j } = triageWork('s6-ids', { deps: { ids: [{ id: 'KW1', kind: 'hook', name: 'bootstrap-extra-files', found: false }, { id: 'KR4', kind: 'plugin', name: 'telegram', found: true }] } });
  assert.equal(r.status, 3);
  assert.deepEqual(j.escalate, ['T4']);
  assert.deepEqual(j.rows.find((x) => x.id === 'T4').proof, ['KW1 hook bootstrap-extra-files not found in TO']);
  assert.equal(triageWork('s6-unchecked', { deps: { ids: [], unverified: ['ids: no TO package'] } }).j.rows.find((x) => x.id === 'T4').result, 'unverified');
});
await test('triage P4: a -N hotfix older than latest is not latest; a newer one is (P4)', () => {
  const p4 = (name, to, latest) => triageWork(name, { rd: { to, distTags: { latest } } }).j.rows.find((x) => x.id === 'P4');
  assert.equal(p4('p4-older', '2026.10.14-1', '2026.10.14-2').result, 'full');
  assert.equal(p4('p4-newer', '2026.10.14-3', '2026.10.14-2').result, 'ok');
  assert.equal(p4('p4-of-base', '2026.10.14-1', '2026.10.14').result, 'ok');
  assert.equal(p4('p4-latest', '2026.10.14', '2026.10.14').result, 'ok');
});
await test('triage T8: Rev4a\'s import loop not run (no --to-image) is unverified', () => {
  const { j } = triageWork('t8-unverified', { deps: { internals: [{ id: 'I1', names: ['f'], result: 'unverified (no --to-image)' }] } });
  assert.equal(j.rows.find((x) => x.id === 'T8').result, 'unverified');
});

// ── rev4a-deps.mjs C4 against FROM's rules (S1) ───────────────
await test('rev4a-deps C4 + triage T6: a legacy path FROM already had or only a comment names does not escalate; one new in TO does (S1)', () => {
  const base = path.join(TMP, 'c4');
  const repo = path.join(base, 'repo');
  const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  write(path.join(repo, 'lib', 'agent-setup.ts'), 'export {};\n');
  write(path.join(repo, 'lib', 'channelManager.ts'), "if (v.name === 'readChannelAllowFromStoreSync') x();\n");
  // This case tests legacy-path classification, not pairing discovery. Copy the current
  // declared loader so moving it cannot make this unrelated fixture stale.
  const declared = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills/rev4a-openclaw-upgrade/references/deps.json'), 'utf8'));
  for (const internal of declared.internals) {
    write(path.join(repo, internal.namesFrom.file), fs.readFileSync(path.join(ROOT, internal.namesFrom.file), 'utf8'));
  }
  write(path.join(repo, 'lib', 'model.ts'), 'const list = cfg.agents.list;\nconst s = cfg.tools.web.search;\n// cfg.gateway.controlUi.dangerouslyDisableDeviceAuth is never written\n');
  write(path.join(repo, 'agent-templates', 'base-image', 'Dockerfile'), '# gateway.controlUi.dangerouslyDisableDeviceAuth is not set\n');
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  assert.equal(spawnSync('git', ['-C', repo, 'add', '-A']).status, 0);
  const pkg = (name, rules) => {
    const d = path.join(base, name);
    write(path.join(d, 'package.json'), '{"name":"openclaw"}');
    write(path.join(d, 'dist', 'legacy-x.mjs'), `const legacyRules = [${rules.map((r) => `{ path: [${r.map((s) => `"${s}"`).join(', ')}], message: "moved" }`).join(', ')}];\n`);
    return d;
  };
  const fromPkg = pkg('from-pkg', [['agents', 'list'], ['gateway', 'controlUi', 'dangerouslyDisableDeviceAuth']]);
  const toPkg = pkg('to-pkg', [['agents', 'list'], ['gateway', 'controlUi', 'dangerouslyDisableDeviceAuth'], ['tools', 'web', 'search']]);
  const work = path.join(base, 'work'); fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'release-diff.json'), JSON.stringify({ packages: { from: fromPkg, to: toPkg } }));
  const r = node('rev4a-deps.mjs', ['--to-schema', path.join(TMP, 'sb.json'), '--from-schema', path.join(TMP, 'sa.json'), '--work', work, '--repo', repo]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const legacy = JSON.parse(fs.readFileSync(path.join(work, 'rev4a-deps.json'), 'utf8')).legacy;
  assert.deepEqual(legacy.map((l) => [l.path, l.newInTo]), [['agents.list', false], ['tools.web.search', true]], 'the comment-only path is not listed');
  const t6 = (name, deps) => triageWork(name, { deps }).j.rows.find((x) => x.id === 'T6');
  assert.equal(t6('s1-old', { legacy: legacy.filter((l) => !l.newInTo) }).result, 'ok');
  const fresh = t6('s1-new', { legacy });
  assert.equal(fresh.result, 'full');
  assert.deepEqual(fresh.proof, ['TO migrates or retires tools.web.search, which Rev4a names (new in TO)']);
  // An older rev4a-deps.json (no newInTo) cannot tell: it still escalates.
  assert.equal(t6('s1-unknown', { legacy: [{ path: 'agents.list', exact: true }] }).result, 'full');
});

// ── neutralize-backup.mjs on a fixture archive ─────────────────
/** A gzipped ustar archive of [name, content | null (directory)] entries, as `tar -C <volume> .` writes them. */
function makeTar(entries) {
  const blocks = [];
  for (const [name, content, type] of entries) {
    const h = Buffer.alloc(512);
    const body = content === null ? Buffer.alloc(0) : Buffer.from(content);
    h.write(name, 0, 100, 'utf8');
    h.write(content === null ? '0000755\0' : '0000644\0', 100, 8, 'ascii');
    h.write('0000000\0', 108, 8, 'ascii'); h.write('0000000\0', 116, 8, 'ascii');
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    h.write('15000000000\0', 136, 12, 'ascii');
    h[156] = (type ?? (content === null ? '5' : '0')).charCodeAt(0);
    h.write('ustar  \0', 257, 8, 'ascii');
    h.fill(0x20, 148, 156);
    let sum = 0; for (const x of h) sum += x;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}
function readTar(gz) {
  const b = zlib.gunzipSync(gz); const out = new Map();
  for (let i = 0; i + 512 <= b.length;) {
    const h = b.subarray(i, i + 512);
    if (h.every((x) => x === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    out.set(name, b.subarray(i + 512, i + 512 + size));
    i += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
await test('neutralize-backup refuses PAX extraction paths and gzip-valid truncated tar data without an output', () => {
  const config = ['./.openclaw/openclaw.json','{}'];
  const cases = {
    pax: makeTar([config,['./PaxHeaders/auth','43 path=./.openclaw/credentials/auth.json\n','x'],['./safe-name','secret']]),
    header: zlib.gzipSync(Buffer.concat([zlib.gunzipSync(makeTar([config])).subarray(0,1024),Buffer.alloc(23,1)])),
    body: zlib.gzipSync(zlib.gunzipSync(makeTar([config])).subarray(0,513)),
  };
  for(const [name,bytes] of Object.entries(cases)) {
    const input=path.join(TMP,`unsafe-${name}.tar.gz`);const output=path.join(TMP,`unsafe-${name}-out.tar.gz`);
    fs.writeFileSync(input,bytes);
    const result=node('neutralize-backup.mjs',['--in',input,'--out',output]);
    assert.equal(result.status,2,result.stdout+result.stderr);
    assert.ok(!fs.existsSync(output));assert.ok(!fs.existsSync(output+'.partial'));
  }
});
let sqlite = null;
// node:sqlite prints an ExperimentalWarning on Node 22; it says nothing about this test.
process.removeAllListeners('warning');
try { sqlite = await import('node:sqlite'); } catch { /* reported below */ }
await test('neutralize-backup.mjs: channels, cron, tokens, credentials and sign-ins are gone; the rest is untouched', () => {
  if (!sqlite) { console.log(`     (state DB part not run: node:sqlite is not in Node ${process.versions.node})`); }
  const dbFile = path.join(TMP, 'nb-state.sqlite');
  let dbBytes = null;
  if (sqlite) {
    const d = new sqlite.DatabaseSync(dbFile);
    d.exec("CREATE TABLE secret_store_entries (name, value, kind, deleted_at_ms); INSERT INTO secret_store_entries VALUES ('n', 'SECRETVALUE123', 'env', NULL);"
      + "CREATE TABLE config_machine_state (state_key, value_json); INSERT INTO config_machine_state VALUES ('authProfiles.store', '{\"t\":\"OAUTHSECRET\"}'), ('other', '1');");
    d.close();
    dbBytes = fs.readFileSync(dbFile);
  }
  const cfg = { channels: { telegram: { botToken: '1:x', enabled: true } }, bindings: [{ agentId: 'main', match: { channel: 'telegram' } }], gateway: { auth: { token: 'real' } },
    models: { providers: { rev4a: { apiKey: 'k', headers: { 'x-rev4a-agent': 'agent_real' }, models: [{ id: 'm' }] } } }, skills: { entries: { notion: { enabled: true, env: { NOTION_TOKEN: 'n' } } } } };
  const input = path.join(TMP, 'agent-x-cold-1.tar.gz');
  fs.writeFileSync(input, makeTar([
    ['./', null], ['./.agent-token', 'tok'], ['./.openclaw/', null], ['./.openclaw/openclaw.json', JSON.stringify(cfg)],
    ['./.openclaw/credentials/github/hosts.yml', 'oauth_token: x'], ['./.openclaw/agents/main/agent/auth-profiles.json', '{}'],
    ['./.openclaw/agents/main/agent/models.json', '{"providers":{"rev4a":{"apiKey":"sk-models-json-key"}}}'], ['./.openclaw/.env', 'REV4A_PROXY_KEY=PROXYKEY'],
    ['./.openclaw/agents/main/sessions/s.jsonl', 'transcript'], ['./.codex/auth.json', '{}'],
    ...(dbBytes ? [['./.openclaw/state/openclaw.sqlite', dbBytes]] : []),
  ]));
  const before = fs.readFileSync(input);
  const out = path.join(TMP, 'clean.tar.gz');
  const r = node('neutralize-backup.mjs', ['--in', input, '--out', out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.readFileSync(input).equals(before), 'the input is unchanged');
  const files = readTar(fs.readFileSync(out));
  for (const gone of ['./.agent-token', './.openclaw/credentials/github/hosts.yml', './.openclaw/agents/main/agent/auth-profiles.json', './.codex/auth.json',
    './.openclaw/agents/main/agent/models.json', './.openclaw/.env']) assert.ok(!files.has(gone), gone);
  assert.ok(!r.stdout.includes('sk-models-json-key') && !r.stdout.includes('PROXYKEY'), 'no dropped secret is printed');
  assert.equal(files.get('./.openclaw/agents/main/sessions/s.jsonl').toString(), 'transcript');
  const c = JSON.parse(files.get('./.openclaw/openclaw.json').toString());
  assert.equal(c.channels, undefined);
  assert.deepEqual(c.bindings, []);
  assert.equal(c.cron.enabled, false);
  assert.equal(c.gateway.auth.token, undefined);
  assert.equal(c.models.providers.rev4a.apiKey, undefined);
  assert.deepEqual(c.models.providers.rev4a.headers, {});
  assert.deepEqual(c.skills.entries.notion, { enabled: true });
  if (sqlite) {
    const db = files.get('./.openclaw/state/openclaw.sqlite');
    assert.ok(!db.includes('SECRETVALUE123') && !db.includes('OAUTHSECRET'), 'no secret survives in the file');
    fs.writeFileSync(dbFile, db);
    const d = new sqlite.DatabaseSync(dbFile);
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM secret_store_entries').get().n, 0);
    assert.deepEqual(d.prepare('SELECT state_key FROM config_machine_state').all().map((x) => x.state_key), ['other']);
    d.close();
  }
  assert.equal(node('neutralize-backup.mjs', ['--in', input, '--out', out]).status, 1, 'an existing output needs --force');
});

// ── references/deps.json evidence ──────────────────────────────
await test('every deps.json entry still points at code that contains its evidence', () => {
  const deps = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills', 'rev4a-openclaw-upgrade', 'references', 'deps.json'), 'utf8'));
  const stale = [];
  for (const k of ['configKeys', 'fields', 'cli', 'ids', 'internals']) {
    for (const e of deps[k]) {
      let text = '';
      try { text = fs.readFileSync(path.join(ROOT, e.evidence.file), 'utf8'); } catch { stale.push(`${k} ${e.id}: ${e.evidence.file} is gone`); continue; }
      if (!text.includes(e.evidence.text)) stale.push(`${k} ${e.id}: ${e.evidence.file} no longer contains ${JSON.stringify(e.evidence.text)}`);
    }
  }
  for (const i of deps.internals) {
    const src = fs.readFileSync(path.join(ROOT, i.namesFrom.file), 'utf8');
    if (![...src.matchAll(new RegExp(i.namesFrom.pattern, 'g'))].length) stale.push(`internals ${i.id}: no name matches ${i.namesFrom.pattern}`);
  }
  assert.deepEqual(stale, [], 'update references/deps.json (and references/inventory.md) with the touchpoint that moved');
});

console.log(`\n${passed} passed`);
