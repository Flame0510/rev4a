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

/**
 * ctx: { now, campaign, runs (open run states in scope: id, phase, round, events, finishPending), lastActivity (ms),
 * busy (string or null), busySince (ms, when that same thing was first seen running), othersRunning (a sub-agent of a
 * run outside the scope is within its time limit), blocked ([{ id, why }]), eligible ([{ id }]), waiting ([{ id,
 * reasons }] cards in scope that cannot start or have no run), remaining (cards in scope not finished), standing (bool),
 * limits, nextFor (run → its next: line), progress (fingerprint), reports ({ [run id]: [{ tag, mtime }] } reports a
 * sub-agent left in the run's inbox and nobody recorded yet) }
 * The result always carries `progress`; `partial: true` means the runs were not looked at (something is running), so
 * escalations reported before must not be taken as cleared.
 */
export function decide(ctx) {
  return { ...decideAll(ctx), progress: ctx.progress };
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
  for (const st of ctx.runs) {
    const last = Date.parse(st.events.at(-1)?.t ?? 0) || 0;
    if (st.phase === 'ready' && !ctx.standing) {
      escalations.push({ key: `ready:${st.id}:r${st.round ?? 0}`, reason: `${st.id} is ready and waits for the owner's merge ok` });
      continue;
    }
    if (['rejected', 'gate-failed'].includes(st.phase) && (st.round ?? 0) >= rounds) {
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
      // The clock restarts at the last wake for this run: the coordinator may have started the sub-agent again, which
      // no orch command records, so it gets a full time limit before the next wake.
      const since = Math.max(last, c.overdue?.[st.id] ?? 0);
      if (ctx.now - since < limit) { running = true; waits.push(`${st.id}: ${who} within its time limit`); continue; }
      due.push({ overdue: st.id, reason: `${st.id}: no step from the ${who} for ${min(ctx.now - last)} min, past its time limit; check its session: if it still works, wait for it, if it is gone, start it again (${ctx.nextFor(st)})`, next: `check the ${who} session of ${st.id}; start it again only if it is gone` });
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
