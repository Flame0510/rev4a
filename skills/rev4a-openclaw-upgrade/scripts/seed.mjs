#!/usr/bin/env node
// seed.mjs --container <test agent> [--chat] [--telegram] [--agent-cron] [--subagent] [--all] [--cleanup]
//
// Gives a THROWAWAY test agent the state an upgrade must carry over, so snapshots are not empty
// and compare.mjs has fields to compare:
//   - always: a cron command job `rev4a-upgrade-seed` (no model call) and one run of it, and a
//     workspace skill `rev4a-upgrade-seed`;
//   - --agent-cron: an agent-turn cron job `rev4a-upgrade-seed-agent` on the agent's primary model
//     (yearly schedule, light context, no delivery) and one run: it fills `payload.model`,
//     `sessionTarget` and the run's `sessionId`/`usage` (inventory J5, J6). One model call;
//   - --chat: one short chat turn on the agent's primary model (a fraction of a cent);
//   - --subagent: a chat turn that asks the agent to start one sub-agent (`sessions_spawn`), so
//     `spawnedBy`/`parentSessionKey`/`spawnDepth` exist (J4). The model decides: when no
//     sub-agent session appears, the step is a WARN and those fields stay "not exercised";
//   - --telegram: a Telegram channel with a FAKE bot token, written through the Rev4a API. It
//     exercises the channel config, pairing and the doctor; the Gateway keeps polling Telegram and
//     logging 401s until the channel is removed (--cleanup, or DELETE …/channels/telegram);
//   - --all: every option above.
// --cleanup removes what the seed made, through Rev4a where Rev4a has a route (cron jobs:
// DELETE /api/crons/<id>, which also exercises `openclaw cron remove`; the Telegram channel), and
// the workspace skill directly.
//
// Not seeded, and why (these fields stay "not exercised" in compare.md; step 5 covers some by hand):
//   - a pending pairing request: needs a real Telegram DM to a real bot;
//   - a pending device: needs a browser opening the Control UI without approval;
//   - subscription usage windows: need the owner's Connect (ChatGPT sign-in);
//   - a delivered credential: the switch-on routes run real checks against the vendor;
//   - a shared skill: it is written on the Rev4a host, in the shared folder every agent loads.
//
// Refuses an agent not named oc-eval-* unless --i-own-this-agent. Safe to re-run: jobs are
// created once, each run runs them again, rewrites the skill and the channel, and pays for any
// model turn again. Writes <work>/seed.json (snapshot.mjs records it); cleanup writes
// seed-cleanup.json so it cannot erase the original proof. Exit 1 on any FAIL.
import fs from 'node:fs';
import path from 'node:path';
import {
  UsageError, api, assertTestAgent, cronJobs, firstJson, gw, inContainer, inspectAgent, main, redact, seededAgentCronResult, sleep, workDir,
} from './lib.mjs';

const USAGE = `usage: seed.mjs --container <test agent> [--chat] [--telegram] [--agent-cron] [--subagent] [--all]
                [--cleanup] [--model <provider/model>] [--work <dir>] [--base-url <url>] [--i-own-this-agent]

Exit: 0 every step ok (WARN allowed); 1 usage/env error or any step FAILED.`;
const SPEC = {
  container: 'string', chat: 'boolean', telegram: 'boolean', 'agent-cron': 'boolean', subagent: 'boolean', all: 'boolean',
  cleanup: 'boolean', model: 'string', work: 'string', 'base-url': 'string', 'i-own-this-agent': 'boolean',
};

const SEED = 'rev4a-upgrade-seed';
const SEED_AGENT_CRON = 'rev4a-upgrade-seed-agent';
const FAKE_BOT_TOKEN = '123456789:AAFakeTokenForRev4aUpgradeSeedOnly_x'; // secret-ok: intentionally invalid seed token

