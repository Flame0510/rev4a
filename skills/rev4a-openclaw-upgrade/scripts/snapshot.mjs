#!/usr/bin/env node
// snapshot.mjs --container <agent> --label <before|after|...> [options]: see USAGE below.
//
// Capture of everything Rev4a reads from one agent's OpenClaw: the CLI commands, the Gateway
// RPCs, files and SQLite on the volume, runtime facts (version, memory, restarts, listening
// ports), the Rev4a API answers built on them, and the log lines that matter. For each item it
// writes `<item>.raw` (stdout, secrets redacted), `<item>.err` (stderr, when any) and, when the
// output is JSON, `<item>.shape`; index.json holds the machine facts (rewritten after every item,
// so an interrupted snapshot can still be read) and index.md a summary for people.
//
// It refuses to produce a snapshot that would compare as "no change" while nothing was read:
//   - preflight: the container exists and runs, its Gateway answers /startupz "started", and the
//     Rev4a API answers 200 and lists the agent; any failure → `ok:false`, exit 2;
//   - settle: waits until the container has been up --settle seconds and CPU is below --max-cpu
//     (a snapshot taken 38 s after a start timed out on `dashboard` while CPU was at 561 %);
//   - each failed item is retried once after --retry-wait seconds; an item counts as failed on a
//     non-zero exit, an HTTP status outside 2xx, `{ok:false}` or a top-level `error`;
//   - when more than a third of the required items still fail, the snapshot is `ok:false`, exit 2.
//
// Not quite read-only, and not only this agent:
//   - `openclaw dashboard --json` issues a single-use Control UI link (10 minutes);
//   - `GET /api/agents/<id>/update` may record that a failed update was later proved fine;
//   - --fleet adds the Rev4a pages that run the OpenClaw CLI in EVERY running agent (crons, skills,
//     summaries, system health, gateway state). Each CLI start costs about a CPU-second and
//     100-250 MB per agent: on a small Docker VM that load once got an owner's Gateway killed. Use
//     --fleet only when the other agents are stopped or the host has room.
// Every in-container command runs under `timeout -k 5`, so a stalled CLI never outlives its item.
import fs from 'node:fs';
import path from 'node:path';
import {
  UsageError, Untrustworthy, api, assertOutsideGit, assertTestAgent, firstJson, gw, inContainer,
  inspectAgent, jsonProblem, main, redact, run, shapeOf, sleep, workDir,
  cronJobs, doctorBoxes, listeningPorts, stripStamps,
  snapshotSettleSample, databaseVersionsProblem,
  seedSkillExpected,
  usageCacheProblem,
} from './lib.mjs';

const USAGE = `usage: snapshot.mjs --container <agent container> --label <label> [options]

  --work <dir>         the run's work directory (default $REV4A_UPGRADE_WORK or <tmpdir>/rev4a-openclaw-upgrade/run)
  --out <dir>          where to write (default <work>/snap-<label>); must be empty or missing
  --force              empty a non-empty --out first
  --base-url <url>     the Rev4a under test (default $REV4A_BASE_URL or http://localhost:3740)
  --fleet              also read the Rev4a pages that run the CLI in every running agent
  --logs-since <t>     window for notable log lines, a docker logs --since value (default 3h)
  --settle <s>         minimum container uptime before reading (default 180; 0 skips the wait)
  --max-cpu <pct>      wait until the container's CPU is below this (default 80)
  --retry-wait <s>     pause before retrying a failed item once (default 30)
  --i-own-this-agent   allow an agent not named oc-eval-* (never one someone uses)

Exit: 0 snapshot complete; 1 usage/env error; 2 snapshot not trustworthy (index.json has ok:false).`;

const SPEC = {
  container: 'string', label: 'string', work: 'string', out: 'string', force: 'boolean', 'base-url': 'string',
  fleet: 'boolean', 'logs-since': 'string', settle: 'string', 'max-cpu': 'string', 'retry-wait': 'string',
  'i-own-this-agent': 'boolean',
};

