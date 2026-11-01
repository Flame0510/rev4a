// A process group per command. Optional artifact scopes are allocated before spawning and retired only after
// a successful command and proof that its group is gone. SIGKILL/crashes retain evidence for explicit recovery.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { beginArtifacts, endArtifacts, scopeIdle } from './artifacts.mjs';

const [timeoutArg, cmd, policyArg] = process.argv.slice(2);
try { fs.writeFileSync('/proc/self/oom_score_adj', '500'); } catch { /* not Linux or not allowed */ }
let session;
try {
  session = beginArtifacts(JSON.parse(policyArg ?? '{"enabled":false,"minFreeBytes":0,"disposable":[]}'));
} catch (e) {
  process.stderr.write(`orch: ARTIFACT_INFRA: ${e.message}\n`);
  process.exit(125);
}
const env = session ? { ...process.env, TMPDIR: session.temp, TMP: session.temp, TEMP: session.temp, ORCH_ARTIFACTS_DIR: session.scope } : process.env;
const child = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: 'inherit', env });
const groupAlive = () => { try { process.kill(-child.pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const killGroup = sig => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
const pause = ms => new Promise(r => setTimeout(r, ms));
let timedOut = false; let interrupted = false; let finishing = false;
const timer = setTimeout(() => {
  timedOut = true;
  killGroup('SIGTERM');
  setTimeout(() => killGroup('SIGKILL'), 10_000).unref();
}, Number(timeoutArg) * 1000);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { interrupted = true; killGroup('SIGKILL'); });

async function finish(code) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timer);
  killGroup('SIGTERM');
  for (let i = 0; i < 30 && groupAlive(); i++) await pause(100);
  if (groupAlive()) killGroup('SIGKILL');
  for (let i = 0; i < 20 && groupAlive(); i++) await pause(100);
  if (timedOut || interrupted) code = 124;
  try { endArtifacts(session, { code, interrupted, quiescent: !groupAlive() && scopeIdle(session) }); }
  catch (e) { process.stderr.write(`orch: ARTIFACT_INFRA: cleanup failed: ${e.message}\n`); code = 125; }
  if (timedOut) process.stderr.write('\norch: timed out, the command and its processes were stopped\n');
  process.exit(code);
}
child.on('exit', (code, signal) => {
  if (signal) process.stderr.write(`\norch: the command was killed by ${signal}\n`);
  void finish(signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 1));
});
child.on('error', e => { process.stderr.write(`orch: cannot start the command: ${e.message}\n`); void finish(127); });
