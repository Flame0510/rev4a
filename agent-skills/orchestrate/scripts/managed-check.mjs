// Use the same environment filtering, timeout and artifact policy as the gate for worker/checker commands.
import { loadConfig, primaryRoot } from './lib/config.mjs';
import { sh } from './lib/util.mjs';
const [command, timeout = '1800'] = process.argv.slice(2);
if (!command || !/^\d+$/.test(timeout) || Number(timeout) < 1) {
  console.error('Usage: node <skill>/scripts/managed-check.mjs "command" [timeoutSeconds]');
  process.exit(1);
}
loadConfig(primaryRoot());
const r = sh(command, { cwd: process.cwd(), timeoutSec: Number(timeout) });
process.stdout.write(r.out);
process.exitCode = r.infra ? 3 : r.code;
