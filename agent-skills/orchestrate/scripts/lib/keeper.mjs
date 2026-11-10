// The campaign keeper: decides, without a model, whether the coordinator of an active campaign must be woken up.
// A model ends its turn when it believes it is done or waiting; when that belief is wrong, nothing in the runtime
// starts the next turn. The keeper reads orch's own state and answers one of:
//   wake      the coordinator must act (eligible work and nobody on it, a step waiting for the coordinator, a
//             sub-agent past its time limit) and has been quiet for campaign.idleMinutes
//   wait      something is running, the coordinator acted recently, or a wake was sent recently (backoff)
//   escalate  a person must decide (an unsafe or unchecked merge, a ready card without merge consent, every
//             remaining card blocked, or several wakes without progress)
//   done      nothing left in the campaign's scope
//   off       no active campaign
// Every open run is looked at, not only the first: one card waiting for its worker must not hide another card waiting
// for the coordinator. Escalations are returned as a list (`escalations`, each with a stable key) next to the action,
// so a wake and a report to the owner can happen in the same check.
// It never starts a coordinator, never writes to another session than the one recorded by `orch campaign start`.

export const CAMPAIGN_DEFAULTS = { idleMinutes: 10, graceMinutes: 10, backoffMinutes: [10, 20, 40], maxWakesWithoutProgress: 3 };