// Bumped when items are added, renamed or change meaning; compare.mjs warns when two differ.
const FORMAT_VERSION = 2;
// What seed.mjs creates; without them the cron-runs and skills-info items have nothing to read.
const SEED = 'rev4a-upgrade-seed';
const SEED_AGENT_CRON = 'rev4a-upgrade-seed-agent';
// The MongoDB credential skill Rev4a reads with `skills info` (lib/credentials/mongodb.ts). It
// exists only after a MongoDB switch-on (lib/credentials/delivery.ts), so on a test agent the
// item is expected to fail: it is optional and reported as "not exercised".
const MONGODB_SKILL = 'rev4a-mongodb';

const num = (v, name, min = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new UsageError(`--${name} must be a number ≥ ${min}`);
  return n;
};
// Lines worth reading across releases.
const NOTABLE = /deprecat|retired|removed|migrat|doctor (warnings|changes)|invalid|unknown key|memory pressure|out of memory|security warning|refus|\[entrypoint\].*(fail|not applied|error)/i;
// Rev4a's credentials probe (lib/credentials/detect.ts) runs a shell script whose lines OpenClaw
// echoes into the log; they match the words above and are noise here.
const PROBE_LINE = /^\s*(k\s+[\w:"$]|k\(\)|e\(\)|for t in |done$|sbout=|exit 0$)/;
// The seed's fake Telegram token is refused with a 401 on every poll. Only that exact line is
// dropped: a channel failing for another reason must stay visible.
const FAKE_TOKEN_401 = (l) => /telegram/i.test(l) && /\b401\b/.test(l);

await main(USAGE, SPEC, async (args) => {
  const container = args.container;
  const label = args.label;
  if (!container || !label) throw new UsageError(`--container and --label are required\n\n${USAGE}`);
  if (!/^[\w.-]+$/.test(label)) throw new UsageError('--label may hold letters, digits, ".", "_" and "-" only');
  const settleS = num(args.settle ?? 180, 'settle');
  const maxCpu = num(args['max-cpu'] ?? 80, 'max-cpu', 1);
  const retryWaitS = num(args['retry-wait'] ?? 30, 'retry-wait');
  const logsSince = args['logs-since'] ?? '3h';
  const apiOpts = args['base-url'] ? { baseUrl: args['base-url'] } : {};
  const work = workDir(args);
  const outDir = path.resolve(args.out ?? path.join(work, `snap-${label}`));
  assertOutsideGit(outDir);
  // A refusal needs no Docker access. In particular an unavailable daemon must not delay it.
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length && !args.force) {
    throw new UsageError(`${outDir} is not empty: pick a new --out, or pass --force to empty it`);
  }

  // The guard first: a refused agent leaves nothing behind.
  const agent = inspectAgent(container);
  if (!agent) throw new Untrustworthy(`cannot inspect ${container}: existing snapshot evidence was preserved`);
  assertTestAgent(agent, args);

  // A fresh directory: files left by an earlier run were read as current by compare.mjs.
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) {
    if (!args.force) throw new UsageError(`${outDir} is not empty: pick a new --out, or pass --force to empty it`);
    for (const f of fs.readdirSync(outDir)) fs.rmSync(path.join(outDir, f), { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });

  const takenAt = new Date().toISOString();
  const index = { formatVersion: FORMAT_VERSION, container, label, takenAt, complete: false, ok: null, preflight: {}, seed: null, problems: [], items: [] };
  const writeIndex = () => fs.writeFileSync(path.join(outDir, 'index.json'), redact(JSON.stringify(index, null, 1)));
  const fail = (msg) => { index.ok = false; index.problems.push(redact(msg)); writeIndex(); throw new Untrustworthy(`${msg} (index: ${path.join(outDir, 'index.json')})`); };
  writeIndex();

  // ── Preflight ────────────────────────────────────────────────
  if (!agent) fail(`no container named ${container}`);
  index.preflight.agent = { name: agent.name, agentId: agent.agentId, displayName: agent.displayName, image: agent.image };
  if (!agent.running) fail(`${container} is not running (state ${agent.status}): start it through Rev4a first`);

  // Settle: uptime, Gateway started, CPU calm. The Gateway must answer within the window or the
  // snapshot is refused; a CPU that stays high is recorded and the snapshot goes on.
  const deadline = Date.now() + (settleS + 300) * 1000;
  let startupz = null; let cpu = null; let uptimeS = 0;
  for (;;) {
    const current = inspectAgent(container);
    if (!current?.running) fail(`${container} stopped or disappeared during settling`);
    const z = inContainer(container, 'curl -s --max-time 5 http://127.0.0.1:3000/startupz', { timeoutS: 15 });
    const st = run('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}', container], { timeoutMs: 30_000 });
    ({ uptimeS, cpu, startupz } = snapshotSettleSample(current, z, st));
    if (uptimeS === null) fail(`cannot measure the uptime of ${container}`);
    const started = startupz?.status === 'started';
    if (started && uptimeS >= settleS && cpu !== null && cpu < maxCpu) break;
    if (Date.now() > deadline) break;
    console.log(`settling: uptime ${Math.round(uptimeS)}s/${settleS}s, startupz ${startupz?.status ?? 'no answer'}, cpu ${cpu}%`);
    await sleep(10_000);
  }
  index.preflight.settle = { uptimeS: Math.round(uptimeS), startupz: startupz?.status ?? null, cpu, settled: startupz?.status === 'started' && uptimeS >= settleS && cpu !== null && cpu < maxCpu };
  if (startupz?.status !== 'started') fail(`the Gateway of ${container} never answered /startupz "started" (last: ${JSON.stringify(startupz)})`);
  if (!index.preflight.settle.settled) index.problems.push(`not settled: cpu ${cpu}% (limit ${maxCpu}%), uptime ${Math.round(uptimeS)}s: timings and memory are not idle values`);

  const agentsAnswer = await api('GET', '/api/agents', undefined, apiOpts);
  const listed = Array.isArray(agentsAnswer.json) && agentsAnswer.json.some((a) => a.name === container || (agent.agentId && a.agentId === agent.agentId));
  index.preflight.api = { status: agentsAnswer.status, listed };
  if (agentsAnswer.status !== 200) fail(`the Rev4a API answered ${agentsAnswer.status} to GET /api/agents (${agentsAnswer.text.slice(0, 200)}): wrong --base-url, or REV4A_JWT_SECRET is not the one of the instance under test`);
  if (!listed) fail(`the Rev4a API does not list ${container}: is this the Rev4a that manages this agent?`);
  const id = agent.agentId || container;
  writeIndex();

  // ── Items ────────────────────────────────────────────────────
  /**
   * Run one item, retry once when it fails, write its files and its index entry. `json: false`
   * items are text. `optional` items may fail without making the snapshot untrustworthy; they are
   * reported as "not exercised".
   */
  async function item(name, exec, { json = true, optional = false, validate } = {}) {
    let res; let value; let problem; let attempts = 0;
    for (;;) {
      attempts++;
      res = await exec();
      const status = res.status ?? res.rc;
      const stdout = res.stdout ?? res.text ?? '';
      value = json ? firstJson(stdout) : undefined;
      problem = res.status !== undefined
        ? (res.status < 200 || res.status > 299 ? `HTTP ${res.status}` : null)
        : (res.timedOut ? 'timed out' : res.rc !== 0 ? `exit ${res.rc}` : null);
      if (!problem && json && value === undefined) problem = 'no JSON in the output';
      if (!problem && json) problem = jsonProblem(value);
      if (!problem && json && validate) problem = validate(value);
      if (problem) problem = redact(problem);
      if (!problem || attempts >= 2 || optional) break;
      console.log(`${name}: ${problem}; retrying in ${retryWaitS}s`);
      await sleep(retryWaitS * 1000);
    }
    const stdout = res.stdout ?? res.text ?? '';
    const stderr = res.stderr ?? '';
    fs.writeFileSync(path.join(outDir, `${name}.raw`), redact(stdout));
    if (stderr.trim()) fs.writeFileSync(path.join(outDir, `${name}.err`), redact(stderr));
    if (value !== undefined) fs.writeFileSync(path.join(outDir, `${name}.shape`), shapeOf(value).join('\n') + '\n');
    const empty = value !== undefined && value !== null && typeof value === 'object' && Object.keys(value).length === 0;
    const rec = { name, ok: !problem, rc: res.status ?? res.rc, json: value !== undefined, empty, bytes: stdout.length, attempts, ...(optional ? { optional } : {}), ...(problem ? { problem: `${problem}: ${redact(stderr || stdout).trim().split('\n').slice(-2).join(' ').slice(0, 200)}` } : {}) };
    index.items.push(rec);
    writeIndex();
    console.log(`${rec.ok ? 'ok  ' : 'FAIL'} ${name.padEnd(28)} rc=${String(rec.rc).padEnd(4)} json=${rec.json}${rec.empty ? ' (empty)' : ''}${attempts > 1 ? ` attempts=${attempts}` : ''}${problem ? ` — ${problem}` : ''}`);
    return value;
  }
  const cli = (name, argv, opts) => item(name, () => gw(container, argv, { timeoutS: opts?.timeoutS ?? 90 }), opts);
  const sh = (name, script, opts) => item(name, () => inContainer(container, script, { timeoutS: opts?.timeoutS ?? 60 }), opts);
  const apiItem = (name, p, opts) => item(name, () => api('GET', p, undefined, apiOpts), opts);

  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);

  // ── Runtime facts ────────────────────────────────────────────
  await item('runtime.inspect', () => run('docker', ['inspect', container, '--format',
    '{"image":"{{.Config.Image}}","restarts":{{.RestartCount}},"oomKilled":{{.State.OOMKilled}},"startedAt":"{{.State.StartedAt}}","memoryLimit":{{.HostConfig.Memory}}}']));
  await item('runtime.stats', () => run('docker', ['stats', '--no-stream', '--format', '{"mem":"{{.MemUsage}}","memPerc":"{{.MemPerc}}","cpu":"{{.CPUPerc}}"}', container]));
  await sh('runtime.startupz', 'curl -s --max-time 5 http://127.0.0.1:3000/startupz');
  await cli('runtime.version', ['--version'], { json: false });
  await sh('runtime.last-version', 'cat /root/.openclaw/.last-version', { json: false, optional: true });
  // Ports the Gateway and its derived services listen on: Rev4a publishes one 10-port block from
  // 3000 (lib/agent-ports.ts); a listener outside it is unreachable.
  await item('runtime.listeners', () => {
    const r = inContainer(container, 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null');
    return { ...r, stdout: r.rc === 0 ? JSON.stringify(listeningPorts(r.stdout)) : r.stdout };
  });

  // ── CLI and Gateway RPC, as Rev4a calls them ─────────────────
  const cron = await cli('cli.cron-list', ['cron', 'list', '--json', '--all']);
  const jobs = cronJobs(cron);
  const seedJob = jobs.find((j) => j.name === SEED);
  const seedAgentJob = jobs.find((j) => j.name === SEED_AGENT_CRON);
  if (seedJob) await cli('cli.cron-runs', ['cron', 'runs', '--id', seedJob.id, '--limit', '5']);
  if (seedAgentJob) await cli('cli.cron-runs-agent', ['cron', 'runs', '--id', seedAgentJob.id, '--limit', '5']);
  await cli('cli.status-usage', ['status', '--usage', '--json'], { timeoutS: 150 });
  await cli('cli.models-rev4a', ['models', 'list', '--provider', 'rev4a', '--json']);
  await cli('cli.models-all', ['models', 'list', '--json']);
  await cli('cli.plugins-list', ['plugins', 'list', '--json']);
  await cli('cli.devices-list', ['devices', 'list', '--json']);
  await cli('cli.pairing-list', ['pairing', 'list', '--channel', 'telegram', '--json']);
  await cli('cli.channels-status', ['channels', 'status', '--channel', 'telegram', '--json'], { optional: true });
  // OpenClaw's own view of the skills it loads (bundled, shared via skills.load.extraDirs, workspace).
  const skillListing = await cli('cli.skills-list', ['skills', 'list', '--json']);
  let declaredSeed;
  try { declaredSeed = JSON.parse(fs.readFileSync(path.join(work, 'seed.json'), 'utf8')); } catch { /* fresh agent */ }
  await cli('cli.skills-info-seed', ['skills', 'info', SEED, '--json'], { optional: !seedSkillExpected(declaredSeed, container, skillListing) });
  await cli('cli.skills-info-mongodb', ['skills', 'info', MONGODB_SKILL, '--json'], { optional: true });
  // The raw output is kept (link token redacted) so a failure's reason can be read.
  await cli('cli.dashboard', ['dashboard', '--json']);
  const call = (method, params) => ['gateway', 'call', method, '--json', '--params', JSON.stringify(params)];
  await cli('rpc.sessions-list', call('sessions.list', { limit: 50, archived: 'all' }));
  await cli('rpc.sessions-usage', call('sessions.usage', { agentScope: 'all', startDate: weekAgo, endDate: today, limit: 50 }), { validate: usageCacheProblem });
  await cli('rpc.usage-cost', call('usage.cost', { agentScope: 'all', startDate: weekAgo, endDate: today }), { validate: usageCacheProblem });

  // ── Files and databases on the volume ────────────────────────
  await sh('file.openclaw-json', 'cat /root/.openclaw/openclaw.json');
  // `find` instead of a recursive readdir (Node 20.1+ in the container), skipping plugin
  // node_modules and caches, which are slow and hold fixture databases. node:sqlite needs Node
  // 22.13+ in the image; on an older one the item reports the error instead of "0 databases".
  await sh('file.db-versions', 'cd /root/.openclaw && find . \\( -path ./npm -o -path ./cache -o -path ./workspace -o -path ./tmp \\) -prune -o -name "*.sqlite" -print | node -e \''
    + 'const out = {}; let DatabaseSync;'
    + 'try { ({ DatabaseSync } = require("node:sqlite")); } catch (e) { console.log(JSON.stringify({ error: "node:sqlite unavailable: " + e.message })); process.exit(0); }'
    + 'for (const f of require("fs").readFileSync(0, "utf8").split("\\n").filter(Boolean)) {'
    + '  try { const d = new DatabaseSync(f, { readOnly: true });'
    + '    out[f.replace(/^\\.\\//, "")] = { user_version: d.prepare("pragma user_version").get().user_version,'
    + '      tables: d.prepare("select name from sqlite_master where type = ? order by name").all("table").map((r) => r.name) };'
    + '    d.close(); } catch (e) { out[f.replace(/^\\.\\//, "")] = { error: e.message }; } }'
    + 'console.log(JSON.stringify(out));\'', { validate: databaseVersionsProblem });
  await sh('file.volume-tree',
    'cd /root/.openclaw && find . -maxdepth 3 -not -path "./workspace/*" -not -path "./cache/*" -not -path "./tmp/*" -not -path "./npm/*" -not -path "./media/*" | sort', { json: false });
  // One `du` per path: GNU du counts a directory once, so nested paths after their parent were
  // silently dropped.
  await sh('file.volume-size', 'cd /root/.openclaw && for d in state agents . ; do if [ -e "$d" ]; then du -sk "$d"; fi; done', { json: false });
  // Doctor leaves `*.pre-startup-migration-*.bak` copies behind; they grow with the databases.
  await sh('file.bak-files', 'find /root/.openclaw -type f -name "*.bak*" -exec stat -c "%s %n" {} + 2>/dev/null; true', { json: false });
  // Sync All deletes models.json and auth-profiles.json here (inventory P8); depth 3 cannot see it.
  await sh('file.agent-dir', 'for d in /root/.openclaw/agents/*/agent; do [ -d "$d" ] && ls -la "$d"; done; true', { json: false });
  // Plugins installed on the volume (not in the image): the codex plugin lives here and an image
  // update does not replace it; doctor may.
  await sh('file.volume-plugins',
    'for p in /root/.openclaw/npm/projects/*/node_modules/@openclaw/*/package.json /root/.openclaw/npm/projects/*/node_modules/@openai/codex*/package.json; do [ -f "$p" ] && node -e "const p=require(process.argv[1]);console.log(p.name+\\"@\\"+p.version)" "$p"; done; true', { json: false });
  await sh('file.workspace-skills', 'ls -1 /root/.openclaw/workspace/skills 2>/dev/null; true', { json: false });
  // The workspace and OpenClaw-managed skills: where a release may move memory files or learned skills.
  await sh('file.workspace-tree', 'cd /root/.openclaw && find workspace skills -maxdepth 2 -not -path "workspace/.git*" 2>/dev/null | sort; true', { json: false });

  // ── Rev4a API answers for this agent ─────────────────────────
  // Per-agent answers: they read this agent only.
  await apiItem('api.agents', '/api/agents');
  await apiItem('api.update', `/api/agents/${id}/update`);
  await apiItem('api.channels', `/api/agents/${id}/channels`);
  await apiItem('api.pairing', `/api/agents/${id}/channels/pairing?channel=telegram`);
  await apiItem('api.devices', `/api/agents/${id}/devices`);
  await apiItem('api.memory-limit', `/api/agents/${id}/memory-limit`);
  await apiItem('api.model', `/api/agents/${id}/model`);
  if (seedJob) await apiItem('api.cron-runs', `/api/crons/runs?containerName=${container}&jobId=${seedJob.id}&limit=5`);
  await apiItem('api.plugins', `/api/plugins?agent=${container}&fresh=1`);
  await apiItem('api.memory-context', `/api/memory-context?agent=${container}&fresh=1`);
  await apiItem('api.subscriptions', `/api/subscriptions?agentId=${id}`);
  await apiItem('api.credentials-detect', `/api/credentials/detect?agent=${container}`);
  await apiItem('api.config-json', `/api/agents/config-json?name=${container}`);
  await apiItem('api.costs-agent', `/api/costs/agent?container=${container}`);
  // Costs and proxy metering from Rev4a's own database (no exec): calls metered per agent,
  // errors and calls without a usage block.
  await apiItem('api.costs-usage', '/api/costs/usage?range=today');
  // Sessions come from Rev4a's own database (no exec), newest 2000 rows across agents.
  await apiItem('api.sessions-db', '/api/sessions');

  // Fleet answers: these routes run the OpenClaw CLI in every running agent (see the header).
  if (args.fleet) {
    await apiItem('api.crons', '/api/crons');
    await apiItem('api.skills', '/api/skills');
    await apiItem('api.models-summary', '/api/agents/models-summary');
    await apiItem('api.channels-summary', '/api/agents/channels-summary');
    await apiItem('api.devices-summary', '/api/agents/devices-summary');
    await apiItem('api.system-health', '/api/system-health');
    await apiItem('api.gateway-state', '/api/agents/gateway');
  }

  // ── Logs ─────────────────────────────────────────────────────
  // The Gateway logs to stderr, which `docker logs` passes through as its own stderr. The window
  // (--logs-since) gives the notable lines; the whole log of this container (the newest 50000
  // lines) gives the entrypoint and doctor output of its start, which for an updated agent is
  // the update's migration, however long ago it ran.
  const readLog = (extra) => {
    const r = run('docker', ['logs', '-t', ...extra, container], { timeoutMs: 120_000 });
    return { rc: r.rc, lines: `${r.stdout}${r.stderr}`.split('\n').map(stripStamps) };
  };
  const recent = readLog(['--since', logsSince]);
  const whole = readLog(['--tail', '50000']);
  const notable = [...new Set(recent.lines.filter((l) => NOTABLE.test(l) && !PROBE_LINE.test(l) && !FAKE_TOKEN_401(l)).map((l) => l.slice(0, 300)))];
  const logItem = (name, r, lines) => {
    fs.writeFileSync(path.join(outDir, `${name}.raw`), redact(lines.join('\n')));
    const rec = { name, ok: r.rc === 0, rc: r.rc, json: false, empty: !lines.length, bytes: lines.join('\n').length, attempts: 1, lines: lines.length, readLines: r.lines.length };
    if (r.rc !== 0) rec.problem = `docker logs exit ${r.rc}`;
    index.items.push(rec);
    console.log(`${rec.ok ? 'ok  ' : 'FAIL'} ${name.padEnd(28)} lines=${lines.length} (of ${r.lines.length} read)`);
  };
  logItem('log.notable', recent, notable);
  logItem('log.doctor', whole, doctorBoxes(whole.lines));
  logItem('log.entrypoint', whole, whole.lines.filter((l) => l.includes('[entrypoint]')));

  // ── Seed presence and verdict ────────────────────────────────
  // What seed.mjs left: without it, several items compare empty with empty.
  let seedFile = null;
  try { seedFile = JSON.parse(fs.readFileSync(path.join(work, 'seed.json'), 'utf8')); } catch { /* not seeded from this work dir */ }
  // One seed.json per work folder: a seed of another agent in the same folder is not this one's.
  if (seedFile && seedFile.container && seedFile.container !== container) {
    index.problems.push(`seed.json in ${work} belongs to ${seedFile.container}, not ${container}: ignored (seed each agent in its own --work)`);
    seedFile = null;
  }
  const workspaceSkills = (fs.readFileSync(path.join(outDir, 'file.workspace-skills.raw'), 'utf8') || '').split('\n');
  index.seed = {
    cronJob: !!seedJob, agentCron: !!seedAgentJob, skill: workspaceSkills.includes(SEED),
    seededWith: seedFile?.steps ? Object.fromEntries(Object.entries(seedFile.steps).map(([k, v]) => [k, v.status])) : null,
  };
  if (!seedJob) index.problems.push('seed cron job absent: cron-runs items were skipped (run seed.mjs first)');

  const required = index.items.filter((i) => !i.optional);
  const failed = required.filter((i) => !i.ok);
  index.complete = true;
  index.ok = failed.length <= required.length / 3;
  if (failed.length) index.problems.push(`${failed.length} of ${required.length} required items failed: ${failed.map((i) => i.name).join(', ')}`);
  writeIndex();

  const md = [`# Snapshot ${label} of ${container} ("${agent.displayName}")`, '',
    `- Taken ${takenAt}; image \`${agent.image}\`; uptime ${index.preflight.settle.uptimeS}s, cpu ${cpu}%`,
    `- Verdict: **${index.ok ? 'usable' : 'NOT TRUSTWORTHY'}**`,
    ...index.problems.map((p) => `- ${p}`), '',
    '| Item | ok | rc | json | note |', '|---|---|---|---|---|',
    ...index.items.map((i) => `| ${i.name} | ${i.ok ? 'yes' : '**no**'} | ${i.rc} | ${i.json}${i.empty ? ' (empty)' : ''} | ${(i.problem ?? (i.optional ? 'optional' : '')).replace(/\|/g, '/')} |`)].join('\n');
  fs.writeFileSync(path.join(outDir, 'index.md'), redact(md) + '\n');
  console.log(`-> ${outDir}`);
  if (!index.ok) throw new Untrustworthy(`${failed.length} of ${required.length} required items failed; see ${path.join(outDir, 'index.md')}`);
  return 0;
});
