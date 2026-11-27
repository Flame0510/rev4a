#!/usr/bin/env node
/**
 * The orchestrate agent skill (agent-skills/orchestrate) under `npm test`: runs its own suites, each in its own
 * process and all at once (each takes seconds; together they stay well under the runner's per-file timeout).
 * They work on throwaway git repositories in the OS temp folder and need git, no network and no running instance.
 * The PR suite (test/e2e-pr.mjs) needs a GitHub sandbox repository and is opt-in: it is not run here.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent-skills', 'orchestrate');
const SUITES = ['unit', 'artifacts', 'e2e', 'e2e-fast', 'e2e-recovery', 'e2e-card', 'e2e-trello', 'e2e-keeper', 'e2e-lean'];

const run = name => new Promise(resolve => {
  const child = spawn(process.execPath, [path.join(skill, 'test', `${name}.mjs`)], { cwd: skill, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  child.on('close', code => resolve({ name, code, output }));
});

const results = await Promise.all(SUITES.map(run));
for (const r of results) {
  const last = r.output.trim().split('\n').at(-1) ?? '';
  console.log(`${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.name}: ${r.code === 0 ? last : `exit ${r.code}`}`);
  if (r.code !== 0) console.log(r.output.trim().split('\n').slice(-30).join('\n'));
}
process.exit(results.some(r => r.code !== 0) ? 1 : 0);
