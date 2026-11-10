#!/usr/bin/env node
/** Execute the real startup hook with offline boundaries and a suspended credential repair. */
import assert from 'node:assert/strict';
import { register as registerLoader } from 'node:module';
import { pathToFileURL } from 'node:url';

const modules = {
  './lib/credentials/file-mode': 'export function secureDbFiles() {}',
  './lib/credentials/db': 'export const CREDENTIALS_DB_PATH = "offline";',
  './app/api/gateway/sync': `export async function syncAllAgents() {
    const s = globalThis.__credentialStartupTest;
    s.events.push('sync started');
    await s.sync;
    s.events.push('sync finished');
    if (s.failSync) throw new Error('offline sync failed');
    return { ok: true, summary: 'offline' };
  }`,
  './lib/credentials/delivery': `export async function repairCredentialTimeoutsAtStartup() {
    const s = globalThis.__credentialStartupTest;
    s.events.push('repair started');
    await s.repair;
    s.events.push('repair finished');
  }`,
  './lib/price-schedule-sync': 'export function startPriceScheduleSync() {}',
  './lib/agent-update': 'export async function recoverInterruptedUpdates() { return 0; } export async function resolveFailedUpdatesAtStartup() {}',
  './lib/backup-cron-evidence': 'export function readPreUpdateCronEvidence() {}',
  './lib/agent-update-cron-account': 'export function startCronAccountModelRecovery() {}',
  './lib/agent-recreate': 'export async function recoverInterruptedRecreates() { return 0; }',
  './lib/agent-restore': 'export async function recoverInterruptedRestores() { return 0; }',
  './lib/agent-edit': 'export async function recoverInterruptedEdits() { return 0; }',
  './lib/cold-backup': 'export async function reconcileColdBackups() {}',
  './lib/backups-migration-host': 'export function startBackupsMigration() {}',
  './lib/agent-images': 'export async function repairUntaggedAgentImages() { return []; }',
  './lib/agent-token': 'export async function repairAllTokenFileModes() { return 0; }',
  './lib/agent-jobs-maintenance': 'export function pruneLifecycleRows() { return []; }',
};
registerLoader('data:text/javascript,' + encodeURIComponent(`
  const modules = ${JSON.stringify(modules)};
  export async function resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/instrumentation.ts') && modules[specifier]) {
      return { url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]), shortCircuit: true };
    }
    return next(specifier, context);
  }
`), pathToFileURL(import.meta.dirname + '/'));
const { register } = await import('../instrumentation.ts');
const previousRuntime = process.env.NEXT_RUNTIME;
const tick = () => new Promise((resolve) => setImmediate(resolve));
try {
  process.env.NEXT_RUNTIME = 'nodejs';
  const until = async (ok, ms = 10_000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 5)); };
  for (const failSync of [false, true]) {
    let finishSync;
    let finishRepair;
    const state = globalThis.__credentialStartupTest = {
      events: [], failSync,
      sync: new Promise((resolve) => { finishSync = resolve; }),
      repair: new Promise((resolve) => { finishRepair = resolve; }),
    };
    let returned = false;
    const startup = register().then(() => { returned = true; });
    await until(() => state.events.includes('sync started')); // dynamic imports: wall clock, not turns
    assert.equal(returned, false);
    assert.deepEqual(state.events, ['sync started'], 'repair cannot precede startup sync');
    finishSync();
    let timer;
    try {
      await Promise.race([startup, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Startup blocked on credential repair')), 2000);
      })]);
      await until(() => state.events.includes('repair started')); // dynamic imports: wall clock, not turns
      assert.deepEqual(state.events, ['sync started', 'sync finished', 'repair started']);
      console.log(JSON.stringify({ failSync, startupReturned: returned, repairStillPending: true, events: state.events }));
    } finally {
      clearTimeout(timer);
      finishRepair();
      await tick();
    }
  }
  process.env.NEXT_RUNTIME = 'edge';
  globalThis.__credentialStartupTest = { events: [] };
  await register();
  assert.deepEqual(globalThis.__credentialStartupTest.events, []);
  console.log('3 passed: background repair after sync success/failure; no repair outside Node runtime');
} finally {
  if (previousRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = previousRuntime;
  delete globalThis.__credentialStartupTest;
}
