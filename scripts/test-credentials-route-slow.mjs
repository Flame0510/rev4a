#!/usr/bin/env node
/** Real PUT + delivery + concurrency limiter, with virtual time and offline boundaries. */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const stubs = {
  'next/server': 'export const NextResponse = { json: (body, init) => Response.json(body, init) };',
  '@/lib/rev4a-auth': 'export async function requireAuthJWT() { return null; }',
  '@/lib/agent-busy': `
    export async function agentBusyReason() { return null; }
    export function currentBusyReason() { throw new Error('Unexpected startup ownership check'); }
  `,
  '@/lib/agent-readiness': 'export async function waitForGatewayReady() { return true; }',
  '@/lib/rev4a-skills': 'export async function ensureRev4aSkill() {}',
  '@/lib/subscriptions': `export async function listAgentContainers() {
    const s = globalThis.__credentialRouteTest;
    await s.wait(s.discoveryMs);
    return s.agents;
  }`,
  '@/lib/credentials/runtime': `export async function agentUsesCodex() {
    await globalThis.__credentialRouteTest.wait(13000);
    return false;
  }`,
  './vault': `
    export function getProfile() { return { providerId: 'github-pat' }; }
    export function getSecret() { return { token: 'ghp_offline_route_test' }; }
    export function markSynced() {}
    export function markDesynced() {}
  `,
  './assignments': `
    const s = () => globalThis.__credentialRouteTest;
    export function getAssignment() { return s().assignment; }
    export function listAssignments() { return s().assignment ? [s().assignment] : []; }
    export function listLiveForAgent() { return listAssignments(); }
    export function listAllAssignments() { return listAssignments(); }
    export function recordAssignment(profileId, agentId, next) { s().assignment = { profileId, agentId, ...next }; }
    export function supersedeSiblings() {}
    export function deleteAssignment() {}
    export function setAssignmentError() {}
    export function removalRecordState() { throw new Error('unexpected removal'); }
    export function parseMode(value) { return ['env', 'protected'].includes(value) ? value : null; }
  `,
  './providers': 'export function getProvider() { return {}; }',
  './detect': 'export async function listAgentContainers() { return []; }',
};
const docker = `
  export { mapWithConcurrency } from ${JSON.stringify(new URL('../lib/docker-exec.ts', import.meta.url).href)};
  export async function dockerExec(container, argv, opts) {
    return globalThis.__credentialRouteTest.exec({ container, argv, opts });
  }
  export async function dockerExecWithInput(container, argv, input, opts) {
    return globalThis.__credentialRouteTest.exec({ container, argv, input, opts });
  }
`;
register('data:text/javascript,' + encodeURIComponent(`
  import { existsSync } from 'node:fs';
  import { pathToFileURL } from 'node:url';
  const root = ${JSON.stringify(new URL('../', import.meta.url).href)};
  const stubs = ${JSON.stringify(stubs)};
  export async function resolve(specifier, context, next) {
    if (specifier === '@/lib/docker-socket') return { url: 'data:text/javascript,export function resolveDockerSocket() { throw new Error("Real Docker forbidden"); }', shortCircuit: true };
    if (specifier === '@/lib/docker-exec') return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(docker)}), shortCircuit: true };
    const key = specifier === '@/lib/credentials/vault' ? './vault'
      : specifier === '@/lib/credentials/assignments' ? './assignments' : specifier;
    if (stubs[key] && (specifier.startsWith('@/') || specifier === 'next/server' || context.parentURL?.endsWith('/credentials/delivery.ts'))) {
      return { url: 'data:text/javascript,' + encodeURIComponent(stubs[key]), shortCircuit: true };
    }
    if (specifier.startsWith('@/')) return next(new URL(specifier.slice(2) + '.ts', root).href, context);
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !/\\.\\w+$/.test(specifier)) {
      for (const ext of ['.ts', '.js']) {
        const p = new URL(specifier + ext, context.parentURL);
        if (existsSync(p)) return next(p.href, context);
      }
    }
    return next(specifier, context);
  }
`), pathToFileURL(import.meta.dirname + '/'));
const route = await import('../app/api/credentials/[id]/assignments/route.ts');

async function probe(fleet, discoveryMs) {
  let clock = 0;
  let pending = [];
  const wait = (ms) => ms ? new Promise((resolve) => pending.push({ at: clock + ms, resolve })) : Promise.resolve();
  const calls = [];
  const state = globalThis.__credentialRouteTest = {
    discoveryMs, wait, assignment: null,
    agents: Array.from({ length: fleet }, (_, i) => ({ container: 'agent-' + i, agentId: '' + i, running: true })),
    exec: async (call) => {
      calls.push(call);
      const { argv, opts, input } = call;
      let ms = 1000;
      if (argv.includes('patch')) { assert.equal(opts.timeoutMs, 150000); ms = 123000; }
      else if (argv.includes('reload')) { assert.equal(opts.timeoutMs, 150000); ms = 122000; }
      else if (input?.includes('"method"')) { assert.equal(opts.timeoutMs, 30000); ms = 2000; }
      await wait(ms);
      if (argv[1] === '--version') return 'OpenClaw 2026.10.10';
      if (argv[0] === 'sh' && argv[2].startsWith('cat ')) return '\x04';
      return '';
    },
  };
  let finished = false;
  let response;
  let error;
  const request = new Request('http://offline/api/credentials/profile/assignments', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'agent-0', enabled: true }),
  });
  const operation = route.PUT(request, { params: Promise.resolve({ id: 'profile' }) })
    .then((r) => { response = r; }, (e) => { error = e; }).finally(() => { finished = true; });
  while (!finished) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!pending.length) continue;
    clock = Math.min(...pending.map((p) => p.at));
    const ready = pending.filter((p) => p.at === clock);
    pending = pending.filter((p) => p.at !== clock);
    ready.forEach((p) => p.resolve());
  }
  await operation;
  if (error) throw error;
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results[0].status, 'ok');
  assert.equal(body.agents.length, fleet);
  assert.equal(state.assignment.ok, true);
  assert.ok(calls.every((c) => !JSON.stringify([c.argv, c.opts]).includes('ghp_offline_route_test')));
  const expected = 254000 + 4 * discoveryMs + Math.ceil(fleet / 6) * 13000;
  assert.equal(clock, expected);
  console.log(JSON.stringify({ fleet, discoveryMs, elapsedMs: clock, maxDuration: route.maxDuration, httpStatus: response.status, result: body.results[0].status }));
}
try {
  for (const fleet of [1, 7, 19, 25, 49, 61]) await probe(fleet, 0);
  await probe(1, 15998);
  console.log('7 passed: slow delivery and fleet refresh retain their outcome beyond serverless maxDuration');
} finally { delete globalThis.__credentialRouteTest; }