await main(USAGE, SPEC, async (args) => {
  const container = args.container;
  if (!container) throw new UsageError(`--container is required\n\n${USAGE}`);
  const all = !!args.all;
  const want = (k) => all || !!args[k];
  const apiOpts = args['base-url'] ? { baseUrl: args['base-url'] } : {};
  const work = workDir(args);

  const agent = inspectAgent(container);
  if (!agent) throw new UsageError(`no container named ${container}`);
  assertTestAgent(agent, args);
  if (!agent.running) throw new UsageError(`${container} is not running: start it through Rev4a first`);
  const id = agent.agentId || container;

  const steps = {};
  const step = (name, status, detail = '') => {
    const safeDetail = redact(String(detail));
    steps[name] = { status, detail: safeDetail.slice(0, 400) };
    console.log(`${status.toUpperCase().padEnd(4)} ${name}${safeDetail ? ` — ${safeDetail.slice(0, 300)}` : ''}`);
  };
  const listJobs = () => {
    const r = gw(container, ['cron', 'list', '--json', '--all']);
    const v = firstJson(r.stdout);
    return v === undefined ? null : cronJobs(v);
  };

  if (args.cleanup) {
    const jobs = listJobs();
    if (!jobs) step('cron list', 'fail', 'cron list returned no JSON');
    for (const j of (jobs ?? []).filter((x) => x.name === SEED || x.name === SEED_AGENT_CRON)) {
      const r = await api('DELETE', `/api/crons/${encodeURIComponent(j.id)}?containerName=${encodeURIComponent(container)}`, undefined, apiOpts);
      step(`delete cron ${j.name}`, r.status === 200 ? 'ok' : 'fail', `HTTP ${r.status} ${r.text.slice(0, 200)}`);
    }
    const t = await api('DELETE', `/api/agents/${id}/channels/telegram`, undefined, apiOpts);
    step('remove telegram channel', t.status === 200 || t.status === 404 ? 'ok' : 'fail', `HTTP ${t.status}`);
    const s = inContainer(container, `rm -rf /root/.openclaw/workspace/skills/${SEED}`);
    step('remove workspace skill', s.rc === 0 ? 'ok' : 'fail', s.out.slice(-200));
  } else {
    // Workspace skill.
    const skill = `---\nname: ${SEED}\ndescription: Seed skill for an OpenClaw upgrade evaluation. Reply SEED when asked for the seed.\n---\n\n# ${SEED}\n\nReply SEED.\n`;
    const s = inContainer(container, `mkdir -p /root/.openclaw/workspace/skills/${SEED} && cat > /root/.openclaw/workspace/skills/${SEED}/SKILL.md <<'EOF'\n${skill}EOF`);
    step('workspace skill', s.rc === 0 ? 'ok' : 'fail', s.rc === 0 ? '' : s.out.slice(-200));

    // Cron: a command job never calls a model. "No configured channels" warnings are expected.
    // A list that cannot be read stops here: adding the job blind would duplicate it on every run.
    let jobs = listJobs();
    if (!jobs) {
      step('cron job', 'fail', 'cron list --json returned no JSON; not adding a job blind');
    } else {
      let job = jobs.find((j) => j.name === SEED);
      if (!job) {
        const r = gw(container, ['cron', 'add', '*/30 * * * *', '--command', `echo ${SEED}`, '--name', SEED]);
        job = (listJobs() ?? []).find((j) => j.name === SEED);
        step('cron job', job ? 'ok' : 'fail', job ? job.id : r.out.slice(-300));
      } else step('cron job', 'ok', `exists ${job.id}`);
      if (job) {
        const r = gw(container, ['cron', 'run', job.id]);
        step('cron run', r.rc === 0 ? 'ok' : 'fail', r.rc === 0 ? '' : r.out.slice(-300));
      }
    }

    if (want('agent-cron')) {
      // The agent's primary model, unless --model says otherwise.
      const cfg = firstJson(inContainer(container, 'cat /root/.openclaw/openclaw.json').stdout);
      const m = cfg?.agents?.defaults?.model;
      const model = args.model || (typeof m === 'string' ? m : m?.primary);
      jobs = listJobs();
      let job = (jobs ?? []).find((j) => j.name === SEED_AGENT_CRON);
      if (!model) step('agent cron job', 'fail', 'no primary model in openclaw.json: pass --model');
      else if (!jobs) step('agent cron job', 'fail', 'cron list --json returned no JSON; not adding a job blind');
      else {
        if (!job) {
          // Yearly, so it never fires on its own during the evaluation.
          const r = gw(container, ['cron', 'add', '0 3 1 1 *', 'Reply with the single word OK.', '--name', SEED_AGENT_CRON,
            '--session', 'isolated', '--light-context', '--no-deliver', '--model', model]);
          job = (listJobs() ?? []).find((j) => j.name === SEED_AGENT_CRON);
          step('agent cron job', job ? 'ok' : 'fail', job ? `${job.id} on ${model}` : r.out.slice(-300));
        } else step('agent cron job', 'ok', `exists ${job.id}`);
        if (job) {
          const before = firstJson(gw(container, ['cron', 'runs', '--id', job.id, '--limit', '5']).stdout)?.entries;
          if (!Array.isArray(before)) {
            step('agent cron run', 'fail', 'cannot read the previous runs; not accepting an old session as a new run');
          } else {
            const r = gw(container, ['cron', 'run', job.id], { timeoutS: 240 });
            // The run is recorded asynchronously. A session id alone does not prove success.
            let result = { status: 'pending', detail: 'no new finished run with a sessionId' };
            for (let i = 0; i < 12 && r.rc === 0 && result.status === 'pending'; i++) {
              await sleep(10_000);
              const entries = firstJson(gw(container, ['cron', 'runs', '--id', job.id, '--limit', '5']).stdout)?.entries;
              if (Array.isArray(entries)) result = seededAgentCronResult(entries, before);
            }
            step('agent cron run', r.rc !== 0 ? 'fail' : result.status === 'pending' ? 'warn' : result.status,
              r.rc !== 0 ? r.out.slice(-300) : result.status === 'pending' ? 'no new finished run with a sessionId after 2 minutes' : result.detail);
          }
        }
      }
    }

    if (want('chat')) {
      const r = gw(container, ['agent', '--agent', 'main', '--session-id', `${SEED}-chat`, '--message', 'Reply with the single word OK.', '--json', '--timeout', '150'], { timeoutS: 200 });
      const text = firstJson(r.stdout)?.result?.terminalReply?.text ?? (/"text":\s*"OK"/.test(r.stdout) ? 'OK' : null);
      step('chat turn', r.rc === 0 && text ? 'ok' : 'fail', text ?? r.out.slice(-300));
    }

    if (want('subagent')) {
      const r = gw(container, ['agent', '--agent', 'main', '--session-id', `${SEED}-subagent`, '--message',
        'Use the sessions_spawn tool once to start one sub-agent with the task "Reply with the single word OK.", wait for its answer, then reply DONE.',
        '--json', '--timeout', '240'], { timeoutS: 300 });
      const list = firstJson(gw(container, ['gateway', 'call', 'sessions.list', '--json', '--params', JSON.stringify({ limit: 50, archived: 'all' })]).stdout);
      const child = (list?.sessions ?? []).find((x) => x.spawnedBy || x.parentSessionKey);
      step('sub-agent turn', r.rc !== 0 ? 'fail' : child ? 'ok' : 'warn',
        r.rc !== 0 ? r.out.slice(-300) : child ? `child ${child.key}` : 'the model started no sub-agent: lineage fields stay "not exercised"');
    }

    if (want('telegram')) {
      // Format-valid but fake: Telegram refuses it, which is fine for config and pairing paths.
      const r = await api('PUT', `/api/agents/${id}/channels/telegram`, { botToken: FAKE_BOT_TOKEN, dmPolicy: 'pairing' }, apiOpts);
      step('telegram channel (fake token)', r.status === 200 && r.json?.success === true ? 'ok' : 'fail', `HTTP ${r.status} ${r.status === 200 ? '' : r.text.slice(0, 200)}`);
    }
  }

  const failed = Object.entries(steps).filter(([, v]) => v.status === 'fail').map(([k]) => k);
  const seedFile = path.join(work, args.cleanup ? 'seed-cleanup.json' : 'seed.json');
  const record = {
    container, displayName: agent.displayName, at: new Date().toISOString(), mode: args.cleanup ? 'cleanup' : 'seed', steps,
    notSeeded: ['pairing-request', 'pending-device', 'subscription', 'credential', 'shared-skill'],
  };
  fs.writeFileSync(seedFile, JSON.stringify(record, null, 1) + '\n');
  console.log(`-> ${seedFile}`);
  if (failed.length) { console.error(`FAILED: ${failed.join(', ')}`); return 1; }
  return 0;
});