const min = ms => Math.round(ms / 60000);
// Labels as the coordinator typed them: case and spacing may differ from orch's, and it may add a suffix ("(retry)").
const norm = l => String(l ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
export const sameLabel = (actual, expected) => norm(actual) === norm(expected) || norm(actual).startsWith(`${norm(expected)} `);
// Ended as OpenClaw counts it: a terminal status or an end time. Anything else (running, queued, yielded, none) is live.
export const ended = s => ['done', 'failed', 'killed', 'timeout'].includes(s.status) || Boolean(s.endedAt);

// A prepared resume starts a new worker window in this round, even if the coordinator never spawned it.
export const workerRestartAt = st => Date.parse([...(st.events ?? [])].reverse()
  .find(e => e.kind === 'restart' && e.role === 'worker' && e.round === st.round)?.t ?? '') || 0;

/**
 * ctx: { now, campaign, runs (open run states in scope: id, phase, round, events, finishPending),
 * restartRuns (all run states in scope, including closed and archived cards; defaults to runs), lastActivity (ms),
 * busy (string or null), busySince (ms, when that same thing was first seen running), othersRunning (a sub-agent of a
 * run outside the scope is within its time limit), blocked ([{ id, why }]), eligible ([{ id }]), waiting ([{ id,
 * reasons }] cards in scope that cannot start or have no run), remaining (cards in scope not finished), standing (bool),
 * limits, nextFor (run → its next: line), recheckable (run → its checkers only lacked evidence: orch recheck first), progress (fingerprint), reports ({ [run id]: [{ tag, mtime }] } reports a
 * sub-agent left in the run's inbox and nobody recorded yet), sessions (null when unknown, else the runtime's sessions:
 * [{ label, status, updatedAt }]), expected ({ [run id]: { opened, labels: [{ label, who }] } }: the sub-agents the
 * run waits for and when its phase opened) }
 * The result always carries `progress`; `partial: true` means the runs were not looked at (something is running), so
 * escalations reported before must not be taken as cleared.
 */
export function decide(ctx) {
  const d = decideAll(ctx);
  // Model advice accompanies the usual decision; it never blocks a wake or turns a wait into an escalation, and an
  // error while reading history only drops the advice.
  if (ctx.campaign?.active) try {
    const counts = new Map();
    const startedAt = Date.parse(ctx.campaign.startedAt ?? '') || 0;
    // The same run can be read twice in one check (open, then archived by a split meanwhile): per run and per
    // role/model, the larger of its readings counts, never their sum.
    const perRun = new Map();
    for (const st of ctx.restartRuns ?? ctx.runs) {
      // History is advice only: a malformed state or event is skipped, never allowed to break the decision.
      if (!st || typeof st.id !== 'string' || !Array.isArray(st.events)) continue;
      const reading = new Map();
      for (const e of st.events) {
        if (!e || typeof e !== 'object' || e.kind !== 'restart' || typeof e.t !== 'string' || !(Date.parse(e.t) >= startedAt)) continue;
        if (typeof e.role !== 'string' || typeof e.model !== 'string') continue;
        const key = `restarts:${e.role}:${e.model}`;
        reading.set(key, { role: e.role, model: e.model, n: (reading.get(key)?.n ?? 0) + 1 });
      }
      const run = perRun.get(st.id) ?? new Map();
      for (const [key, r] of reading) if (r.n > (run.get(key)?.n ?? 0)) run.set(key, r);
      perRun.set(st.id, run);
    }
    for (const [id, run] of perRun) {
      for (const [key, r] of run) {
        if (!counts.has(key)) counts.set(key, { role: r.role, model: r.model, n: 0, cards: new Set() });
        const count = counts.get(key);
        count.n += r.n; count.cards.add(id);
      }
    }
    const advice = [];
    for (const [key, { role, model, n, cards }] of counts) {
      if (n >= 2) advice.push({ key, reason: `the ${role} (model ${model}) stopped without a report ${n} times in this campaign (cards ${[...cards].join(', ')}): consider another model for this role in the config` });
    }
    d.escalations.push(...advice);
  } catch { /* advice only: the decision above stands */ }
  return { ...d, progress: ctx.progress };
}

function decideAll(ctx) {
  const c = { ...CAMPAIGN_DEFAULTS, ...(ctx.campaign ?? {}) };
  if (!ctx.campaign?.active) return { action: 'off', reason: 'no active campaign (orch campaign start)', escalations: [] };
  if (ctx.busy) {
    // A command or harness that runs longer than any sub-agent may is hung: the owner looks at it, the keeper waits.
    const hungAfter = Math.max(ctx.limits.workerTimeoutSec, ctx.limits.checkerTimeoutSec) * 1000 + c.graceMinutes * 60000;
    const since = ctx.busySince ?? ctx.now;
    if (ctx.now - since >= hungAfter) {
      const e = { key: `busy:${ctx.busy}`, reason: `${ctx.busy} has been running for ${min(ctx.now - since)} min: it may be hung` };
      return { action: 'escalate', reason: e.reason, escalations: [e], partial: true, busy: ctx.busy };
    }
    return { action: 'wait', reason: `running: ${ctx.busy}`, escalations: [], partial: true, busy: ctx.busy };
  }
  const escalations = [];
  if (ctx.blocked.length) {
    // The queue is blocked by design (orch start refuses): only the owner can unblock it.
    escalations.push({ key: `blocked:${ctx.blocked.map(b => b.id).join(',')}`, reason: `a merge needs the owner: ${ctx.blocked.map(b => `${b.id} (${b.why})`).join(', ')}` });
    return { action: 'escalate', reason: escalations[0].reason, escalations, partial: true };
  }
  const idleFor = ctx.now - ctx.lastActivity;
  const quiet = idleFor >= c.idleMinutes * 60000;
  const due = []; const waits = []; let running = Boolean(ctx.othersRunning);
  const rounds = ctx.limits.correctionRounds ?? Infinity;
  // At its limit: the run's own limit (scope rounds granted), unless a gate that failed on files outside the card can
  // still get its scope round (the coordinator adds the files and fixes).
  const atLimit = st => (st.round ?? 0) >= rounds + (st.scopeRounds ?? 0)
    && !(st.phase === 'gate-failed' && (st.gate?.outside ?? 0) > 0 && (st.scopeRounds ?? 0) < (ctx.scopeRoundsMax ?? 1))
    && !ctx.recheckable?.(st); // checkers that only lacked evidence run again first: the coordinator's step
  for (const st of ctx.runs) {
    const last = Date.parse(st.events.at(-1)?.t ?? 0) || 0;
    if (st.phase === 'ready' && !ctx.standing) {
      escalations.push({ key: `ready:${st.id}:r${st.round ?? 0}`, reason: `${st.id} is ready and waits for the owner's merge ok` });
      continue;
    }
    if (['rejected', 'gate-failed'].includes(st.phase) && atLimit(st) && !ctx.selfDecides) {
      // Only the owner can go on (accept, split or park): waking the coordinator would only make it ask.
      escalations.push({ key: `limit:${st.id}:r${st.round}`, reason: `${st.id} reached the round limit (${st.phase}): ${ctx.nextFor(st)}` });
      continue;
    }
    if (st.phase === 'working' || st.phase === 'checking') {
      const who = st.phase === 'working' ? 'worker' : 'checker';
      // A report in the inbox that nobody recorded: the sub-agent finished, but its completion may never have reached
      // the coordinator (a delivery error, an aborted turn). Once it has been there, untouched, for idleMinutes and the
      // coordinator is quiet, the coordinator records it instead of waiting for the time limit.
      const left = (ctx.reports?.[st.id] ?? []).filter(r => ctx.now - r.mtime >= c.idleMinutes * 60000);
      if (left.length && quiet) {
        const age = min(ctx.now - Math.max(...left.map(r => r.mtime)));
        due.push({ reason: `${st.id}: the ${who} left its report ${age} min ago and nobody recorded it (its completion may not have reached you)`,
          next: left.map(r => `orch record ${st.id} ${who}${r.tag ? ` --tag ${r.tag}` : ''}`).join(', then ') });
        continue;
      }
      const limit = (st.phase === 'working' ? ctx.limits.workerTimeoutSec : ctx.limits.checkerTimeoutSec) * 1000 + c.graceMinutes * 60000;
      // The last event (including restart) or overdue wake gives the sub-agent a full time limit.
      const resume = `orch prompt ${st.id} worker --resume, then start the worker from that file using its next: line`;
      const restartedAt = who === 'worker' ? workerRestartAt(st) : 0;
      const workerRecovery = restartedAt
        ? `split the card (orch card split ${st.id}) or park it (orch park ${st.id}), or ask the owner: this round already used its worker resume`
        : `run ${resume}`;
      // A sub-agent the run waits for but that is not running: never started (the coordinator ended its turn first) or
      // ended without a report. Known only when the runtime's sessions could be read; checked once the phase has been
      // open for idleMinutes and the coordinator is quiet.
      const exp = ctx.expected?.[st.id];
      const opened = Math.max(exp?.opened ?? 0, restartedAt);
      if (ctx.sessions && exp && quiet && ctx.now - opened >= c.idleMinutes * 60000) {
        // A label with a report in the inbox (any age) has finished: the report rule handles it. Otherwise the label is
        // live when any of its sessions since the phase opened is live (a restart leaves the ended one in the list),
        // and ended when its latest one ended.
        const reported = new Set((ctx.reports?.[st.id] ?? []).map(r => r.tag ?? null));
        const gone = exp.labels.filter(x => !reported.has(x.tag ?? null)).map(x => {
          // No clock tolerance across a resume: an earlier session belongs to the stopped worker.
          const mine = ctx.sessions.filter(s => sameLabel(s.label, x.label) && (s.updatedAt ?? 0) >= (restartedAt ? opened : opened - 60000));
          return { ...x, s: mine.find(s => !ended(s)) ?? mine.sort((a, b) => b.updatedAt - a.updatedAt)[0] };
        }).filter(x => !x.s || ended(x.s));
        if (gone.length) {
          const never = gone.filter(x => !x.s).map(x => `"${x.label}"`);
          const ended = gone.filter(x => x.s).map(x => `"${x.label}"`);
          due.push({ reason: [
            never.length ? `${st.id}: no OpenClaw session ${never.join(', ')} was started for this ${who === 'worker' ? 'round' : 'gate'}` : null,
            ended.length ? `${st.id}: the session ${ended.join(', ')} ended without leaving a report` : null,
          ].filter(Boolean).join('; '), next: ended.length && !never.length
            ? `read its last answer (sessions_history); if it is the report, save it to the inbox and orch record it, otherwise ${who === 'worker' ? workerRecovery : `start it again: ${ctx.nextFor(st)}`}`
            : `start it now: ${ctx.nextFor(st)}`, overdue: st.id }); // the restarted sub-agent gets a full time limit
          continue;
        }
      }
      const since = Math.max(last, c.overdue?.[st.id] ?? 0);
      if (ctx.now - since < limit) { running = true; waits.push(`${st.id}: ${who} within its time limit`); continue; }
      due.push({ overdue: st.id, reason: `${st.id}: no step from the ${who} for ${min(ctx.now - last)} min, past its time limit; check its session: if it still works, wait for it, if it is gone, ${who === 'worker' ? workerRecovery : `start it again (${ctx.nextFor(st)})`}`, next: `check the ${who} session of ${st.id}; ${who === 'worker' ? `only if it is gone, ${workerRecovery}` : 'start it again only if it is gone'}` });
      continue;
    }
    // A run at its round limit that the coordinator decides itself: while its advisor sub-agent is at work, it waits.
    // Only a session since the run reached its limit counts, and only for a worker's time limit: a hung advisor
    // does not hold the campaign.
    // The window opens at the limit, or later when the advisor's brief was written later (a slow coordinator).
    const limitAt = Math.max(Date.parse(st.events.at(-1)?.t ?? 0) || 0, ctx.advisorBriefAt?.[st.id] ?? 0);
    if (ctx.selfDecides && !st.setAside && ['rejected', 'gate-failed'].includes(st.phase) && atLimit(st)
      && ctx.now - limitAt < ctx.limits.workerTimeoutSec * 1000 + c.graceMinutes * 60000
      && ctx.sessions?.some(s => sameLabel(s.label, `${st.id} advisor r${st.round}`) && !ended(s) && (s.updatedAt ?? 0) >= limitAt - 60000)) {
      running = true; // a sub-agent at work: a legitimate end of turn, like a worker's
      waits.push(`${st.id}: its advisor is at work`);
      continue;
    }
    // A step the coordinator owns (worked, gated, gate-failed, rejected, ready with consent, a merge with steps left).
    if (quiet) due.push({ reason: `${st.id} waits for the coordinator (${st.phase}${st.finishPending?.length ? `, still to do: ${st.finishPending.join(', ')}` : ''}) and nothing happened for ${min(idleFor)} min`, next: ctx.nextFor(st) });
    else waits.push(`${st.id} (${st.phase}): the coordinator acted ${min(idleFor)} min ago`);
  }
  // A sub-agent at work is a legitimate end of turn (its completion wakes the coordinator): eligible cards alone do
  // not wake it then.
  if (!due.length && !running && ctx.eligible.length) {
    if (quiet) due.push({ reason: `${ctx.eligible.length} card(s) can start and nobody works on them (quiet for ${min(idleFor)} min)`, next: `orch start ${ctx.eligible[0].id}` });
    else waits.push(`the coordinator acted ${min(idleFor)} min ago`);
  }
  if (due.length) {
    const w = wake(ctx, c, due[0].reason, due[0].next);
    if (w.escalation) escalations.push(w.escalation);
    return { ...w, ...(w.action === 'wake' && due[0].overdue ? { overdue: due[0].overdue } : {}), escalations };
  }
  if (!ctx.runs.length && !ctx.eligible.length) {
    if (ctx.remaining.length) {
      escalations.push({ key: `waiting:${ctx.waiting.map(x => x.id).join(',')}`, reason: `every remaining card waits: ${ctx.waiting.slice(0, 5).map(x => `${x.id} (${x.reasons[0]})`).join('; ')}` });
    } else if (!escalations.length) {
      return { action: 'done', reason: 'every card in the campaign is done', escalations: [] };
    }
  }
  if (escalations.length) return { action: 'escalate', reason: escalations.map(e => e.reason).join(' · '), escalations };
  return { action: 'wait', reason: waits.join('; ') || 'nothing due', escalations: [] };
}

// A wake, unless the previous one is still recent (backoff) or several brought no progress (then the owner decides).
function wake(ctx, c, reason, next) {
  const w = ctx.campaign.wakes ?? { count: 0, at: 0, progress: null };
  const sameProgress = w.progress === ctx.progress;
  const count = sameProgress ? w.count : 0;
  if (count >= c.maxWakesWithoutProgress) {
    const escalation = { key: `stuck:${ctx.progress}`, reason: `${count} wakes without progress; last reason: ${reason}` };
    return { action: 'escalate', reason: escalation.reason, escalation };
  }
  // After the first wake wait backoffMinutes[0], after the second [1], and so on.
  const backoff = c.backoffMinutes[Math.min(Math.max(count - 1, 0), c.backoffMinutes.length - 1)] * 60000;
  if (sameProgress && count > 0 && ctx.now - w.at < backoff) {
    return { action: 'wait', reason: `woken ${min(ctx.now - w.at)} min ago, next wake not before ${min(backoff)} min (${reason})` };
  }
  return { action: 'wake', reason, next, wakeCount: count + 1, progress: ctx.progress };
}

/** The self-contained message the coordinator receives. */
export function wakeMessage(campaign, d) {
  return [
    `[orch keeper] Campaign "${campaign.scopeLabel}" is active and nothing is moving: ${d.reason}.`,
    `Resume as the sole coordinator of this campaign. Run orch status, then: ${d.next}.`,
    'After every closure run orch next in the same turn and start the next card. End a turn only to wait for a running',
    'sub-agent or process, when a person must decide (say what), or when orch campaign status says done.',
  ].join(' ');
}
