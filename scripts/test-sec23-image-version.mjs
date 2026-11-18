#!/usr/bin/env node
/** SEC-23: real image resolution and edit code, with all Docker/process access mocked. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(file, dependencies, globals = {}) {
  const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, Buffer, console, setTimeout, clearTimeout,
    fetch: () => assert.fail('No network access'),
    require: (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency in ${file}: ${name}`);
      return dependencies[name];
    }, ...globals,
  }, { filename: file });
  return module.exports;
}
const versions = load('lib/agent-versions.ts', {
  './agent-versions.json': require('../lib/agent-versions.json'),
  './image-revision': require('../lib/image-revision.js'),
}, { process: { env: {} } });
const label = 'org.opencontainers.image.version';
const legacyId = 'sha256:legacy';
const oldVersion = '2026.9.3';
const otherVersion = '2026.9.9';
const ref = versions.localImageRef;
const legacy = { Id: legacyId, RepoTags: ['openclaw-agent-base:latest'], Labels: {} };
const container = (name, imageId = legacyId, running = true) => ({ name, imageId, running });
const inspection = (name, imageId = legacyId, running = true) => ({
  Id: `id-${name}`, Name: `/${name}`, Image: imageId,
  Config: { Image: 'openclaw-agent-base:latest' }, State: { Running: running },
});

function harness(localImages = [legacy], extraImages = [], options = {}) {
  let now = 0;
  const execCalls = [], commands = [], requests = [];
  const answers = new Map();
  const byRef = new Map();
  const imageReads = new Map();
  for (const image of [...localImages, ...extraImages]) {
    const info = { ...image, Config: { Labels: image.Labels ?? {} } };
    byRef.set(image.Id, info);
    for (const tag of Array.isArray(image.RepoTags) ? image.RepoTags : []) {
      if (typeof tag === 'string') byRef.set(tag, info);
    }
  }
  const api = load('lib/agent-images.ts', {
    child_process: { spawn: (command, argv) => {
      assert.equal(command, 'docker');
      if (options.allowPull) assert.ok(['tag', 'pull', 'rmi'].includes(argv[0]), 'Only mocked image commands are allowed');
      else assert.equal(argv[0], 'tag', 'Only metadata-based tagging is expected; no pull/run');
      commands.push(Array.from(argv));
      if (argv[0] === 'pull') byRef.set(argv[1], { Id: 'sha256:pulled' });
      if (argv[0] === 'rmi') byRef.delete(argv[1]);
      if (argv[0] === 'tag') {
        assert.ok(byRef.has(argv[1]), `Tag source must exist: ${argv[1]}`);
        byRef.set(argv[2], byRef.get(argv[1]));
      }
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => assert.fail('Mock command must finish before its timeout');
      queueMicrotask(() => child.emit('close', 0));
      return child;
    } },
    '@/lib/docker-socket': { dockerFetch: async (method, path) => {
      assert.equal(method, 'GET'); requests.push(path);
      if (path.startsWith('/images/json?')) return localImages;
      if (path.startsWith('/containers/json?')) return [];
      const match = /^\/images\/(.+)\/json$/.exec(path);
      assert.ok(match, `Unexpected Docker request: ${path}`);
      const reference = decodeURIComponent(match[1]);
      const read = (imageReads.get(reference) ?? 0) + 1;
      imageReads.set(reference, read);
      const override = options.inspect?.(reference, read);
      return override === undefined ? byRef.get(reference) ?? { message: 'No such image' } : override;
    } },
    '@/lib/docker-exec': { dockerExecNoFail: async (name, argv) => {
      assert.deepEqual(Array.from(argv), ['openclaw', '--version']);
      execCalls.push(name);
      assert.ok(answers.has(name), `Unexpected exec into ${name}`);
      return answers.get(name);
    } },
    '@/lib/agent-versions': versions,
  }, { Date: class extends Date { static now() { return now; } } });
  return { ...api, answers, execCalls, commands, requests, imageReads,
    images: () => api.listLocalAgentImages(), advance: (ms) => { now += ms; },
    imageAt: (reference) => byRef.get(reference)?.Id };
}

async function agentsWith(h, containers) {
  const route = load('app/api/agents/route.ts', {
    'next/server': { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    '@/lib/rev4a-auth': { requireAuthJWT: async () => null },
    '@/lib/agent-ports-server': { currentAgentPortsListen: () => ({ hostIp: null }) },
    '@/lib/agent-ports': load('lib/agent-ports.ts', {}),
    '@/lib/docker-socket': {
      dockerAvailable: () => true,
      dockerFetch: async (_method, path) => {
        if (path.startsWith('/containers/json?')) return containers;
        const target = containers.find(c => path === `/containers/${c.Id}/json`);
        assert.ok(target, `Unexpected agents request: ${path}`);
        return { Config: { Env: [] } };
      },
    },
    '@/lib/agent-images': h,
    '@/lib/agent-versions': versions,
  });
  const response = await route.GET({});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

function recreateWith(h, inspected) {
  const events = [];
  let current = inspected;
  const api = load('lib/agent-recreate.ts', {
    '@/lib/docker-socket': { dockerFetch: async (_method, path) => {
      if (path.startsWith('/containers/json?')) return [{ Id: current.Id }];
      if (path === `/containers/${current.Id}/json`) return current;
      assert.fail(`Unexpected recreate request: ${path}`);
    } },
    '@/lib/agent-images': { ...h, runDocker: async (args) => {
      assert.equal(args[0], 'run');
      events.push(['run', args.at(-1)]);
      current = { ...inspected, Id: 'new-container', Name: '/agent_victim', Image: args.at(-1) };
    } },
    '@/lib/agent-ports': { hostPortsFromArgs: () => [], portArgsFromBindings: () => [] },
    '@/lib/agent-ports-server': { agentPortsHostIp: () => null, assertPortArgsHostIps: () => {} },
    '@/lib/agent-setup': { getMountFlags: () => [] },
    '@/lib/container': {}, '@/lib/backups-volume': {}, '@/lib/cold-backup': {},
    '@/lib/agent-readiness': {}, '@/app/api/gateway/sync': {},
    '@/lib/agent-recreate-state': {}, '@/lib/agent-busy': {},
    '@/lib/agent-memory-limit': { rebuildLimitArgs: () => [] },
    '@/lib/agent-stop': { removeAgentContainer: async (_agentId, id) => { events.push(['remove', id]); } },
  });
  return { ...api, events, current: () => current };
}

async function editProbe(h, inspected, { realRecreate = false } = {}) {
  const replacements = [], rows = [];
  const recreation = realRecreate ? recreateWith(h, inspected) : null;
  const edit = load('lib/agent-edit.ts', {
    '@/lib/container': { isValidAgentId: () => true },
    '@/lib/agent-ports': {}, '@/lib/agent-ports-server': {},
    '@/lib/agent-images': h,
    '@/lib/agent-recreate': {
      inspectAgentContainer: async () => inspected,
      recreateAgentContainer: async (agentId, original, image, opts) => {
        assert.equal(original, inspected); assert.equal(opts.env.AGENT_NAME, 'Renamed');
        replacements.push({ agentId, image });
        if (recreation) await recreation.recreateAgentContainer(agentId, original, image, opts);
      },
    },
    '@/lib/agent-busy': { agentBusyReason: async () => null },
    '@/lib/agent-readiness': { waitForGatewayReady: async () => true },
    '@/lib/agent-setup': { applyRuntimeConfig: async () => {} },
    '@/app/api/gateway/sync': { patchRev4aProvider: async () => {} },
    '@/lib/agent-edit-state': {
      isEditActive: () => false, insertEdit: () => 1,
      updateEditRow: (_id, row) => rows.push(row),
    },
  });
  assert.equal(await edit.startAgentEdit('agent_victim', { displayName: 'Renamed' }), 1);
  // Flush the mocked background job without wall-clock sleeps or external services.
  for (let i = 0; i < 100 && !rows.some(row => ['done', 'failed'].includes(row.status)); i++) await Promise.resolve();
  return { replacements, row: rows.at(-1), recreation };
}

async function editWith(h, inspected) {
  const { row, replacements } = await editProbe(h, inspected);
  assert.equal(row?.status, 'done', JSON.stringify(row));
  assert.equal(replacements.length, 1);
  return replacements[0].image;
}

async function rollbackProbe(h, running = false) {
  const rows = [], effects = [];
  const row = { id: 1, agent_id: 'agent_victim', status: 'done', from_version: oldVersion,
    to_version: otherVersion, backup_file: 'agent-victim-preupdate.tar.gz' };
  const update = load('lib/agent-update.ts', {
    '@/lib/docker-exec': {}, '@/lib/container': { isValidAgentId: () => true },
    '@/lib/gateway-cli': {}, '@/lib/agent-versions': versions, '@/lib/agent-images': h,
    '@/lib/backups-volume': {
      locateBackup: async () => 'dir',
      backupMountSource: async () => { effects.push('volume'); throw new Error('PROBE STOP before volume access'); },
    },
    '@/lib/cold-backup': {},
    '@/lib/agent-recreate': {
      inspectAgentContainer: async () => inspection('victim', legacyId, running),
      recreateAgentContainer: async () => assert.fail('No container replacement expected'),
    },
    '@/lib/agent-setup': {}, '@/lib/agent-readiness': {}, '@/app/api/gateway/sync': {},
    '@/lib/agent-update-state': {
      latestUpdate: () => row,
      claimRollbackUpdate: () => rows.push({ status: 'rolling_back' }),
      updateRow: (_id, fields) => rows.push(fields),
    },
    '@/lib/agent-update-cron': {}, '@/lib/agent-busy': { agentBusyReason: async () => null },
    '@/lib/agent-recreate-state': {}, '@/lib/agent-restore-state': {}, '@/lib/agent-update-later-job': {},
    '@/lib/credentials/delivery': {}, '@/lib/agent-update-resolution': {}, '@/lib/agent-update-cron-account': {},
    '@/lib/backup-cron-evidence': {}, '@/lib/redact-secret': { redactSecret: text => text },
    '@/lib/rev4a-paths': { AGENTS_TOKEN_FILE: '/unused' },
    'node:fs': { readFileSync: () => '' }, '@/lib/agent-resource-preflight': {},
  });
  assert.equal(await update.startAgentRollback(row.agent_id), row.id);
  for (let i = 0; i < 1000 && !rows.some(r => r.status === 'rollback_failed'); i++) await Promise.resolve();
  assert.equal(rows.at(-1)?.status, 'rollback_failed', 'Mock rollback must finish');
  return { row: rows.at(-1), effects };
}

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok   ' + name); }

await test('two legacy containers on one image keep their own exec answers and caches', async () => {
  const h = harness(); const images = await h.images();
  h.answers.set('attacker', `OpenClaw ${otherVersion}`);
  h.answers.set('victim', `OpenClaw ${oldVersion}`);
  assert.equal(await h.containerOpenClawVersion(container('attacker'), images), otherVersion);
  assert.equal(await h.containerOpenClawVersion(container('victim'), images), oldVersion);
  h.advance(10 * 60 * 1000 - 1);
  for (const [name, expected] of [['victim', oldVersion], ['attacker', otherVersion]]) {
    assert.equal(await h.containerOpenClawVersion(container(name), images), expected);
  }
  assert.deepEqual(h.execCalls, ['attacker', 'victim']);
});

await test('changing the image under the same container name re-reads its version', async () => {
  const nextId = 'sha256:replacement';
  const h = harness([legacy], [{ Id: nextId, RepoTags: [], Labels: {} }]);
  const images = await h.images(); h.answers.set('victim', oldVersion);
  assert.equal(await h.containerOpenClawVersion(container('victim'), images), oldVersion);
  h.answers.set('victim', otherVersion);
  assert.equal(await h.containerOpenClawVersion(container('victim', nextId), images), otherVersion);
  assert.deepEqual(h.execCalls, ['victim', 'victim']);
});

await test('failed exec caches are container-specific and expire after five minutes', async () => {
  const h = harness(); const images = await h.images();
  h.answers.set('unknown', ''); h.answers.set('victim', oldVersion);
  assert.equal(await h.containerOpenClawVersion(container('unknown'), images), null);
  assert.equal(await h.containerOpenClawVersion(container('victim'), images), oldVersion);
  h.answers.set('unknown', otherVersion);
  assert.equal(await h.containerOpenClawVersion(container('unknown'), images), null);
  h.advance(5 * 60 * 1000);
  assert.equal(await h.containerOpenClawVersion(container('unknown'), images), otherVersion);
  assert.deepEqual(h.execCalls, ['unknown', 'victim', 'unknown']);
});

await test('stopped legacy containers never inherit another container\'s cached version', async () => {
  const h = harness(); const images = await h.images(); h.answers.set('attacker', otherVersion);
  await h.containerOpenClawVersion(container('attacker'), images);
  assert.equal(await h.containerOpenClawVersion(container('victim', legacyId, false), images), null);
  assert.equal(await h.containerOpenClawVersion(container('attacker', legacyId, false), images), otherVersion);
  assert.deepEqual(h.execCalls, ['attacker']);
});

await test('legacy recreate and actual edit keep the image id despite any cached exec claim', async () => {
  for (const claimed of [oldVersion, otherVersion, '2030.1.1', 'not a version']) {
    const h = harness([legacy, {
      Id: 'sha256:downloaded', RepoTags: [ref(otherVersion)], Labels: { [label]: otherVersion },
    }]);
    const images = await h.images();
    h.answers.set('attacker', otherVersion); h.answers.set('victim', claimed);
    await h.containerOpenClawVersion(container('attacker'), images);
    await h.containerOpenClawVersion(container('victim'), images);
    for (const running of [true, false]) {
      assert.equal(await h.resolveRecreateImage(inspection('victim', legacyId, running)), legacyId);
      assert.equal(await editWith(h, inspection('victim', legacyId, running)), legacyId);
    }
    assert.deepEqual(h.execCalls, ['attacker', 'victim'], 'Image selection must never exec');
    assert.deepEqual(h.commands, [], 'Exec output must never trigger tagging or pulling');
  }
});

await test('a cold recreate/edit of a legacy image does not exec to select its image', async () => {
  const h = harness();
  assert.equal(await h.resolveRecreateImage(inspection('victim')), legacyId);
  assert.equal(await editWith(h, inspection('victim')), legacyId);
  assert.deepEqual(h.execCalls, []); assert.deepEqual(h.commands, []);
});

await test('transient second image-id read keeps the id through real edit and recreation', async () => {
  for (const failure of ['timeout', 'daemon error', 'empty response', 'null response']) {
    const h = harness([legacy, {
      Id: 'sha256:new-latest', RepoTags: ['openclaw-agent-base:latest'], Labels: {},
    }], [], { inspect: (reference, read) => {
      if (reference !== legacyId || read !== 2) return;
      if (failure === 'empty response') return {};
      if (failure === 'null response') return null;
      throw new Error(failure === 'timeout' ? 'Docker request timed out' : 'Docker error 500: unavailable');
    } });
    const inspected = { ...inspection('victim'), HostConfig: { NetworkMode: 'bridge' } };
    const { row, replacements, recreation } = await editProbe(h, inspected, { realRecreate: true });
    assert.equal(row.status, 'done', row.error);
    assert.deepEqual(replacements.map(r => r.image), [legacyId]);
    assert.deepEqual(recreation.events, [['remove', 'id-victim'], ['run', legacyId]]);
    assert.equal(h.imageReads.get(legacyId), 2);
    assert.deepEqual(h.execCalls, []);
    console.log(`REAL_EDIT_RECREATE ${failure} => ${JSON.stringify({
      status: row.status, events: recreation.events, execs: h.execCalls.length,
      imageIdReads: h.imageReads.get(legacyId),
    })}`);
  }
});

await test('first image inspection failures also retain the immutable id', async () => {
  const h = harness([], [], { inspect: () => { throw new Error('Docker request timed out'); } });
  assert.equal(await h.resolveRecreateImage(inspection('victim')), legacyId);
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.execCalls, []);
});

await test('only confirmed missing images permit the configured reference fallback', async () => {
  for (const missing of [{ message: `No such image: ${legacyId}` }, new Error('Docker error 404: image not found')]) {
    const h = harness([], [], { inspect: () => {
      if (missing instanceof Error) throw missing;
      return missing;
    } });
    assert.equal(await h.resolveRecreateImage(inspection('victim')), 'openclaw-agent-base:latest');
    const noFallback = inspection('victim'); delete noFallback.Config.Image;
    await assert.rejects(h.resolveRecreateImage(noFallback), /Cannot safely determine/);
  }
  console.log('MISSING_IMAGE => configured reference allowed only on explicit not-found; no fallback => refused');
});

await test('missing current image id refuses real edit before removal even with a configured latest tag', async () => {
  const h = harness();
  const inspected = { ...inspection('victim', ''), HostConfig: { NetworkMode: 'bridge' } };
  const { row, replacements, recreation } = await editProbe(h, inspected, { realRecreate: true });
  assert.equal(row.status, 'failed');
  assert.match(row.error, /Cannot safely determine/);
  assert.deepEqual(replacements, []); assert.deepEqual(recreation.events, []);
  console.log(`NO_SAFE_IMAGE => ${JSON.stringify({ status: row.status, events: recreation.events, error: row.error })}`);
});

await test('a labelled image with unknown image-id existence keeps its id instead of pulling', async () => {
  const h = harness([{ Id: legacyId, RepoTags: [], Labels: { [label]: oldVersion } }], [], {
    inspect: (reference) => { if (reference === legacyId) throw new Error('Docker request timed out'); },
  });
  assert.equal(await h.resolveRecreateImage(inspection('victim')), legacyId);
  assert.deepEqual(h.execCalls, []); assert.deepEqual(h.commands, []);
});

await test('real same-image recreation reads the new Docker container instance', async () => {
  const h = harness(); const images = await h.images();
  const inspected = { ...inspection('agent_victim'), HostConfig: { NetworkMode: 'bridge' } };
  h.answers.set(inspected.Id, '2030.1.1');
  const before = await h.containerOpenClawVersion({ ...container('agent_victim'), id: inspected.Id }, images);
  const { row, recreation } = await editProbe(h, inspected, { realRecreate: true });
  assert.equal(row.status, 'done', row.error);
  const after = await recreation.inspectAgentContainer('agent_victim');
  h.answers.set(after.Id, oldVersion);
  const observed = await h.containerOpenClawVersion({ ...container('agent_victim'), id: after.Id }, images);
  assert.equal(before, '2030.1.1'); assert.equal(after.Image, legacyId);
  assert.equal(after.Name, inspected.Name, 'Same name and image must not hide a new container instance');
  assert.notEqual(after.Id, inspected.Id); assert.equal(observed, oldVersion);
  assert.deepEqual(h.execCalls, [inspected.Id, after.Id]);
  console.log(`POST_REAL_RECREATE => ${JSON.stringify({ before, runImage: after.Image, newContainerVersion: oldVersion, observed, execCount: h.execCalls.length })}`);
});

await test('successful exec answers expire at ten minutes with and without container ids', async () => {
  const results = [];
  for (const id of [undefined, 'id-victim']) {
    for (const age of [-1, 0, 299999, 300000, 300001, 599999, 600000, 600001, Number.MAX_SAFE_INTEGER, NaN, Infinity]) {
      const h = harness(); const images = await h.images();
      const target = { ...container('victim'), id };
      h.answers.set(id || 'victim', oldVersion);
      assert.equal(await h.containerOpenClawVersion(target, images), oldVersion);
      h.answers.set(id || 'victim', otherVersion); h.advance(age);
      const answer = await h.containerOpenClawVersion(target, images);
      assert.equal(answer, age < 600000 ? oldVersion : otherVersion);
      assert.equal(h.execCalls.length, age < 600000 ? 1 : 2);
      if (id) results.push({ age: Number.isFinite(age) ? age : String(age), answer, exec: h.execCalls.length });
    }
  }
  console.log(`SUCCESS_CACHE_AGES => ${JSON.stringify(results)}`);
});

await test('failed exec cache expiry handles the checkers boundary ages', async () => {
  const results = [];
  for (const age of [-1, 0, 299999, 300000, 300001, 599999, 600000, 600001, Number.MAX_SAFE_INTEGER, NaN, Infinity]) {
    const h = harness(); const images = await h.images(); h.answers.set('victim', '');
    assert.equal(await h.containerOpenClawVersion(container('victim'), images), null);
    h.answers.set('victim', otherVersion); h.advance(age);
    const answer = await h.containerOpenClawVersion(container('victim'), images);
    assert.equal(answer, age < 300000 ? null : otherVersion);
    assert.equal(h.execCalls.length, age < 300000 ? 1 : 2);
    results.push({ age: Number.isFinite(age) ? age : String(age), answer, exec: h.execCalls.length });
  }
  console.log(`FAILED_CACHE_AGES => ${JSON.stringify(results)}`);
});

await test('expired stopped-container answers are unknown until the container runs again', async () => {
  const h = harness(); const images = await h.images();
  h.answers.set('id-victim', oldVersion);
  const target = { ...container('victim'), id: 'id-victim' };
  assert.equal(await h.containerOpenClawVersion(target, images), oldVersion);
  h.advance(600000);
  assert.equal(await h.containerOpenClawVersion({ ...target, running: false }, images), null);
  assert.equal(await h.containerOpenClawVersion({ ...target, id: 'new-id', running: false }, images), null);
  assert.equal(h.execCalls.length, 1);
});

await test('invalid, huge and future exec answers never select another image', async () => {
  const results = [];
  for (const [name, output, expected] of [
    ['empty', '', null], ['null', null, null], ['undefined', undefined, null],
    ['NaN', NaN, null], ['zero', 0, null], ['negative', -1, null], ['false', false, null],
    ['noise', 'not a version', null], ['old', oldVersion, oldVersion], ['future', '2030.1.1', '2030.1.1'],
    ['1MiB noise', 'x'.repeat(1024 * 1024), null],
    ['million characters then version', 'x'.repeat(1000000) + ' 2030.1.1', '2030.1.1'],
  ]) {
    const h = harness(); const images = await h.images(); h.answers.set('victim', output);
    const shown = await h.containerOpenClawVersion(container('victim'), images);
    const selected = await h.resolveRecreateImage(inspection('victim'));
    assert.equal(shown, expected); assert.equal(selected, legacyId);
    assert.equal(await editWith(h, inspection('victim')), legacyId);
    results.push({ input: name, shown, selected });
  }
  console.log(`EXEC_INPUTS => ${JSON.stringify(results)}`);
});

await test('concurrent attacker and victim reads remain isolated', async () => {
  const h = harness(); const images = await h.images();
  h.answers.set('attacker', otherVersion); h.answers.set('victim', oldVersion);
  const answers = await Promise.all(['attacker', 'victim'].map(name => h.containerOpenClawVersion(container(name), images)));
  assert.deepEqual(answers, [otherVersion, oldVersion]);
  assert.equal(h.execCalls.length, 2);
  console.log(`CONCURRENT_CONTAINERS => ${JSON.stringify(answers)} execs=${h.execCalls.length}`);
});

await test('10000 legacy agents do not share versions with stopped containers', async () => {
  const h = harness(); const images = await h.images(); const started = performance.now();
  const answers = await Promise.all(Array.from({ length: 10000 }, (_, i) => {
    const name = `agent-${i}`; h.answers.set(name, oldVersion);
    return h.containerOpenClawVersion(container(name, legacyId, i % 2 === 0), images);
  }));
  const known = answers.filter(v => v === oldVersion).length;
  const stoppedUnknown = answers.filter(v => v === null).length;
  assert.equal(known, 5000); assert.equal(stoppedUnknown, 5000); assert.equal(h.execCalls.length, 5000);
  console.log(`LEGACY_AGENTS => ${JSON.stringify({ known, stoppedUnknown, milliseconds: Math.round(performance.now() - started) })}`);
});

await test('labelled and version-tagged images retain display, recreate and edit behavior', async () => {
  for (const labels of [{ [label]: oldVersion }, {}]) {
    const h = harness([{ Id: legacyId, RepoTags: [ref(oldVersion)], Labels: labels }]);
    const images = await h.images();
    for (const running of [true, false]) {
      assert.equal(await h.containerOpenClawVersion(container('victim', legacyId, running), images), oldVersion);
      assert.equal(await h.resolveRecreateImage(inspection('victim', legacyId, running)), ref(oldVersion));
      assert.equal(await editWith(h, inspection('victim', legacyId, running)), ref(oldVersion));
    }
    assert.deepEqual(h.execCalls, []); assert.deepEqual(h.commands, []);
  }
});

await test('an unlisted image\'s inspected label remains shared metadata and selects its version', async () => {
  const h = harness([], [{ Id: legacyId, RepoTags: [ref(oldVersion)], Labels: { [label]: oldVersion } }]);
  for (const name of ['first', 'second']) {
    assert.equal(await h.containerOpenClawVersion(container(name, legacyId, false), []), oldVersion);
  }
  assert.equal(h.requests.length, 1, 'A successful metadata lookup can be cached by image id');
  assert.equal(await h.resolveRecreateImage(inspection('victim', legacyId, false)), ref(oldVersion));
  assert.equal(await editWith(h, inspection('victim')), ref(oldVersion));
  assert.deepEqual(h.execCalls, []); assert.deepEqual(h.commands, []);
});

await test('a labelled image missing its version tag is still tagged from metadata', async () => {
  const h = harness([], [{ Id: legacyId, RepoTags: [], Labels: { [label]: oldVersion } }]);
  assert.equal(await h.resolveRecreateImage(inspection('victim', legacyId, false)), ref(oldVersion));
  assert.deepEqual(h.commands, [['tag', legacyId, ref(oldVersion)]]);
  assert.deepEqual(h.execCalls, []);
});

await test('unknown version-tag reads never overwrite a newer build through real edit/recreation', async () => {
  for (const version of [oldVersion, '2030.1.1']) {
    for (const failure of ['timeout', '500', 'null', 'empty', 'malformed']) {
      const tag = ref(version);
      const h = harness([
        { Id: legacyId, RepoTags: [], Labels: { [label]: version } },
        { Id: 'sha256:new-build', RepoTags: [tag], Labels: { [label]: version } },
      ], [], { inspect: (reference) => {
        if (reference !== tag) return;
        if (failure === 'null') return null;
        if (failure === 'empty') return {};
        if (failure === 'malformed') return { Id: 123 };
        throw new Error(failure === 'timeout' ? 'Docker request timed out' : 'Docker error 500: unavailable');
      } });
      const inspected = { ...inspection('victim'), HostConfig: { NetworkMode: 'bridge' } };
      const before = h.imageAt(tag);
      const { row, replacements, recreation } = await editProbe(h, inspected, { realRecreate: true });
      assert.equal(row.status, 'done', row.error);
      assert.deepEqual(replacements.map(r => r.image), [legacyId]);
      assert.deepEqual(recreation.events, [['remove', 'id-victim'], ['run', legacyId]]);
      assert.deepEqual(h.commands, []); assert.deepEqual(h.execCalls, []);
      assert.equal(h.imageAt(tag), before);
      assert.equal(h.imageReads.get(legacyId) ?? 0, 0, 'Unknown tag lookup retains id without another image read');
      console.log(`TAG_LOOKUP_FAILURE => ${JSON.stringify({ version, failure, before,
        selected: replacements[0].image, after: h.imageAt(tag), commands: h.commands })}`);
    }
  }
});

await test('tri-state tag lookup refuses rollback image changes on every inconclusive response', async () => {
  for (const failure of ['timeout', '500', 'null', 'empty', 'malformed', 'null tag', 'numeric tag']) {
    const h = harness([
      { Id: legacyId, RepoTags: [], Labels: { [label]: oldVersion } },
      { Id: 'sha256:newer-local-build', RepoTags: [ref(oldVersion)], Labels: { [label]: oldVersion } },
    ], [], { allowPull: true, inspect: reference => {
      if (reference !== ref(oldVersion)) return;
      if (failure === 'null') return null;
      if (failure === 'empty') return {};
      if (failure === 'malformed') return { Id: 123 };
      if (failure === 'null tag') return { Id: 'sha256:newer-local-build', RepoTags: [null] };
      if (failure === 'numeric tag') return { Id: 'sha256:newer-local-build', RepoTags: [0] };
      throw new Error(failure === 'timeout' ? 'Docker request timed out' : 'Docker error 500: unavailable');
    } });
    assert.equal(await h.localVersionPresence(oldVersion), 'unknown');
    await assert.rejects(h.localVersionExists(oldVersion), {
      message: `Could not check the local image for ${oldVersion}; try again.`,
    });
    const before = h.imageAt(ref(oldVersion));
    const { row, effects } = await rollbackProbe(h, true);
    assert.equal(row.error, `Could not check the local image for ${oldVersion}; try again.`);
    assert.deepEqual(h.commands, []); assert.deepEqual(effects, []);
    assert.equal(h.imageAt(ref(oldVersion)), before);
    console.log(`ROLLBACK_UNKNOWN => ${JSON.stringify({ failure, presence: 'unknown', before,
      after: h.imageAt(ref(oldVersion)), commands: h.commands, effects, status: row.status, error: row.error })}`);
  }
});

await test('the existing download consumer also refuses unknown instead of pulling or building', async () => {
  for (const failure of ['timeout', '500', 'null']) {
    const h = harness([], [], { allowPull: true, inspect: () => {
      if (failure === 'null') return null;
      throw new Error(failure === 'timeout' ? 'Docker request timed out' : 'Docker error 500: unavailable');
    } });
    const download = load('lib/buildAgentImage.ts', {
      fs: { writeFileSync: () => {}, readdirSync: () => [] },
      path: require('node:path'),
      '@/lib/agent-versions': versions,
      '@/lib/agent-images': { ...h, listLocalAgentImages: async () => { throw new Error('Docker request timed out'); } },
      '@/lib/docker-socket': { dockerAvailable: () => true },
    }, { process: { cwd: () => '/unused' }, AbortController });
    await assert.rejects(download.downloadAgentImage({ version: oldVersion }), {
      message: `Could not check the local image for ${oldVersion}; try again.`,
    });
    assert.deepEqual(h.commands, []);
    assert.equal(download.getLastDownloadResult().result, 'failed');
    console.log(`DOWNLOAD_UNKNOWN => ${JSON.stringify({ failure, commands: h.commands,
      error: download.getLastDownloadResult().message })}`);
  }
});

await test('rollback uses an existing tag and pulls only a confirmed missing tag', async () => {
  for (const presence of ['exists', 'missing']) {
    const h = harness(presence === 'exists'
      ? [{ Id: 'sha256:newer-local-build', RepoTags: [ref(oldVersion)], Labels: { [label]: oldVersion } }]
      : [], [], { allowPull: true });
    assert.equal(await h.localVersionPresence(oldVersion), presence);
    assert.equal(await h.localVersionExists(oldVersion), presence === 'exists');
    const { row, effects } = await rollbackProbe(h);
    assert.equal(row.error, 'PROBE STOP before volume access');
    assert.deepEqual(effects, ['volume']);
    const commands = h.commands.map(args => args[0]);
    assert.deepEqual(commands, presence === 'exists' ? [] : ['pull', 'tag', 'tag', 'rmi']);
    console.log(`ROLLBACK_CONFIRMED => ${JSON.stringify({ presence, commands, effects, error: row.error })}`);
  }
});

await test('malformed tag arrays are unknown and never break agents GET or recreate/edit', async () => {
  for (const tags of [[null], [0], [ref(oldVersion), null], [0, ref(oldVersion)], 'invalid', {}]) {
    for (const source of ['inspection', 'listing']) {
      const malformed = { Id: legacyId, RepoTags: tags, Labels: {} };
      const h = source === 'inspection' ? harness([], [malformed]) : harness([malformed]);
      const [agent] = await agentsWith(h, [{ Id: 'id-victim', Names: ['/victim'], ImageID: legacyId,
        Image: 'openclaw-agent-base:latest', State: 'exited', Labels: { AGENT_ID: 'agent_victim' } }]);
      assert.equal(agent.openclawVersion, null);
      assert.equal(agent.newBuildAvailable, false);
      assert.equal(await h.imageOpenClawVersion(legacyId, await h.images()), null);
      assert.equal(await h.resolveRecreateImage(inspection('victim', legacyId, false)), legacyId);
      assert.equal(await editWith(h, inspection('victim', legacyId, false)), legacyId);
      assert.deepEqual(h.commands, []); assert.deepEqual(h.execCalls, []);
      console.log(`MALFORMED_TAGS => ${JSON.stringify({ source, tags, http: 200,
        version: agent.openclawVersion, selected: legacyId, commands: h.commands })}`);
    }
  }
});

await test('resolver preserves all three tag and image states for supported and unsupported versions', async () => {
  const results = [];
  for (const version of [oldVersion, '2030.1.1']) {
    for (const tag of ['exists', 'missing', 'unknown']) {
      for (const image of ['exists', 'missing', 'unknown']) {
        const h = harness([{ Id: legacyId, RepoTags: [], Labels: { [label]: version } }], [], {
          allowPull: true,
          inspect: (reference) => {
            if (![ref(version), legacyId].includes(reference)) return;
            const state = reference === legacyId ? image : tag;
            if (state === 'exists') return { Id: reference === legacyId ? legacyId : 'sha256:new-build' };
            if (state === 'missing') return { message: 'No such image' };
            throw new Error('Docker request timed out');
          },
        });
        const refused = tag === 'missing' && image === 'missing' && !versions.isSupportedVersion(version);
        let selected = 'refused';
        if (refused) await assert.rejects(h.resolveRecreateImage(inspection('victim')), /not available locally/);
        else selected = await h.resolveRecreateImage(inspection('victim'));
        const retainsId = tag === 'unknown' || (tag === 'missing' && image === 'unknown');
        assert.equal(selected, refused ? 'refused' : retainsId ? legacyId : ref(version));
        const commands = h.commands.map(args => args[0]);
        if (tag !== 'missing' || image === 'unknown' || refused) assert.deepEqual(commands, []);
        else if (image === 'exists') assert.deepEqual(commands, ['tag']);
        else assert.deepEqual(commands, ['pull', 'tag', 'tag', 'rmi']);
        assert.deepEqual(h.execCalls, []);
        results.push({ version, tag, image, selected, commands });
      }
    }
  }
  console.log(`RESOLVER_MATRIX => ${JSON.stringify(results)}`);
});

await test('agents GET suppresses exec-only build prompts before and after same-image recreation', async () => {
  const version = versions.newestSupportedVersion();
  const pinnedId = 'sha256:pinned';
  const h = harness([legacy, {
    Id: pinnedId, RepoTags: [ref(version), versions.localRevisionRef(version, versions.pinnedImageRevision(version))],
    Labels: { [label]: version },
  }]);
  assert.equal(versions.newBuildAvailableFor(version, await h.images(), legacyId), true, 'Fixture must reproduce the former prompt');
  const inspected = { ...inspection('agent_victim'), HostConfig: { NetworkMode: 'bridge' } };
  const listing = c => [{ Id: c.Id, Names: [c.Name], ImageID: c.Image, Image: c.Config.Image,
    State: 'running', Labels: { AGENT_ID: 'agent_victim' } }];
  h.answers.set(inspected.Id, version);
  const [before] = await agentsWith(h, listing(inspected));
  assert.equal(before.openclawVersion, version);
  assert.equal(before.updateAvailable, false); assert.equal(before.newBuildAvailable, false);
  const { row, recreation } = await editProbe(h, inspected, { realRecreate: true });
  assert.equal(row.status, 'done', row.error);
  const recreated = recreation.current(); h.answers.set(recreated.Id, version);
  const [after] = await agentsWith(h, listing(recreated));
  assert.equal(recreated.Image, legacyId); assert.equal(after.openclawVersion, version);
  assert.equal(after.newBuildAvailable, false); assert.deepEqual(h.commands, []);
  console.log(`BUILD_PROMPT => ${JSON.stringify({ version, before: { updateAvailable: before.updateAvailable,
    newBuildAvailable: before.newBuildAvailable }, selectedImage: recreated.Image, pinnedImage: pinnedId,
    after: { newBuildAvailable: after.newBuildAvailable } })}`);
});

await test('metadata versions still produce actionable build prompts, including unlisted inspected images', async () => {
  const version = versions.newestSupportedVersion();
  const pinned = { Id: 'sha256:pinned', RepoTags: [ref(version), versions.localRevisionRef(version, versions.pinnedImageRevision(version))],
    Labels: { [label]: version } };
  for (const source of ['label', 'version tag', 'inspected label', 'inspected version tag']) {
    const current = { Id: legacyId, RepoTags: source.includes('version tag') ? [versions.localRevisionRef(version, 'abcdef0')] : [],
      Labels: source.includes('label') ? { [label]: version } : {} };
    const h = source.startsWith('inspected') ? harness([pinned], [current]) : harness([current, pinned]);
    const [agent] = await agentsWith(h, [{ Id: 'id-victim', Names: ['/victim'], ImageID: legacyId,
      Image: legacyId, State: 'exited', Labels: { AGENT_ID: 'agent_victim' } }]);
    assert.equal(agent.openclawVersion, version); assert.equal(agent.newBuildAvailable, true);
    assert.equal(await h.resolveRecreateImage(inspection('victim', legacyId, false)), ref(version));
    assert.deepEqual(h.execCalls, []); assert.deepEqual(h.commands, []);
    console.log(`METADATA_BUILD_PROMPT => ${JSON.stringify({ source, version, newBuildAvailable: agent.newBuildAvailable })}`);
  }
});

await test('exec-only versions remain available for update planning', async () => {
  const version = versions.newestSupportedVersion();
  const h = harness([legacy, { Id: 'sha256:new-version', RepoTags: [ref(version)], Labels: { [label]: version } }]);
  h.answers.set('id-victim', oldVersion);
  const [agent] = await agentsWith(h, [{ Id: 'id-victim', Names: ['/victim'], ImageID: legacyId,
    Image: legacyId, State: 'running', Labels: { AGENT_ID: 'agent_victim' } }]);
  assert.equal(agent.openclawVersion, oldVersion); assert.equal(agent.updateAvailable, true);
  assert.equal(agent.newBuildAvailable, false);
  console.log(`LEGACY_UPDATE_PLANNING => ${JSON.stringify({ version: agent.openclawVersion,
    updateAvailable: agent.updateAvailable, newBuildAvailable: agent.newBuildAvailable })}`);
});

await test('a version tag found by image-id inspection can select an unlabelled image', async () => {
  const h = harness([], [{ Id: legacyId, RepoTags: [ref(oldVersion)], Labels: {} }]);
  assert.equal(await h.resolveRecreateImage(inspection('victim')), ref(oldVersion));
  assert.deepEqual(h.execCalls, []); assert.deepEqual(h.commands, []);
});

console.log(`\n${passed} passed`);
