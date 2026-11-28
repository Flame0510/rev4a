#!/usr/bin/env node
/** Exercise the preview and authenticated GET with Docker replaced by in-memory fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const policy = require('../lib/agent-resource-policy.js');
const memory = require('../lib/agent-memory-limit.js');
const stats = require('../lib/docker-stats.js');
const MB = 1024 * 1024;
const version = '2026.10.10';
const input = { version, operation: 'create', targetAgentId: 'preview', limitMb: null };
const facts = async () => ({ dockerTotalMb: 7834, dockerDesktop: true, containers: [] });
const agentContainer = 'a'.repeat(64);
const plainContainer = 'b'.repeat(64);
const fakeToken = 'synthetic-secret-resource-preview';

function load(file, mocks, globals = {}) {
  const source = ts.transpileModule(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, setTimeout, clearTimeout, AbortController,
    require(id) {
      assert.ok(Object.hasOwn(mocks, id), 'Unexpected dependency: ' + id);
      return mocks[id];
    },
    ...globals,
  };
  vm.runInNewContext(source, context, { filename: file });
  return module.exports;
}

function dockerFacts(apiPath, timeoutMs) {
  assert.ok(timeoutMs > 0 && timeoutMs <= 5000);
  if (apiPath === '/info') return { MemTotal: 7834 * MB, OperatingSystem: 'Docker Desktop' };
  if (apiPath === '/containers/json') return [{ Id: agentContainer }, { Id: plainContainer }];
  if (apiPath === '/containers/' + agentContainer + '/json') {
    return {
      State: { Running: true }, HostConfig: { Memory: 0 },
      Config: { Labels: { AGENT_ID: 'running' }, Env: ['TOKEN=' + fakeToken, 'AGENT_NAME= test\u0000\u009f '] },
    };
  }
  if (apiPath === '/containers/' + plainContainer + '/json') {
    return {
      Name: '/database', State: { Running: true }, HostConfig: { Memory: 0 },
      Config: { Env: ['AGENT_NAME=' + fakeToken] },
    };
  }
  return { memory_stats: { usage: apiPath.includes(agentContainer) ? 2215 * MB : 0 } };
}

let dockerReads = 0;
const preflight = load('lib/agent-resource-preflight.ts', {
  '@/lib/docker-socket-path': { dockerRequestJson: async (method, apiPath, timeoutMs) => {
    assert.equal(method, 'GET');
    dockerReads++;
    return dockerFacts(apiPath, timeoutMs);
  } },
  '@/lib/docker-stats': stats,
  '@/lib/agent-resource-policy': policy,
});

let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log('ok   ' + name);
}

await test('an admitted preview leaves no claim for a later acquire', async () => {
  const preview = await preflight.previewAgentResources(input, facts);
  assert.equal(preview.ok, true);
  assert.equal(preview.breakdown.requiredMb, 5120);
  assert.equal(preview.breakdown.shortfallMb, 0);
  const release = await preflight.acquireAgentResourcePreflight({ ...input, targetAgentId: 'separate-create' }, facts);
  release();
});

await test('preview accounts for active claims and leaves them available for their owners to release', async () => {
  const release = await preflight.acquireAgentResourcePreflight({ ...input, targetAgentId: 'in-flight' }, facts);
  try {
    const preview = await preflight.previewAgentResources(input, facts);
    assert.equal(preview.code, 'insufficient-host');
    assert.deepEqual(preview.breakdown.others, [
      { agentId: 'in-flight', name: null, reservedMb: 4096, basis: 'claim', kind: 'agent' },
    ]);
    assert.equal(preview.breakdown.suggestion.stopAgentId, null);
    const duplicate = await preflight.previewAgentResources({ ...input, targetAgentId: 'in-flight' }, facts);
    assert.equal(duplicate.code, 'duplicate-claim');
  } finally {
    release();
  }
  assert.equal((await preflight.previewAgentResources(input, facts)).ok, true);
});

await test('a running Worker with a 4096 MB claim is excluded from stop suggestions', async () => {
  const dockerTotalMb = 8700;
  const emptyHost = async () => ({ dockerTotalMb, containers: [] });
  const release = await preflight.acquireAgentResourcePreflight({ ...input, targetAgentId: 'worker', limitMb: 4096 }, emptyHost);
  try {
    for (const [limitMb, usageMb, basis] of [[4096, null, 'limit'], [null, 4096, 'usage'], [2048, null, 'claim']]) {
      const running = async () => ({
        dockerTotalMb,
        containers: [{ agentId: 'worker', name: 'Worker', limitMb, usageMb }],
      });
      const preview = await preflight.previewAgentResources(input, running);
      const worker = preview.breakdown.others[0];
      assert.equal(worker.basis, basis);
      assert.equal(worker.claimed, true);
      assert.equal(preview.breakdown.suggestion.stopAgentId, null);
      assert.equal(preview.breakdown.suggestion.freesMb, null);
      assert.match(preview.error, /To continue, stop running agents/);
      if (limitMb === 4096) {
        assert.equal(preview.breakdown.requiredMb, 9216);
        const stopped = await preflight.previewAgentResources(input, emptyHost);
        assert.deepEqual([stopped.ok, stopped.code, stopped.breakdown.requiredMb, stopped.breakdown.shortfallMb],
          [false, 'insufficient-host', 9216, 516]);
        console.log(JSON.stringify({ claimed: worker.claimed, suggestion: preview.breakdown.suggestion, afterStop: [stopped.ok, stopped.code, stopped.breakdown.requiredMb, stopped.breakdown.shortfallMb] }));
      }
    }
    const worker = { agentId: 'worker', name: 'Worker', limitMb: 4096, usageMb: null };
    const duplicateContainers = await preflight.previewAgentResources(input, async () => ({ dockerTotalMb: 12000, containers: [worker, worker] }));
    assert.equal(duplicateContainers.breakdown.shortfallMb, 1312);
    assert.equal(duplicateContainers.breakdown.suggestion.stopAgentId, null);
  } finally {
    release();
  }
});

await test('a facts read failure returns the existing unknown-host message', async () => {
  const preview = await preflight.previewAgentResources(input, async () => { throw new Error(fakeToken); });
  assert.deepEqual({ ...preview }, {
    ok: false, code: 'unknown-host',
    error: 'Docker memory capacity or running-container statistics could not be read. Check Docker and retry; nothing was changed.',
  });
});

await test('Docker facts include sanitized agent names, plain container names and Desktop status', async () => {
  const result = await preflight.readDockerResourceFacts();
  assert.equal(result.dockerDesktop, true);
  assert.equal(result.containers.find((entry) => entry.agentId === 'running').name, 'test');
  assert.equal(result.containers.find((entry) => entry.agentId === null).name, 'database');
  assert.ok(!JSON.stringify(result).includes(fakeToken));
  const controls = '\u0000\u007f\u009f\u200b\u200f\u202a\u202e\u2060\u2066\u2069\ufeff';
  const expected = 'a'.repeat(79) + '😀';
  for (const [raw, name] of [[' ' + controls + expected + 'x ', expected], [' ' + controls + ' ', null]]) {
    const sanitized = await preflight.readDockerResourceFacts(async (apiPath, timeoutMs) => {
      const data = dockerFacts(apiPath, timeoutMs);
      if (apiPath === '/info') data.OperatingSystem = 'Linux';
      if (data.Config?.Labels?.AGENT_ID) data.Config.Env[1] = 'AGENT_NAME=' + raw;
      return data;
    });
    const actual = sanitized.containers.find((entry) => entry.agentId === 'running').name;
    assert.equal(sanitized.dockerDesktop, false);
    assert.equal(actual, name);
    const syntheticTokenPresent = JSON.stringify(sanitized).includes(fakeToken);
    assert.equal(syntheticTokenPresent, false);
    console.log(JSON.stringify({ codePoints: actual ? Array.from(actual).length : 0, name: actual, syntheticTokenPresent }));
  }
});

function fakeClock() {
  const timers = new Map();
  let now = 0;
  let nextTimer = 0;
  return {
    setTimeout(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, { fn, at }] of timers) {
        if (at <= now) {
          timers.delete(id);
          fn();
        }
      }
    },
  };
}

let authDenied = false;
let images = [];
let imageReadMode = 'ready';
const imageClock = fakeClock();
const imageRequests = [];
const openRequests = new Set();
const socketPath = load('lib/docker-socket-path.js', {
  http: {
    request({ method, path }, onResponse) {
      assert.equal(method, 'GET');
      const isImage = path.startsWith('/images/json?');
      assert.ok(isImage || path.startsWith('/containers/json?all=true&'));
      const req = new EventEmitter();
      const request = { path, timeoutMs: null };
      imageRequests.push(request);
      req.setTimeout = (timeoutMs) => { request.timeoutMs = timeoutMs; };
      req.destroy = (error) => {
        if (openRequests.delete(req)) req.emit('error', error);
      };
      req.end = () => {
        openRequests.add(req);
        if (imageReadMode === 'pending' || (imageReadMode === 'reject' && !isImage)) return;
        queueMicrotask(() => {
          if (!openRequests.delete(req)) return;
          if (imageReadMode === 'reject') {
            req.emit('error', new Error('Docker read rejected'));
            return;
          }
          const res = Object.assign(new EventEmitter(), { statusCode: 200 });
          onResponse(res);
          res.emit('data', JSON.stringify(isImage ? images : []));
          res.emit('end');
        });
      };
      return req;
    },
  },
  fs: { accessSync() {}, constants: { R_OK: 4, W_OK: 2 } },
  os: { homedir: () => assert.fail('Mock socket should resolve first') },
  path: { join: () => assert.fail('Mock socket should resolve first') },
  child_process: { execFileSync: () => assert.fail('Docker CLI is forbidden in this test') },
}, { process: { env: { DOCKER_HOST: 'unix:///mock/docker.sock' } } });
const agentImages = load('lib/agent-images.ts', {
  child_process: { spawn: () => assert.fail('Docker CLI is forbidden in this test') },
  '@/lib/docker-exec': {},
  '@/lib/docker-socket': load('lib/docker-socket.ts', { './docker-socket-path': socketPath }),
  '@/lib/agent-versions': load('lib/agent-versions.ts', {
    './agent-versions.json': require('../lib/agent-versions.json'),
    './image-revision': require('../lib/image-revision.js'),
  }, { process: { env: {} } }),
}, imageClock);
const route = load('app/api/agents/create/resources/route.ts', {
  'next/server': { NextResponse: Response },
  '@/lib/rev4a-auth': { requireAuthJWT: async () => authDenied ? new Response(null, { status: 401 }) : null },
  '@/lib/agent-memory-limit': memory,
  '@/lib/agent-images': agentImages,
  '@/lib/agent-resource-preflight': preflight,
});
const get = (query = '') => route.GET({ nextUrl: new URL('http://localhost/api/agents/create/resources' + query) });

await test('GET denies unauthenticated requests before validating or reading Docker', async () => {
  authDenied = true;
  const before = dockerReads;
  assert.equal((await get('?limitMb=bad')).status, 401);
  assert.equal(imageRequests.length, 0);
  assert.equal(dockerReads, before);
  authDenied = false;
});

await test('GET rejects invalid limits with the Create parser before reading images', async () => {
  for (const limit of ['bad', '1', '2.5', '-4096', '1048577']) {
    const response = await get('?limitMb=' + limit);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Memory limit/);
  }
  assert.equal(imageRequests.length, 0);
});

await test('GET without a supported local image returns the no-image error', async () => {
  const before = dockerReads;
  const response = await get();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: false, code: 'no-image',
    error: 'No supported agent image is downloaded. Download it from the Agents page first.',
  });
  assert.equal(dockerReads, before);
});

await test('GET closes both Docker requests at the five-second deadline and returns unknown-host', async () => {
  imageReadMode = 'pending';
  const firstRequest = imageRequests.length;
  const before = dockerReads;
  const previews = Array.from({ length: 5 }, () => get());
  await new Promise(setImmediate);
  assert.equal(openRequests.size, 10);
  imageClock.advance(4999);
  assert.equal(openRequests.size, 10);
  imageClock.advance(1);
  for (const preview of previews) {
    const response = await preview;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: false, code: 'unknown-host',
      error: 'Docker could not be read. Check that Docker is running, then retry.',
    });
  }
  const started = imageRequests.length - firstRequest;
  const withTimeout = imageRequests.slice(firstRequest).filter(({ timeoutMs }) => timeoutMs === 5000).length;
  assert.deepEqual([started, openRequests.size, withTimeout], [10, 0, 10]);
  assert.equal(dockerReads, before);
  console.log(JSON.stringify({ status: 200, code: 'unknown-host', started, open: openRequests.size, withTimeout }));
});

await test('GET returns unknown-host after a rejected read and cancels its pending sibling', async () => {
  imageReadMode = 'reject';
  const response = await get();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.code, 'unknown-host');
  assert.equal(body.error, 'Docker could not be read. Check that Docker is running, then retry.');
  assert.equal(openRequests.size, 0);
  console.log(JSON.stringify({ status: response.status, ...body, open: openRequests.size }));
  imageReadMode = 'ready';
});

await test('GET previews the selected version with omitted, empty, zero and explicit limits', async () => {
  images = ['2026.9.9', version].map((tag) => ({ Id: tag, RepoTags: ['openclaw-agent-base:' + tag] }));
  for (const [query, basis] of [['', 'policy'], ['?limitMb=', 'policy'], ['?limitMb=0', 'policy'], ['?limitMb=4096', 'limit']]) {
    const response = await get(query);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.version, version);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'insufficient-host');
    assert.equal(body.breakdown.target.basis, basis);
    assert.equal(body.breakdown.requiredMb, 8359);
    assert.match(body.error, /stop "test" \(frees 3.16 GB\)/);
    assert.ok(!JSON.stringify(body).includes(fakeToken));
  }
});

await test('GET distinguishes invalid, below-floor and insufficient limits', async () => {
  const cases = [
    [255, 400, undefined], [256, 200, 'limit-too-low'], [4095, 200, 'limit-too-low'],
    [4096, 200, 'insufficient-host'], [1048576, 200, 'insufficient-host'], [1048577, 400, undefined],
  ];
  const observed = [];
  for (const [mb, status, code] of cases) {
    const response = await get('?limitMb=' + mb);
    const body = await response.json();
    assert.equal(response.status, status);
    assert.equal(body.code, code);
    observed.push([mb, code ?? response.status]);
  }
  console.log(JSON.stringify({ limitOutcomes: observed }));
});

// Use the same JSX and hook harness style as the other page-client tests.
function createWizard(initialPreview) {
  const clock = fakeClock();
  const slots = [];
  const requests = [];
  let index, effects, tree;
  let preview = initialPreview;
  function memo(fn, deps) {
    const slot = index++;
    const previous = slots[slot];
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
      slots[slot] = { value: fn(previous?.value), deps };
    }
    return slots[slot].value;
  }
  const react = {
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = initial;
      return [slots[slot], (value) => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }];
    },
    useRef: (initial) => memo(() => ({ current: initial }), []),
    useMemo: memo,
    useCallback: (fn, deps) => memo(() => fn, deps),
    useEffect: (fn, deps) => memo((effect) => {
      const next = {};
      effects.push(() => { effect?.cleanup?.(); next.cleanup = fn(); });
      return next;
    }, deps),
  };
  const ui = Object.fromEntries(['Button', 'Input', 'MemoryLimitPicker', 'Surface', 'TemplateOption'].map((name) => [name, function primitive() {}]));
  ui.useDockerTotalMb = () => 7834;
  const { default: CreatePage } = load('app/agents/create/PageClient.tsx', {
    react, 'react/jsx-runtime': require('react/jsx-runtime'),
    'next/navigation': { useRouter: () => ({}) },
    '../../components/ui': ui,
    '../BrowserAccessSection': { useControlUiPublicUrl: () => undefined },
    '@/lib/agent-ports': load('lib/agent-ports.ts', {}),
    '@/lib/agent-resource-policy': policy,
  }, {
    ...clock,
    async fetch(url, options) {
      if (url === '/api/agents/ports') return Response.json({ ports: [] });
      if (url === '/api/agents/create' && options.method === 'POST') {
        preview = await preflight.previewAgentResources(input);
        return Response.json({ success: true, noModel: true, containerName: 'new-agent', containerId: 'fixture' });
      }
      assert.ok(url.startsWith('/api/agents/create/resources'));
      requests.push({ url, signal: options.signal });
      return Response.json(preview);
    },
  });
  function render() {
    index = 0;
    effects = [];
    tree = CreatePage({ templates: [{ id: 'atlas', files: [] }], models: [], usedNames: [], usedPorts: [], openclawVersion: version });
    for (const run of effects) run();
  }
  function* nodes(element) {
    if (Array.isArray(element)) {
      for (const child of element) yield* nodes(child);
    } else if (element?.props) {
      yield element;
      yield* nodes(element.props.children);
    }
  }
  const find = (type, match = () => true) => {
    const element = [...nodes(tree)].find((node) => node.type === ui[type] && match(node.props));
    assert.ok(element, 'Could not find ' + type);
    return element.props;
  };
  const button = (label) => find('Button', ({ children }) => children === label);
  function text(element) {
    if (Array.isArray(element)) return element.map(text).join('');
    if (element?.props) return text(element.props.children);
    return typeof element === 'string' || typeof element === 'number' ? String(element) : '';
  }
  async function advance(ms) {
    clock.advance(ms);
    // Allow both fetch and Response.json to settle before rendering the result.
    await new Promise(setImmediate);
    render();
  }
  function configure(name) {
    find('TemplateOption').onClick();
    render();
    button('Next').onClick();
    render();
    find('Input', ({ label }) => label === 'Agent Name').onChange({ target: { value: name } });
    render();
  }
  render();
  return { render, advance, configure, requests, find, button, text: () => text(tree), setPreview(value) { preview = value; } };
}

await test('Create Another clears and reruns the memory check with the same limit', async () => {
  const wizard = createWizard(await preflight.previewAgentResources(input, facts));
  wizard.configure('First Agent');
  await wizard.advance(399);
  const getsAt399Ms = wizard.requests.length;
  assert.equal(getsAt399Ms, 0);
  await wizard.advance(1);
  const before = 'Memory: needs 5 of 7.65 GB available in Docker.';
  assert.ok(wizard.text().includes(before));
  assert.equal(wizard.requests.length, 1);
  await wizard.button('Deploy Agent').onClick();
  wizard.render();
  wizard.button('Create Another').onClick();
  wizard.render();
  wizard.configure('Second Agent');
  assert.ok(wizard.text().includes('Checking memory…'));
  assert.ok(!wizard.text().includes(before));
  await wizard.advance(400);
  assert.equal(wizard.requests.length, 2);
  assert.equal(wizard.requests[0].url, wizard.requests[1].url);
  const refusal = wizard.find('Surface', ({ tone }) => tone === 'danger').children[0].props.children;
  assert.match(refusal, /creating it needs 8.16 GB/);
  assert.equal(wizard.button('Deploy Agent').disabled, false);
  console.log(JSON.stringify({ getsAt399Ms, getsAfterReset: wizard.requests.length, before, after: refusal }));
});

await test('invalid limits suppress GETs and malformed success bodies show the fallback', async () => {
  const wizard = createWizard({ ok: true });
  wizard.configure('Example Agent');
  wizard.find('MemoryLimitPicker').onChange(null, 'Invalid custom size');
  wizard.render();
  await wizard.advance(400);
  assert.equal(wizard.requests.length, 0);
  const invalid = 'Fix the memory limit to check memory.';
  assert.ok(wizard.text().includes(invalid));
  const getsWithInvalidLimit = wizard.requests.length;
  const fallback = 'Memory check unavailable: Could not check Docker memory. Try again later.';
  for (const [limit, preview] of [[null, { ok: true }], [4096, { ok: true, breakdown: { requiredMb: 5120, dockerTotalMb: '7834' } }]]) {
    wizard.setPreview(preview);
    wizard.find('MemoryLimitPicker').onChange(limit, '');
    wizard.render();
    await wizard.advance(400);
    assert.ok(wizard.text().includes(fallback));
  }
  assert.equal(wizard.requests.length, 2);
  assert.equal(wizard.requests[0].signal.aborted, true);
  console.log(JSON.stringify({ getsWithInvalidLimit, invalid, malformedSuccess: fallback }));
});

console.log('\n' + passed + ' passed');
